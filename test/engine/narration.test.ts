import { describe, expect, it } from "vitest";
import {
  FADE_MS,
  FIRST_HOLD_MS,
  HOLD_CHARS,
  MAX_HOLD_MS,
  MIN_HOLD_MS,
  MIN_WORDS,
  Narrator,
  type NarratorDeps,
} from "../../src/engine/read-aloud";

/** A clock and timers the test moves by hand. */
function clock() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => now,
    after(ms: number, fn: () => void) {
      const t = { at: now + ms, fn };
      timers.push(t);
      return () => {
        timers = timers.filter((x) => x !== t);
      };
    },
    /** Move the clock on by `ms`, running the timers due, and letting promises settle between them. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await flush();
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
      await flush();
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function harness(opts: { summaryMs?: number; maxWords?: number } = {}) {
  const c = clock();
  const asked: Array<{ text: string; words: number; at: number }> = [];
  const spoken: Array<{ text: string; fade: boolean; at: number }> = [];
  let speakingUntil = 0;
  const deps: NarratorDeps = {
    now: c.now,
    after: c.after,
    maxWords: () => opts.maxWords ?? 38,
    async summarize(text, words) {
      asked.push({ text, words, at: c.now() });
      if (opts.summaryMs) await new Promise<void>((r) => c.after(opts.summaryMs ?? 0, r));
      return `summary of ${text.slice(0, 12)}`;
    },
    async speak(text, fade) {
      spoken.push({ text, fade, at: c.now() });
      speakingUntil = c.now() + 3000; // each summary speaks for 3 s
    },
    speaking: () => c.now() < speakingUntil,
  };
  return { n: new Narrator(deps), c, asked, spoken };
}

const words = (n: number) => "x".repeat(n);

describe("narration pacing", () => {
  it("holds a lone short thought for the next, then summarizes what gathered as one", async () => {
    const h = harness();
    h.n.thought(words(100));
    await h.c.advance(1000);
    h.n.thought(words(100));
    expect(h.asked).toHaveLength(0);
    await h.c.advance(10_000);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0].text).toBe(`${words(100)}\n\n${words(100)}`);
  });

  it("does not wait once enough text has gathered", async () => {
    const h = harness();
    h.n.thought(words(HOLD_CHARS));
    await h.c.advance(0);
    expect(h.asked).toHaveLength(1);
  });

  it("waits longer for a sparse thinker and less for a quick one, within bounds", async () => {
    const h = harness();
    expect(h.n.holdMs()).toBe(FIRST_HOLD_MS);
    for (let i = 0; i < 6; i++) {
      h.n.thought(words(50));
      await h.c.advance(20_000);
    }
    expect(h.n.holdMs()).toBe(MAX_HOLD_MS);
    const quick = harness();
    for (let i = 0; i < 6; i++) {
      quick.n.thought(words(50));
      await quick.c.advance(200);
    }
    expect(quick.n.holdMs()).toBe(MIN_HOLD_MS);
  });

  it("sizes each summary to the time before the next thought: short for a fast thinker, full for a slow one", async () => {
    const fast = harness({ maxWords: 75 });
    for (let i = 0; i < 8; i++) {
      fast.n.thought(words(HOLD_CHARS)); // verbose: summarized at once
      await fast.c.advance(1500);
    }
    expect(fast.asked.at(-1)?.words).toBeLessThanOrEqual(5 + MIN_WORDS);
    const slow = harness({ maxWords: 75 });
    for (let i = 0; i < 8; i++) {
      slow.n.thought(words(HOLD_CHARS));
      await slow.c.advance(40_000);
    }
    expect(slow.asked.at(-1)?.words).toBe(75);
  });

  it("waits for the summary speaking to finish, unless it has fallen behind: then it crossfades", async () => {
    const h = harness({ summaryMs: 500 });
    h.n.thought(words(HOLD_CHARS));
    await h.c.advance(600);
    expect(h.spoken).toEqual([expect.objectContaining({ fade: false, at: 500 })]);
    // A thought while the first speaks, nothing newer behind it: it waits for the first to end.
    h.n.thought(words(HOLD_CHARS));
    await h.c.advance(5000);
    expect(h.spoken[1]).toMatchObject({ fade: false, at: 3500 });
    // Thoughts come faster than they are spoken: the next summary crossfades over the one speaking.
    h.n.thought(words(HOLD_CHARS));
    await h.c.advance(100);
    h.n.thought(words(HOLD_CHARS));
    await h.c.advance(1000);
    expect(h.spoken.some((s) => s.fade)).toBe(true);
    expect(FADE_MS).toBe(500);
  });

  it("says what is held at once when the run ends, and a new run forgets it", async () => {
    const h = harness();
    h.n.thought(words(50));
    h.n.end();
    await h.c.advance(0);
    expect(h.asked).toHaveLength(1);
    h.n.reset();
    h.n.thought(words(50));
    h.n.reset();
    await h.c.advance(20_000);
    expect(h.asked).toHaveLength(1);
  });
});
