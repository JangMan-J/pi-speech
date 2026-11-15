/**
 * Narration: read-aloud's Streaming mode. Each reasoning block the model finishes is summarized by another
 * model and spoken, paced to how this model thinks:
 *
 * - It learns the cadence as the run goes: moving averages of the time between thoughts, of their length, and
 *   of how long a summary takes.
 * - Each summary is sized to the time it has: about 2.5 words a second times (the expected time to the next
 *   thought, less the summary's own wait), between MIN_WORDS and the Length setting. A fast, verbose thinker
 *   gets short summaries; a sparse one fuller ones.
 * - Sparse thoughts are held and merged: a block is summarized once enough text has gathered (HOLD_CHARS),
 *   once the model has been quiet a while (a multiple of its usual gap), or when the run ends.
 * - When narration falls behind (newer thoughts came while a summary was being made), the new summary
 *   crossfades over the one still speaking (FADE_MS out, FADE_MS in); otherwise it waits for it to finish.
 */

/** Words spoken per second. */
export const WORDS_PER_SECOND = 2.5;
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
          // Behind: newer thoughts came while this was made, so it crossfades over what still speaks.
          // Otherwise it waits for that to finish, unless newer thoughts come meanwhile.
          while (this.d.speaking() && !this.pending.length && run === this.run) await this.sleep(QUIET_POLL_MS);
          if (run !== this.run) return;
          await this.d.speak(summary, this.d.speaking(), this.signal);
        }
        // Thoughts that came meanwhile wait for more, as any lone thought does, unless enough is held or the
        // run has ended.
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
