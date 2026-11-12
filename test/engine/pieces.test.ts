import { describe, expect, it } from "vitest";
import { FIRST_PIECE_MAX, FIRST_PIECE_MIN, PIECE_MAX, splitForSpeech } from "../../src/engine/pieces";

const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const squash = (t: string) => t.replace(/\s+/g, "");

/** The rules every split keeps: nothing lost, repeated or added; the size limits. */
function expectPieces(text: string, pieces: string[]) {
  expect(norm(pieces.join(" "))).toBe(norm(text));
  expect(pieces.length).toBeGreaterThan(1);
  expect(pieces[0].length).toBeGreaterThanOrEqual(FIRST_PIECE_MIN);
  expect(pieces[0].length).toBeLessThanOrEqual(FIRST_PIECE_MAX);
  for (const p of pieces) {
    expect(p.length).toBeLessThanOrEqual(PIECE_MAX);
    expect(p).toBe(p.trim());
    expect(p.length).toBeGreaterThan(0);
  }
}

describe("splitting a long text into pieces", () => {
  it("splits at sentence ends, with a short first piece and whole sentences after it", () => {
    const sentences = Array.from(
      { length: 12 },
      (_, i) => `Sentence number ${i + 1} says that the streamed reading should begin early and never lose a word.`,
    );
    const text = sentences.join(" ");
    const pieces = splitForSpeech(text);
    expectPieces(text, pieces);
    expect(pieces[0]).toBe(sentences[0]);
    for (const p of pieces) expect(p).toMatch(/[.!?]$/);
    expect(pieces.length).toBeGreaterThanOrEqual(4);
  });

  it("takes several short sentences for the first piece until it holds 40 characters", () => {
    const text = `Yes. Done. It works now. ${"Here is a longer sentence with more words in it. ".repeat(10)}`.trim();
    const pieces = splitForSpeech(text);
    expectPieces(text, pieces);
    expect(pieces[0]).toBe("Yes. Done. It works now. Here is a longer sentence with more words in it.");
  });

  it("keeps paragraphs and line breaks out of the pieces' ends", () => {
    const para = "This paragraph has a few sentences. They are not very long. But together they add up.";
    const text = [para, para, para, para, para].join("\n\n");
    const pieces = splitForSpeech(text);
    expectPieces(text, pieces);
    for (const p of pieces) expect(p).toMatch(/\.$/);
  });

  it("does not end a piece at an abbreviation, an initial or a lowercase continuation", () => {
    const text =
      "Mr. Smith and Dr. Jones met J. R. Tolkien at 3 p.m. in the hall, e.g. near the door, vs. the garden. " +
      "That meeting went well for everyone. ".repeat(10);
    const pieces = splitForSpeech(text.trim());
    expectPieces(text, pieces);
    expect(pieces[0]).toBe(
      "Mr. Smith and Dr. Jones met J. R. Tolkien at 3 p.m. in the hall, e.g. near the door, vs. the garden.",
    );
  });

  it("cuts text without punctuation at a word boundary", () => {
    const text = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const pieces = splitForSpeech(text);
    expectPieces(text, pieces);
    for (const p of pieces.slice(0, -1)) expect(text).toContain(`${p} `);
  });

  it("cuts one huge sentence at a clause boundary", () => {
    const text = `${Array.from({ length: 30 }, (_, i) => `clause number ${i} goes here`).join(", ")}.`;
    expect(text.length).toBeGreaterThan(600);
    const pieces = splitForSpeech(text);
    expectPieces(text, pieces);
    for (const p of pieces.slice(0, -1)) expect(p).toMatch(/,$/);
  });

  it("splits a text that is one sentence over 280 characters", () => {
    const text = `This one sentence runs on and on ${"and then some more ".repeat(16)}until it finally stops here.`;
    expect(text.length).toBeGreaterThan(280);
    const pieces = splitForSpeech(text);
    expectPieces(text, pieces);
  });

  it("splits Japanese at 。 without spaces", () => {
    const s = "これは日本語の文章で、音声で読み上げるためのテストです。";
    const text = s.repeat(20);
    const pieces = splitForSpeech(text);
    expect(squash(pieces.join(""))).toBe(squash(text));
    expect(pieces[0].length).toBeGreaterThanOrEqual(FIRST_PIECE_MIN);
    expect(pieces[0].length).toBeLessThanOrEqual(FIRST_PIECE_MAX);
    for (const p of pieces) {
      expect(p).toMatch(/。$/);
      expect(p.length).toBeLessThanOrEqual(PIECE_MAX);
    }
  });

  it("cuts unpunctuated text without spaces at the limit, never inside a surrogate pair", () => {
    const text = "あ😀".repeat(400);
    const pieces = splitForSpeech(text);
    expect(pieces.join("")).toBe(text);
    expect(pieces[0].length).toBeLessThanOrEqual(FIRST_PIECE_MAX);
    for (const p of pieces) {
      expect(p.length).toBeLessThanOrEqual(PIECE_MAX);
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p)).toBe(false);
    }
  });

  it("keeps a short text whole", () => {
    expect(splitForSpeech("Short and sweet.")).toEqual(["Short and sweet."]);
  });
});
