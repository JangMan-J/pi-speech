/**
 * Local speech: the bundled binary's `speak <id> [--voice <v>]` speaks a text with an on-device voice model
 * (Kokoro, Piper) on This machine. It writes raw 16-bit mono PCM to its standard output while it generates the
 * audio, sentence by sentence, and JSON lines on its standard error: `{"event":"format","rate","channels"}` before
 * any audio, then `{"event":"done"}`, `{"event":"error","message"}` or `{"event":"stopped"}` (protocol/bridge.md,
 * "Subcommand notes: speak"). The audio is an AudioStream, played as a Stream. Nothing goes over the network.
 * Aborting kills the process, which stops at once. `speak <id> --list-voices` names the model's voices.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ChunkBuffer, clipOf } from "./audio-stream";
import { type LocalModel, listModels } from "./local-models";
import type { ModelBackend } from "./model-backend";
import type { AudioStream, SpeechProvider, SynthesisRequest, SynthesizedAudio } from "./provider";
import { ReceiverWorker, WORKER_IDLE_MS } from "./receiver-worker";

/** Catalogue languages describe the voice; only models with `languageMode: "selectable"` (Supertonic) take a language. */
export function localSpeechLanguage(
  model: Pick<LocalModel, "id" | "languages" | "languageMode"> | undefined,
  requested: string | undefined,
): string | undefined {
  const selectable = model?.languageMode ? model.languageMode === "selectable" : model?.id.startsWith("supertonic");
  return selectable && requested && requested !== "auto" && model?.languages.includes(requested)
    ? requested
    : undefined;
}

export class LocalSpeechError extends Error {
  override name = "LocalSpeechError";
}

export interface LocalSpeechOptions {
  /** A voice name or number of the model; the model's first voice when unset or empty. */
  voice?: string;
  /** 1 is normal; 0.25 to 4. */
  speed?: number;
  /** Aborting kills the binary. */
  signal?: AbortSignal;
  /** The binary's environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
}

/** The arguments of `speak`. */
export function speakArgs(id: string, options: Pick<LocalSpeechOptions, "voice" | "speed"> = {}): string[] {
  return [
    "speak",
    id,
    ...(options.voice ? ["--voice", options.voice] : []),
    ...(options.speed !== undefined && options.speed !== 1 ? ["--speed", String(options.speed)] : []),
  ];
}

function parse(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) && typeof v.event === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A voice of a local speech model, as `speak <id> --list-voices` prints it. */
export interface LocalVoice {
  name: string;
  number: number;
}

/**
 * The voices of the downloaded voice model `id`, in the model's order (the first is its default): Kokoro v1.1 has
 * 103, a Piper voice one. Rejects with the binary's message (a model not downloaded).
 */
export async function listVoices(
  binary: string,
  id: string,
  options: Pick<LocalSpeechOptions, "env" | "signal"> = {},
): Promise<LocalVoice[]> {
  options.signal?.throwIfAborted();
  const child = spawn(binary, ["speak", id, "--list-voices"], {
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    stdout += d;
  });
  child.stderr?.on("data", (d: string) => {
    stderr += d;
  });
  const onAbort = () => kill(child);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", (e) => reject(new LocalSpeechError(`cannot run ${binary}: ${e.message}`)));
      child.once("close", (c) => resolve(c));
    });
    options.signal?.throwIfAborted();
    if (code !== 0) {
      const lines = stderr.trim().split("\n");
      const event = lines
        .map((l) => parse(l.trim()))
        .filter((v) => v?.event === "error")
        .at(-1);
      const why =
        typeof event?.message === "string" ? event.message : lines.at(-1)?.replace(/^pi-speech-receiver: /, "");
      throw new LocalSpeechError(why || `the speak command exited with ${code}`);
    }
    const voices: LocalVoice[] = [];
    for (const line of stdout.split("\n")) {
      try {
        const v = JSON.parse(line);
        if (v && typeof v.name === "string" && typeof v.number === "number")
          voices.push({ name: v.name, number: v.number });
      } catch {
        /* not a voice line */
      }
    }
    return voices;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Stop the binary unless it has exited. */
function kill(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill();
}

/**
 * Speak `text` with the downloaded voice model `id` through `binary`. Resolves once the binary has said the audio's
 * format (the model is loaded); rejects with its message when it fails before (a model not downloaded, an unknown
 * voice). The chunks are the PCM as it is generated; reading them throws the binary's message when it fails
 * midway. Aborting, or leaving the chunks before their end, kills the binary.
 */
export function speakLocal(
  binary: string,
  id: string,
  text: string,
  options: LocalSpeechOptions = {},
): Promise<AudioStream> {
  const { signal } = options;
  if (signal?.aborted) return Promise.reject(signal.reason);
  const child = spawn(binary, speakArgs(id, options), {
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const onAbort = () => kill(child);
  signal?.addEventListener("abort", onAbort, { once: true });
  // A binary that fails before it reads the text closes its input.
  child.stdin?.on("error", () => {});
  child.stdin?.end(text);

  let message: string | undefined;
  let outcome: "done" | "stopped" | undefined;
  const noise: string[] = [];
  let onFormat!: (rate: number, channels: number) => void;
  const format = new Promise<{ rate: number; channels: number }>((resolve) => {
    onFormat = (rate, channels) => resolve({ rate, channels });
  });
  const lines = createInterface({ input: child.stderr!, crlfDelay: Number.POSITIVE_INFINITY });
  lines.on("line", (raw) => {
    const line = raw.trim();
    const v = parse(line);
    if (!v) {
      if (line) noise.push(line);
      return;
    }
    if (v.event === "format" && typeof v.rate === "number" && v.rate > 0) {
      onFormat(v.rate, typeof v.channels === "number" && v.channels > 0 ? v.channels : 1);
    } else if (v.event === "error") {
      message = typeof v.message === "string" ? v.message : "the speak command failed";
    } else if (v.event === "done" || v.event === "stopped") {
      outcome = v.event;
    }
  });
  const stderrDone = new Promise<void>((resolve) => lines.once("close", resolve));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", (e) => reject(new LocalSpeechError(`cannot run ${binary}: ${e.message}`)));
    // After every line of standard error: the last event decides.
    child.once("close", (code) => void stderrDone.then(() => resolve(code)));
  });
  exited.catch(() => {});
  const failure = (code: number | null) => {
    signal?.throwIfAborted();
    const why = message ?? noise.at(-1)?.replace(/^pi-speech-receiver: /, "");
    return new LocalSpeechError(why || `the speak command exited with ${code}`);
  };
  const cleanup = () => {
    kill(child);
    signal?.removeEventListener("abort", onAbort);
  };

  async function* chunks(): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of child.stdout!) yield chunk as Buffer;
      const code = await exited;
      if (code !== 0 || outcome !== "done") throw failure(code);
    } finally {
      cleanup();
    }
  }

  return Promise.race([
    format,
    exited.then((code): never => {
      throw failure(code);
    }),
  ]).then(
    ({ rate, channels }) => ({ format: { codec: "pcm" as const, rate, channels }, chunks: chunks() }),
    (err) => {
      cleanup();
      throw err;
    },
  );
}

/** How long the speech worker, and the voice model in it, stays after its last request: ten minutes. */
export const SPEECH_WORKER_IDLE_MS = WORKER_IDLE_MS;

interface Turn {
  id: number;
  onEvent(ev: Record<string, unknown>): void;
  onAudio(chunk: Buffer): void;
  /** The worker went away. */
  onGone(err: Error): void;
}

/**
 * A running `pi-speech-receiver speak --serve`: it keeps the last voice model loaded, so that only the first
 * utterance pays for loading it (about 2 s). Utterances go one at a time, in order; each answers with a `format`
 * event, its audio as it is generated, and `done`, `stopped` or `error`. Stopping one (abort, or leaving its chunks
 * early) sends a cancel and keeps the process and the model. The process ends after `idleMs` without a request,
 * on `close()`, or when it fails; the next request starts another.
 */
export class SpeechWorker {
  private readonly worker: ReceiverWorker;
  private nextId = 1;
  private turn?: Turn;
  private buffer = Buffer.alloc(0);

  constructor(binary: () => string, env: () => NodeJS.ProcessEnv, idleMs = SPEECH_WORKER_IDLE_MS) {
    this.worker = new ReceiverWorker(
      binary,
      ["speak", "--serve"],
      env,
      "speech",
      (msg) => new LocalSpeechError(msg),
      {
        onData: (data) => this.onData(data),
        onStop: (err) => {
          this.buffer = Buffer.alloc(0);
          const turn = this.turn;
          this.turn = undefined;
          turn?.onGone(err);
        },
      },
      idleMs,
    );
  }

  /** Load voice model `id` now. Never rejects. */
  load(id: string): void {
    void this.worker.enqueue(
      () =>
        new Promise<void>((resolve) => {
          this.request(
            { model: id, load: true },
            {
              onEvent: (ev) => {
                if (ev.event === "loaded" || ev.event === "error") resolve();
              },
              onAudio: () => {},
              onGone: () => resolve(),
            },
          );
        }),
    );
  }

  /** Speak `text` with voice model `id`; as `speakLocal`, but through the running worker. */
  speak(id: string, text: string, options: LocalSpeechOptions & { lang?: string } = {}): Promise<AudioStream> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(signal.reason);
    // The turn ends (and the next may start) when this utterance is done, stopped or failed.
    let release!: () => void;
    const ended = new Promise<void>((r) => {
      release = r;
    });
    const started = this.worker.enqueue(() => this.start(id, text, options, release));
    void started.then(() => ended).catch(() => {});
    return started;
  }

  /** End the process; what is being spoken fails. */
  close(): void {
    this.worker.close();
  }

  private start(
    id: string,
    text: string,
    options: LocalSpeechOptions & { lang?: string },
    release: () => void,
  ): Promise<AudioStream> {
    const { signal } = options;
    if (signal?.aborted) {
      release();
      return Promise.reject(signal.reason);
    }
    const chunks: Buffer[] = [];
    let wake: (() => void) | undefined;
    let end: { error?: Error } | undefined;
    let id_ = 0;
    const finish = (error?: Error) => {
      if (end) return;
      end = { error };
      signal?.removeEventListener("abort", onAbort);
      release();
      wake?.();
    };
    const cancel = () => {
      if (!end) this.worker.writeIfRunning(`${JSON.stringify({ cancel: id_ })}\n`);
    };
    const onAbort = () => cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    return new Promise<AudioStream>((resolve, reject) => {
      let formatted = false;
      id_ = this.request(
        {
          model: id,
          text,
          ...(options.voice ? { voice: options.voice } : {}),
          ...(options.speed !== undefined && options.speed !== 1 ? { speed: options.speed } : {}),
          ...(options.lang ? { lang: options.lang } : {}),
        },
        {
          onEvent: (ev) => {
            if (ev.event === "format" && typeof ev.rate === "number" && ev.rate > 0) {
              formatted = true;
              const channels = typeof ev.channels === "number" && ev.channels > 0 ? ev.channels : 1;
              resolve({ format: { codec: "pcm", rate: ev.rate, channels }, chunks: read() });
            } else if (ev.event === "done") finish();
            else if (ev.event === "stopped") finish(signal?.aborted ? signal.reason : new LocalSpeechError("stopped"));
            else if (ev.event === "error") {
              const err = new LocalSpeechError(typeof ev.message === "string" ? ev.message : "speaking failed");
              finish(err);
              if (!formatted) reject(signal?.aborted ? signal.reason : err);
            }
          },
          onAudio: (chunk) => {
            chunks.push(chunk);
            wake?.();
          },
          onGone: (err) => {
            finish(err);
            if (!formatted) reject(signal?.aborted ? signal.reason : err);
          },
        },
      );
    });

    async function* read(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) {
          const chunk = chunks.shift();
          if (chunk) {
            yield chunk;
            continue;
          }
          if (end) {
            if (end.error) throw end.error;
            return;
          }
          await new Promise<void>((r) => {
            wake = r;
          });
          wake = undefined;
        }
      } finally {
        // Left early (or aborted): stop it there.
        cancel();
      }
    }
  }

  /** Send a request, answered through `turn`; returns its id. */
  private request(body: Record<string, unknown>, turn: Omit<Turn, "id">): number {
    const id = this.nextId++;
    const wrapped: Turn = {
      id,
      ...turn,
      onEvent: (ev) => {
        turn.onEvent(ev);
        if (["done", "stopped", "error", "loaded"].includes(String(ev.event))) {
          this.turn = undefined;
          this.worker.markIdle();
        }
      },
    };
    this.turn = wrapped;
    try {
      this.worker.send(`${JSON.stringify({ id, ...body })}\n`);
    } catch (e) {
      this.turn = undefined;
      turn.onGone(e instanceof Error ? e : new LocalSpeechError(String(e)));
    }
    return id;
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 5) {
      const n = this.buffer.readUInt32LE(1);
      if (this.buffer.length < 5 + n) break;
      const kind = this.buffer[0];
      const body = this.buffer.subarray(5, 5 + n);
      this.buffer = this.buffer.subarray(5 + n);
      const turn = this.turn;
      if (kind === 0x41 /* A */) turn?.onAudio(Buffer.from(body));
      else if (kind === 0x4a /* J */) {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(body.toString("utf8"));
        } catch {
          continue;
        }
        if (turn && (ev.id === undefined || ev.id === turn.id)) turn.onEvent(ev);
      }
    }
  }
}

/**
 * Local speech as a speech provider: the model is a downloaded voice model's id, the voice a voice name or number
 * of it (empty: its first). It needs no credential and transcribes nothing.
 */
export class LocalSpeechProvider implements SpeechProvider {
  readonly name = "Local speech";

  /** The running `speak --serve`, which keeps the last voice model loaded between utterances. */
  private readonly worker: SpeechWorker;
  /** The catalogue's language lists, fetched once rather than for every utterance. */
  private catalogue?: Promise<LocalModel[]>;

  constructor(
    /** The binary's path; throws why there is none. */
    private readonly binary: () => string,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
    /** The Remote machine's models when they run there (Run models on), else undefined. */
    private readonly remote: () => ModelBackend | undefined = () => undefined,
    /** Ensure the local binary is downloaded before calling `binary()`. */
    private readonly ensureBinary: () => Promise<string> = async () => binary(),
  ) {
    this.worker = new SpeechWorker(binary, env);
  }

  /** Load voice model `id` now, on This machine, so the next utterance does not wait for it. */
  preload(id: string): void {
    if (this.remote()) return;
    try {
      this.binary();
    } catch {
      return;
    }
    this.worker.load(id);
  }

  /** End the speech worker, giving back the memory of the voice model it holds. */
  close(): void {
    this.worker.close();
  }

  async ensureCredential(): Promise<void> {}

  /** The voices of the downloaded voice model `id`. */
  async voices(id: string, signal?: AbortSignal): Promise<LocalVoice[]> {
    const remote = this.remote();
    if (remote) return remote.voices(id, signal);
    return listVoices(await this.ensureBinary(), id, { signal, env: this.env() });
  }

  private languages(): Promise<LocalModel[]> {
    // Speaking still works with a receiver whose catalogue cannot be read; retry on the next call after a failure.
    this.catalogue ??= this.ensureBinary()
      .then((bin) => listModels(bin, this.env()))
      .catch(() => {
        this.catalogue = undefined;
        return [];
      });
    return this.catalogue;
  }

  async synthesizeStream(req: SynthesisRequest): Promise<AudioStream> {
    const remote = this.remote();
    if (remote) {
      const remoteList = await remote.list().catch(() => []);
      const raw = remoteList.find((m) => m.id === req.model);
      const langs = Array.isArray(raw?.languages)
        ? raw.languages.filter((l): l is string => typeof l === "string")
        : [];
      const languageMode =
        raw?.language_mode === "selectable" || raw?.language_mode === "auto" || raw?.language_mode === "fixed"
          ? raw.language_mode
          : undefined;
      const lang = localSpeechLanguage({ id: req.model, languages: langs, languageMode }, req.language);
      return remote.speak(req.model, req.text, { voice: req.voice, signal: req.signal, ...(lang ? { lang } : {}) });
    }
    await this.ensureBinary();
    const lang = localSpeechLanguage(
      (await this.languages()).find((model) => model.id === req.model),
      req.language,
    );
    return this.worker.speak(req.model, req.text, { voice: req.voice, signal: req.signal, lang });
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesizedAudio> {
    const stream = await this.synthesizeStream(req);
    const kept = new ChunkBuffer();
    try {
      for await (const chunk of stream.chunks) kept.push(chunk);
    } finally {
      kept.end();
    }
    return clipOf(stream.format, kept.bytes(), this.name);
  }

  async transcribe(): Promise<string> {
    throw new LocalSpeechError("local speech does not transcribe");
  }
}
