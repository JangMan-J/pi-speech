import { describe, expect, it } from "vitest";
import { REPLACED } from "../../src/engine/player";
import { ReadAloud } from "../../src/engine/read-aloud";
import type { SpeechResult } from "../../src/engine/speech";

const reply = (text: string) => [{ role: "assistant", content: [{ type: "text", text }] }];

function harness(result: Partial<SpeechResult> | Error = { player: "mpv" }) {
  const spoken: string[] = [];
  const notes: Array<{ message: string; level: string }> = [];
  const r = new ReadAloud(
    {
      say: async (text: string) => {
        spoken.push(text);
        if (result instanceof Error) throw result;
        return { files: [], model: "m", voice: "v", ...result };
      },
    },
    (message, level) => notes.push({ message, level }),
  );
  return { r, spoken, notes };
}

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
});
