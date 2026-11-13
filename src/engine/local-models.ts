/**
 * Local speech models through the receiver binary's `models` commands: the catalogue with each model's state in
 * the per-user model cache, downloads with progress (stoppable, resumed by the next download), and deletes. The
 * binary's path is given by the caller; its output is one JSON object per line.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type ModelKind = "transcription" | "speech";

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
  /** Where the model is, or will be once downloaded. */
  path: string;
}

/** A step of a download, in order: progress (repeated), verifying, unpacking. */
export type DownloadProgress =
  | { phase: "progress"; done: number; total: number }
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
  const { id, kind, name, languages, size, downloaded, partial, path } = v;
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
    let delivered: Promise<void> = Promise.resolve();
    let callbackError: unknown;
    const deliver = (p: DownloadProgress) => {
      const cb = options.onProgress;
      if (!cb) return;
      delivered = delivered.then(async () => {
        if (callbackError !== undefined) return;
        try {
          await cb(p);
        } catch (e) {
          callbackError = e;
        }
      });
    };
    let last: Record<string, unknown> | undefined;
    let done = 0;
    let total = 0;
    try {
      for await (const line of r.lines) {
        const v = parse(line);
        if (!v) continue;
        if (v.event === "progress" && typeof v.done === "number" && typeof v.total === "number") {
          done = v.done;
          total = v.total;
          deliver({ phase: "progress", done, total });
        } else if (v.event === "verifying" || v.event === "unpacking") {
          deliver({ phase: v.event });
        } else if (v.event === "done" || v.event === "stopped" || v.event === "error") {
          last = v;
        }
      }
      const { code, stderr } = await r.exited;
      await delivered;
      if (callbackError !== undefined) throw callbackError;
      if (last?.event === "done" && typeof last.path === "string" && code === 0) {
        return { status: "done", path: last.path };
      }
      if (last?.event === "stopped" || (stopping && last?.event !== "error")) {
        const kept = typeof last?.done === "number" ? last.done : done;
        const of = typeof last?.total === "number" ? last.total : total;
        return { status: "stopped", done: kept, total: of };
      }
      throw failure(stderr, code, last?.message);
    } finally {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  })();
  return { result, cancel };
}
