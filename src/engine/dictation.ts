/**
 * Microphone dictation: one toggle starts a recording on the selected route's microphone, the next stops
 * it, transcribes it, and pastes the transcript at the cursor. It never submits. The audio exists only
 * between start and stop (or cancel, or the time limit), is held in memory, and never reaches the history.
 */

import type { AudioInput, Recording } from "./audio";
import { errorMessage } from "./env";

/** A recording stops by itself, and is transcribed, after this long. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

export interface DictationUi {
  notify(message: string, level: "info" | "warning" | "error"): void;
  /** Insert at the cursor without submitting. */
  paste(text: string): void;
}

export interface DictationDeps {
  input(): AudioInput;
  transcribe(audio: Buffer, format: string, signal: AbortSignal, language?: string): Promise<string>;
  /** The saved dictation language, used when a toggle names none. */
  defaultLanguage?(): string | undefined;
  /** Whether a user-defined output command is configured; when false the transcript goes to the editor. */
  outputConfigured?(): boolean;
  /** Run the user-defined output command with the transcript; rejects when it fails. */
  output?(text: string): Promise<void>;
  /** The state changed, or the recording clock ticked. */
  onChange?(): void;
  maxMs?: number;
  tickMs?: number;
}

const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** `prefix: reason`, unless the reason already says as much ("Transcription failed: …"). */
const report = (prefix: string, err: unknown) => {
  const reason = errorMessage(err);
  return /^(dictation|transcription) (failed|could not)/i.test(reason) ? reason : `${prefix}: ${reason}`;
};

export class Dictation {
  private current: DictationState = "idle";
  private recording?: Recording;
  private ui?: DictationUi;
  private startedAt = 0;
  private abandoned = false;
  /** A toggle arrived while the recorder was still starting: stop as soon as it has started. */
  private stopRequested = false;
  private transcription?: AbortController;
  /** Language captured when this recording started; the stopping toggle does not need to repeat it. */
  private language?: string;
  private tick?: ReturnType<typeof setInterval>;
  private limit?: ReturnType<typeof setTimeout>;

  constructor(private readonly deps: DictationDeps) {}

  get state(): DictationState {
    return this.current;
  }

  /** The status indicator text, or undefined when idle. */
  indicator(): string | undefined {
    switch (this.current) {
      case "starting":
        return "● REC 0:00";
      case "recording":
        return `● REC ${clock(Date.now() - this.startedAt)}`;
      case "transcribing":
        return "… transcribing";
      default:
        return undefined;
    }
  }

  /** Alt+Z and /speech --dictate: start when idle, stop and transcribe when recording. */
  async toggle(ui: DictationUi, language?: string): Promise<void> {
    switch (this.current) {
      case "idle":
        return this.start(ui, language);
      case "recording":
        return this.finish(ui);
      case "starting":
        this.stopRequested = true;
        return;
      case "transcribing":
        this.notify(ui, "Dictation is still transcribing the previous recording", "warning");
        return;
    }
  }

  /** Session end: throw a recording away, or abort a transcription in flight; nothing is inserted. */
  async cancel(): Promise<void> {
    if (this.current === "starting") this.abandoned = true;
    this.transcription?.abort();
    const recording = this.recording;
    if (this.current !== "recording" || !recording) return;
    this.recording = undefined;
    this.endTimers();
    this.set("idle");
    await recording.cancel().catch(() => {});
  }

  private set(state: DictationState): void {
    this.current = state;
    this.changed();
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch {
      /* the UI is gone */
    }
  }

  private async start(ui: DictationUi, language?: string): Promise<void> {
    this.language = language === undefined ? this.deps.defaultLanguage?.() : language === "auto" ? undefined : language;
    this.abandoned = false;
    this.stopRequested = false;
    this.ui = ui;
    this.startedAt = Date.now();
    this.set("starting");
    try {
      const recording = await this.deps.input().start();
      if (this.abandoned) {
        this.set("idle");
        await recording.cancel().catch(() => {});
        return;
      }
      this.recording = recording;
      this.startedAt = Date.now();
      this.set("recording");
      this.tick = setInterval(() => this.changed(), this.deps.tickMs ?? 1000);
      this.limit = setTimeout(() => {
        const u = this.ui;
        if (this.current === "recording" && u) void this.finish(u);
      }, this.deps.maxMs ?? MAX_RECORDING_MS);
      this.tick.unref?.();
      this.limit.unref?.();
      void recording.ended?.then((reason) => this.ended(recording, reason, ui));
      if (this.stopRequested) {
        this.stopRequested = false;
        await this.finish(ui);
      }
    } catch (err) {
      this.set("idle");
      this.notify(ui, report("Dictation could not start", err), "error");
    }
  }

  /** The recorder ended by itself while recording: report it now and return to idle. */
  private async ended(recording: Recording, reason: string, ui: DictationUi): Promise<void> {
    if (this.recording !== recording) return;
    this.recording = undefined;
    this.endTimers();
    this.set("idle");
    this.notify(ui, report("Dictation failed", reason), "error");
    await recording.cancel().catch(() => {});
  }

  private async finish(ui: DictationUi): Promise<void> {
    const recording = this.recording;
    if (!recording) return;
    this.recording = undefined;
    this.endTimers();
    this.set("transcribing");
    const abort = new AbortController();
    this.transcription = abort;
    try {
      const { audio, format } = await recording.stop();
      if (abort.signal.aborted) return;
      const text = (await this.deps.transcribe(audio, format, abort.signal, this.language)).trim();
      if (abort.signal.aborted) return;
      if (!text) throw new Error("no speech was recognized in the recording");
      await this.deliver(ui, text);
    } catch (err) {
      if (!abort.signal.aborted) this.notify(ui, report("Dictation failed", err), "error");
    } finally {
      this.transcription = undefined;
      this.language = undefined;
      this.set("idle");
    }
  }

  /** Send the transcript to the user's output command, falling back to the editor when none is set or it fails. */
  private async deliver(ui: DictationUi, text: string): Promise<void> {
    if (this.deps.outputConfigured?.() && this.deps.output) {
      try {
        await this.deps.output(text);
        return;
      } catch (err) {
        this.notify(ui, `${report("Dictation output failed", err)}; put in the editor instead`, "warning");
      }
    }
    ui.paste(text);
  }

  private endTimers(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.limit) clearTimeout(this.limit);
    this.tick = this.limit = undefined;
  }

  private notify(ui: DictationUi, text: string, level: "error" | "warning"): void {
    try {
      ui.notify(text, level);
    } catch {
      /* the UI is gone */
    }
  }
}
