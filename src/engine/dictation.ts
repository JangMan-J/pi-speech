/**
 * Microphone dictation: one toggle starts a recording on the selected route's microphone, the next stops
 * it, transcribes it, and pastes the transcript at the cursor. It never submits. The audio exists only
 * between start and stop (or cancel, or the time limit), is held in memory, and never reaches the history.
 */

import type { AudioInput, Recording } from "./audio";
import { errorMessage } from "./env";
import type { RedirectResult } from "./redirect";
import { quietSplitByte, sliceWav, wavPcmInfo } from "./wav";

/** A recording stops by itself, and is transcribed, after this long. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

export interface DictationUi {
  notify(message: string, level: "info" | "warning" | "error"): void;
  /** Insert at the cursor without submitting. */
  paste(text: string): void;
  /** Live typing / cleanup: read and replace the editor box text natively. */
  getEditor?(): string;
  setEditor?(text: string): void;
  /** Submit a message directly in Pi (triggered by trailing submit word). */
  submit?(text: string): void;
  /** Run a slash command directly in Pi (triggered by a sole-word voice command). */
  runCommand?(command: string): void;
}

export interface DictationOutcome {
  text: string;
  submit?: boolean;
  command?: string;
}

export interface DictationDeps {
  input(): AudioInput;
  transcribe(audio: Buffer, format: string, signal: AbortSignal, language?: string): Promise<string>;
  /** The saved dictation language, used when a toggle names none. */
  defaultLanguage?(): string | undefined;
  /** Recording has started: get the transcription ready (load a local model) while the user speaks. */
  prepare?(language?: string): void;
  /** Whether live typing while speaking is enabled by the user. */
  liveEnabled?(): boolean;
  redirectEnabled?(): boolean;
  redirect?: {
    available(): Promise<RedirectResult>;
    deliver(text: string, opts?: { submit?: boolean }): Promise<RedirectResult>;
  };
  /** Whether the active STT model/route supports fast live chunking. */
  liveCapable?(): boolean;
  /** Poll interval (ms) for live typing snapshots. */
  liveMs?: number;
  /** Transform live preview text (e.g. apply vocabulary casing/replacements). */
  previewTransform?(text: string): string;
  /** Finalize transcript: apply vocabulary, detect sole voice command, and check trailing submit word. */
  finalize?(text: string): DictationOutcome;
  /** The state changed, or the recording clock ticked. */
  onChange?(): void;
  maxMs?: number;
  tickMs?: number;
}

const LIVE_WINDOW_MAX_SEC = 15;
const LIVE_COMMIT_MIN_SEC = 8;
const LIVE_COMMIT_MAX_SEC = 13;
const LIVE_MIN_DELTA_SEC = 0.05;

function joinEditorText(base: string, spoken: string): string {
  if (!spoken) return base;
  if (!base) return spoken;
  return /\s$/.test(base) ? `${base}${spoken}` : `${base} ${spoken}`;
}

function joinTranscript(a: string, b: string): string {
  const left = a.trim();
  const right = b.trim();
  if (!left) return right;
  if (!right) return left;
  return `${left} ${right}`;
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
  private liveTimer?: ReturnType<typeof setInterval>;
  private limit?: ReturnType<typeof setTimeout>;
  private liveActive = false;
  private baseEditor = "";
  private committedByte = 0;
  private committedText = "";
  private lastSnapBytes = 0;
  private liveAbort?: AbortController;
  private liveInFlight?: Promise<void>;
  private redirectActive = false;
  private redirectNotice = false;
  /** Raw committed prefix already delivered elsewhere, never insert it again in Pi. */
  private redirectedText = "";

  constructor(private readonly deps: DictationDeps) {}

  get state(): DictationState {
    return this.current;
  }

  /** Structured dictation phase when active, or undefined when idle. */
  phase(): "starting" | "recording" | "transcribing" | undefined {
    return this.current === "idle" ? undefined : this.current;
  }

  /** The status indicator text, or undefined when idle. */
  indicator(): string | undefined {
    const suffix = this.redirectActive ? " → pane" : "";
    switch (this.current) {
      case "starting":
        return `● REC 0:00${suffix}`;
      case "recording":
        return `● REC ${clock(Date.now() - this.startedAt)}${suffix}`;
      case "transcribing":
        return `… transcribing${suffix}`;
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
    const wasLive = this.liveActive;
    const base = this.baseEditor;
    const ui = this.ui;
    this.endTimers();
    this.liveAbort?.abort();
    this.resetLive();
    this.set("idle");
    if (wasLive) ui?.setEditor?.(base);
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
    this.redirectActive = false;
    this.redirectedText = "";
    this.set("starting");
    try {
      if (this.deps.redirectEnabled?.() && this.deps.redirect) {
        const result = await this.deps.redirect.available();
        this.redirectActive = result.ok;
        if (!result.ok && (result.reason !== "Redirect needs Zellij; typing into Pi" || !this.redirectNotice)) {
          this.notify(ui, result.reason, "warning");
          if (result.reason === "Redirect needs Zellij; typing into Pi") this.redirectNotice = true;
        }
        this.changed();
      }
      const recording = await this.deps.input().start();
      if (this.abandoned) {
        this.set("idle");
        await recording.cancel().catch(() => {});
        return;
      }
      this.recording = recording;
      this.startedAt = Date.now();
      this.set("recording");
      try {
        this.deps.prepare?.(this.language);
      } catch {
        /* only a head start */
      }
      this.tick = setInterval(() => this.changed(), this.deps.tickMs ?? 1000);
      this.limit = setTimeout(() => {
        const u = this.ui;
        if (this.current === "recording" && u) void this.finish(u);
      }, this.deps.maxMs ?? MAX_RECORDING_MS);
      this.tick.unref?.();
      this.limit.unref?.();
      this.resetLive();
      if (this.deps.liveEnabled?.() && this.deps.liveCapable?.() && recording.snapshot && ui.setEditor) {
        this.liveActive = true;
        this.baseEditor = ui.getEditor?.() ?? "";
        this.liveTimer = setInterval(() => {
          void this.pollLive(recording, ui);
        }, this.deps.liveMs ?? 650);
        this.liveTimer.unref?.();
      }
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

  private resetLive(): void {
    this.liveActive = false;
    this.baseEditor = "";
    this.committedByte = 0;
    this.committedText = "";
    this.lastSnapBytes = 0;
    this.liveAbort = undefined;
    this.liveInFlight = undefined;
  }

  private async pollLive(recording: Recording, ui: DictationUi): Promise<void> {
    if (!this.liveActive || this.current !== "recording" || this.liveInFlight || this.recording !== recording) return;
    const run = (async () => {
      const snap = await recording.snapshot?.();
      if (!snap || !this.liveActive || this.current !== "recording") return;
      const wav = snap.audio;
      const { dataOffset, byteRate } = wavPcmInfo(wav);
      if (this.committedByte < dataOffset) this.committedByte = dataOffset;
      if (this.lastSnapBytes < dataOffset) this.lastSnapBytes = dataOffset;
      const minDelta = Math.max(2, Math.round(byteRate * LIVE_MIN_DELTA_SEC));
      if (this.lastSnapBytes > dataOffset) {
        if (wav.length <= this.lastSnapBytes + minDelta) return;
        let sum = 0;
        let count = 0;
        for (let i = Math.max(dataOffset, this.lastSnapBytes & ~1); i + 2 <= wav.length; i += 8) {
          sum += Math.abs(wav.readInt16LE(i));
          count++;
        }
        if (count > 0 && sum / count < 90) {
          this.lastSnapBytes = wav.length;
          return;
        }
      }
      this.lastSnapBytes = wav.length;
      const ac = new AbortController();
      this.liveAbort = ac;
      try {
        const maxWindowBytes = Math.round(LIVE_WINDOW_MAX_SEC * byteRate);
        if (wav.length - this.committedByte > maxWindowBytes) {
          const splitAt = quietSplitByte(wav, this.committedByte, LIVE_COMMIT_MIN_SEC, LIVE_COMMIT_MAX_SEC);
          if (splitAt > this.committedByte) {
            const headWav = sliceWav(wav, this.committedByte, splitAt);
            const headText = (await this.deps.transcribe(headWav, snap.format, ac.signal, this.language)).trim();
            if (ac.signal.aborted || !this.liveActive) return;
            this.committedText = joinTranscript(this.committedText, headText);
            this.committedByte = splitAt;
            if (headText && this.redirectActive && this.deps.redirect) {
              const transformed = this.deps.previewTransform ? this.deps.previewTransform(headText) : headText;
              const result = await this.deps.redirect.deliver(`${this.redirectedText ? " " : ""}${transformed}`);
              if (result.ok) this.redirectedText = joinTranscript(this.redirectedText, headText);
              else {
                this.redirectActive = false;
                this.notify(ui, result.reason, "warning");
                this.changed();
              }
            }
          }
        }
        const tailWav = this.committedByte > dataOffset ? sliceWav(wav, this.committedByte) : wav;
        const partial = (await this.deps.transcribe(tailWav, snap.format, ac.signal, this.language)).trim();
        if (ac.signal.aborted || !this.liveActive || this.current !== "recording") return;
        const combined = joinTranscript(this.committedText, partial);
        const remaining = this.withoutRedirected(combined);
        const preview = this.deps.previewTransform ? this.deps.previewTransform(remaining) : remaining;
        if (!this.redirectActive) ui.setEditor?.(joinEditorText(this.baseEditor, preview));
      } catch {
        /* transient partial errors are ignored; final pass resolves cleanly */
      } finally {
        if (this.liveAbort === ac) this.liveAbort = undefined;
      }
    })();
    this.liveInFlight = run;
    await run;
    if (this.liveInFlight === run) this.liveInFlight = undefined;
  }

  /** The recorder ended by itself while recording: report it now and return to idle. */
  private async ended(recording: Recording, reason: string, ui: DictationUi): Promise<void> {
    if (this.recording !== recording) return;
    this.recording = undefined;
    const wasLive = this.liveActive;
    const base = this.baseEditor;
    this.endTimers();
    this.liveAbort?.abort();
    this.resetLive();
    this.set("idle");
    if (wasLive) ui.setEditor?.(base);
    this.notify(ui, report("Dictation failed", reason), "error");
    await recording.cancel().catch(() => {});
  }

  private async finish(ui: DictationUi): Promise<void> {
    const recording = this.recording;
    if (!recording) return;
    this.recording = undefined;
    const wasLive = this.liveActive;
    const base = this.baseEditor;
    this.endTimers();
    this.liveAbort?.abort();
    if (this.liveInFlight) await this.liveInFlight.catch(() => {});
    const committedByte = this.committedByte;
    const committedText = this.committedText;
    this.resetLive();
    this.set("transcribing");
    const abort = new AbortController();
    this.transcription = abort;
    try {
      const { audio, format } = await recording.stop();
      if (abort.signal.aborted) return;
      let rawText: string;
      const dataOffset = format === "wav" ? wavPcmInfo(audio).dataOffset : 0;
      if (wasLive && committedByte > dataOffset && format === "wav") {
        const tailText =
          audio.length > committedByte
            ? (await this.deps.transcribe(sliceWav(audio, committedByte), format, abort.signal, this.language)).trim()
            : "";
        rawText = joinTranscript(committedText, tailText);
      } else {
        rawText = (await this.deps.transcribe(audio, format, abort.signal, this.language)).trim();
      }
      if (abort.signal.aborted) return;
      if (!rawText) throw new Error("no speech was recognized in the recording");
      await this.deliver(ui, rawText, wasLive, base);
    } catch (err) {
      if (wasLive) ui.setEditor?.(base);
      if (!abort.signal.aborted) this.notify(ui, report("Dictation failed", err), "error");
    } finally {
      this.transcription = undefined;
      this.language = undefined;
      this.set("idle");
    }
  }

  private withoutRedirected(text: string): string {
    return this.redirectedText && text.startsWith(this.redirectedText)
      ? text.slice(this.redirectedText.length).trimStart()
      : text;
  }

  /** Apply vocabulary, voice command, or submit-word handling and deliver cleanly into Pi. */
  private async deliver(ui: DictationUi, rawText: string, wasLive: boolean, base: string): Promise<void> {
    const finalized = this.deps.finalize ? this.deps.finalize(rawText) : { text: rawText };
    const sent = this.deps.previewTransform ? this.deps.previewTransform(this.redirectedText) : this.redirectedText;
    const outcome =
      sent && finalized.text.startsWith(sent)
        ? { ...finalized, text: finalized.text.slice(sent.length).trimStart() }
        : this.redirectedText
          ? { ...finalized, text: this.withoutRedirected(rawText) }
          : finalized;
    if (outcome.command) {
      if (wasLive) ui.setEditor?.(base);
      if (ui.runCommand) ui.runCommand(outcome.command);
      else if (ui.submit) ui.submit(outcome.command);
      else ui.paste(outcome.command);
      return;
    }
    if (this.redirectActive && this.deps.redirect) {
      if (wasLive) ui.setEditor?.(base);
      const prefix = this.redirectedText && outcome.text ? " " : "";
      const result = await this.deps.redirect.deliver(prefix + outcome.text, { submit: outcome.submit });
      if (result.ok) return;
      this.notify(ui, result.reason, "warning");
      if (result.reason.startsWith("Redirect text delivered")) return;
      this.redirectActive = false;
    }
    if (outcome.submit) {
      if (wasLive) ui.setEditor?.(base);
      if (ui.submit) ui.submit(outcome.text);
      else ui.paste(outcome.text);
      return;
    }
    if (wasLive && ui.setEditor) {
      ui.setEditor(joinEditorText(base, outcome.text));
      return;
    }
    ui.paste(outcome.text);
  }

  private endTimers(): void {
    if (this.tick) clearInterval(this.tick);
    if (this.liveTimer) clearInterval(this.liveTimer);
    if (this.limit) clearTimeout(this.limit);
    this.tick = this.liveTimer = this.limit = undefined;
  }

  private notify(ui: DictationUi, text: string, level: "error" | "warning"): void {
    try {
      ui.notify(text, level);
    } catch {
      /* the UI is gone */
    }
  }
}
