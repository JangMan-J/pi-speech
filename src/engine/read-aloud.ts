/**
 * Assistant read-aloud: what is spoken. It starts Off in every session; its options (who summarizes, how long
 * a summary is, where reading stops) are saved in the settings.
 *
 * - Summarized reads a spoken summary of the reply once the run ends. With the same model, a guideline in the
 *   system prompt asks the model to end each reply with the summary between markers; the marked block is taken
 *   out of the finished message (so it is neither shown nor kept in the history) and read. With another Pi
 *   model, one extra request per reply asks that model for the summary.
 * - Streaming narrates a spoken summary of each reasoning block as it finishes streaming, through a separate Pi
 *   model (the main model is busy, so Same model is not offered).
 * - Truncate at stops reading at the last sentence end before the limit, in every mode.
 */

import { errorMessage } from "./env";
import { FADE_MS, Narrator, type NarratorDeps } from "./narration";
import { REPLACED } from "./player";
import { finalAssistantText, speakable } from "./readable";
import { ReadingFailed, readingFailedMessage } from "./reading";
import type { Speech } from "./speech";

export type Notify = (message: string, level: "info" | "warning" | "error") => void;

/** What is read: a spoken summary of the reply at run end, or each reasoning step live as it is produced. */
export type ReadMode = "off" | "summary" | "streaming";
export const READ_MODES: ReadMode[] = ["off", "summary", "streaming"];

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

/** What a summary is asked to say. */
function what(whose: "your" | "the"): string {
  return `a spoken summary of ${whose === "your" ? "that" : "the"} reply`;
}

function lengthClause(length: SummaryLength): string {
  return wordsClause(wordsFor(LENGTH_SECONDS[length]));
}

/** The length asked for, shown as a lorem-ipsum placeholder of `n` words: models match a shape better than a count. */
function wordsClause(n: number): string {
  const seconds = Math.max(1, Math.round(n / WORDS_PER_SECOND));
  return `Make it about as long as this ${n}-word placeholder (about ${seconds} seconds spoken): ${loremWords(n)}`;
}

const SPOKEN_STYLE = "written to be heard: plain sentences in the reply's language, no markdown, code, lists or links.";

/** The system-prompt guideline that asks the model for a marked summary at the end of each reply. */
export function guidelineFor(length: SummaryLength): string {
  return (
    `${GUIDELINE_PREFIX} end every final reply to the user with ${what("your")}, between ${SUMMARY_OPEN} ` +
    `and ${SUMMARY_CLOSE}, ${SPOKEN_STYLE} It is read aloud and hidden from the transcript, so never refer to it. ` +
    lengthClause(length)
  );
}

/** The one extra request to another model: the reply, asking for the summary. */
export function summaryPrompt(length: SummaryLength, reply: string): string {
  return [
    `Write ${what("the")} below, to be read aloud by text-to-speech, ${SPOKEN_STYLE} ${lengthClause(length)}`,
    "Answer with the summary only.",
    `<reply>\n${reply}\n</reply>`,
  ].join("\n\n");
}

/** The one extra request for Streaming: the reasoning gathered, asking for a spoken summary of about `words` words. */
export function streamingPrompt(words: number, block: string): string {
  return (
    `Write a spoken summary of this reasoning step below, to be read aloud by text-to-speech, ${SPOKEN_STYLE} ` +
    `${wordsClause(words)}\nAnswer with the summary only.\n\n<reasoning>\n${block}\n</reasoning>`
  );
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

export class ReadAloud {
  /** Starts off in every session. */
  mode: ReadMode = "off";
  /** Asks another Pi model for a summary; set by the adapter. */
  summarize?: Summarize;
  /** The user's Pi models (`provider/id`), for the Summarized by picker; set by the adapter. */
  models: () => string[] = () => [];
  /** The Pi model of the session now (`provider/id`), if any; set by the adapter. */
  currentModel: () => string | undefined = () => undefined;

  /**
   * The model Streaming takes when none is chosen: the session's model (asked in a request of its own, which is
   * all Streaming needs), else the first of the user's models; undefined when there are none.
   */
  defaultSummarizer(): string | undefined {
    const models = this.models();
    const current = this.currentModel();
    return current && models.includes(current) ? current : models[0];
  }
  /** The summary taken from the marked block of this run's reply. */
  private taken?: string;
  /** Streaming: paces the summaries of the reasoning to how the model thinks. */
  private readonly narrator: Narrator;
  /** Streaming has warned this run that it has no model to summarize with. */
  private warned = false;

  constructor(
    private readonly speech: Pick<Speech, "say">,
    private readonly notify: Notify,
    private readonly options: () => ReadAloudOptions = () => DEFAULT_READ_ALOUD,
    /** Something plays now; and the clock and timers, replaceable for tests. */
    narration: Partial<Pick<NarratorDeps, "speaking" | "now" | "after">> = {},
  ) {
    this.narrator = new Narrator({
      now: narration.now ?? (() => Date.now()),
      after:
        narration.after ??
        ((ms, fn) => {
          const t = setTimeout(fn, ms);
          return () => clearTimeout(t);
        }),
      speaking: narration.speaking ?? (() => false),
      maxWords: () => wordsFor(LENGTH_SECONDS[this.options().length]),
      summarize: (text, words, signal) => this.narrationSummary(text, words, signal),
      speak: (text, fade, signal) => this.narrate(text, fade, signal),
    });
  }

  /** On: reading a spoken summary of the reply, unless Streaming is chosen. */
  get enabled(): boolean {
    return this.mode !== "off";
  }

  set enabled(on: boolean) {
    this.mode = on ? (this.mode === "off" ? "summary" : this.mode) : "off";
  }

  /** Whether the model itself is asked for the summary, in the same reply. */
  private sameModel(): boolean {
    return this.mode === "summary" && !this.options().summarizer;
  }

  /** The system-prompt guideline for the run that starts; undefined when none is needed. */
  guideline(): string | undefined {
    if (!this.sameModel()) return undefined;
    return guidelineFor(this.options().length);
  }

  /**
   * A run starts: forget an earlier summary, and set the guideline in Pi's prompt guidelines (replacing an
   * earlier one of read-aloud; none when not needed). Returns the list.
   */
  onRunStart(guidelines: string[]): string[] {
    this.taken = undefined;
    this.narrator.reset();
    this.warned = false;
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
    if (mode === "streaming") this.narrator.end();
    if (mode !== "summary") return;
    const opts = this.options();
    const summary = await this.summary(messages, taken, opts, signal);
    if (summary === undefined) return;
    let text = speakable(summary);
    if (!text) return;
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

  /** Streaming: a reasoning block finished streaming; the narrator decides when its summary is made. */
  onThinkingBlock(block: string, signal?: AbortSignal): void {
    if (this.mode !== "streaming") return;
    this.narrator.thought(block, signal);
  }

  /** Streaming: the spoken summary of reasoning gathered, about `words` long; undefined when none. */
  private async narrationSummary(text: string, words: number, signal?: AbortSignal): Promise<string | undefined> {
    const opts = this.options();
    if (!opts.summarizer || !this.summarize) {
      if (!this.warned) {
        this.warned = true;
        this.notify("Streaming needs a separate Summarized by model (Same model cannot summarize mid-run)", "warning");
      }
      return undefined;
    }
    try {
      const answer = await this.summarize(opts.summarizer, streamingPrompt(words, text), signal);
      const marked = splitSummary(answer).summary;
      const spoken = speakable((marked ?? answer).trim());
      if (!spoken) return undefined;
      return opts.truncate ? truncateToSeconds(spoken, opts.truncate).text : spoken;
    } catch (err) {
      if (!signal?.aborted) {
        this.notify(`Streaming: the summary by ${opts.summarizer} failed: ${errorMessage(err)}`, "error");
      }
      return undefined;
    }
  }

  /** Streaming: speak one summary, crossfading over what plays when `fade`. */
  private async narrate(text: string, fade: boolean, signal?: AbortSignal): Promise<void> {
    try {
      const r = await this.speech.say(text, { signal, ...(fade ? { fadeMs: FADE_MS } : {}) });
      if (!r.stopped && !r.player && r.notPlayed !== REPLACED) {
        this.notify(`Streaming could not play: ${r.notPlayed ?? "unknown reason"}`, "error");
      }
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof ReadingFailed)
        this.notify(readingFailedMessage("Streaming", "reasoning", err.reason), "error");
      else this.notify(`Streaming failed: ${errorMessage(err)}`, "error");
    }
  }

  /** The summary to read: the marked block of the reply, or another model's answer; undefined when none. */
  private async summary(
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
    try {
      const answer = await this.summarize(opts.summarizer, summaryPrompt(opts.length, reply), signal);
      // A model that marked its answer anyway: only the marked part.
      const marked = splitSummary(answer).summary;
      return (marked ?? answer).trim() || undefined;
    } catch (err) {
      this.notify(`Read-aloud: the summary by ${opts.summarizer} failed: ${errorMessage(err)}`, "error");
      return undefined;
    }
  }
}
