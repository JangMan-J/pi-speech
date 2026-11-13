/**
 * The player: a queue of length one over the selected route. A new playback replaces the one in progress
 * (whatever route it plays on), stop stops it, and its state drives the status indicator. Messages,
 * samples, read-aloud and replay all go through it, and every playback is a Stream (GLOSSARY.md): a saved
 * message is replayed by feeding its file to the output as a Stream. The start of every Stream goes through
 * the adaptive start buffer (start-buffer.ts), here, so it serves every output alike.
 *
 * A caller that must synthesize before it can play first takes a ticket; a later ticket or a stop makes
 * the earlier one stale, so audio that arrives late never plays over newer audio or after a stop.
 */

import { readFile } from "node:fs/promises";
import type { AudioOutput, Playback, PlayKind, PlayStart } from "./audio";
import { streamFromBody } from "./audio-stream";
import { errorMessage } from "./env";
import type { AudioStream } from "./provider";
import { bufferStart, estimateSeconds } from "./start-buffer";

export interface PlayerEvents {
  /** The player started or stopped playing. */
  onChange?(playing: boolean): void;
  /** A playback that had started failed; called once per playback. */
  onFailed?(error: string, kind: PlayKind): void;
}

export interface PlayOptions {
  /** From `claim()`; the play is skipped when a newer ticket was taken or the player was stopped since. */
  ticket?: number;
  /** Runs once the playback has ended, or when it does not start. */
  cleanup?: () => void;
  /** The text the Stream speaks: its length sets how much audio the start buffer may hold. */
  text?: string;
}

interface Current {
  playback: Playback;
  kind: PlayKind;
}

export const REPLACED = "a newer playback or a stop replaced it";

/** A saved message (WAV or MP3) as a Stream: the whole file in one chunk. */
export async function streamOfFile(file: string): Promise<AudioStream> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    throw new Error(`cannot read ${file}: ${(err as NodeJS.ErrnoException).code ?? errorMessage(err)}`);
  }
  const type = /\.mp3$/i.test(file) ? "audio/mpeg" : "audio/wav";
  const stream = await streamFromBody(new Response(new Uint8Array(bytes)).body, type, file);
  return { ...stream, file };
}

export class Player {
  private current?: Current;
  private tickets = 0;
  /** Aborted when the newest ticket goes stale: a newer claim or a stop. */
  private claimed = new AbortController();
  private lastFile?: string;

  constructor(
    private readonly output: () => AudioOutput,
    private readonly events: PlayerEvents = {},
  ) {}

  get playing(): boolean {
    return this.current !== undefined;
  }

  /** The file of the last message replayed (not samples). */
  get lastMessage(): string | undefined {
    return this.lastFile;
  }

  /** Reserve the next playback; plays with older tickets are skipped. */
  claim(): number {
    const ticket = ++this.tickets;
    this.claimed.abort();
    this.claimed = new AbortController();
    return ticket;
  }

  /**
   * Aborted once `ticket` is stale (a newer claim or a stop), so work for it can be cancelled: already
   * aborted when it is stale now.
   */
  signalFor(ticket: number): AbortSignal {
    return ticket === this.tickets ? this.claimed.signal : AbortSignal.abort();
  }

  /** Play a saved message (or any WAV or MP3 file), fed to the output as a Stream. */
  async play(file: string, kind: PlayKind, opts: PlayOptions = {}): Promise<PlayStart> {
    let stream: AudioStream;
    try {
      stream = await streamOfFile(file);
    } catch (err) {
      opts.cleanup?.();
      return { ok: false, reason: errorMessage(err) };
    }
    const started = await this.playStream(stream, kind, opts);
    if (started.ok && kind === "message") this.lastFile = file;
    return started;
  }

  /** Play a Stream as its chunks arrive, starting once the start buffer says enough has arrived. */
  async playStream(stream: AudioStream, kind: PlayKind, opts: PlayOptions = {}): Promise<PlayStart> {
    if (this.stale(opts)) {
      opts.cleanup?.();
      return { ok: false, reason: REPLACED };
    }
    const output = this.output();
    const replacing = await this.stopCurrent(false);
    const expected = opts.text === undefined ? undefined : estimateSeconds(opts.text);
    const chunks = bufferStart(stream.chunks, stream.format, expected);
    let started: PlayStart;
    try {
      started = await output.playStream({ ...stream, chunks }, kind);
    } catch (err) {
      started = { ok: false, reason: errorMessage(err) };
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
    const entry: Current = { playback: started, kind };
    // Another play may have started while this one was starting; the newest wins.
    await this.stopCurrent(false);
    this.current = entry;
    this.events.onChange?.(true);
    void started.done.then((outcome) => {
      opts.cleanup?.();
      if (this.current === entry) {
        this.current = undefined;
        this.events.onChange?.(false);
      }
      if (outcome.state === "failed") this.events.onFailed?.(outcome.error, kind);
    });
    return started;
  }

  private stale(opts: PlayOptions): boolean {
    return opts.ticket !== undefined && opts.ticket !== this.tickets;
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
