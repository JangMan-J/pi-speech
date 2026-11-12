import { describe, expect, it } from "vitest";
import { cutForSpeech, finalAssistantText, MAX_SPOKEN_CHARS, speakable } from "../../src/engine/readable";

describe("speakable text", () => {
  it("leaves plain text as it is", () => {
    expect(speakable("The answer is forty two.")).toBe("The answer is forty two.");
    expect(speakable("One. Two!  Three?")).toBe("One. Two!  Three?");
  });

  it("removes markdown formatting and keeps the words", () => {
    const md = "# Release notes\n\nSome **bold** and *italic* and __strong__ and ~~gone~~ and `code` text.";
    expect(speakable(md)).toBe("Release notes.\n\nSome bold and italic and strong and gone and code text.");
  });

  it("skips fenced code blocks", () => {
    expect(speakable("Before.\n\n```js\nconst x = 1;\n```\n\nAfter.")).toBe("Before.\n\nAfter.");
    expect(speakable("Before.\n~~~\nraw\n~~~\nAfter.")).toBe("Before.\nAfter.");
  });

  it("reads links as their text and drops bare URLs to their host", () => {
    expect(speakable("See [the docs](https://example.com/page) now.")).toBe("See the docs now.");
    expect(speakable("Image ![a cat](http://x.y/cat.png) here.")).toBe("Image a cat here.");
    expect(speakable("Go to https://example.com/a/b?c=d today.")).toBe("Go to example.com today.");
    expect(speakable("Mail <https://example.org/x>.")).toBe("Mail example.org.");
  });

  it("drops list markers, quotes, rules, and table pipes", () => {
    expect(speakable("- one\n* two\n1. three\n> quoted\n---\n| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
      "one\ntwo\nthree\nquoted\na, b\n1, 2",
    );
  });

  it("keeps underscores inside words", () => {
    expect(speakable("Use snake_case_names here.")).toBe("Use snake_case_names here.");
  });
});

describe("cutting long replies", () => {
  it("keeps short text whole", () => {
    expect(cutForSpeech("Short. Text.")).toEqual({ text: "Short. Text.", cut: false });
  });

  it("cuts at the last sentence boundary within the limit", () => {
    const long = Array.from({ length: 70 }, (_, i) => `This is sentence number ${i + 1} of a very long reply.`).join(
      " ",
    );
    const r = cutForSpeech(long);
    expect(r.cut).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(MAX_SPOKEN_CHARS);
    expect(r.text.length).toBeGreaterThan(1900);
    expect(r.text.endsWith(".")).toBe(true);
    expect(long.startsWith(r.text)).toBe(true);
  });

  it("cuts at a word when there is no sentence boundary", () => {
    const words = "word ".repeat(600);
    const r = cutForSpeech(words, 100);
    expect(r.cut).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100);
    expect(r.text.endsWith("word")).toBe(true);
  });
});

describe("the final reply of a run", () => {
  it("takes the text parts of the last assistant message", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "toolResult", content: [] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "Final" },
          { type: "text", text: "words." },
        ],
      },
    ];
    expect(finalAssistantText(messages)).toBe("Final\nwords.");
  });

  it("is empty when the last assistant message has no text", () => {
    expect(finalAssistantText([{ role: "assistant", content: [{ type: "toolCall" }] }])).toBe("");
    expect(finalAssistantText([])).toBe("");
  });
});
