/**
 * A running `pi-speech-receiver transcribe --serve`: it keeps the last model it used loaded, so that only the
 * first transcription with a model pays for loading it (seconds for the larger ones), and a model can be loaded
 * while the user is still speaking. Requests go one at a time, in order; each is one JSON line, answered by one.
 *
 * The process starts on the first request and ends after `idleMs` without one (giving the model's memory
 * back), when a request is aborted (the model cannot be stopped midway; the next request starts a new process),
 * or on `close()`. One that dies is started again by the next request.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class TranscribeWorkerError extends Error {}

interface Pending {
  resolve(reply: Record<string, unknown>): void;
  reject(err: Error): void;
}

/** How long the worker, and the model in it, stays after its last request: ten minutes. */
export const WORKER_IDLE_MS = 10 * 60 * 1000;

export class TranscribeWorker {
  private child?: ChildProcess;
  private pending: Pending[] = [];
  /** The requests in order: each waits for the one before. */
  private queue: Promise<unknown> = Promise.resolve();
  private idle?: ReturnType<typeof setTimeout>;
  private stderr = "";

  constructor(
    private readonly binary: () => string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly idleMs = WORKER_IDLE_MS,
  ) {}

  /** Load `model` now, before its audio is there. Never rejects: a failure shows when the audio is sent. */
  load(model: string, language?: string): void {
    void this.request({ model, language, load: true }).catch(() => {});
  }

  /** The text spoken in `file` (WAV or MP3). */
  async transcribe(model: string, file: string, language?: string, signal?: AbortSignal): Promise<string> {
    const reply = await this.request({ model, audio: file, language }, signal);
    return typeof reply.text === "string" ? reply.text.trim() : "";
  }

  /** End the process, failing what waits. */
  close(): void {
    this.stop(new TranscribeWorkerError("the transcription worker was closed"));
  }

  private request(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const run = this.queue.then(() => this.send(body, signal));
    this.queue = run.catch(() => {});
    return run;
  }

  private send(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    if (this.idle) clearTimeout(this.idle);
    const child = this.child ?? this.start();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const onAbort = () => this.stop(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        if (this.pending.length === 0 && this.child) {
          this.idle = setTimeout(() => this.close(), this.idleMs);
          this.idle.unref?.();
        }
      };
      this.pending.push({
        resolve: (reply) => {
          done();
          if (typeof reply.error === "string") reject(new TranscribeWorkerError(reply.error));
          else resolve(reply);
        },
        reject: (err) => {
          done();
          reject(err);
        },
      });
      child.stdin?.write(`${JSON.stringify(body)}\n`);
    });
  }

  private start(): ChildProcess {
    const binary = this.binary();
    const child = spawn(binary, ["transcribe", "--serve"], {
      env: this.env(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.stderr = "";
    child.stdin?.on("error", () => {});
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (s: string) => {
      this.stderr = (this.stderr + s).slice(-4000);
    });
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (line) => {
      if (this.child !== child) return;
      let reply: Record<string, unknown>;
      try {
        reply = JSON.parse(line);
      } catch {
        return; // not an answer
      }
      this.pending.shift()?.resolve(reply);
    });
    const ended = (why: string) => {
      if (this.child !== child) return;
      const last = this.stderr
        .trim()
        .split("\n")
        .at(-1)
        ?.replace(/^pi-speech-receiver: /, "");
      this.stop(new TranscribeWorkerError(last || why), false);
    };
    child.once("error", (e) => ended(`cannot run ${binary}: ${e.message}`));
    child.once("exit", (code, sig) => ended(`the transcription worker ended (${sig ?? code})`));
    return child;
  }

  private stop(err: Error, kill = true): void {
    const child = this.child;
    this.child = undefined;
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    if (kill && child && child.exitCode === null) child.kill();
    for (const p of this.pending.splice(0)) p.reject(err);
  }
}
