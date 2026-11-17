/**
 * Pure dictation post-processing: domain vocabulary replacements, single-utterance voice slash
 * commands, and trailing submit-word detection, with compiled rule caching so live dictation ticks
 * never re-parse or re-compile regexes.
 */

export interface VocabRules {
  /** Exact/phrase replacements (`wrong -> right`), matched case-insensitively on word boundaries. */
  replacements: Array<{ from: string; to: string; re: RegExp }>;
  /** Bare domain terms (`Pi`, `Zellij`, `Claude`) whose exact casing is enforced when matched. */
  terms: Array<{ term: string; re: RegExp }>;
}

export interface VoiceCommand {
  /** Spoken trigger phrase, lowercased and stripped of punctuation. */
  phrase: string;
  /** Slash command to run (`"/compact"`). */
  command: string;
}

export const VOCAB_EDITOR_HEADER = [
  "# Fix spelling and capitalization in dictated text. One entry per line:",
  '#   Zellij             keep exact capitalization ("zellij" → "Zellij")',
  "#   pie, Pi            replace misheard speech (spoken, written)",
  "#   see make, CMake    phrases work on either side of the comma",
].join("\n");

export const COMMANDS_EDITOR_HEADER = [
  "# Run a slash command by voice. Triggers only when spoken alone, never mid-sentence:",
  '#   /compact                  say "compact" to run /compact',
  "#   clear screen, /clear      map a spoken phrase (phrase, /command)",
  "#   fast model, /model haiku  command arguments and templates work too",
].join("\n");

/** Strip `# ...` comments and blank lines from an editor buffer. */
export function stripEditorComments(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** Format saved lines with the inline `# ...` help header for `ctx.ui.editor`. */
export function formatEditorPrefill(header: string, lines: readonly string[] | undefined): string {
  const body = (lines ?? []).join("\n");
  return body ? `${header}\n\n${body}\n` : `${header}\n\n`;
}

/** Separate leading `# ...` guidance lines from the user's editable entries for custom TUI editors. */
export function splitEditorPrefill(prefill: string | undefined): { guide: string[]; body: string } {
  if (!prefill) return { guide: [], body: "" };
  const lines = prefill.split(/\r?\n/);
  const guide: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i].trimStart().startsWith("#")) {
    guide.push(lines[i].trimStart().replace(/^# ?/, ""));
    i++;
  }
  while (i < lines.length && lines[i].trim() === "") i++;
  return { guide, body: lines.slice(i).join("\n").replace(/\n+$/, "") };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Parse and pre-compile `dictationVocabulary` lines into replacements + bare terms. */
export function parseVocabulary(lines: readonly string[] | undefined): VocabRules {
  const rawReplacements: Array<{ from: string; to: string }> = [];
  const rawTerms: string[] = [];
  for (const raw of lines ?? []) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf(",");
    if (sep > 0) {
      const from = line.slice(0, sep).trim();
      const to = line.slice(sep + 1).trim();
      if (from && to) rawReplacements.push({ from, to });
    } else {
      rawTerms.push(line);
    }
  }
  rawReplacements.sort((a, b) => b.from.length - a.from.length);
  rawTerms.sort((a, b) => b.length - a.length);
  return {
    replacements: rawReplacements.map(({ from, to }) => ({
      from,
      to,
      re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(from)}(?![\\p{L}\\p{N}])`, "giu"),
    })),
    terms: rawTerms.map((term) => ({
      term,
      re: new RegExp(`(?<![\\p{L}\\p{N}-])${escapeRegex(term)}(?![\\p{L}\\p{N}-])`, "giu"),
    })),
  };
}

/** Apply pre-compiled `wrong -> right` replacements and bare-term casing fixes to `text`. */
export function applyVocabulary(text: string, rules: VocabRules): string {
  let out = text;
  for (const { to, re } of rules.replacements) {
    out = out.replace(re, to);
  }
  for (const { term, re } of rules.terms) {
    out = out.replace(re, term);
  }
  return out;
}

const normalizeSpoken = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Parse `dictationCommands` lines (`"/compact"` or `"compact chat, /compact"`). */
export function parseVoiceCommands(lines: readonly string[] | undefined): VoiceCommand[] {
  const out: VoiceCommand[] = [];
  for (const raw of lines ?? []) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sep = line.indexOf(",");
    if (sep > 0) {
      const phrase = normalizeSpoken(line.slice(0, sep));
      const cmd = line.slice(sep + 1).trim();
      if (phrase && cmd.startsWith("/")) out.push({ phrase, command: cmd });
    } else if (line.startsWith("/")) {
      const phrase = normalizeSpoken(line.slice(1));
      if (phrase) out.push({ phrase, command: line });
    }
  }
  return out;
}

/** Return the slash command ONLY if the entire spoken dictation equals its trigger phrase. */
export function matchVoiceCommand(text: string, commands: readonly VoiceCommand[]): string | undefined {
  if (!commands.length) return undefined;
  const spoken = normalizeSpoken(text);
  if (!spoken) return undefined;
  return commands.find((c) => c.phrase === spoken)?.command;
}

function compileSubmitRegex(submitWord: string | undefined): RegExp | undefined {
  const trigger = normalizeSpoken(submitWord ?? "");
  if (!trigger) return undefined;
  const parts = trigger.split(" ").map(escapeRegex).join("[\\s,.;:!?-]+");
  return new RegExp(`(?:^|[\\s,.;:!?-]+)${parts}[\\s.!?,"'”’\\)\\]]*$`, "iu");
}

/**
 * If `submitWord` is set and `text` ends with that word/phrase (ignoring trailing punctuation),
 * strip it and return `{ text, submit: true }`.
 */
export function extractSubmitWord(
  text: string,
  submitWord: string | undefined,
  compiled?: RegExp,
): { text: string; submit: boolean } {
  const re = compiled ?? compileSubmitRegex(submitWord);
  if (!re) return { text, submit: false };
  if (!re.test(text)) return { text, submit: false };
  const stripped = text
    .replace(re, "")
    .replace(/[\s,]+$/, "")
    .trim();
  return { text: stripped, submit: stripped.length > 0 };
}

/** Caches compiled vocabulary, voice commands, and submit-word regexes across live dictation ticks. */
export class DictationRuleCache {
  private vocabSource?: readonly string[];
  private vocabRules: VocabRules = { replacements: [], terms: [] };
  private cmdSource?: readonly string[];
  private cmdRules: VoiceCommand[] = [];
  private submitSource?: string;
  private submitRegex?: RegExp;

  private vocab(lines: readonly string[] | undefined): VocabRules {
    if (lines !== this.vocabSource) {
      this.vocabSource = lines;
      this.vocabRules = parseVocabulary(lines);
    }
    return this.vocabRules;
  }

  private commands(lines: readonly string[] | undefined): VoiceCommand[] {
    if (lines !== this.cmdSource) {
      this.cmdSource = lines;
      this.cmdRules = parseVoiceCommands(lines);
    }
    return this.cmdRules;
  }

  private submitRe(word: string | undefined): RegExp | undefined {
    if (word !== this.submitSource) {
      this.submitSource = word;
      this.submitRegex = compileSubmitRegex(word);
    }
    return this.submitRegex;
  }

  preview(text: string, vocabLines: readonly string[] | undefined): string {
    return applyVocabulary(text, this.vocab(vocabLines));
  }

  finalize(
    rawText: string,
    vocabLines: readonly string[] | undefined,
    commandLines: readonly string[] | undefined,
    submitWord: string | undefined,
  ): { text: string; submit?: boolean; command?: string } {
    const cleaned = applyVocabulary(rawText, this.vocab(vocabLines));
    const cmd = matchVoiceCommand(cleaned, this.commands(commandLines));
    if (cmd) return { text: cleaned, command: cmd };
    const { text, submit } = extractSubmitWord(cleaned, submitWord, this.submitRe(submitWord));
    return { text, submit };
  }
}
