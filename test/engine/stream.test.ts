import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AudioOutput, PlayOutcome, PlayStart } from "../../src/engine/audio";
import type { SavedMessage } from "../../src/engine/history";
import { wrapPcmAsWav } from "../../src/engine/openrouter";
import { Player } from "../../src/engine/player";
import type { SynthesizedAudio } from "../../src/engine/provider";
import { IN_FLIGHT, ReadingFailed, type StreamDeps, speakInPieces } from "../../src/engine/stream";

const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const pcm = (i: number) => new Uint8Array(10).fill(i + 1);
const wav = (i: number, rate = 24000) => wrapPcmAsWav(pcm(i), rate, 1);

interface Request {
  text: string;
  signal: AbortSignal;
  resolve(a: SynthesizedAudio): void;
  reject(e: Error): void;
}

/** A stream over a fake output and a fake speech service answered by hand. */
function harness(opts: { convert?: (from: string, to: string) => Promise<boolean>; refuse?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-speech-stream-"));
  const plays: string[] = [];
  const playedBytes: Buffer[] = [];
  const endings: Array<(o: PlayOutcome) => void> = [];
  const stopped: string[] = [];
  const output: AudioOutput = {
    name: "fake",
    async play(file): Promise<PlayStart> {
      if (opts.refuse) return { ok: false, reason: opts.refuse };
      plays.push(file);
      playedBytes.push(readFileSync(file));
      let end!: (o: PlayOutcome) => void;
      const done = new Promise<PlayOutcome>((r) => {
        end = r;
      });
      endings.push(end);
      return {
        ok: true,
        player: "fake",
        done,
        stop: async () => {
          stopped.push(file);
          end({ state: "cancelled" });
        },
      };
    },
    async stop() {},
  };
  const states: boolean[] = [];
  const player = new Player(() => output, { onChange: (s) => states.push(s) });
  const requests: Request[] = [];
  const saved: Uint8Array[] = [];
  let saving: Promise<void> | undefined;
  const deps = (pieces: string[]): StreamDeps => ({
    pieces,
    player,
    synthesize: (text, signal) =>
      new Promise<SynthesizedAudio>((resolve, reject) => {
        const req = { text, signal, resolve, reject };
        requests.push(req);
        signal.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      }),
    convert:
      opts.convert ??
      (async () => {
        throw new Error("no conversion expected");
      }),
    save: async (w): Promise<SavedMessage> => {
      await saving;
      saved.push(w);
      return { files: ["m.wav", "m.mp3"], wav: "m.wav", mp3: "m.mp3" };
    },
    tmpRoot: dir,
  });
  return {
    dir,
    player,
    plays,
    playedBytes,
    stopped,
    states,
    requests,
    saved,
    deps,
    /** The playback of piece `i` (in play order) finished. */
    finish: async (i: number) => {
      endings[i]({ state: "completed" });
      await tick();
    },
    answer: async (i: number, a: SynthesizedAudio = { audio: wav(i), format: "wav" }) => {
      requests[i].resolve(a);
      await tick();
    },
    tempFiles: () => readdirSync(dir, { recursive: true }),
    /** Saving waits until `release` is called. */
    holdSaving: () => {
      let release!: () => void;
      saving = new Promise<void>((r) => {
        release = r;
      });
      return release;
    },
  };
}

const PIECES = ["one", "two", "three", "four"];

/** A run expected to fail: handled at once, so its rejection is never unhandled while the test goes on. */
const failing = (run: Promise<unknown>) => {
  run.catch(() => {});
  return run;
};

describe("speaking a text in pieces", () => {
  it("asks for the first piece first, keeps at most 2 requests in flight, and starts the next when a slot frees", async () => {
    const h = harness();
    const run = speakInPieces(h.deps(PIECES));
    await tick();
    expect(IN_FLIGHT).toBe(2);
    expect(h.requests.map((r) => r.text)).toEqual(["one", "two"]);
    await h.answer(1);
    expect(h.requests.map((r) => r.text)).toEqual(["one", "two", "three"]);
    expect(h.plays).toEqual([]);
    await h.answer(0);
    expect(h.requests.map((r) => r.text)).toEqual(["one", "two", "three", "four"]);
    await h.answer(2);
    await h.answer(3);
    const r = await run;
    expect(r.state).toBe("saved");
  });

  it("plays each piece once it is ready and the one before has finished, in order, as one playback", async () => {
    const h = harness();
    const run = speakInPieces(h.deps(PIECES));
    await tick();
    await h.answer(1);
    expect(h.plays.length).toBe(0);
    await h.answer(0);
    expect(h.plays.length).toBe(1);
    expect(h.player.playing).toBe(true);
    await h.answer(2);
    expect(h.plays.length).toBe(1);
    await h.finish(0);
    expect(h.plays.length).toBe(2);
    await h.finish(1);
    expect(h.plays.length).toBe(3);
    await h.finish(2);
    expect(h.plays.length).toBe(3);
    expect(h.player.playing).toBe(true);
    await h.answer(3);
    expect(h.plays.length).toBe(4);
    const r = await run;
    expect(r).toMatchObject({ state: "saved", player: "fake" });
    expect(h.player.playing).toBe(true);
    await h.finish(3);
    expect(h.player.playing).toBe(false);
    expect(h.states.filter((s) => !s)).toEqual([false]);
    expect(h.playedBytes.map((b) => b[44])).toEqual([1, 2, 3, 4]);
    expect(h.tempFiles()).toEqual([]);
  });

  it("saves one message: the pieces' data joined under one header, once every piece is synthesized", async () => {
    const h = harness();
    const run = speakInPieces(h.deps(PIECES.slice(0, 3)));
    await tick();
    await h.answer(0);
    await h.answer(1);
    expect(h.saved).toEqual([]);
    await h.answer(2);
    const r = await run;
    expect(r).toMatchObject({ state: "saved", saved: { files: ["m.wav", "m.mp3"] } });
    expect(h.saved.length).toBe(1);
    const b = Buffer.from(h.saved[0]);
    expect(b.readUInt32LE(40)).toBe(30);
    expect([...b.subarray(44)]).toEqual([...pcm(0), ...pcm(1), ...pcm(2)]);
  });

  it("converts MP3 pieces to WAV with the converter", async () => {
    const h = harness({
      convert: async (from, to) => {
        expect(from.endsWith(".mp3")).toBe(true);
        writeFileSync(to, wav(Number(readFileSync(from)[0])));
        return true;
      },
    });
    const run = speakInPieces(h.deps(PIECES.slice(0, 2)));
    await tick();
    await h.answer(0, { audio: new Uint8Array([0]), format: "mp3" });
    await h.answer(1, { audio: new Uint8Array([1]), format: "mp3" });
    const r = await run;
    expect(r.state).toBe("saved");
    expect([...Buffer.from(h.saved[0]).subarray(44)]).toEqual([...pcm(0), ...pcm(1)]);
    await h.finish(0);
    await h.finish(1);
    expect(h.tempFiles()).toEqual([]);
  });

  it("cannot stream when the first piece cannot become WAV: nothing plays, nothing is left", async () => {
    const h = harness({ convert: async () => false });
    const run = speakInPieces(h.deps(PIECES));
    await tick();
    await h.answer(0, { audio: new Uint8Array([0]), format: "mp3" });
    const r = await run;
    expect(r.state).toBe("unchunkable");
    expect(h.plays).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.requests[1].signal.aborted).toBe(true);
    expect(h.tempFiles()).toEqual([]);
  });

  it("decides from the first piece only: a later piece that cannot become WAV before it is a failure", async () => {
    const h = harness({ convert: async () => false });
    const run = failing(speakInPieces(h.deps(PIECES)));
    await tick();
    await h.answer(1, { audio: new Uint8Array([1]), format: "mp3" });
    expect(h.requests[0].signal.aborted).toBe(false);
    await h.answer(0);
    await expect(run).rejects.toThrow(ReadingFailed);
    expect(h.saved).toEqual([]);
  });

  it("cannot stream when the first piece cannot become WAV, even after a later piece could not", async () => {
    const h = harness({ convert: async () => false });
    const run = speakInPieces(h.deps(PIECES));
    await tick();
    await h.answer(1, { audio: new Uint8Array([1]), format: "mp3" });
    await h.answer(0, { audio: new Uint8Array([0]), format: "mp3" });
    expect((await run).state).toBe("unchunkable");
    expect(h.plays).toEqual([]);
  });

  it("plays the pieces from a private temporary directory, removed at the end", async () => {
    const h = harness();
    const run = speakInPieces(h.deps(PIECES.slice(0, 2)));
    await tick();
    await h.answer(0);
    const [file] = h.plays;
    expect(file.startsWith(h.dir)).toBe(true);
    const sub = file.slice(h.dir.length + 1).split("/");
    expect(sub.length).toBe(2);
    expect(sub[0]).toMatch(/^pi-speech-.+/);
    await h.answer(1);
    await run;
    await h.finish(0);
    await h.finish(1);
    expect(h.tempFiles()).toEqual([]);
  });

  it("still saves when the first piece cannot be played", async () => {
    const h = harness({ refuse: "no audio player found" });
    const run = speakInPieces(h.deps(PIECES.slice(0, 2)));
    await tick();
    await h.answer(0);
    await h.answer(1);
    expect(await run).toMatchObject({ state: "saved", notPlayed: "no audio player found" });
    expect(h.tempFiles()).toEqual([]);
  });
});

describe("stopping or replacing a reading", () => {
  const stages = {
    "before the first piece": async (_h: ReturnType<typeof harness>) => {
      await tick();
    },
    "between pieces": async (h: ReturnType<typeof harness>) => {
      await tick();
      await h.answer(0);
      await h.finish(0);
    },
    "after the last request": async (h: ReturnType<typeof harness>) => {
      await tick();
      await h.answer(0);
      await h.answer(1);
      await h.answer(2);
      expect(h.requests.length).toBe(4);
    },
  };
  const ends = {
    stop: (h: ReturnType<typeof harness>) => h.player.stop(),
    "a newer playback": async (h: ReturnType<typeof harness>) => {
      const ticket = h.player.claim();
      const file = join(h.dir, "newer.wav");
      writeFileSync(file, wav(9));
      await h.player.play(file, "message", { ticket });
    },
  };
  for (const [stage, reach] of Object.entries(stages)) {
    for (const [how, end] of Object.entries(ends)) {
      it(`${how} ${stage} cancels the rest and saves nothing`, async () => {
        const h = harness();
        const run = speakInPieces(h.deps(PIECES));
        await reach(h);
        const asked = h.requests.length;
        const played = h.plays.length;
        await end(h);
        await tick();
        expect(h.requests.every((r) => r.signal.aborted)).toBe(true);
        expect(await run).toEqual({ state: "stopped" });
        await tick();
        expect(h.requests.length).toBe(asked);
        const newer = how === "a newer playback" ? 1 : 0;
        expect(h.plays.length).toBe(played + newer);
        expect(h.saved).toEqual([]);
        if (how === "stop") expect(h.player.playing).toBe(false);
        // The piece the stop interrupted has ended, so its file is gone too.
        expect(h.tempFiles().filter((f) => f !== "newer.wav")).toEqual([]);
      });
    }
  }

  it("a stop after every piece is synthesized keeps the saved message and stops the audio", async () => {
    const h = harness();
    const run = speakInPieces(h.deps(PIECES.slice(0, 2)));
    await tick();
    await h.answer(0);
    await h.answer(1);
    expect((await run).state).toBe("saved");
    await h.player.stop();
    await tick();
    expect(h.plays.length).toBe(1);
    expect(h.stopped.length).toBe(1);
    expect(h.tempFiles()).toEqual([]);
  });

  it("a caller's abort while the joined message is saved stops the playing piece and plays no more", async () => {
    const h = harness();
    const ac = new AbortController();
    const release = h.holdSaving();
    const run = speakInPieces({ ...h.deps(PIECES.slice(0, 2)), signal: ac.signal });
    await tick();
    await h.answer(0);
    await h.answer(1);
    expect(h.plays.length).toBe(1);
    ac.abort();
    await tick();
    expect(h.stopped.length).toBe(1);
    release();
    expect((await run).state).toBe("saved");
    await tick();
    expect(h.plays.length).toBe(1);
    expect(h.player.playing).toBe(false);
    expect(h.tempFiles()).toEqual([]);
  });

  it("a caller's abort while the last pieces play stops them", async () => {
    const h = harness();
    const ac = new AbortController();
    const run = speakInPieces({ ...h.deps(PIECES.slice(0, 2)), signal: ac.signal });
    await tick();
    await h.answer(0);
    await h.answer(1);
    expect((await run).state).toBe("saved");
    ac.abort();
    await tick();
    expect(h.stopped.length).toBe(1);
    expect(h.plays.length).toBe(1);
    expect(h.player.playing).toBe(false);
  });

  it("a caller's abort stops the reading", async () => {
    const h = harness();
    const ac = new AbortController();
    const run = speakInPieces({ ...h.deps(PIECES), signal: ac.signal });
    await tick();
    ac.abort();
    expect(await run).toEqual({ state: "stopped" });
    expect(h.requests.every((r) => r.signal.aborted)).toBe(true);
  });
});

describe("a failed request ends the reading", () => {
  it("when the first piece fails nothing plays, the other request is aborted and nothing is saved", async () => {
    const h = harness();
    const run = failing(speakInPieces(h.deps(PIECES)));
    await tick();
    h.requests[0].reject(new Error("Speech synthesis failed: HTTP 500: injected failure"));
    await expect(run).rejects.toThrow(ReadingFailed);
    await expect(run).rejects.toThrow("Speech synthesis failed: HTTP 500: injected failure");
    await tick();
    expect(h.requests.length).toBe(2);
    expect(h.requests[1].signal.aborted).toBe(true);
    expect(h.plays).toEqual([]);
    expect(h.saved).toEqual([]);
    expect(h.player.playing).toBe(false);
  });

  it("between pieces the piece already playing may finish, and no later piece plays", async () => {
    const h = harness();
    const run = failing(speakInPieces(h.deps(PIECES)));
    await tick();
    await h.answer(0);
    expect(h.plays.length).toBe(1);
    h.requests[1].reject(new Error("Speech synthesis failed: HTTP 429: slow down"));
    await expect(run).rejects.toThrow(/HTTP 429/);
    expect(h.stopped).toEqual([]);
    expect(h.player.playing).toBe(true);
    expect(h.requests[2].signal.aborted).toBe(true);
    await h.finish(0);
    expect(h.plays.length).toBe(1);
    expect(h.player.playing).toBe(false);
    expect(h.saved).toEqual([]);
    expect(h.tempFiles()).toEqual([]);
  });

  it("after the last request nothing more plays and nothing is saved", async () => {
    const h = harness();
    const run = failing(speakInPieces(h.deps(PIECES)));
    await tick();
    await h.answer(0);
    await h.answer(1);
    await h.answer(2);
    h.requests[3].reject(new Error("Speech synthesis failed: HTTP 502: bad gateway"));
    await expect(run).rejects.toThrow(/HTTP 502/);
    await h.finish(0);
    expect(h.plays.length).toBe(1);
    expect(h.saved).toEqual([]);
    await tick();
    expect(h.tempFiles()).toEqual([]);
    expect(existsSync(h.dir)).toBe(true);
  });

  it("after the first piece started, a piece in a different format is a failure: no later piece plays", async () => {
    const h = harness();
    const run = failing(speakInPieces(h.deps(PIECES)));
    await tick();
    await h.answer(0);
    expect(h.plays.length).toBe(1);
    await h.answer(1, { audio: wav(1, 16000), format: "wav" });
    await expect(run).rejects.toThrow(/different audio format/);
    expect(h.requests.slice(2).every((r) => r.signal.aborted)).toBe(true);
    await h.finish(0);
    expect(h.plays.length).toBe(1);
    expect(h.saved).toEqual([]);
    expect(h.tempFiles()).toEqual([]);
  });

  it("after the first piece started, a piece whose conversion fails is a failure: no later piece plays", async () => {
    const h = harness({
      convert: async (from, to) => {
        const i = Number(readFileSync(from)[0]);
        if (i !== 0) return false;
        writeFileSync(to, wav(i));
        return true;
      },
    });
    const run = failing(speakInPieces(h.deps(PIECES)));
    await tick();
    await h.answer(0, { audio: new Uint8Array([0]), format: "mp3" });
    expect(h.plays.length).toBe(1);
    await h.answer(1, { audio: new Uint8Array([1]), format: "mp3" });
    await expect(run).rejects.toThrow(/could not be converted to WAV/);
    await h.finish(0);
    expect(h.plays.length).toBe(1);
    expect(h.saved).toEqual([]);
    expect(h.tempFiles()).toEqual([]);
  });
});
