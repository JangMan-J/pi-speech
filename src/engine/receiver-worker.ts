/**
 * Shared persistent `--serve` worker lifecycle for `pi-speech-receiver` (`transcribe --serve` and
 * `speak --serve`): lazy spawn, serialized request queue, 10-minute idle shutdown, stderr tailing, and
 * clean restart after exit or abort.
 */

import { type ChildProcess, spawn } from "node:child_process";

/** How long a worker, and the model in it, stays after its last request: ten minutes. */
export const WORKER_IDLE_MS = 10 * 60 * 1000;

export interface WorkerHooks {
  onData(chunk: Buffer): void;
  onStop(err: Error): void;
}

export class ReceiverWorker {
  private child?: ChildProcess;
  private idle?: ReturnType<typeof setTimeout>;
  private stderr = "";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly binary: () => string,
    private readonly args: readonly string[],
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly label: string,
    private readonly makeError: (message: string) => Error,
    private readonly hooks: WorkerHooks,
    private readonly idleMs = WORKER_IDLE_MS,
  ) {}

  get running(): boolean {
    return this.child !== undefined;
  }

  /** Serialize an operation behind earlier turns on this worker. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /** Ensure the worker process is running and write one JSON line to its stdin. */
  send(line: string): void {
    this.clearIdle();
    const child = this.child ?? this.start();
    child.stdin?.write(line);
  }

  /** Write a line only if the worker is currently running (e.g. a cancel frame). */
  writeIfRunning(line: string): void {
    this.child?.stdin?.write(line);
  }

  /** Start or reset the idle shutdown timer once no turn is active. */
  markIdle(): void {
    this.clearIdle();
    if (!this.child) return;
    this.idle = setTimeout(() => this.close(), this.idleMs);
    this.idle.unref?.();
  }

  clearIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
  }

  /** End the process, failing any active turn. */
  close(): void {
    this.stop(this.makeError(`the ${this.label} worker was closed`));
  }

  /** Stop the process with `err` (killing it unless `kill` is false). */
  stop(err: Error, kill = true): void {
    const child = this.child;
    this.child = undefined;
    this.clearIdle();
    if (kill && child && child.exitCode === null) child.kill();
    this.hooks.onStop(err);
  }

  private start(): ChildProcess {
    const binary = this.binary();
    const child = spawn(binary, [...this.args], {
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
    child.stdout?.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      this.hooks.onData(chunk);
    });
    const ended = (why: string) => {
      if (this.child !== child) return;
      const last = this.stderr
        .trim()
        .split("\n")
        .at(-1)
        ?.replace(/^pi-speech-receiver: /, "");
      this.stop(this.makeError(last || why), false);
    };
    child.once("error", (e) => ended(`cannot run ${binary}: ${e.message}`));
    child.once("exit", (code, sig) => ended(`the ${this.label} worker ended (${sig ?? code})`));
    return child;
  }
}

export class TranscribeWorkerError extends Error {}

interface Pending {
  resolve(reply: Record<string, unknown>): void;
  reject(err: Error): void;
}

/**
 * A running `pi-speech-receiver transcribe --serve`: keeps the last transcription model loaded across calls.
 */
export class TranscribeWorker {
  private readonly worker: ReceiverWorker;
  private pending: Pending[] = [];
  private lineBuf = "";

  constructor(binary: () => string, env: () => NodeJS.ProcessEnv, idleMs = WORKER_IDLE_MS) {
    this.worker = new ReceiverWorker(
      binary,
      ["transcribe", "--serve"],
      env,
      "transcription",
      (msg) => new TranscribeWorkerError(msg),
      {
        onData: (chunk) => this.onData(chunk),
        onStop: (err) => {
          this.lineBuf = "";
          for (const p of this.pending.splice(0)) p.reject(err);
        },
      },
      idleMs,
    );
  }

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
    this.worker.close();
  }

  private request(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.worker.enqueue(() => this.send(body, signal));
  }

  private send(body: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const onAbort = () => this.worker.stop(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        signal?.removeEventListener("abort", onAbort);
        if (this.pending.length === 0) this.worker.markIdle();
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
      try {
        this.worker.send(`${JSON.stringify(body)}\n`);
      } catch (err) {
        this.pending.pop()?.reject(err instanceof Error ? err : new TranscribeWorkerError(String(err)));
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.lineBuf += chunk.toString("utf8");
    let nl = this.lineBuf.indexOf("\n");
    while (nl >= 0) {
      const line = this.lineBuf.slice(0, nl).replace(/\r$/, "");
      this.lineBuf = this.lineBuf.slice(nl + 1);
      nl = this.lineBuf.indexOf("\n");
      let reply: Record<string, unknown>;
      try {
        reply = JSON.parse(line);
      } catch {
        continue;
      }
      this.pending.shift()?.resolve(reply);
    }
  }
}
