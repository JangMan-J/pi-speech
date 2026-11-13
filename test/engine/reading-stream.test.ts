/** A Reading played as one Stream: pieces requested ahead, fed in order to one player with no gap. */

import { afterEach, describe, expect, it } from "vitest";
import type { SavedMessage } from "../../src/engine/history";
import { Player } from "../../src/engine/player";
import type { AudioStream, StreamFormat, SynthesizedAudio } from "../../src/engine/provider";
import { ReadingFailed } from "../../src/engine/reading";
import { IN_FLIGHT, streamReading } from "../../src/engine/reading-stream";
import { fakeOutput, pcmBytes, until } from "./fixtures";

const PCM: StreamFormat = { codec: "pcm", rate: 24000, channels: 1 };

/** A piece the test answers by hand: `start` resolves the request with a Stream, then `send`/`end`/`fail`. */
interface HandPiece {
  text: string;
  aborted: boolean;
  start(format?: StreamFormat): void;
  reject(err: Error): void;
  send(b: Uint8Array): void;
  end(): void;
  fail(err: Error): void;
}

function harness(pieces: string[]) {
  const out = fakeOutput("local", { streams: true });
  const player = new Player(() => out);
  const asked: HandPiece[] = [];
  const saved: SynthesizedAudio[] = [];
  const synthesize = (text: string, signal: AbortSignal) =>
    new Promise<AudioStream>((resolve, rejectRequest) => {
      const queue: Uint8Array[] = [];
      let ended = false;
      let error: Error | undefined;
      let wake: (() => void) | undefined;
      const poke = () => {
        const w = wake;
        wake = undefined;
        w?.();
      };
      async function* chunks() {
        while (true) {
          if (queue.length) yield queue.shift()!;
          else if (error) throw error;
          else if (ended) return;
          else await new Promise<void>((r) => (wake = r));
        }
      }
      const piece: HandPiece = {
        text,
        aborted: false,
        start: (format = PCM) => resolve({ format, chunks: chunks() }),
        reject: rejectRequest,
        send: (b) => {
          queue.push(b);
          poke();
        },
        end: () => {
          ended = true;
          poke();
        },
        fail: (err) => {
          error = err;
          poke();
        },
      };
      signal.addEventListener("abort", () => {
        piece.aborted = true;
        const err = new DOMException("aborted", "AbortError");
        rejectRequest(err);
        piece.fail(err);
      });
      asked.push(piece);
    });
  const caller = new AbortController();
  const result = streamReading({
    pieces,
    synthesize,
    player,
    who: "S",
    signal: caller.signal,
    save: async (audio): Promise<SavedMessage> => {
      saved.push(audio);
      return { file: "/history/message.wav" };
    },
  });
  const played = () => Buffer.concat(out.streams[0]?.chunks ?? []);
  return { out, player, asked, saved, result, caller, played };
}

const settle = () => new Promise((r) => setTimeout(r, 15));

afterEach(async () => {
  await settle();
});

describe("a Reading played as one Stream", () => {
  it("asks for the first piece first and keeps at most two requests in flight", async () => {
    const h = harness(["one.", "two.", "three."]);
    await until(() => h.asked.length === IN_FLIGHT);
    expect(h.asked.map((p) => p.text)).toEqual(["one.", "two."]);
    h.asked[0].start();
    h.asked[0].send(pcmBytes(2));
    h.asked[0].end();
    await until(() => h.asked.length === 3);
    for (const p of h.asked.slice(1)) {
      p.start();
      p.send(pcmBytes(2));
      p.end();
    }
    expect((await h.result).state).toBe("saved");
  });

  it("feeds every piece in order to one player, the next one buffered while the one before plays", async () => {
    const h = harness(["one.", "two."]);
    await until(() => h.asked.length === 2);
    h.asked[1].start();
    h.asked[1].send(pcmBytes(4, 100));
    h.asked[1].end();
    h.asked[0].start();
    h.asked[0].send(pcmBytes(4));
    await until(() => h.played().length === 4);
    expect(h.out.streams).toHaveLength(1);
    expect(h.player.playing).toBe(true);
    h.asked[0].send(pcmBytes(2, 4));
    h.asked[0].end();
    const r = await h.result;
    expect(r.state).toBe("saved");
    await until(() => h.out.streams[0].ended);
    expect(Array.from(h.played())).toEqual([...pcmBytes(6), ...pcmBytes(4, 100)]);
    expect(h.out.plays).toHaveLength(1);
  });

  it("saves one WAV of every piece; a piece that ends inside a sample is padded so the next stays aligned", async () => {
    const h = harness(["one.", "two."]);
    await until(() => h.asked.length === 2);
    h.asked[0].start();
    h.asked[0].send(pcmBytes(3));
    h.asked[0].end();
    h.asked[1].start();
    h.asked[1].send(pcmBytes(4, 50));
    h.asked[1].end();
    const r = await h.result;
    expect(r).toMatchObject({ state: "saved", player: "local" });
    const wav = Buffer.from(h.saved[0].audio);
    expect(h.saved[0].format).toBe("wav");
    expect(Array.from(wav.subarray(44))).toEqual([...pcmBytes(3), 0, ...pcmBytes(4, 50)]);
    await until(() => h.out.streams[0].ended);
    expect(Array.from(h.played())).toEqual([...pcmBytes(3), 0, ...pcmBytes(4, 50)]);
  });

  it("a stop while a later piece downloads stops everything, cancels the requests and saves nothing", async () => {
    const h = harness(["one.", "two.", "three."]);
    await until(() => h.asked.length === 2);
    h.asked[0].start();
    h.asked[0].send(pcmBytes(10));
    h.asked[1].start();
    await until(() => h.played().length === 10);
    await h.player.stop();
    expect(await h.result).toEqual({ state: "stopped" });
    expect(h.asked.every((p) => p.aborted)).toBe(true);
    expect(h.out.streams[0].outcome).toEqual({ state: "cancelled" });
    expect(h.saved).toEqual([]);
    expect(h.player.playing).toBe(false);
  });

  it("the caller's signal stops it as a stop does", async () => {
    const h = harness(["one.", "two."]);
    await until(() => h.asked.length === 2);
    h.asked[0].start();
    h.asked[0].send(pcmBytes(10));
    await until(() => h.played().length === 10);
    h.caller.abort();
    expect(await h.result).toEqual({ state: "stopped" });
    expect(h.saved).toEqual([]);
  });

  it("a piece that fails stops playback, plays nothing after it, and saves nothing", async () => {
    const h = harness(["one.", "two.", "three."]);
    await until(() => h.asked.length === 2);
    h.asked[0].start();
    h.asked[0].send(pcmBytes(10));
    h.asked[0].end();
    await until(() => h.asked.length === 3);
    h.asked[1].start();
    h.asked[1].send(pcmBytes(4));
    h.asked[1].end();
    h.asked[2].reject(new Error("HTTP 503: upstream down"));
    const err = await h.result.catch((e) => e);
    expect(err).toBeInstanceOf(ReadingFailed);
    expect(err.reason).toBe("HTTP 503: upstream down");
    expect(h.out.streams[0].outcome).toEqual({ state: "cancelled" });
    expect(h.saved).toEqual([]);
  });

  it("a piece in another audio format is a failure", async () => {
    const h = harness(["one.", "two."]);
    await until(() => h.asked.length === 2);
    h.asked[0].start();
    h.asked[0].send(pcmBytes(4));
    h.asked[0].end();
    h.asked[1].start({ codec: "pcm", rate: 16000, channels: 1 });
    h.asked[1].end();
    const err = await h.result.catch((e) => e);
    expect(err).toBeInstanceOf(ReadingFailed);
    expect(err.reason).toMatch(/different audio format/);
  });

  it("where the first piece cannot play as a Stream, nothing plays and the pieces asked for are handed over", async () => {
    const h = harness(["one.", "two.", "three."]);
    h.out.canStream = () => ({ ok: false, reason: "no player" });
    await until(() => h.asked.length === 2);
    h.asked[0].start();
    h.asked[0].send(pcmBytes(4));
    const r = await h.result;
    if (r.state !== "files") throw new Error(`expected files, got ${r.state}`);
    expect(r.reason).toBe("no player");
    expect(h.out.plays).toHaveLength(0);
    // No new piece is asked for, and the ones in flight are not cancelled.
    await settle();
    expect(h.asked).toHaveLength(2);
    expect(h.asked.some((p) => p.aborted)).toBe(false);
    const signal = new AbortController().signal;
    expect(r.requested(2, signal)).toBeUndefined();
    const first = r.requested(0, signal)!;
    h.asked[0].end();
    expect(Array.from(Buffer.from((await first).audio).subarray(44))).toEqual(Array.from(pcmBytes(4)));
    // A piece handed over is cancelled with the signal it is asked for with.
    const stopper = new AbortController();
    const second = r.requested(1, stopper.signal)!;
    stopper.abort();
    await expect(second).rejects.toThrow();
    expect(h.asked[1].aborted).toBe(true);
  });
});
