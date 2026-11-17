/**
 * Shared model-backend contract and receiver NDJSON download stream parser.
 * Kept free of bridge/ and local-models.ts imports so both LocalReceiverBackend and BridgeModelBackend
 * implement the same port without circular dependencies.
 */

import type { AudioStream } from "./provider";

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

export interface Download {
  /** Settles once the binary has exited and every progress callback has finished. Rejects on an error. */
  readonly result: Promise<DownloadResult>;
  /** Stop the download, leaving what has arrived to be resumed. */
  cancel(): void;
}

/** A voice of a speech model, as `speak <id> --list-voices` names it. */
export interface BridgeVoice {
  name: string;
  number: number;
}

/**
 * Local models run by a receiver (either on This machine or on the Remote machine over the bridge).
 */
export interface ModelBackend {
  /** The catalogue with each model's state on the target machine, as `models list` prints it. */
  list(): Promise<Record<string, unknown>[]>;
  voices(id: string, signal?: AbortSignal): Promise<BridgeVoice[]>;
  transcribe(
    id: string,
    audio: Buffer,
    format: "wav" | "mp3",
    signal?: AbortSignal,
    language?: string,
  ): Promise<string>;
  /**
   * Download a model into the target machine's cache; cancelling stops it there, keeping what arrived.
   * Absent in stand-ins that cannot.
   */
  download?(
    id: string,
    options?: { onProgress?: (p: DownloadProgress) => void | Promise<void>; signal?: AbortSignal },
  ): Download;
  /** Delete a model on the target machine; resolves to the bytes freed. */
  delete?(id: string): Promise<number>;
  /** Resolves once the model has loaded there; the chunks are the PCM as it is generated. */
  speak(
    id: string,
    text: string,
    opts?: { voice?: string; speed?: number; lang?: string; signal?: AbortSignal },
  ): Promise<AudioStream>;
}

/** What a download's event lines said: how it ended, and how far it got. */
export interface FollowedDownload {
  last?: Record<string, unknown>;
  done: number;
  total: number;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
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
    const v = parseJsonLine(line);
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
