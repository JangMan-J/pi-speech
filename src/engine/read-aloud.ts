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
 *
 * Absorbs markdown-to-speech cleanup (`speakable`, `finalAssistantText`) and adaptive narration pacing
 * (`Narrator`) behind a constructor `ReadAloudHost` port.
 */

import { errorMessage } from "./env";
import { REPLACED } from "./player";
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

/** Host capabilities injected into ReadAloud at construction time. */
export interface ReadAloudHost {
  /** The user's Pi models (`provider/id`), for the Summarized by picker. */
  models(): string[];
  /** The Pi model of the session now (`provider/id`), if any. */
  currentModel(): string | undefined;
  /** Asks another Pi model for a summary. */
  summarize?: Summarize;
}

// ── Markdown-to-speech cleanup ──────────────────────────────────────────────

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s*>\s?/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const ENDS_SENTENCE = /[.!?…:;。！？]["'”’)\]]*$/;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function inline(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_m, url: string) => hostOf(url))
    .replace(/https?:\/\/[^\s<>()]+/g, (url) => {
      const trail = /[.,;:!?'"”’]+$/.exec(url)?.[0] ?? "";
      return hostOf(url.slice(0, url.length - trail.length)) + trail;
    })
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1")
    .replace(/(?<![\w_])__(\S(?:.*?\S)?)__(?![\w_])/g, "$1")
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    .replace(/(?<![\w_])_(\S(?:.*?\S)?)_(?![\w_])/g, "$1")
    .replace(/~~(\S(?:.*?\S)?)~~/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "");
}

/** The words of a markdown reply, as they should be spoken. */
export function speakable(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const raw of markdown.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || RULE.test(raw) || TABLE_SEPARATOR.test(raw)) continue;
    let line = raw;
    const heading = HEADING.exec(line);
    if (heading) {
      const text = inline(heading[1]);
      out.push(text && !ENDS_SENTENCE.test(text) ? `${text}.` : text);
      continue;
    }
    while (QUOTE.test(line)) line = line.replace(QUOTE, "");
    line = line.replace(LIST_MARKER, "");
    if (TABLE_ROW.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(", ");
    }
    out.push(inline(line));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text parts of the final assistant message in a run; "" when there is none. */
export function finalAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (!Array.isArray(m.content)) return "";
    return m.content
      .filter((p: { type?: string; text?: unknown }) => p?.type === "text" && typeof p.text === "string")
      .map((p: { text: string }) => p.text)
      .join("\n");
  }
  return "";
}

// ── Adaptive narration pacing ───────────────────────────────────────────────

/** The shortest summary asked for. */
export const MIN_WORDS = 6;
/** Text gathered that is summarized without waiting for more. */
export const HOLD_CHARS = 400;
/** How long a lone thought is held for the next, as a multiple of the usual gap, within these bounds. */
export const HOLD_GAPS = 1.5;
export const MIN_HOLD_MS = 1500;
export const MAX_HOLD_MS = 8000;
/** The hold before the cadence is known. */
export const FIRST_HOLD_MS = 3000;
/** Crossfade length when narration catches up. */
export const FADE_MS = 500;
/** Weight of the newest sample in each moving average. */
const ALPHA = 0.3;
/** How often a summary that waits for the one speaking looks again. */
const QUIET_POLL_MS = 100;

export interface NarratorDeps {
  now(): number;
  /** Run `fn` after `ms`; returns what cancels it. */
  after(ms: number, fn: () => void): () => void;
  /** A spoken summary of `text` in about `words` words; undefined when there is nothing to say. */
  summarize(text: string, words: number, signal?: AbortSignal): Promise<string | undefined>;
  /** Speak `text`, crossfading over what plays when `fade`; resolves once its audio has arrived. */
  speak(text: string, fade: boolean, signal?: AbortSignal): Promise<void>;
  /** Something is playing now. */
  speaking(): boolean;
  /** The longest summary, in words (the Length setting). */
  maxWords(): number;
}

/** A moving average; undefined until its first sample. */
class Average {
  value?: number;
  add(x: number): void {
    this.value = this.value === undefined ? x : this.value + ALPHA * (x - this.value);
  }
}

export class Narrator {
  /** Time between the ends of consecutive thoughts, in ms. */
  readonly gap = new Average();
  /** Characters per thought. */
  readonly size = new Average();
  /** How long a summary takes, in ms. */
  readonly latency = new Average();

  private pending: string[] = [];
  private lastAt?: number;
  private cancelHold?: () => void;
  /** A summary is being made or spoken. */
  private busy = false;
  /** The run ended: say what is held at once. */
  private ending = false;
  private signal?: AbortSignal;
  /** Bumped by `reset`: work of an earlier run stops. */
  private run = 0;

  constructor(private readonly d: NarratorDeps) {}

  /** A run starts: forget what is held. The cadence learned so far stays (the model rarely changes). */
  reset(): void {
    this.run++;
    this.cancelHold?.();
    this.cancelHold = undefined;
    this.pending = [];
    this.lastAt = undefined;
    this.ending = false;
    this.busy = false;
  }

  /** A reasoning block has finished. */
  thought(text: string, signal?: AbortSignal): void {
    const t = text.trim();
    if (!t) return;
    this.signal = signal;
    const now = this.d.now();
    if (this.lastAt !== undefined) this.gap.add(now - this.lastAt);
    this.lastAt = now;
    this.size.add(t.length);
    this.pending.push(t);
    if (this.held() >= HOLD_CHARS) this.flush();
    else this.hold();
  }

  /** The run ended: whatever is held is summarized now. */
  end(): void {
    this.ending = true;
    this.flush();
  }

  /** Characters held now. */
  held(): number {
    return this.pending.reduce((n, t) => n + t.length, 0);
  }

  /** How long a lone thought waits for the next before it is summarized alone. */
  holdMs(): number {
    if (this.gap.value === undefined) return FIRST_HOLD_MS;
    return Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, HOLD_GAPS * this.gap.value));
  }

  /** The words the next summary is asked for: what fits before the next thought, within the bounds. */
  words(): number {
    const max = Math.max(MIN_WORDS, this.d.maxWords());
    if (this.gap.value === undefined) return max;
    const ms = this.gap.value - (this.latency.value ?? 0);
    return Math.min(max, Math.max(MIN_WORDS, Math.round((WORDS_PER_SECOND * ms) / 1000)));
  }

  private hold(): void {
    this.cancelHold?.();
    this.cancelHold = this.d.after(this.holdMs(), () => {
      this.cancelHold = undefined;
      this.flush();
    });
  }

  private flush(): void {
    this.cancelHold?.();
    this.cancelHold = undefined;
    if (!this.busy && this.pending.length) void this.work(this.run);
  }

  /** Summarize and speak what is held, and again while more comes, until nothing is held. */
  private async work(run: number): Promise<void> {
    this.busy = true;
    try {
      while (this.pending.length && run === this.run && !this.signal?.aborted) {
        const text = this.pending.join("\n\n");
        this.pending = [];
        const started = this.d.now();
        const summary = await this.d.summarize(text, this.words(), this.signal);
        this.latency.add(this.d.now() - started);
        if (run !== this.run || this.signal?.aborted) return;
        if (summary) {
          while (this.d.speaking() && !this.pending.length && run === this.run) await this.sleep(QUIET_POLL_MS);
          if (run !== this.run) return;
          await this.d.speak(summary, this.d.speaking(), this.signal);
        }
        if (this.pending.length && !this.ending && this.held() < HOLD_CHARS) {
          this.hold();
          return;
        }
      }
    } finally {
      if (run === this.run) this.busy = false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => this.d.after(ms, r));
  }
}

// ── Prompts & summary extraction ────────────────────────────────────────────

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
  private host: ReadAloudHost;
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
    host: Partial<ReadAloudHost> = {},
  ) {
    this.host = {
      models: host.models ?? (() => []),
      currentModel: host.currentModel ?? (() => undefined),
      summarize: host.summarize,
    };
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

  /** Update the host callbacks (used by tests or late-bound adapters). */
  attachHost(patch: Partial<ReadAloudHost>): void {
    this.host = { ...this.host, ...patch };
  }

  /** The user's Pi models (`provider/id`), for the Summarized by picker. */
  models(): string[] {
    return this.host.models();
  }

  /** The Pi model of the session now (`provider/id`), if any. */
  currentModel(): string | undefined {
    return this.host.currentModel();
  }

  /**
   * The model Streaming takes when none is chosen: the session's model (asked in a request of its own, which is
   * all Streaming needs), else the first of the user's models; undefined when there are none.
   */
  defaultSummarizer(): string | undefined {
    const models = this.models();
    const current = this.currentModel();
    return current && models.includes(current) ? current : models[0];
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
      const r = await this.speech.say(text, { signal });
      if (!r.stopped && !r.player && r.notPlayed !== REPLACED) {
        this.notify(`Read-aloud could not play the reply: ${r.notPlayed ?? "unknown reason"}`, "error");
      }
    } catch (err) {
      if (signal?.aborted) return;
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
    if (!opts.summarizer || !this.host.summarize) {
      if (!this.warned) {
        this.warned = true;
        this.notify("Streaming needs a separate Summarized by model (Same model cannot summarize mid-run)", "warning");
      }
      return undefined;
    }
    try {
      const answer = await this.host.summarize(opts.summarizer, streamingPrompt(words, text), signal);
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
    if (!this.host.summarize) {
      this.notify(`Read-aloud: cannot ask ${opts.summarizer} for a summary here`, "error");
      return undefined;
    }
    try {
      const answer = await this.host.summarize(opts.summarizer, summaryPrompt(opts.length, reply), signal);
      // A model that marked its answer anyway: only the marked part.
      const marked = splitSummary(answer).summary;
      return (marked ?? answer).trim() || undefined;
    } catch (err) {
      this.notify(`Read-aloud: the summary by ${opts.summarizer} failed: ${errorMessage(err)}`, "error");
      return undefined;
    }
  }
}
