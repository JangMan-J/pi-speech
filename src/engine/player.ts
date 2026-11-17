/**
 * The player: a queue of length one over the selected route. A new playback replaces the one in progress
 * (whatever route it plays on), stop stops it, and its state drives the status indicator. Messages,
 * samples, read-aloud and replay all go through it, and every playback is a Stream (GLOSSARY.md): a saved
 * message is replayed by feeding its file to the output as a Stream.
 *
 * Owns:
 * - Per-ticket reservation and crossfade tracking (`claim`, `signalFor`, `replaceFadeFor`)
 * - Adaptive start buffering (`StartBuffer`, `bufferStart`) above every output
 * - Single-clip streaming synthesis + playback (`streamAndPlay`)
 */

import { readFile } from "node:fs/promises";
import type { AudioOutput, Playback, PlayKind, PlayStart } from "./audio";
import { ChunkBuffer, clipOf, streamFromBody } from "./audio-stream";
import { errorMessage } from "./env";
import type { AudioStream, SpeechProvider, StreamFormat, SynthesisRequest, SynthesizedAudio } from "./provider";

// ── Adaptive start buffer ───────────────────────────────────────────────────

/** Characters of text spoken per second, a little fast so the clip's length is not underestimated by much. */
export const CHARS_PER_SECOND = 14;
/** The arrival rate is measured over at least this long from the first chunk. */
export const RATE_WINDOW_MS = 250;
/** Audio held beyond the shortfall when arrival is slower than playback, for jitter. */
export const MARGIN_SECONDS = 0.15;

/** The estimated length in seconds of `text` spoken. */
export function estimateSeconds(text: string): number {
  return text.trim().length / CHARS_PER_SECOND;
}

/** Bytes per second of the audio, from its format and (for MP3) its first frame; undefined when unknown. */
export function bytesPerSecond(format: StreamFormat, head: Uint8Array): number | undefined {
  if (format.codec === "pcm") return format.rate * format.channels * 2;
  if (format.codec === "mp3") return mp3BytesPerSecond(head);
  return undefined;
}

const MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** The bit rate of the first MPEG Layer III frame (after an ID3v2 tag), in bytes per second. */
export function mp3BytesPerSecond(b: Uint8Array): number | undefined {
  let pos = 0;
  if (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    pos = 10 + size + (b[5] & 0x10 ? 10 : 0);
  }
  for (; pos + 3 < b.length; pos++) {
    if (b[pos] !== 0xff || (b[pos + 1] & 0xe0) !== 0xe0) continue;
    const version = (b[pos + 1] >> 3) & 3; // 3: MPEG 1, 2: MPEG 2, 0: MPEG 2.5
    const layer = (b[pos + 1] >> 1) & 3; // 1: Layer III
    const index = b[pos + 2] >> 4;
    if (version === 1 || layer !== 1 || index === 0 || index === 15) continue;
    const kbps = (version === 3 ? MPEG1_L3 : MPEG2_L3)[index];
    return (kbps * 1000) / 8;
  }
  return undefined;
}

/**
 * The decision for one Stream: told of every chunk as it arrives, says when playback may start. Times are in
 * milliseconds, from any fixed origin.
 */
export class StartBuffer {
  private bytes = 0;
  private firstAt?: number;
  private firstSeconds = 0;
  private go = false;

  /**
   * `expectedSeconds`: the clip's estimated length; `perSecond`: bytes of audio per second. Either unknown:
   * playback starts with the first chunk.
   */
  constructor(
    private readonly expectedSeconds: number | undefined,
    private readonly perSecond: number | undefined,
  ) {}

  get started(): boolean {
    return this.go;
  }

  /** Seconds of audio arrived so far. */
  get arrived(): number {
    return this.perSecond ? this.bytes / this.perSecond : 0;
  }

  /** A chunk of `length` bytes arrived at `at`: whether playback may start now. */
  arrive(length: number, at: number): boolean {
    this.bytes += length;
    if (this.go) return true;
    const d = this.expectedSeconds;
    if (!d || !this.perSecond) return this.start();
    const a = this.arrived;
    if (this.firstAt === undefined) {
      this.firstAt = at;
      this.firstSeconds = a;
    }
    if (a >= d) return this.start();
    const elapsed = Math.max(at - this.firstAt, RATE_WINDOW_MS) / 1000;
    const rate = (a - this.firstSeconds) / elapsed;
    if (rate >= 1 || a >= d * (1 - rate) + MARGIN_SECONDS) return this.start();
    return false;
  }

  private start(): true {
    this.go = true;
    return true;
  }
}

export interface BufferStartOptions {
  /** The clock, in milliseconds. */
  now?: () => number;
  /** Told once when playback starts: how long after the first chunk it was held, in milliseconds. */
  onStart?(heldMs: number): void;
}

/**
 * The chunks of a Stream, held back at the start as the StartBuffer decides, then passed on as they arrive.
 * The source is read while it is held, so a source that buffers (ChunkBuffer) never waits; the whole clip
 * having arrived always starts playback.
 */
export async function* bufferStart(
  source: AsyncIterable<Uint8Array>,
  format: StreamFormat,
  expectedSeconds: number | undefined,
  opts: BufferStartOptions = {},
): AsyncGenerator<Uint8Array> {
  const now = opts.now ?? (() => performance.now());
  const it = source[Symbol.asyncIterator]();
  const held: Uint8Array[] = [];
  let gate: StartBuffer | undefined;
  let firstAt: number | undefined;
  let done = false;
  try {
    while (!gate?.started) {
      const n = await it.next();
      if (n.done) {
        done = true;
        break;
      }
      const at = now();
      firstAt ??= at;
      held.push(n.value);
      if (!gate) {
        // The rate of an MP3 is read from its first frame, which may not be in the first chunk.
        const head = held.length === 1 ? n.value : Buffer.concat(held);
        const perSecond = bytesPerSecond(format, head);
        if (perSecond === undefined && format.codec === "mp3" && head.length < 64 * 1024) continue;
        gate = new StartBuffer(expectedSeconds, perSecond);
        if (gate.arrive(head.length, firstAt) || gate.arrive(0, at)) break;
        continue;
      }
      gate.arrive(n.value.byteLength, at);
    }
    opts.onStart?.(firstAt === undefined ? 0 : now() - firstAt);
    for (const chunk of held.splice(0)) yield chunk;
    if (done) return;
    while (true) {
      const n = await it.next();
      if (n.done) return;
      yield n.value;
    }
  } finally {
    if (!done) await it.return?.(undefined);
  }
}

// ── Player ──────────────────────────────────────────────────────────────────

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
  /** Crossfade: fade the playback this one replaces out, and this one's start in, over this long. */
  fadeMs?: number;
}

interface Current {
  playback: Playback;
  kind: PlayKind;
}

interface TicketState {
  ac: AbortController;
  replacedFade?: number;
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
  private readonly ticketStates = new Map<number, TicketState>();
  private lastClaimFade?: number;
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

  /**
   * Reserve the next playback; plays with older tickets are skipped, and one already playing ends: faded
   * over `fadeMs` when given (a crossfade into this one), else at once.
   */
  claim(fadeMs?: number): number {
    this.lastClaimFade = fadeMs;
    const prev = this.ticketStates.get(this.tickets);
    if (prev) {
      prev.replacedFade = fadeMs;
      prev.ac.abort();
    }
    const ticket = ++this.tickets;
    this.ticketStates.set(ticket, { ac: new AbortController() });
    // Keep bounded history of replaced tickets so stale listeners can still read their exact fade.
    if (this.ticketStates.size > 32) {
      const oldest = this.ticketStates.keys().next().value;
      if (oldest !== undefined && oldest !== ticket) this.ticketStates.delete(oldest);
    }
    return ticket;
  }

  /**
   * Aborted once `ticket` is stale (a newer claim or a stop), so work for it can be cancelled: already
   * aborted when it is stale now.
   */
  signalFor(ticket: number): AbortSignal {
    return ticket === this.tickets
      ? (this.ticketStates.get(ticket)?.ac.signal ?? AbortSignal.abort())
      : AbortSignal.abort();
  }

  /** The crossfade requested by the claim that replaced `ticket`, if any. */
  replaceFadeFor(ticket: number): number | undefined {
    return this.ticketStates.get(ticket)?.replacedFade;
  }

  /** How the newest claim asked to replace what came before it, if any. */
  get replaceFade(): number | undefined {
    return this.lastClaimFade;
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
    const replacing = await this.stopCurrent(false, opts.fadeMs);
    const expected = opts.text === undefined ? undefined : estimateSeconds(opts.text);
    const chunks = bufferStart(stream.chunks, stream.format, expected);
    let started: PlayStart;
    try {
      started = await output.playStream({ ...stream, chunks }, kind, opts.fadeMs ? { fadeMs: opts.fadeMs } : undefined);
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
    await this.stopCurrent(false, opts.fadeMs);
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

  /**
   * Stop the current playback; `announce` false when a new one takes its place at once. With `fadeMs` it
   * fades out instead (where its output can fade), and this does not wait for it.
   */
  private async stopCurrent(announce = true, fadeMs?: number): Promise<boolean> {
    const c = this.current;
    if (!c) return false;
    this.current = undefined;
    if (announce) this.events.onChange?.(false);
    if (fadeMs && c.playback.fadeOut) await c.playback.fadeOut(fadeMs).catch(() => {});
    else await c.playback.stop().catch(() => {});
    return true;
  }
}

// ── Single-clip stream synthesis + playback ─────────────────────────────────

export type StreamPlay =
  /** The response fully arrived: `audio` is the whole clip; `started` says whether and where it plays. */
  | { state: "arrived"; audio: SynthesizedAudio; started: PlayStart }
  /** Stopped or replaced before the response fully arrived: the request was cancelled, nothing kept. */
  | { state: "stopped" };

/**
 * Synthesize `req` as a Stream and play it through `player` as it arrives, under `ticket` from `player.claim()`.
 * Throws "Speech synthesis failed: …" when the request fails, or after stopping the playback when the response
 * breaks off or holds no audio.
 */
export async function streamAndPlay(
  provider: SpeechProvider,
  req: SynthesisRequest,
  player: Player,
  kind: PlayKind,
  ticket: number,
  /** Crossfade from what plays now into this playback over this long. */
  fadeMs?: number,
): Promise<StreamPlay> {
  const stale = player.signalFor(ticket);
  const caller = req.signal;
  if (stale.aborted || caller?.aborted) return { state: "stopped" };
  const request = new AbortController();
  let started: PlayStart | undefined;
  let stopped = false;
  const stop = (ended = false, fade?: number) => {
    if (stopped) return;
    stopped = true;
    request.abort();
    if (!started?.ok || ended) return;
    void (fade && started.fadeOut ? started.fadeOut(fade) : started.stop()).catch(() => {});
  };
  const onAbort = () => stop();
  const onStale = () => stop(false, player.replaceFadeFor(ticket));
  stale.addEventListener("abort", onStale);
  caller?.addEventListener("abort", onAbort);
  const failed = async (reason: string): Promise<never> => {
    request.abort();
    if (started?.ok) await started.stop().catch(() => {});
    throw new Error(`Speech synthesis failed: ${reason}`);
  };
  try {
    let stream: AudioStream;
    try {
      stream = await provider.synthesizeStream({ ...req, signal: request.signal });
    } catch (err) {
      if (stopped) return { state: "stopped" };
      return failed(errorMessage(err));
    }
    const kept = new ChunkBuffer();
    const download = (async (): Promise<unknown> => {
      try {
        for await (const chunk of stream.chunks) kept.push(chunk);
        return undefined;
      } catch (err) {
        return err ?? new Error("the response broke off");
      } finally {
        kept.end();
      }
    })();
    started = await player.playStream({ format: stream.format, chunks: kept.read() }, kind, {
      ticket,
      text: req.text,
      fadeMs,
    });
    if (started.ok) {
      if (stopped) void started.stop().catch(() => {});
      void started.done.then((o) => {
        if (o.state === "cancelled") stop(true);
      });
    } else if (started.reason === REPLACED) stop();
    const failure = await download;
    if (stopped) return { state: "stopped" };
    if (failure !== undefined) return failed(errorMessage(failure));
    let audio: SynthesizedAudio;
    try {
      audio = clipOf(stream.format, kept.bytes(), provider.name);
    } catch (err) {
      return failed(errorMessage(err));
    }
    return { state: "arrived", audio, started };
  } finally {
    stale.removeEventListener("abort", onStale);
    caller?.removeEventListener("abort", onAbort);
  }
}
