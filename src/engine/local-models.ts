/**
 * Local speech models through the receiver binary's `models` commands: the catalogue with each model's state in
 * the per-user model cache, downloads with progress (stoppable, resumed by the next download), and deletes. The
 * binary's path is given by the caller; its output is one JSON object per line.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { type BinaryChoice, ensureBinary, findBinary } from "./binary";
import { childEnv, type Env } from "./env";
import {
  type Download,
  type DownloadProgress,
  type DownloadResult,
  downloadResult,
  type FollowedDownload,
  followDownload,
  type ModelBackend,
} from "./model-backend";
import { TranscribeWorker } from "./receiver-worker";
import type { Device, Settings } from "./settings";

export type { Download, DownloadProgress, DownloadResult, FollowedDownload };
export { downloadResult, followDownload };

/** Whether live typing into Pi's editor is available for the current transcription settings. */
export function canLiveDictate(s: Pick<Settings, "transcriptionSource" | "localTranscriptionModel">): boolean {
  return s.transcriptionSource === "local" && Boolean(s.localTranscriptionModel);
}

/** Whether a local STT model is fast enough (or true-streaming) for live typing into Pi's editor. */
export function isLiveCapableLocalStt(modelOrId: LocalModel | string | undefined, device: Device): boolean {
  if (!modelOrId) return false;
  if (typeof modelOrId !== "string" && modelOrId.liveCapable) {
    return modelOrId.liveCapable === "always" || (modelOrId.liveCapable === "gpu" && device === "gpu");
  }
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  if (id.startsWith("nemotron-3.5-asr-")) return true;
  if (
    id.startsWith("parakeet-") ||
    id.startsWith("sense-voice-") ||
    id.startsWith("moonshine-") ||
    id.startsWith("canary-180m-") ||
    id.startsWith("dolphin-") ||
    id.startsWith("whisper-tiny") ||
    id.startsWith("whisper-base") ||
    id.startsWith("whisper-small") ||
    id.startsWith("whisper-distil-")
  ) {
    return true;
  }
  return device === "gpu" && id.startsWith("whisper-turbo");
}

export type LocalSttLanguage = { kind: "selectable" } | { kind: "auto" } | { kind: "fixed"; language: string };

/**
 * How a local transcription model handles the spoken-language setting: reads `languageMode` from the
 * receiver's catalog metadata when present, falling back to ID heuristics for older receivers/stand-ins.
 */
export function localSttLanguage(
  modelOrId: LocalModel | string | undefined,
  languages?: readonly string[],
): LocalSttLanguage {
  if (!modelOrId) return { kind: "selectable" };
  const model = typeof modelOrId === "string" ? undefined : modelOrId;
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  const langs = languages ?? model?.languages;
  if (model?.languageMode) {
    if (model.languageMode === "selectable") return { kind: "selectable" };
    if (model.languageMode === "auto") return { kind: "auto" };
    const moonshine = id.match(/^moonshine-(?:tiny|base)-([a-z]{2,3})(?:-|$)/);
    const lang = moonshine?.[1] ?? (langs?.length === 1 && langs[0] !== "mul" ? langs[0] : "en");
    return { kind: "fixed", language: lang };
  }
  if (id.startsWith("canary-") || id.startsWith("cohere-") || id.startsWith("nemotron-")) {
    return { kind: "selectable" };
  }
  const moonshine = id.match(/^moonshine-(?:tiny|base)-([a-z]{2,3})(?:-|$)/);
  if (moonshine) return { kind: "fixed", language: moonshine[1] };
  if (
    /\.en(?:-|$)|-en(?:-|$)/.test(id) ||
    id.startsWith("parakeet-tdt-0.6b-v2") ||
    id === "whisper-distil-large-v3.5"
  ) {
    return { kind: "fixed", language: "en" };
  }
  if (langs?.length === 1 && langs[0] !== "mul" && !id.startsWith("whisper-")) {
    return { kind: "fixed", language: langs[0] };
  }
  return { kind: "auto" };
}

/** What a catalogue entry is: a model of each direction, or a runtime (the GPU runtime) the models run with. */
export type ModelKind = "transcription" | "speech" | "runtime";

/** A catalogue entry with its state in the model cache, as `models list` prints it. */
export interface LocalModel {
  id: string;
  kind: ModelKind;
  name: string;
  /** ISO 639 codes. */
  languages: string[];
  /** The archive's size in bytes (what a download fetches). */
  size: number;
  downloaded: boolean;
  /** Bytes of an interrupted download that the next download resumes from. */
  partial: number;
  /** The shared lexicon the voice needs (an English Piper voice), and whether it is in the cache. */
  lexicon?: { name: string; size: number; downloaded: boolean };
  /** All shared files (`lexicon`, `vocoder`) the model needs in the cache root. */
  shared?: Array<{ name: string; size: number; downloaded: boolean }>;
  /** Where the model is, or will be once downloaded. */
  path: string;
  /** Optional capability, grouping, and ranking metadata emitted by `models list`. */
  group?: string;
  speakers?: number;
  liveCapable?: "always" | "gpu" | "never";
  languageMode?: "selectable" | "auto" | "fixed";
  tags?: string;
  cpuRank?: number;
  gpuRank?: number;
}

export interface DownloadOptions {
  /** Called for each step, one at a time: the next waits for the promise the last returned. */
  onProgress?: (progress: DownloadProgress) => void | Promise<void>;
  /** Aborting stops the download, as `cancel` does. */
  signal?: AbortSignal;
  /** The binary's environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
}

/** How long a stopped download gets to exit before it is killed. */
export const STOP_GRACE_MS = 5000;

export class LocalModelsError extends Error {
  override name = "LocalModelsError";
}

interface Run {
  child: ChildProcess;
  lines: AsyncIterable<string>;
  exited: Promise<{ code: number | null; stderr: string }>;
}

function run(binary: string, args: string[], env: NodeJS.ProcessEnv | undefined): Run {
  const child = spawn(binary, ["models", ...args], {
    env: env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (s: string) => {
    stderr += s;
  });
  // A binary that cannot be started still gives a result, not an unhandled error.
  child.stdin?.on("error", () => {});
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", (e) => reject(new LocalModelsError(`cannot run ${binary}: ${e.message}`)));
    child.once("close", (code) => resolve({ code, stderr }));
  });
  exited.catch(() => {});
  const lines = createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY });
  return { child, lines, exited };
}

function parse(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function failure(stderr: string, code: number | null, message?: unknown): LocalModelsError {
  if (typeof message === "string" && message) return new LocalModelsError(message);
  const why = stderr.trim().replace(/^pi-speech-receiver: /, "");
  return new LocalModelsError(why || `the models command exited with ${code}`);
}

function toModel(v: Record<string, unknown>): LocalModel | undefined {
  const {
    id,
    kind,
    name,
    languages,
    size,
    downloaded,
    partial,
    path,
    lexicon,
    shared,
    group,
    speakers,
    live_capable,
    language_mode,
    tags,
    cpu_rank,
    gpu_rank,
  } = v;
  const lex = lexicon && typeof lexicon === "object" ? (lexicon as Record<string, unknown>) : undefined;
  if (typeof id !== "string" || (kind !== "transcription" && kind !== "speech")) return undefined;
  const sharedList = Array.isArray(shared)
    ? shared.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const o = item as Record<string, unknown>;
        return typeof o.name === "string"
          ? [{ name: o.name, size: typeof o.size === "number" ? o.size : 0, downloaded: o.downloaded === true }]
          : [];
      })
    : undefined;
  return {
    id,
    kind,
    name: typeof name === "string" ? name : id,
    languages: Array.isArray(languages) ? languages.filter((l): l is string => typeof l === "string") : [],
    size: typeof size === "number" ? size : 0,
    downloaded: downloaded === true,
    partial: typeof partial === "number" ? partial : 0,
    path: typeof path === "string" ? path : "",
    ...(lex && typeof lex.name === "string"
      ? {
          lexicon: {
            name: lex.name,
            size: typeof lex.size === "number" ? lex.size : 0,
            downloaded: lex.downloaded === true,
          },
        }
      : {}),
    ...(sharedList?.length ? { shared: sharedList } : {}),
    ...(typeof group === "string" && group ? { group } : {}),
    ...(typeof speakers === "number" ? { speakers } : {}),
    ...(live_capable === "always" || live_capable === "gpu" || live_capable === "never"
      ? { liveCapable: live_capable }
      : {}),
    ...(language_mode === "selectable" || language_mode === "auto" || language_mode === "fixed"
      ? { languageMode: language_mode }
      : {}),
    ...(typeof tags === "string" && tags ? { tags } : {}),
    ...(typeof cpu_rank === "number" ? { cpuRank: cpu_rank } : {}),
    ...(typeof gpu_rank === "number" ? { gpuRank: gpu_rank } : {}),
  };
}

/** The catalogue, with each model's state in the model cache. */
export async function listModels(binary: string, env?: NodeJS.ProcessEnv): Promise<LocalModel[]> {
  const r = run(binary, ["list"], env);
  r.child.stdin?.end();
  const models: LocalModel[] = [];
  let error: unknown;
  for await (const line of r.lines) {
    const v = parse(line);
    if (!v) continue;
    if (v.event === "error") error = v.message;
    const m = toModel(v);
    if (m) models.push(m);
  }
  const { code, stderr } = await r.exited;
  if (code !== 0 || error !== undefined) throw failure(stderr, code, error);
  return models;
}

/** Delete a model and any interrupted download of it; resolves to the bytes freed. */
export async function deleteModel(binary: string, id: string, env?: NodeJS.ProcessEnv): Promise<number> {
  const r = run(binary, ["delete", id], env);
  r.child.stdin?.end();
  let freed: number | undefined;
  let error: unknown;
  for await (const line of r.lines) {
    const v = parse(line);
    if (v?.event === "deleted" && typeof v.freed === "number") freed = v.freed;
    if (v?.event === "error") error = v.message;
  }
  const { code, stderr } = await r.exited;
  if (code !== 0 || freed === undefined) throw failure(stderr, code, error);
  return freed;
}

/**
 * Download a model into the model cache. Nothing is downloaded unless asked for by id. Cancelling closes the
 * binary's standard input, which stops it and keeps what has arrived; it is killed if it has not exited after
 * `STOP_GRACE_MS`.
 */
export function downloadModel(binary: string, id: string, options: DownloadOptions = {}): Download {
  const r = run(binary, ["download", id], options.env);
  let stopping = false;
  let killTimer: NodeJS.Timeout | undefined;
  const cancel = () => {
    if (stopping) return;
    stopping = true;
    r.child.stdin?.end();
    killTimer = setTimeout(() => r.child.kill(), STOP_GRACE_MS);
    killTimer.unref();
  };
  const onAbort = () => cancel();
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const result = (async (): Promise<DownloadResult> => {
    try {
      const followed = await followDownload(r.lines, options.onProgress);
      const { code, stderr } = await r.exited;
      return downloadResult(followed, stopping, code === 0, () => failure(stderr, code, followed.last?.message));
    } finally {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  })();
  return { result, cancel };
}

/** Synthetic family id grouping all Piper English models under one Speech model entry. */
export const PIPER_EN_FAMILY = "piper-en";

const PIPER_SPEAKER_COUNTS: Record<string, number> = {
  "piper-en_US-libritts-high": 904,
  "piper-en_GB-vctk-medium": 109,
  "piper-en_GB-aru-medium": 12,
  "piper-en_GB-semaine-medium": 4,
};

/** Whether `modelOrId` is a Piper archive grouped under `piper-en` in the Speech model picker. */
export function isSingleVoicePiper(modelOrId: LocalModel | string | undefined): boolean {
  if (!modelOrId) return false;
  if (typeof modelOrId !== "string") {
    return modelOrId.group ? modelOrId.group === PIPER_EN_FAMILY : modelOrId.id.startsWith("piper-");
  }
  return modelOrId.startsWith("piper-");
}

/** Human-friendly voice name for a Piper archive (`piper-en_US-lessac-high` -> `lessac-high (US)`). */
export function piperVoiceLabel(modelOrId: LocalModel | string): string {
  const id = typeof modelOrId === "string" ? modelOrId : modelOrId.id;
  const m = /^piper-en_(US|GB)-(.+)$/.exec(id);
  if (!m) return id;
  const count = (typeof modelOrId !== "string" ? modelOrId.speakers : undefined) ?? PIPER_SPEAKER_COUNTS[id];
  const region = m[1] === "US" ? "US" : "UK";
  return count ? `${m[2]} (${region}, ${count} voices)` : `${m[2]} (${region})`;
}

/** The audio a local model transcribes, by file extension. */
export const LOCAL_AUDIO = ["wav", "mp3"];

/** A size as the pickers show it: `640 MB`, `1.2 GB`, `80 KB`. */
export function formatSize(bytes: number): string {
  const units: Array<[number, string]> = [
    [1e9, "GB"],
    [1e6, "MB"],
    [1e3, "KB"],
  ];
  for (const [n, unit] of units) {
    if (bytes >= n) {
      const v = bytes / n;
      return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${unit}`;
    }
  }
  return `${bytes} B`;
}

/**
 * Transcribe a WAV or MP3 file with a downloaded model, on this machine: `transcribe <id> <file>` prints the
 * text. `language` (`de`) is passed for a model that must be told (Canary); the others detect it. Nothing goes over the network. Aborting kills the binary.
 */
export async function transcribeLocal(
  binary: string,
  id: string,
  file: string,
  options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv; language?: string } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const language = options.language && options.language !== "auto" ? ["--language", options.language] : [];
  const child = spawn(binary, ["transcribe", id, file, ...language], {
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (s: string) => {
    stdout += s;
  });
  child.stderr?.on("data", (s: string) => {
    stderr += s;
  });
  const onAbort = () => child.kill();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", (e) => reject(new LocalModelsError(`cannot run ${binary}: ${e.message}`)));
      child.once("close", (c) => resolve(c));
    });
    options.signal?.throwIfAborted();
    if (code !== 0) {
      const why = stderr
        .trim()
        .split("\n")
        .at(-1)
        ?.replace(/^pi-speech-receiver: /, "");
      throw new LocalModelsError(why || `the transcribe command exited with ${code}`);
    }
    return stdout.trim();
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** What `pi-speech-receiver gpu` says. */
export interface GpuInfo {
  driver: boolean;
  /** The CUDA runtime's major version, or null. */
  cuda: number | null;
  cudnn: boolean;
  /** Whether compatible GPU hardware + system CUDA/cuDNN are present. */
  hardware?: boolean;
  /** Which receiver edition was probed (`cpu` or `gpu`). */
  edition?: "cpu" | "gpu";
  /** The GPU receiver target that fits this machine (`linux-x64-cuda13`), or null. */
  target?: string | null;
  usable: boolean;
  /** Why the GPU cannot be used yet, when it cannot. */
  why: string | null;
}

/** Ask the binary what this machine has for the GPU. */
export async function probeGpu(binary: string, env: NodeJS.ProcessEnv): Promise<GpuInfo> {
  const child = spawn(binary, ["gpu"], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let out = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (s: string) => {
    out += s;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", (e) => reject(new LocalModelsError(`cannot run ${binary}: ${e.message}`)));
    child.once("close", resolve);
  });
  try {
    if (code !== 0) throw new Error();
    const parsed = JSON.parse(out.trim().split("\n").at(-1) ?? "") as GpuInfo;
    if (parsed.hardware === undefined) {
      parsed.hardware = parsed.driver && parsed.cuda !== null && parsed.cudnn;
    }
    return parsed;
  } catch {
    // An older receiver without `gpu`.
    return {
      driver: false,
      cuda: null,
      cudnn: false,
      hardware: false,
      usable: false,
      why: "this pi-speech-receiver cannot probe GPU hardware",
    };
  }
}

/** What a download or delete says while Run models on is the Remote machine. */
export function remoteOnly(what: string, id: string): string {
  return `Run models on is Remote machine: ${what} ${id} there with pi-speech-receiver models ${what} ${id}, or set Run models on to This machine (/speech, SETTINGS, Bridge connection)`;
}

/**
 * The on-device models through the bundled binary (found as src/engine/binary.ts says): the catalogue, downloads,
 * deletes, and transcription with a downloaded model. While `remote` gives the Remote machine's models (Run models
 * on is Remote machine with the bridge in use), the catalogue and the runs are the receiver's there instead.
 */
export class LocalModels {
  /** The Remote machine's models when they are the ones to use. */
  readonly remote: () => ModelBackend | undefined;

  /** The running `transcribe --serve`, which keeps the last model loaded between transcriptions. */
  private readonly worker: TranscribeWorker;
  /** Which receiver edition (`cpu` or `gpu`) is active; see `setDevice`. */
  private device: "cpu" | "gpu" = "cpu";
  /** The last GPU probe. */
  private gpuInfo?: GpuInfo;

  constructor(
    private readonly env: Env,
    private readonly locate?: () => BinaryChoice,
    remote: () => ModelBackend | undefined = () => undefined,
  ) {
    this.remote = remote;
    this.worker = new TranscribeWorker(
      () => this.binary(),
      () => this.childEnv,
    );
  }

  /** Run on-device models (transcription and speech) on the CPU or GPU receiver from their next run on. */
  setDevice(device: "cpu" | "gpu"): void {
    if (device === this.device) return;
    this.device = device;
    this.gpuInfo = undefined;
    this.worker.close();
  }

  /**
   * What this machine has for the GPU (`pi-speech-receiver gpu`): driver, CUDA, cuDNN, matching target, and
   * whether the active binary is the GPU edition.
   */
  async gpu(): Promise<GpuInfo> {
    if (this.gpuInfo?.usable) return this.gpuInfo;
    const bin = await this.ensureBinary();
    const info = await probeGpu(bin, this.childEnv);
    this.gpuInfo = info;
    return info;
  }

  /**
   * Load transcription model `id` now (as dictation starts), so the transcription after the recording does not
   * wait for it. Only on This machine; never fails (a failure shows when the audio is sent).
   */
  preload(id: string, language?: string): void {
    if (this.remote()) return;
    try {
      this.binary();
    } catch {
      return;
    }
    const lang = language && language !== "auto" ? language : undefined;
    this.worker.load(id, lang);
  }

  /** End the transcription worker, giving back the memory of the model it holds. */
  close(): void {
    this.worker.close();
  }

  private binaryOpts() {
    return {
      device: this.device,
      ...(this.gpuInfo?.target ? { gpuTarget: this.gpuInfo.target } : {}),
    };
  }

  /** The binary's path; throws why there is none. */
  binary(): string {
    const b = this.locate ? this.locate() : findBinary(this.env, this.binaryOpts());
    if (!b.ok) throw new LocalModelsError(b.reason);
    return b.path;
  }

  /** Ensure the binary is available on disk (downloading from the release manifest if needed). */
  async ensureBinary(): Promise<string> {
    const b = this.locate ? this.locate() : await ensureBinary(this.env, this.binaryOpts());
    if (!b.ok) throw new LocalModelsError(b.reason);
    return b.path;
  }

  private get childEnv(): NodeJS.ProcessEnv {
    return childEnv(this.env);
  }

  /** The catalogue, of one kind when given, with each model's state. */
  async list(kind?: ModelKind): Promise<LocalModel[]> {
    const remote = this.remote();
    const all = remote
      ? (await remote.list()).flatMap((v) => toModel(v) ?? [])
      : await listModels(await this.ensureBinary(), this.childEnv);
    return kind ? all.filter((m) => m.kind === kind) : all;
  }

  /** Download a model: into this machine's cache, or the Remote machine's while its models are the ones used. Each call runs independently (its own process), so downloads of different models proceed at once. */
  download(id: string, options: Omit<DownloadOptions, "env"> = {}): Download {
    const remote = this.remote();
    if (remote) {
      if (!remote.download) throw new LocalModelsError(remoteOnly("download", id));
      return remote.download(id, options);
    }
    const existing = this.locate ? this.locate() : findBinary(this.env);
    if (existing.ok) return downloadModel(existing.path, id, { ...options, env: this.childEnv });
    let inner: Download | undefined;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      inner?.cancel();
    };
    const result = this.ensureBinary().then((bin) => {
      if (cancelled) return { status: "stopped" as const, done: 0, total: 0 };
      inner = downloadModel(bin, id, { ...options, env: this.childEnv });
      return inner.result;
    });
    return { result, cancel };
  }

  /** Delete a model, here or on the Remote machine as `download`; resolves to the bytes freed. */
  async delete(id: string): Promise<number> {
    const remote = this.remote();
    if (remote) {
      if (!remote.delete) throw new LocalModelsError(remoteOnly("delete", id));
      return remote.delete(id);
    }
    return deleteModel(await this.ensureBinary(), id, this.childEnv);
  }

  /** Transcribe an audio file (WAV or MP3) with the downloaded model `id`. */
  async transcribeFile(id: string, file: string, signal?: AbortSignal, language?: string): Promise<string> {
    const ext = extname(file).slice(1).toLowerCase();
    if (!LOCAL_AUDIO.includes(ext)) {
      throw new LocalModelsError(
        `local models transcribe ${LOCAL_AUDIO.join(" and ")} files, not ${ext || "this file"}`,
      );
    }
    const remote = this.remote();
    const lang = language && language !== "auto" ? language : undefined;
    if (remote) return remote.transcribe(id, readFileSync(file), ext as "wav" | "mp3", signal, lang);
    await this.ensureBinary();
    return this.worker.transcribe(id, file, lang, signal);
  }

  /** Transcribe audio held in memory (a dictation recording), through a private temporary file. */
  async transcribe(
    id: string,
    audio: Buffer,
    format: string,
    signal?: AbortSignal,
    language?: string,
  ): Promise<string> {
    if (!LOCAL_AUDIO.includes(format)) {
      throw new LocalModelsError(`local models transcribe ${LOCAL_AUDIO.join(" and ")} audio, not ${format}`);
    }
    const remote = this.remote();
    const lang = language && language !== "auto" ? language : undefined;
    if (remote) return remote.transcribe(id, audio, format as "wav" | "mp3", signal, lang);
    const dir = mkdtempSync(join(tmpdir(), "pi-speech-local-"));
    try {
      const file = join(dir, `audio.${format}`);
      writeFileSync(file, audio, { mode: 0o600 });
      await this.ensureBinary();
      return await this.worker.transcribe(id, file, lang, signal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
