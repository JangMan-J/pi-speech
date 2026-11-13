import { describe, expect, it } from "vitest";
import type { StreamFormat } from "../../src/engine/provider";
import {
  bufferStart,
  bytesPerSecond,
  CHARS_PER_SECOND,
  estimateSeconds,
  mp3BytesPerSecond,
  RATE_WINDOW_MS,
  StartBuffer,
} from "../../src/engine/start-buffer";

const PCM: StreamFormat = { codec: "pcm", rate: 24000, channels: 1 };
const PER_SECOND = 48000;
const TICK_MS = 20;

/** A text that the estimate takes for `seconds` of speech. */
const textOf = (seconds: number) => "a".repeat(Math.round(seconds * CHARS_PER_SECOND));

/**
 * A drip feeder: `seconds` of PCM arriving at `rate` seconds of audio per second of time, one chunk every
 * TICK_MS from time 0, after a first chunk of `burst` seconds (a service that sends a little ahead first).
 */
function drip(seconds: number, rate: number, burst = 0): Array<{ at: number; bytes: number }> {
  const out: Array<{ at: number; bytes: number }> = [];
  const total = Math.round(seconds * PER_SECOND);
  let sent = 0;
  const frames = (s: number) => Math.round((s * PER_SECOND) / 2) * 2;
  if (burst > 0) {
    const b = Math.min(frames(burst), total);
    out.push({ at: 0, bytes: b });
    sent = b;
  }
  for (let t = burst > 0 ? TICK_MS : 0; sent < total; t += TICK_MS) {
    const b = Math.min(Math.max(2, frames((rate * TICK_MS) / 1000)), total - sent);
    out.push({ at: t, bytes: b });
    sent += b;
  }
  return out;
}

/**
 * Feed `chunks` through bufferStart on a virtual clock, as a player would read them: returns when playback
 * started (ms after the first chunk) and the longest gap at the speakers, where a gap is a chunk read later
 * than the audio before it takes to play.
 */
async function play(chunks: Array<{ at: number; bytes: number }>, expectedSeconds: number, format = PCM) {
  let now = 0;
  async function* source() {
    for (const c of chunks) {
      now = c.at;
      yield new Uint8Array(c.bytes);
    }
  }
  let held = -1;
  const read: Array<{ at: number; bytes: number }> = [];
  for await (const c of bufferStart(source(), format, expectedSeconds, {
    now: () => now,
    onStart: (ms) => (held = ms),
  })) {
    read.push({ at: now, bytes: c.byteLength });
  }
  const start = chunks[0].at + held;
  let position = 0; // seconds of audio before this chunk
  let gap = 0;
  for (const c of read) {
    const due = start + position * 1000; // when the speakers reach this chunk
    gap = Math.max(gap, c.at - due);
    position += c.bytes / PER_SECOND;
  }
  return { held, gap, bytes: read.reduce((n, c) => n + c.bytes, 0) };
}

describe("the clip length estimated from the text", () => {
  it("is the text's characters at CHARS_PER_SECOND", () => {
    expect(estimateSeconds(`  ${"x".repeat(CHARS_PER_SECOND * 3)}  `)).toBe(3);
    expect(estimateSeconds("")).toBe(0);
  });
});

describe("bytes per second", () => {
  it("of PCM from its rate and channels, of MP3 from its first frame, of another WAV unknown", () => {
    expect(bytesPerSecond({ codec: "pcm", rate: 44100, channels: 2 }, new Uint8Array())).toBe(176400);
    // MPEG 1 Layer III at 128 kbit/s, after an ID3v2 tag of 4 bytes.
    const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 1, 2, 3, 4, 0xff, 0xfb, 0x90, 0x64]);
    expect(mp3BytesPerSecond(mp3)).toBe(16000);
    // MPEG 2 Layer III at 64 kbit/s.
    expect(mp3BytesPerSecond(Uint8Array.from([0xff, 0xf3, 0x80, 0xc4]))).toBe(8000);
    expect(mp3BytesPerSecond(Uint8Array.from([1, 2, 3, 4]))).toBeUndefined();
    expect(bytesPerSecond({ codec: "wav" }, new Uint8Array(100))).toBeUndefined();
  });
});

describe("the adaptive start buffer, checked with a drip feeder", () => {
  const CLIP = 10;
  const SLOW = [0.25, 0.5, 0.75, 0.9];
  const FAST = [1.2, 2, 5, 10];

  it.each(SLOW)("a steady slow source at %sx plays with no gap", async (rate) => {
    const r = await play(drip(CLIP, rate), CLIP);
    expect(r.gap).toBeLessThanOrEqual(0);
    expect(r.bytes).toBe(CLIP * PER_SECOND);
    // Held about the shortfall, D * (1 - r) / r, and not much more.
    const shortfall = ((CLIP * (1 - rate)) / rate) * 1000;
    expect(r.held).toBeGreaterThan(shortfall * 0.9);
    expect(r.held).toBeLessThan(shortfall + 1000);
  });

  it("the start delay shrinks as the arrival rate rises", async () => {
    const helds: number[] = [];
    for (const rate of [...SLOW, ...FAST]) helds.push((await play(drip(CLIP, rate), CLIP)).held);
    for (let i = 1; i < helds.length; i++) expect(helds[i]).toBeLessThanOrEqual(helds[i - 1]);
    expect(helds[0]).toBeGreaterThan(helds[SLOW.length - 1]);
  });

  it.each(FAST)("a source faster than playback (%sx) starts within the measuring window, with no gap", async (rate) => {
    const r = await play(drip(CLIP, rate), CLIP);
    expect(r.held).toBeLessThanOrEqual(RATE_WINDOW_MS);
    expect(r.gap).toBeLessThanOrEqual(0);
  });

  it("adds no delay for a fast streaming service (xAI: well ahead within a few chunks)", async () => {
    const r = await play(drip(CLIP, 10, 0.3), CLIP);
    expect(r.held).toBeLessThanOrEqual(2 * TICK_MS);
    expect(r.gap).toBeLessThanOrEqual(0);
  });

  it("a whole clip that arrives at the end (one late chunk) plays at once", async () => {
    const r = await play([{ at: 900, bytes: CLIP * PER_SECOND }], CLIP);
    expect(r.held).toBe(0);
    expect(r.bytes).toBe(CLIP * PER_SECOND);
  });

  it("never waits for more than the whole clip, even when the text promised a longer one", async () => {
    const r = await play(drip(2, 0.5), 30);
    expect(r.bytes).toBe(2 * PER_SECOND);
    expect(r.held).toBeLessThanOrEqual(drip(2, 0.5).at(-1)!.at);
  });

  it("starts with the first chunk when the length or the rate of the audio is unknown", async () => {
    expect((await play(drip(CLIP, 0.5), 0)).held).toBe(0);
    expect((await play(drip(CLIP, 0.5), CLIP, { codec: "wav" })).held).toBe(0);
  });

  it("passes every chunk on, in order, once started; a source that slows later is not held again", async () => {
    const slowLater = [...drip(3, 5), ...drip(3, 0.2).map((c) => ({ at: c.at + 1000, bytes: c.bytes }))];
    let now = 0;
    const sent: number[] = [];
    async function* source() {
      let i = 0;
      for (const c of slowLater) {
        now = c.at;
        sent.push(i);
        yield Uint8Array.of(i++ % 256);
      }
    }
    const got: number[] = [];
    let held = -1;
    for await (const c of bufferStart(source(), PCM, 6, { now: () => now, onStart: (ms) => (held = ms) })) {
      got.push(c[0]);
    }
    expect(got).toEqual(sent.map((i) => i % 256));
    expect(held).toBeGreaterThanOrEqual(0);
  });

  it("a reader that stops early ends the source too", async () => {
    let ended = false;
    async function* source() {
      try {
        while (true) yield new Uint8Array(PER_SECOND);
      } finally {
        ended = true;
      }
    }
    for await (const _ of bufferStart(source(), PCM, 1)) break;
    expect(ended).toBe(true);
  });

  it("the decision alone: the shortfall of a 0.5x source over a 4 s clip is held", () => {
    const b = new StartBuffer(4, PER_SECOND);
    let t = 0;
    let started = -1;
    while (started < 0) {
      if (b.arrive(PER_SECOND * 0.5 * 0.02, t)) started = t;
      t += 20;
    }
    // D * (1 - r) = 2 s of audio held, plus the margin: about 4.3 s at 0.5x.
    expect(started).toBeGreaterThan(4000);
    expect(started).toBeLessThan(4600);
  });
});

describe("estimate and text", () => {
  it("a text of the clip's length gives the clip's estimate", () => {
    expect(estimateSeconds(textOf(10))).toBeCloseTo(10, 1);
  });
});
