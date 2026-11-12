/**
 * The player: a queue of length one over the selected route. A new playback replaces the one in progress
 * (whatever route it plays on), stop stops it, and its state drives the status indicator. Messages,
 * samples, read-aloud and replay all go through it.
 *
 * A caller that must synthesize before it can play first takes a ticket; a later ticket or a stop makes
 * the earlier one stale, so audio that arrives late never plays over newer audio or after a stop.
 *
 * A reading (`read()`) is one playback made of several files played one after another, such as a long text
 * spoken in pieces: the player counts as playing from its first piece until it ends, and a newer claim,
 * playback or stop ends it at once.
 */

import type { AudioOutput, Playback, PlayKind, PlayStart } from "./audio";
import type { AudioStream } from "./provider";

export interface PlayerEvents {
  /** The player started or stopped playing. */
  onChange?(playing: boolean): void;
  /** A playback that had started failed; called once per playback. */
  onFailed?(error: string, kind: PlayKind): void;
}

export interface PlayOptions {
  /** From `claim()`; the play is skipped when a newer ticket was taken or the player was stopped since. */
  ticket?: number;
  /** Runs once the file is no longer needed: after playback, or when it does not start. */
  cleanup?: () => void;
}

interface InternalPlayOptions extends PlayOptions {
  reading?: ReadingState;
}

interface Current {
  playback: Playback;
  kind: PlayKind;
}

/** What one play starts on the output: a file (kept for replay when it is a message) or a Stream. */
type Source = { file: string } | { stream: AudioStream };

/** One playback made of pieces played in order; see `Player.read()`. */
export interface Reading {
  /** Aborted when the reading ends: replaced, stopped, or ended by its owner. */
  readonly signal: AbortSignal;
  /** Whether the reading still owns the player. */
  readonly current: boolean;
  /** Play the next piece (after the one before it has finished); skipped when the reading is no longer current. */
  play(file: string, cleanup?: () => void): Promise<PlayStart>;
  /** The reading is over: the player is free once a piece still playing ends. */
  end(): void;
}

interface ReadingState {
  ticket: number;
  controller: AbortController;
  /** A piece has started: the player counts as playing until the reading ends. */
  started: boolean;
}

export const REPLACED = "a newer playback or a stop replaced it";

export class Player {
  private current?: Current;
  private tickets = 0;
  /** Aborted when the newest ticket goes stale: a newer claim or a stop. */
  private claimed = new AbortController();
  private lastFile?: string;
  private reading?: ReadingState;

  constructor(
    private readonly output: () => AudioOutput,
    private readonly events: PlayerEvents = {},
  ) {}

  get playing(): boolean {
    return this.current !== undefined || this.reading?.started === true;
  }

  /** The file of the last message played (not samples), for replay. */
  get lastMessage(): string | undefined {
    return this.lastFile;
  }

  /** Reserve the next playback; plays with older tickets are skipped. */
  claim(): number {
    const ticket = ++this.tickets;
    this.claimed.abort();
    this.claimed = new AbortController();
    this.endReading();
    return ticket;
  }

  /** Whether the selected output plays a Stream of 16-bit PCM now (the format every streaming provider can give). */
  canStream(): boolean {
    const output = this.output();
    if (!output.playStream) return false;
    return output.canStream?.({ codec: "pcm", rate: 24000, channels: 1 }).ok ?? true;
  }

  /**
   * Aborted once `ticket` is stale (a newer claim or a stop), so work for it can be cancelled: already
   * aborted when it is stale now.
   */
  signalFor(ticket: number): AbortSignal {
    return ticket === this.tickets ? this.claimed.signal : AbortSignal.abort();
  }

  /** Start a reading: one playback of pieces played in order. It replaces a reading in progress. */
  read(): Reading {
    const state: ReadingState = { ticket: this.claim(), controller: new AbortController(), started: false };
    this.reading = state;
    const current = () => this.reading === state;
    return {
      signal: state.controller.signal,
      get current() {
        return current();
      },
      play: (file, cleanup) => this.start({ file }, "message", { ticket: state.ticket, cleanup, reading: state }),
      end: () => {
        if (this.reading === state) this.endReading();
      },
    };
  }

  async play(file: string, kind: PlayKind, opts: PlayOptions = {}): Promise<PlayStart> {
    return this.start({ file }, kind, opts);
  }

  /**
   * Play a Stream as its chunks arrive, under the same rules as a file. `{ ok: false, cannotStream: true }`
   * when the selected output cannot play a Stream now; nothing of the Stream was read then.
   */
  async playStream(stream: AudioStream, kind: PlayKind, opts: PlayOptions = {}): Promise<PlayStart> {
    return this.start({ stream }, kind, opts);
  }

  private stale(opts: InternalPlayOptions): boolean {
    if (opts.reading) return this.reading !== opts.reading;
    return opts.ticket !== undefined && opts.ticket !== this.tickets;
  }

  private async start(source: Source, kind: PlayKind, opts: InternalPlayOptions): Promise<PlayStart> {
    if (this.stale(opts)) {
      opts.cleanup?.();
      return { ok: false, reason: REPLACED };
    }
    const output = this.output();
    if ("stream" in source) {
      // Decided before anything stops: where a Stream cannot play, what plays now goes on until the clip is ready.
      const can = output.playStream
        ? (output.canStream?.(source.stream.format) ?? { ok: true as const })
        : { ok: false as const, reason: `${output.name} playback cannot play speech as it arrives` };
      if (!can.ok) {
        opts.cleanup?.();
        return { ok: false, reason: can.reason, cannotStream: true };
      }
    }
    if (!opts.reading) this.endReading();
    const replacing = await this.stopCurrent(false);
    let started: PlayStart;
    try {
      started = "file" in source ? await output.play(source.file, kind) : await output.playStream!(source.stream, kind);
    } catch (err) {
      started = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (!started.ok) {
      if (replacing && !this.playing) this.events.onChange?.(false);
      opts.cleanup?.();
      return started;
    }
    if (this.stale(opts)) {
      // A stop or newer audio came while this one was starting: it must not play on.
      await started.stop().catch(() => {});
      void started.done.then(() => opts.cleanup?.());
      if (replacing && !this.playing) this.events.onChange?.(false);
      return { ok: false, reason: REPLACED };
    }
    if (opts.reading) opts.reading.started = true;
    else if (kind === "message" && "file" in source) this.lastFile = source.file;
    const entry: Current = { playback: started, kind };
    // Another play may have started while this one was starting; the newest wins.
    await this.stopCurrent(false);
    this.current = entry;
    this.events.onChange?.(true);
    void started.done.then((outcome) => {
      opts.cleanup?.();
      if (this.current === entry) {
        this.current = undefined;
        if (!this.playing) this.events.onChange?.(false);
      }
      if (outcome.state === "failed") this.events.onFailed?.(outcome.error, kind);
    });
    return started;
  }

  /** Stop what plays and cancel plays still being prepared. Resolves true when something was playing. */
  async stop(): Promise<boolean> {
    const was = this.playing;
    this.claim();
    await this.stopCurrent();
    await this.output()
      .stop()
      .catch(() => {});
    return was;
  }

  /** End the reading in progress, if any; announced when nothing plays any more. */
  private endReading(): void {
    const r = this.reading;
    if (!r) return;
    this.reading = undefined;
    r.controller.abort();
    if (r.started && !this.current) this.events.onChange?.(false);
  }

  /** Stop the current playback; `announce` false when a new one takes its place at once. */
  private async stopCurrent(announce = true): Promise<boolean> {
    const c = this.current;
    if (!c) return false;
    this.current = undefined;
    if (announce) this.events.onChange?.(false);
    await c.playback.stop().catch(() => {});
    return true;
  }
}
