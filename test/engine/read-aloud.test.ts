import { describe, expect, it } from "vitest";
import { REPLACED } from "../../src/engine/player";
import {
  DEFAULT_READ_ALOUD,
  guidelineFor,
  loremWords,
  ReadAloud,
  type ReadAloudOptions,
  splitSummary,
  summaryPrompt,
  truncateToSeconds,
  wordsFor,
} from "../../src/engine/read-aloud";
import type { SpeechResult } from "../../src/engine/speech";

const reply = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];

function harness(result: Partial<SpeechResult> | Error = { player: "mpv" }, options?: Partial<ReadAloudOptions>) {
  const spoken: string[] = [];
  const notes: Array<{ message: string; level: string }> = [];
  const opts: ReadAloudOptions = { ...DEFAULT_READ_ALOUD, ...options };
  const r = new ReadAloud(
    {
      say: async (text: string) => {
        spoken.push(text);
        if (result instanceof Error) throw result;
        return { files: [], model: "m", voice: "v", ...result };
      },
    },
    (message, level) => notes.push({ message, level }),
    () => opts,
  );
  return { r, spoken, notes, opts };
}

const SUMMARY = "<spoken_summary>The fix works. Tests pass.</spoken_summary>";

describe("read-aloud", () => {
  it("starts off and speaks nothing", async () => {
    const h = harness();
    await h.r.onRunEnd(reply("Hello."));
    expect(h.spoken).toEqual([]);
  });

  it("speaks the final reply as readable text", async () => {
    const h = harness();
    h.r.enabled = true;
    await h.r.onRunEnd(reply("# Title\n\nSee [docs](https://x.y/z).\n\n```\ncode\n```"));
    expect(h.spoken).toEqual(["Title.\n\nSee docs."]);
    expect(h.notes).toEqual([]);
  });

  it("skips a reply without words", async () => {
    const h = harness();
    h.r.enabled = true;
    await h.r.onRunEnd(reply("```\nonly code\n```"));
    await h.r.onRunEnd([{ role: "assistant", content: [] }]);
    expect(h.spoken).toEqual([]);
  });

  it("cuts a long reply and says so", async () => {
    const h = harness();
    h.r.enabled = true;
    await h.r.onRunEnd(reply("A sentence that goes on. ".repeat(200)));
    expect(h.spoken[0].length).toBeLessThanOrEqual(2000);
    expect(h.notes[0]).toMatchObject({ level: "info", message: expect.stringMatching(/first \d+ characters/) });
  });

  it("reports a synthesis failure and a playback that did not start, but not a replaced one", async () => {
    let h = harness(new Error("Speech synthesis failed: HTTP 500"));
    h.r.enabled = true;
    await h.r.onRunEnd(reply("Hi."));
    expect(h.notes).toEqual([{ level: "error", message: "Read-aloud failed: Speech synthesis failed: HTTP 500" }]);
    h = harness({ notPlayed: "no audio player found" });
    h.r.enabled = true;
    await h.r.onRunEnd(reply("Hi."));
    expect(h.notes[0]).toMatchObject({ level: "error", message: expect.stringMatching(/no audio player/) });
    h = harness({ notPlayed: REPLACED });
    h.r.enabled = true;
    await h.r.onRunEnd(reply("Hi."));
    expect(h.notes).toEqual([]);
  });

  it("on keeps a summary mode; off turns every mode off", () => {
    const h = harness();
    h.r.enabled = true;
    expect(h.r.mode).toBe("all");
    h.r.mode = "summary";
    h.r.enabled = true;
    expect(h.r.mode).toBe("summary");
    h.r.enabled = false;
    expect(h.r.mode).toBe("off");
  });
});

describe("read-aloud summaries", () => {
  it("states the target length with a lorem-ipsum block of that many words: 38, 75, 150", () => {
    expect([15, 30, 60].map(wordsFor)).toEqual([38, 75, 150]);
    for (const [length, n] of [
      ["minimum", 38],
      ["abridged", 75],
      ["full", 150],
    ] as const) {
      const g = guidelineFor("summary", length);
      expect(g).toContain(loremWords(n));
      expect(g).not.toContain(loremWords(n + 1));
      expect(g).toContain(`${n}-word placeholder`);
    }
    expect(loremWords(75).split(" ")).toHaveLength(75);
    expect(guidelineFor("thinking", "abridged")).toMatch(/summary of your reasoning, then of the reply/);
  });

  it("asks for the guideline only for Summary and Thinking with the same model", () => {
    const h = harness();
    expect(h.r.guideline()).toBeUndefined();
    h.r.mode = "all";
    expect(h.r.guideline()).toBeUndefined();
    h.r.mode = "summary";
    expect(h.r.guideline()).toBe(guidelineFor("summary", "minimum"));
    h.opts.length = "full";
    h.r.mode = "thinking";
    expect(h.r.guideline()).toBe(guidelineFor("thinking", "full"));
    h.opts.summarizer = "anthropic/claude-haiku";
    expect(h.r.guideline()).toBeUndefined();
  });

  it("onRunStart replaces an earlier guideline and leaves the others", () => {
    const h = harness();
    h.r.mode = "summary";
    const list = ["other rule"];
    h.r.onRunStart(list);
    h.r.onRunStart(list);
    expect(list).toEqual(["other rule", guidelineFor("summary", "minimum")]);
    h.r.mode = "off";
    expect(h.r.onRunStart(list)).toEqual(["other rule"]);
  });

  it("splits the marked block off a reply; one left open at the end too", () => {
    expect(splitSummary(`Answer.\n\n${SUMMARY}`)).toEqual({ reply: "Answer.", summary: "The fix works. Tests pass." });
    expect(splitSummary("Answer. <spoken_summary>cut off")).toEqual({ reply: "Answer.", summary: "cut off" });
    expect(splitSummary("No block.")).toEqual({ reply: "No block." });
  });

  it("message_end: the summary is removed from the message and read when the run ends (Summary)", async () => {
    const h = harness();
    h.r.mode = "summary";
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: `Long answer.\n\n${SUMMARY}` },
      ],
      stopReason: "stop",
    };
    const replaced = h.r.onMessageEnd(message);
    expect(replaced).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "Long answer." },
      ],
      stopReason: "stop",
    });
    expect(h.r.onMessageEnd({ role: "assistant", content: [{ type: "text", text: "plain" }] })).toBeUndefined();
    expect(h.r.onMessageEnd({ role: "user", content: [{ type: "text", text: SUMMARY }] })).toBeUndefined();
    await h.r.onRunEnd([replaced]);
    expect(h.spoken).toEqual(["The fix works. Tests pass."]);
    // The next run starts with nothing taken.
    await h.r.onRunEnd(reply("Another answer without one."));
    expect(h.spoken).toHaveLength(1);
    expect(h.notes).toEqual([
      { level: "warning", message: "Read-aloud: the reply has no spoken summary, so nothing was read" },
    ]);
  });

  it("a block only text holds leaves no empty text part", () => {
    const h = harness();
    const out = h.r.onMessageEnd({ role: "assistant", content: [{ type: "text", text: SUMMARY }] });
    expect(out).toEqual({ role: "assistant", content: [] });
  });

  it("All reads the reply without a marked block that slipped in", async () => {
    const h = harness();
    h.r.mode = "all";
    await h.r.onRunEnd(reply(`Whole reply.\n\n${SUMMARY}`));
    expect(h.spoken).toEqual(["Whole reply."]);
  });

  it("another Pi model: one request with the reply (and for Thinking the reasoning); its answer is read", async () => {
    const h = harness(undefined, { summarizer: "anthropic/claude-haiku", length: "minimum" });
    const asked: Array<[string, string]> = [];
    h.r.summarize = async (model, prompt) => {
      asked.push([model, prompt]);
      return "Two things changed.";
    };
    h.r.mode = "summary";
    const run = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "I should check the logs." },
          { type: "text", text: "Done: two things." },
        ],
      },
    ];
    await h.r.onRunEnd(run);
    expect(asked).toHaveLength(1);
    expect(asked[0][0]).toBe("anthropic/claude-haiku");
    expect(asked[0][1]).toBe(summaryPrompt("summary", "minimum", "Done: two things."));
    expect(asked[0][1]).not.toContain("check the logs");
    h.r.mode = "thinking";
    await h.r.onRunEnd(run);
    expect(asked[1][1]).toContain("<reasoning>\nI should check the logs.\n</reasoning>");
    expect(asked[1][1]).toContain("<reply>\nDone: two things.\n</reply>");
    expect(asked[1][1]).toContain(loremWords(38));
    expect(h.spoken).toEqual(["Two things changed.", "Two things changed."]);
  });

  it("another Pi model that fails is reported, and nothing is read", async () => {
    const h = harness(undefined, { summarizer: "anthropic/claude-haiku" });
    h.r.summarize = async () => {
      throw new Error("rate limited");
    };
    h.r.mode = "summary";
    await h.r.onRunEnd(reply("Answer."));
    expect(h.spoken).toEqual([]);
    expect(h.notes).toEqual([
      { level: "error", message: "Read-aloud: the summary by anthropic/claude-haiku failed: rate limited" },
    ]);
  });
});

describe("Truncate at", () => {
  const sentence = (i: number) => `Sentence number ${i} has exactly seven words.`;
  const text = Array.from({ length: 30 }, (_, i) => sentence(i)).join(" ");

  it("stops at the last sentence end before the limit (2.5 words a second)", () => {
    // 15 s is 37 words: five sentences of seven words fit, the sixth does not.
    const r = truncateToSeconds(text, 15);
    expect(r).toEqual({ text: Array.from({ length: 5 }, (_, i) => sentence(i)).join(" "), cut: true });
    expect(truncateToSeconds(text, 0)).toEqual({ text, cut: false });
    expect(truncateToSeconds("Short one.", 15)).toEqual({ text: "Short one.", cut: false });
  });

  it("cuts at a word when even the first sentence is longer than the limit", () => {
    const long = `${"word ".repeat(100)}end.`;
    expect(truncateToSeconds(long, 15).text.split(" ")).toHaveLength(37);
  });

  it("applies in every Read mode", async () => {
    for (const mode of ["all", "summary", "thinking"] as const) {
      const h = harness(undefined, { truncate: 15 });
      h.r.mode = mode;
      const body = mode === "all" ? text : `Answer.\n<spoken_summary>${text}</spoken_summary>`;
      await h.r.onRunEnd(reply(body));
      expect(h.spoken[0], mode).toBe(truncateToSeconds(text, 15).text);
    }
  });
});
