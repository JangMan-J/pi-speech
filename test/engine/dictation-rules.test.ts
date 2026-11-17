import { describe, expect, it } from "vitest";
import {
  applyVocabulary,
  COMMANDS_EDITOR_HEADER,
  DictationRuleCache,
  extractSubmitWord,
  formatEditorPrefill,
  matchVoiceCommand,
  parseVocabulary,
  parseVoiceCommands,
  splitEditorPrefill,
  stripEditorComments,
  VOCAB_EDITOR_HEADER,
} from "../../src/engine/dictation-rules";

describe("dictation rules", () => {
  it("parses vocabulary lines, enforces bare-term casing, and applies wrong, right replacements", () => {
    const lines = stripEditorComments(`
      # comment
      Pi
      Zellij
      zelij, Zellij
      pie speech, pi-speech
    `);
    const rules = parseVocabulary(lines);
    expect(applyVocabulary("open zelij and pie speech for pi", rules)).toBe("open Zellij and pi-speech for Pi");
    // Does not clobber substrings inside other words ("piece", "spike").
    expect(applyVocabulary("a piece of spike", rules)).toBe("a piece of spike");

    const cache = new DictationRuleCache();
    expect(cache.preview("open zelij and pie speech for pi", lines)).toBe("open Zellij and pi-speech for Pi");
    expect(cache.finalize("open zelij, over.", lines, ["/compact"], "over")).toEqual({
      text: "open Zellij",
      submit: true,
    });
  });

  it("matches voice slash commands only when spoken as the sole phrase", () => {
    const cmds = parseVoiceCommands(["/compact", "clear screen, /clear", "/speech"]);
    expect(matchVoiceCommand("Compact.", cmds)).toBe("/compact");
    expect(matchVoiceCommand("clear screen!", cmds)).toBe("/clear");
    expect(matchVoiceCommand("speech", cmds)).toBe("/speech");
    expect(matchVoiceCommand("please compact this file", cmds)).toBeUndefined();
    expect(matchVoiceCommand("compact now", cmds)).toBeUndefined();
  });

  it("strips a trailing submit word (ignoring punctuation) and ignores mid-sentence occurrences", () => {
    expect(extractSubmitWord("fix the bug, over.", "over")).toEqual({
      text: "fix the bug",
      submit: true,
    });
    expect(extractSubmitWord("refactor this send it!", "send it")).toEqual({
      text: "refactor this",
      submit: true,
    });
    expect(extractSubmitWord("send it to bob", "send it")).toEqual({
      text: "send it to bob",
      submit: false,
    });
    expect(extractSubmitWord("over.", "over")).toEqual({ text: "", submit: false });
    expect(extractSubmitWord("hello world", undefined)).toEqual({ text: "hello world", submit: false });
  });

  it("splits leading # guidance lines out of editor prefills so the custom editor shows only saved entries", () => {
    const vocab = splitEditorPrefill(formatEditorPrefill(VOCAB_EDITOR_HEADER, ["pie, Pi", "Zellij"]));
    expect(vocab.guide).toHaveLength(4);
    expect(vocab.guide[0]).toBe("Fix spelling and capitalization in dictated text. One entry per line:");
    expect(vocab.guide.every((l) => !l.startsWith("#"))).toBe(true);
    expect(vocab.body).toBe("pie, Pi\nZellij");

    const emptyCmds = splitEditorPrefill(formatEditorPrefill(COMMANDS_EDITOR_HEADER, undefined));
    expect(emptyCmds.guide).toHaveLength(4);
    expect(emptyCmds.guide[0]).toContain("Run a slash command by voice.");
    expect(emptyCmds.body).toBe("");
  });
});
