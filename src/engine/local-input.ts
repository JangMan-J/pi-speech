/**
 * The "local" microphone: records this machine's microphone with a command-line recorder.
 * `PI_SPEECH_RECORDER`, when set, names an executable run as `<recorder> <output.wav>` that writes a WAV
 * and finishes it on SIGINT; otherwise the first available of pw-record, parecord, arecord, recording
 * mono 16 kHz 16-bit WAV. The recording lives in a private temporary directory that is removed as soon
 * as the audio is read or discarded.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AudioInput, Recording } from "./audio";
import { childEnv, type Env, findExecutable, overSsh } from "./env";
import { wavSeconds } from "./wav";

/** A recorder that exits sooner than this after starting has failed to start. */
export const START_WINDOW_MS = 500;
/** How long a recorder gets to finish its file after SIGINT before it is killed. */
export const STOP_GRACE_MS = 2000;
/** Less audio than this is an empty recording. */
export const MIN_SECONDS = 0.1;

const RECORDERS: ReadonlyArray<readonly [string, (file: string) => string[]]> = [
  ["pw-record", (f) => ["--rate", "16000", "--channels", "1", "--format", "s16", f]],
  ["parecord", (f) => ["--rate=16000", "--channels=1", "--format=s16le", "--file-format=wav", f]],
  ["arecord", (f) => ["-q", "-t", "wav", "-f", "S16_LE", "-r", "16000", "-c", "1", f]],
];

type RecorderChoice =
  | { ok: true; name: string; bin: string; args: (file: string) => string[] }
  | { ok: false; reason: string };

export function chooseRecorder(env: Env): RecorderChoice {
  const custom = env.PI_SPEECH_RECORDER;
  if (custom) {
    const bin = findExecutable(custom, env);
    if (!bin) return { ok: false, reason: `PI_SPEECH_RECORDER (${custom}) is not an executable` };
    return { ok: true, name: custom, bin, args: (f) => [f] };
  }
  for (const [name, args] of RECORDERS) {
    const bin = findExecutable(name, env);
    if (bin) return { ok: true, name, bin, args };
  }
  const names = RECORDERS.map(([n]) => n).join(", ");
  return { ok: false, reason: `no audio recorder found (set PI_SPEECH_RECORDER or install one of ${names})` };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Recorders still running when Pi exits are killed, so the microphone is never left open, and the
// recording directories still on disk are removed, so no audio outlives the process.
const live = new Set<ChildProcess>();
const dirs = new Set<string>();
let exitHook = false;
function track(child: ChildProcess, dir: string): void {
  live.add(child);
  dirs.add(dir);
  child.once("close", () => live.delete(child));
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => {
    for (const c of live) c.kill("SIGKILL");
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
}

function removeDir(dir: string): void {
  dirs.delete(dir);
  rmSync(dir, { recursive: true, force: true });
}

class LocalRecording implements Recording {
  private finished = false;
  private endedReason: string | undefined;
  readonly ended: Promise<string>;

  constructor(
    private readonly name: string,
    private readonly child: ChildProcess,
    private readonly closed: Promise<void>,
    private readonly dir: string,
    private readonly file: string,
    private readonly errorTail: () => string,
  ) {
    // The recorder ending before stop() or cancel() is reported at once, and its audio is dropped.
    this.ended = new Promise<string>((resolve) => {
      void closed.then(() => {
        if (this.finished) return;
        const tail = this.errorTail();
        this.endedReason = `${this.name} stopped unexpectedly${tail ? `: ${tail}` : ""}`;
        this.cleanup();
        resolve(this.endedReason);
      });
    });
  }

  private get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  private async halt(): Promise<void> {
    if (this.running) {
      this.child.kill("SIGINT");
      await Promise.race([this.closed, sleep(STOP_GRACE_MS)]);
      if (this.running) {
        this.child.kill("SIGKILL");
        await this.closed;
      }
    }
  }

  private cleanup(): void {
    removeDir(this.dir);
  }

  async stop(): Promise<{ audio: Buffer; format: "wav" }> {
    if (this.finished) throw new Error("the recording has already ended");
    this.finished = true;
    if (this.endedReason !== undefined) throw new Error(this.endedReason);
    const crashed = !this.running;
    try {
      await this.halt();
      const tail = this.errorTail();
      const detail = tail ? `: ${tail}` : "";
      let audio: Buffer;
      try {
        audio = readFileSync(this.file);
      } catch {
        throw new Error(`${this.name} ${crashed ? "stopped unexpectedly" : "wrote no recording"}${detail}`);
      }
      const seconds = wavSeconds(audio);
      if (seconds === undefined) throw new Error(`${this.name} did not write a readable WAV file${detail}`);
      if (crashed && this.child.exitCode !== 0) throw new Error(`${this.name} stopped unexpectedly${detail}`);
      if (seconds < MIN_SECONDS) throw new Error("the recording is empty (no audio was captured)");
      return { audio, format: "wav" };
    } finally {
      this.cleanup();
    }
  }

  async cancel(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    try {
      await this.halt();
    } finally {
      this.cleanup();
    }
  }
}

export class LocalInput implements AudioInput {
  readonly name = "local";

  constructor(private readonly env: Env) {}

  async start(): Promise<Recording> {
    if (overSsh(this.env) && this.env.PI_SPEECH_LOCAL_MIC !== "1") {
      throw new Error(
        "Pi is running over SSH, so the local microphone is this remote host's, not yours. " +
          "Use the playback bridge (/speech --bridge on, or --bridge auto) to record on your own machine, " +
          "or set PI_SPEECH_LOCAL_MIC=1 if this host's microphone is yours.",
      );
    }
    const choice = chooseRecorder(this.env);
    if (!choice.ok) throw new Error(choice.reason);
    const dir = mkdtempSync(join(tmpdir(), "pi-speech-rec-"));
    const file = join(dir, "dictation.wav");
    const fail = (message: string): never => {
      removeDir(dir);
      throw new Error(message);
    };

    let child: ChildProcess;
    try {
      child = spawn(choice.bin, choice.args(file), { stdio: ["ignore", "ignore", "pipe"], env: childEnv(this.env) });
    } catch (err) {
      return fail(`cannot start ${choice.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    track(child, dir);
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-2000);
    });
    const errorTail = () => stderr.trim().slice(-400);
    let spawnError: Error | undefined;
    child.on("error", (err) => {
      spawnError = err;
    });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    const early = await Promise.race([closed.then(() => true), sleep(START_WINDOW_MS).then(() => false)]);
    if (early || spawnError) {
      const detail = errorTail();
      const why = spawnError
        ? `cannot start ${choice.name}: ${spawnError.message}`
        : `${choice.name} exited right after starting (${child.signalCode ?? `code ${child.exitCode}`})`;
      return fail(detail ? `${why}: ${detail}` : why);
    }
    return new LocalRecording(choice.name, child, closed, dir, file, errorTail);
  }
}
