/**
 * Local speech: the bundled binary's `speak <id> [--voice <v>]` speaks a text with an on-device voice model
 * (Kokoro, Piper) on This machine. It writes raw 16-bit mono PCM to its standard output while it generates the
 * audio, sentence by sentence, and JSON lines on its standard error: `{"event":"format","rate","channels"}` before
 * any audio, then `{"event":"done"}`, `{"event":"error","message"}` or `{"event":"stopped"}` (protocol/bridge.md,
 * "Subcommand notes: speak"). The audio is an AudioStream, played as a Stream. Nothing goes over the network.
 * Aborting kills the process, which stops at once.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ChunkBuffer, clipOf } from "./audio-stream";
import type { AudioStream, SpeechProvider, SynthesisRequest, SynthesizedAudio } from "./provider";

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

/**
 * Local speech as a speech provider: the model is a downloaded voice model's id, the voice a voice name or number
 * of it (empty: its first). It needs no credential and transcribes nothing.
 */
export class LocalSpeechProvider implements SpeechProvider {
  readonly name = "Local speech";

  constructor(
    /** The binary's path; throws why there is none. */
    private readonly binary: () => string,
    private readonly env: () => NodeJS.ProcessEnv = () => process.env,
  ) {}

  async ensureCredential(): Promise<void> {}

  async synthesizeStream(req: SynthesisRequest): Promise<AudioStream> {
    return speakLocal(this.binary(), req.model, req.text, { voice: req.voice, signal: req.signal, env: this.env() });
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
