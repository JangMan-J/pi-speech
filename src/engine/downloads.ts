/**
 * The on-device model download in progress, one at a time, owned by the engine rather than by a settings
 * panel: the panel is made anew each time it opens, and a download (with its unpacking, which for a large
 * model takes a while) outlives the panel that started it. Every open panel follows it here, and a model chosen
 * from a list becomes that direction's model when it is done, whether or not a panel is still open.
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

export class Downloads {
  /** The download in progress, if any. */
  current?: ActiveDownload;
  /** How the last download ended; kept until the next starts, so a panel opened after it can say so. */
  last?: DownloadEnd;
  private running?: Download;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly local: () => Pick<LocalModels, "download">,
    /** Make `id` the model of `direction`; returns what to tell the user. */
    private readonly choose: (direction: Direction, id: string) => string,
  ) {}

  /** Hear every change (progress, the end); returns what stops listening. */
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start downloading `model`; resolves with how it ended (never rejects). Throws, sending nothing, when
   * another download runs or the download cannot start.
   */
  start(model: { id: string; size: number }, direction?: Direction): Promise<DownloadEnd> {
    if (this.current) throw new Error(`${this.current.id} is downloading; one download at a time`);
    const state: ActiveDownload = { id: model.id, size: model.size, ...(direction ? { direction } : {}) };
    const running = this.local().download(model.id, {
      onProgress: (p) => {
        state.progress = p;
        this.emit();
      },
    });
    this.current = state;
    this.running = running;
    this.last = undefined;
    this.emit();
    return running.result.then(
      (r): DownloadEnd => {
        if (r.status === "stopped") return this.finish({ status: "stopped", id: model.id });
        const summary = direction ? this.choose(direction, model.id) : undefined;
        return this.finish({ status: "done", id: model.id, ...(direction ? { direction, summary } : {}) });
      },
      (err: unknown) =>
        this.finish({ status: "failed", id: model.id, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  /** Stop the download in progress, keeping what has arrived for the next one to resume. */
  stop(): void {
    this.running?.cancel();
  }

  private finish(end: DownloadEnd): DownloadEnd {
    this.current = undefined;
    this.running = undefined;
    this.last = end;
    this.emit();
    return end;
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
}
