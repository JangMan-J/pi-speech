/**
 * Assistant read-aloud: what is spoken once a run ends. It starts Off in every session; its options (who
 * summarizes, how long a summary is, where reading stops) are saved in the settings.
 *
 * - All reads the whole final reply as readable text.
 * - Summary reads a spoken summary of the reply; Thinking a spoken summary of the reasoning, then of the reply.
 *   With the same model, a guideline in the system prompt asks the model to end each reply with the summary
 *   between markers; the marked block is taken out of the finished message (so it is neither shown nor kept in
 *   the history) and read. With another Pi model, one extra request per reply asks that model for the summary.
 * - Truncate at stops reading at the last sentence end before the limit, in every mode.
 */

import { errorMessage } from "./env";
import { REPLACED } from "./player";
import { cutForSpeech, finalAssistantText, speakable } from "./readable";
import { ReadingFailed, readingFailedMessage } from "./reading";
import type { Speech } from "./speech";

export type Notify = (message: string, level: "info" | "warning" | "error") => void;

/** What is read once a run ends. */
export type ReadMode = "off" | "summary" | "thinking" | "all";
export const READ_MODES: ReadMode[] = ["off", "summary", "thinking", "all"];

/** The target length of a summary. */
export type SummaryLength = "minimum" | "abridged" | "full";
export const SUMMARY_LENGTHS: SummaryLength[] = ["minimum", "abridged", "full"];
export const LENGTH_SECONDS: Record<SummaryLength, number> = { minimum: 15, abridged: 30, full: 60 };

/** Where reading stops, in seconds; 0 is Off. */
export const TRUNCATE_SECONDS = [0, 15, 30, 60, 120];

/** Speech runs at about this many words a second. */
export const WORDS_PER_SECOND = 2.5;

export interface ReadAloudOptions {
  /** The Pi model (`provider/id`) that summarizes; undefined: the same model, in the same reply. */
  summarizer?: string;
  length: SummaryLength;
  /** Seconds; 0 reads to the end. */
  truncate: number;
}

export const DEFAULT_READ_ALOUD: Readonly<ReadAloudOptions> = Object.freeze({ length: "minimum", truncate: 0 });

/** The markers around the spoken summary at the end of a reply. */
export const SUMMARY_OPEN = "<spoken_summary>";
export const SUMMARY_CLOSE = "</spoken_summary>";
/** Every guideline of read-aloud starts with this, so an earlier one can be found and replaced. */
export const GUIDELINE_PREFIX = "pi-speech read-aloud:";

/** Asks another model for a summary: resolves to its answer's text. */
export type Summarize = (model: string, prompt: string, signal?: AbortSignal) => Promise<string>;

const LOREM =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat".split(
    " ",
  );

/** Words in `seconds` of speech: 38, 75 and 150 for 15, 30 and 60 s. */
export const wordsFor = (seconds: number) => Math.round(seconds * WORDS_PER_SECOND);

/** `n` words of lorem ipsum: a placeholder as long as the summary should be. */
export function loremWords(n: number): string {
  return Array.from({ length: n }, (_, i) => LOREM[i % LOREM.length]).join(" ");
}

/** What a summary is asked to say, by mode. */
function what(mode: "summary" | "thinking", whose: "your" | "the"): string {
  return mode === "thinking"
    ? `a spoken summary of ${whose} reasoning, then of the reply`
    : `a spoken summary of ${whose === "your" ? "that" : "the"} reply`;
}

function lengthClause(length: SummaryLength): string {
  const seconds = LENGTH_SECONDS[length];
  const n = wordsFor(seconds);
  return `Make it about as long as this ${n}-word placeholder (about ${seconds} seconds spoken): ${loremWords(n)}`;
}

const SPOKEN_STYLE = "written to be heard: plain sentences in the reply's language, no markdown, code, lists or links.";

/** The system-prompt guideline that asks the model for a marked summary at the end of each reply. */
export function guidelineFor(mode: "summary" | "thinking", length: SummaryLength): string {
  return (
    `${GUIDELINE_PREFIX} end every final reply to the user with ${what(mode, "your")}, between ${SUMMARY_OPEN} ` +
    `and ${SUMMARY_CLOSE}, ${SPOKEN_STYLE} It is read aloud and hidden from the transcript, so never refer to it. ` +
    lengthClause(length)
  );
}

/** The one extra request to another model: the reply (and the reasoning, for Thinking), asking for the summary. */
export function summaryPrompt(
  mode: "summary" | "thinking",
  length: SummaryLength,
  reply: string,
  reasoning?: string,
): string {
  const parts = [
    `Write ${what(mode, "the")} below, to be read aloud by text-to-speech, ${SPOKEN_STYLE} ${lengthClause(length)}`,
    "Answer with the summary only.",
  ];
  if (mode === "thinking" && reasoning) parts.push(`<reasoning>\n${reasoning}\n</reasoning>`);
  parts.push(`<reply>\n${reply}\n</reply>`);
  return parts.join("\n\n");
}

/**
 * A reply without its marked summary: every block between the markers is removed (one left open at the end
 * too), and the last one's text is the summary.
 */
export function splitSummary(text: string): { reply: string; summary?: string } {
  let reply = "";
  let summary: string | undefined;
  let rest = text;
  for (;;) {
    const open = rest.indexOf(SUMMARY_OPEN);
    if (open < 0) break;
    reply += rest.slice(0, open);
    const after = rest.slice(open + SUMMARY_OPEN.length);
    const close = after.indexOf(SUMMARY_CLOSE);
    summary = (close < 0 ? after : after.slice(0, close)).trim();
    rest = close < 0 ? "" : after.slice(close + SUMMARY_CLOSE.length);
  }
  if (summary === undefined) return { reply: text };
  return { reply: (reply + rest).replace(/\s+$/, ""), summary };
}

const SENTENCE_END = /[.!?…。！？]+["'”’)\]]*(?=\s|$)/g;
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * Text that takes at most `seconds` to speak (at WORDS_PER_SECOND): cut at the last sentence end before the
 * limit, or at a word when even the first sentence is longer. 0 leaves it whole.
 */
export function truncateToSeconds(text: string, seconds: number): { text: string; cut: boolean } {
  const max = Math.floor(seconds * WORDS_PER_SECOND);
  if (seconds <= 0 || wordCount(text) <= max) return { text, cut: false };
  let end = 0;
  for (const m of text.matchAll(SENTENCE_END)) {
    const e = (m.index ?? 0) + m[0].length;
    if (wordCount(text.slice(0, e)) > max) break;
    end = e;
  }
  if (end === 0) {
    const words = text.trim().split(/\s+/).slice(0, max);
    return { text: words.join(" "), cut: true };
  }
  return { text: text.slice(0, end).trimEnd(), cut: true };
}

type Part = { type?: string; text?: unknown; thinking?: unknown };

/** The reasoning the run exposed (thinking parts of its assistant messages), the latest kept when long. */
export function runReasoning(messages: readonly unknown[], max = 8000): string {
  const out: string[] = [];
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content as Part[]) {
      if (p?.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim()) out.push(p.thinking.trim());
    }
  }
  const all = out.join("\n\n");
  return all.length > max ? all.slice(all.length - max) : all;
}

export class ReadAloud {
  /** Starts off in every session. */
  mode: ReadMode = "off";
  /** Asks another Pi model for a summary; set by the adapter. */
  summarize?: Summarize;
  /** The user's Pi models (`provider/id`), for the Summarized by picker; set by the adapter. */
  models: () => string[] = () => [];
  /** The summary taken from the marked block of this run's reply. */
  private taken?: string;

  constructor(
    private readonly speech: Pick<Speech, "say">,
    private readonly notify: Notify,
    private readonly options: () => ReadAloudOptions = () => DEFAULT_READ_ALOUD,
  ) {}

  /** On: reading the whole reply unless a summary mode is chosen. */
  get enabled(): boolean {
    return this.mode !== "off";
  }

  set enabled(on: boolean) {
    this.mode = on ? (this.mode === "off" ? "all" : this.mode) : "off";
  }

  /** Whether the model itself is asked for the summary, in the same reply. */
  private sameModel(): boolean {
    return (this.mode === "summary" || this.mode === "thinking") && !this.options().summarizer;
  }

  /** The system-prompt guideline for the run that starts; undefined when none is needed. */
  guideline(): string | undefined {
    if (!this.sameModel()) return undefined;
    return guidelineFor(this.mode as "summary" | "thinking", this.options().length);
  }

  /**
   * A run starts: forget an earlier summary, and set the guideline in Pi's prompt guidelines (replacing an
   * earlier one of read-aloud; none when not needed). Returns the list.
   */
  onRunStart(guidelines: string[]): string[] {
    this.taken = undefined;
    for (let i = guidelines.length - 1; i >= 0; i--) {
      if (guidelines[i].startsWith(GUIDELINE_PREFIX)) guidelines.splice(i, 1);
    }
    const g = this.guideline();
    if (g) guidelines.push(g);
    return guidelines;
  }

  /**
   * A message is finished: an assistant message with a marked summary comes back without it (to replace the
   * finished message, so it is neither shown nor kept), and the summary is kept to be read when the run ends.
   * Undefined: nothing to change.
   */
  onMessageEnd<T>(message: T): T | undefined {
    const m = message as { role?: string; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return undefined;
    let found: string | undefined;
    const content: unknown[] = [];
    for (const part of m.content as Part[]) {
      if (part?.type !== "text" || typeof part.text !== "string" || !part.text.includes(SUMMARY_OPEN)) {
        content.push(part);
        continue;
      }
      const { reply, summary } = splitSummary(part.text);
      if (summary !== undefined) found = summary;
      if (reply.trim()) content.push({ ...part, text: reply });
    }
    if (found === undefined) return undefined;
    this.taken = found;
    return { ...(message as object), content } as T;
  }

  /** A run ended with these messages: read what the mode says. */
  async onRunEnd(messages: readonly unknown[], signal?: AbortSignal): Promise<void> {
    const mode = this.mode;
    const taken = this.taken;
    this.taken = undefined;
    if (mode === "off") return;
    const opts = this.options();
    let text: string;
    if (mode === "all") {
      text = speakable(splitSummary(finalAssistantText(messages)).reply);
      if (!text) return;
      const { text: spoken, cut } = cutForSpeech(text);
      if (cut && !opts.truncate) {
        this.notify(`Read-aloud: the reply is long, so only its first ${spoken.length} characters are spoken`, "info");
      }
      text = spoken;
    } else {
      const summary = await this.summary(mode, messages, taken, opts, signal);
      if (summary === undefined) return;
      text = speakable(summary);
      if (!text) return;
    }
    if (opts.truncate) text = truncateToSeconds(text, opts.truncate).text;
    try {
      const r = await this.speech.say(text);
      if (!r.stopped && !r.player && r.notPlayed !== REPLACED) {
        this.notify(`Read-aloud could not play the reply: ${r.notPlayed ?? "unknown reason"}`, "error");
      }
    } catch (err) {
      if (err instanceof ReadingFailed) this.notify(readingFailedMessage("Read-aloud", "reply", err.reason), "error");
      else this.notify(`Read-aloud failed: ${errorMessage(err)}`, "error");
    }
  }

  /** The summary to read: the marked block of the reply, or another model's answer; undefined when none. */
  private async summary(
    mode: "summary" | "thinking",
    messages: readonly unknown[],
    taken: string | undefined,
    opts: ReadAloudOptions,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const final = finalAssistantText(messages);
    if (!opts.summarizer) {
      const summary = taken ?? splitSummary(final).summary;
      if (summary === undefined && final.trim()) {
        this.notify("Read-aloud: the reply has no spoken summary, so nothing was read", "warning");
      }
      return summary;
    }
    const reply = splitSummary(final).reply;
    if (!reply.trim()) return undefined;
    if (!this.summarize) {
      this.notify(`Read-aloud: cannot ask ${opts.summarizer} for a summary here`, "error");
      return undefined;
    }
    const reasoning = mode === "thinking" ? runReasoning(messages) : undefined;
    try {
      const answer = await this.summarize(opts.summarizer, summaryPrompt(mode, opts.length, reply, reasoning), signal);
      // A model that marked its answer anyway: only the marked part.
      const marked = splitSummary(answer).summary;
      return (marked ?? answer).trim() || undefined;
    } catch (err) {
      this.notify(`Read-aloud: the summary by ${opts.summarizer} failed: ${errorMessage(err)}`, "error");
      return undefined;
    }
  }
}
