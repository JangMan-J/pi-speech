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
import type { BridgeModels } from "../bridge/index";
import { type BinaryChoice, findBinary } from "./binary";
import { childEnv, type Env } from "./env";
import { TranscribeWorker } from "./transcribe-worker";

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
  /** Where the model is, or will be once downloaded. */
  path: string;
}

/**
 * A step of a download, in order: progress (repeated), verifying, unpacking; then, for a voice that needs a lexicon
 * not yet in the cache (an English Piper voice), progress of that file, named by `file`.
 */
export type DownloadProgress =
  | { phase: "progress"; done: number; total: number; file?: string }
  | { phase: "verifying" }
  | { phase: "unpacking" };

export type DownloadResult =
  /** The model is in the cache at `path`. */
  | { status: "done"; path: string }
  /** Stopped on request; `done` bytes are kept for the next download. */
  | { status: "stopped"; done: number; total: number };

export interface DownloadOptions {
  /** Called for each step, one at a time: the next waits for the promise the last returned. */
  onProgress?: (progress: DownloadProgress) => void | Promise<void>;
  /** Aborting stops the download, as `cancel` does. */
  signal?: AbortSignal;
  /** The binary's environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
}

export interface Download {
  /** Settles once the binary has exited and every progress callback has finished. Rejects on an error. */
  readonly result: Promise<DownloadResult>;
  /** Stop the download, leaving what has arrived to be resumed. */
  cancel(): void;
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
  const { id, kind, name, languages, size, downloaded, partial, path, lexicon } = v;
  const lex = lexicon && typeof lexicon === "object" ? (lexicon as Record<string, unknown>) : undefined;
  if (typeof id !== "string" || (kind !== "transcription" && kind !== "speech")) return undefined;
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

/** What a download's event lines said: how it ended, and how far it got. */
export interface FollowedDownload {
  last?: Record<string, unknown>;
  done: number;
  total: number;
}

/**
 * Follow a download's event lines (`models download` prints them, and the receiver streams the same for the
 * Remote machine's), passing its progress on in order; resolves once the lines end and every callback has.
 */
export async function followDownload(
  lines: AsyncIterable<string>,
  onProgress?: (p: DownloadProgress) => void | Promise<void>,
): Promise<FollowedDownload> {
  let delivered: Promise<void> = Promise.resolve();
  let callbackError: unknown;
  const deliver = (p: DownloadProgress) => {
    if (!onProgress) return;
    delivered = delivered.then(async () => {
      if (callbackError !== undefined) return;
      try {
        await onProgress(p);
      } catch (e) {
        callbackError = e;
      }
    });
  };
  const out: FollowedDownload = { done: 0, total: 0 };
  for await (const line of lines) {
    const v = parse(line);
    if (!v) continue;
    if (v.event === "progress" && typeof v.done === "number" && typeof v.total === "number") {
      out.done = v.done;
      out.total = v.total;
      const file = typeof v.file === "string" && v.file ? v.file : undefined;
      deliver({ phase: "progress", done: out.done, total: out.total, ...(file ? { file } : {}) });
    } else if (v.event === "verifying" || v.event === "unpacking") {
      deliver({ phase: v.event });
    } else if (v.event === "done" || v.event === "stopped" || v.event === "error") {
      out.last = v;
    }
  }
  await delivered;
  if (callbackError !== undefined) throw callbackError;
  return out;
}

/** How a followed download ended: done, stopped (asked to, or it said so), else the error `fail` makes. */
export function downloadResult(
  f: FollowedDownload,
  stopping: boolean,
  exitedOk: boolean,
  fail: () => Error,
): DownloadResult {
  const last = f.last;
  if (last?.event === "done" && typeof last.path === "string" && exitedOk) return { status: "done", path: last.path };
  if (last?.event === "stopped" || (stopping && last?.event !== "error")) {
    const kept = typeof last?.done === "number" ? last.done : f.done;
    const of = typeof last?.total === "number" ? last.total : f.total;
    return { status: "stopped", done: kept, total: of };
  }
  throw fail();
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
  /** The catalogue id of the GPU runtime that fits, or null. */
  runtime: string | null;
  downloaded: boolean;
  /** The GPU runtime's library directory. */
  lib: string | null;
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
    return JSON.parse(out.trim().split("\n").at(-1) ?? "") as GpuInfo;
  } catch {
    // An older receiver without `gpu`.
    return {
      driver: false,
      cuda: null,
      cudnn: false,
      runtime: null,
      downloaded: false,
      lib: null,
      usable: false,
      why: "this pi-speech-receiver cannot run models on a GPU",
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
  /** The Remote machine's models when they are the ones to use; set by the engine. */
  remote: () => BridgeModels | undefined = () => undefined;

  /** The running `transcribe --serve`, which keeps the last model loaded between transcriptions. */
  private readonly worker: TranscribeWorker;
  /** Where local models run; see `setDevice`. */
  private device: "cpu" | "gpu" = "cpu";
  /** What the worker runs with beyond the usual environment (the GPU runtime's), as it was started. */
  private deviceEnv: NodeJS.ProcessEnv = {};
  /** The last GPU probe, while it said usable (a usable GPU stays so; an unusable one is asked again). */
  private gpuInfo?: GpuInfo;

  constructor(
    private readonly env: Env,
    private readonly locate: () => BinaryChoice = () => findBinary(env),
  ) {
    this.worker = new TranscribeWorker(
      () => this.binary(),
      () => ({ ...this.childEnv, ...this.deviceEnv }),
    );
  }

  /** Run on-device models (transcription and speech) on the CPU or an NVIDIA GPU from their next run on. */
  setDevice(device: "cpu" | "gpu"): void {
    if (device === this.device) return;
    this.device = device;
    this.gpuInfo = undefined;
  }

  /**
   * What this machine has for the GPU (`pi-speech-receiver gpu`): the driver, CUDA and cuDNN, and the GPU runtime
   * that fits them, whether it is downloaded, and why the GPU cannot be used yet.
   */
  async gpu(): Promise<GpuInfo> {
    if (this.gpuInfo?.usable) return this.gpuInfo;
    const info = await probeGpu(this.binary(), this.childEnv);
    if (info.usable) this.gpuInfo = info;
    return info;
  }

  /**
   * What a model process needs in its environment, beyond the usual, to run on the chosen device: on a usable GPU,
   * the GPU runtime first on the library path and the CUDA provider; else nothing (the CPU).
   */
  async deviceEnvironment(): Promise<NodeJS.ProcessEnv> {
    if (this.device !== "gpu") return {};
    const info = await this.gpu().catch(() => undefined);
    if (!info?.usable || !info.lib) return {};
    const prior = this.childEnv.LD_LIBRARY_PATH;
    return { LD_LIBRARY_PATH: prior ? `${info.lib}:${prior}` : info.lib, PI_SPEECH_PROVIDER: "cuda" };
  }

  /** The environment the chosen device needs; restarts the worker when it changes. GPU unusable: the CPU. */
  private async applyDevice(): Promise<void> {
    const env = await this.deviceEnvironment();
    if (JSON.stringify(env) !== JSON.stringify(this.deviceEnv)) {
      this.worker.close();
      this.deviceEnv = env;
    }
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
    void this.applyDevice().then(() => this.worker.load(id, lang));
  }

  /** End the transcription worker, giving back the memory of the model it holds. */
  close(): void {
    this.worker.close();
  }

  /** The binary's path; throws why there is none. */
  binary(): string {
    const b = this.locate();
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
      : await listModels(this.binary(), this.childEnv);
    return kind ? all.filter((m) => m.kind === kind) : all;
  }

  /** Download a model: into this machine's cache, or the Remote machine's while its models are the ones used. */
  download(id: string, options: Omit<DownloadOptions, "env"> = {}): Download {
    const remote = this.remote();
    if (remote) {
      if (!remote.download) throw new LocalModelsError(remoteOnly("download", id));
      return remote.download(id, options);
    }
    return downloadModel(this.binary(), id, { ...options, env: this.childEnv });
  }

  /** Delete a model, here or on the Remote machine as `download`; resolves to the bytes freed. */
  delete(id: string): Promise<number> {
    const remote = this.remote();
    if (remote) {
      if (!remote.delete) return Promise.reject(new LocalModelsError(remoteOnly("delete", id)));
      return remote.delete(id);
    }
    return deleteModel(this.binary(), id, this.childEnv);
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
    this.binary();
    await this.applyDevice();
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
      this.binary();
      await this.applyDevice();
      return await this.worker.transcribe(id, file, lang, signal);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
