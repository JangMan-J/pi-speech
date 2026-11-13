/**
 * The adaptive start buffer of a Stream (GLOSSARY.md): playback starts once enough audio has arrived that the
 * rest will not fall behind it. At once on a fast connection, later on a slow one, never later than the whole
 * clip. It sits in the player (player.ts), above every output, so it serves playback on this machine and on the
 * Remote machine through the bridge alike.
 *
 * The clip's length is estimated from its text (CHARS_PER_SECOND of speech). The arrival rate `r` (seconds of
 * audio per second) is measured from the first chunk on, over at least RATE_WINDOW_MS: before that much time
 * has passed, the audio that came after the first chunk is divided by the whole window, so the rate is never
 * overestimated. Audio arriving at rate `r < 1` keeps up with a playback of `D` seconds when `D * (1 - r)`
 * seconds are held before it starts (the shortfall); at `r >= 1` nothing is held. A connection that slows down
 * after the start gives a clean pause, never lost audio: the player waits for the input.
 */

import type { StreamFormat } from "./provider";

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
