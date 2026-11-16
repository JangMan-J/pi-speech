/**
 * The on-device model downloads in progress, any number at once (one per model), owned by the engine rather
 * than by a settings panel: the panel is made anew each time it opens, and a download (with its unpacking,
 * which for a large model takes a while) outlives the panel that started it. Every open panel follows them
 * here, and a model chosen from a list becomes that direction's model when it is done, whether or not a panel
 * is still open. Downloads of different models run independently: one verifying or unpacking never blocks
 * starting or running another.
 */

import type { Download, DownloadProgress, LocalModels } from "./local-models";
import type { Direction } from "./speech";

export interface ActiveDownload {
  id: string;
  /** Its size, for the status line before progress arrives. */
  size: number;
  progress?: DownloadProgress;
  /** Chosen from that direction's model list: it becomes that direction's model once downloaded. */
  direction?: Direction;
}

export type DownloadEnd =
  | { status: "done"; id: string; direction?: Direction; summary?: string }
  | { status: "stopped"; id: string }
  | { status: "failed"; id: string; error: string };

/** One change: the model it concerns, and how it ended when it has ended. */
export interface DownloadChange {
  id: string;
  end?: DownloadEnd;
}

export class Downloads {
  /** The downloads in progress, by model id. */
  readonly active = new Map<string, ActiveDownload>();
  /** How each model's last download ended, by model id; kept so a panel opened after it can say so. */
  readonly ends = new Map<string, DownloadEnd>();
  /** How the most recent download ended; kept until another ends. */
  last?: DownloadEnd;
  private readonly running = new Map<string, { download: Download; promise: Promise<DownloadEnd> }>();
  private readonly listeners = new Set<(change: DownloadChange) => void>();

  constructor(
    private readonly local: () => Pick<LocalModels, "download">,
    /** Make `id` the model of `direction`; returns what to tell the user. */
    private readonly choose: (direction: Direction, id: string) => string,
  ) {}

  /** The download of `id` in progress, if any. */
  get(id: string): ActiveDownload | undefined {
    return this.active.get(id);
  }

  /** Hear every change (progress, the end); returns what stops listening. */
  listen(listener: (change: DownloadChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start downloading `model`; resolves with how it ended (never rejects). Starting a model that is already
   * downloading returns that download's promise. Throws, sending nothing, when the download cannot start.
   */
  start(model: { id: string; size: number }, direction?: Direction): Promise<DownloadEnd> {
    const existing = this.running.get(model.id);
    if (existing) return existing.promise;
    const state: ActiveDownload = { id: model.id, size: model.size, ...(direction ? { direction } : {}) };
    const download = this.local().download(model.id, {
      onProgress: (p) => {
        state.progress = p;
        this.emit({ id: model.id });
      },
    });
    this.active.set(model.id, state);
    this.ends.delete(model.id);
    const promise = download.result.then(
      (r): DownloadEnd => {
        if (r.status === "stopped") return this.finish({ status: "stopped", id: model.id });
        const summary = direction ? this.choose(direction, model.id) : undefined;
        return this.finish({ status: "done", id: model.id, ...(direction ? { direction, summary } : {}) });
      },
      (err: unknown) =>
        this.finish({ status: "failed", id: model.id, error: err instanceof Error ? err.message : String(err) }),
    );
    this.running.set(model.id, { download, promise });
    this.emit({ id: model.id });
    return promise;
  }

  /** Stop the download of `id` (or every download), keeping what has arrived for the next one to resume. */
  stop(id?: string): void {
    if (id) this.running.get(id)?.download.cancel();
    else for (const r of this.running.values()) r.download.cancel();
  }

  private finish(end: DownloadEnd): DownloadEnd {
    this.active.delete(end.id);
    this.running.delete(end.id);
    this.ends.set(end.id, end);
    this.last = end;
    this.emit({ id: end.id, end });
    return end;
  }

  private emit(change: DownloadChange): void {
    for (const l of this.listeners) {
      try {
        l(change);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
}
