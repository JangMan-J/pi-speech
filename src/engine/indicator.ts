/**
 * The single footer status, key `pi-speech`. Dictation outranks playback, which outranks the idle route:
 *   ● REC 0:03       recording
 *   … transcribing   transcribing a dictation
 *   ▶ speaking       a playback runs
 *   speech: bridge   idle on the bridge
 *   (empty)          idle on the local route
 */

export const STATUS_KEY = "pi-speech";

export interface IndicatorState {
  /** The dictation indicator, when dictation is not idle. */
  dictation?: string;
  playing: boolean;
  route: "local" | "bridge";
}

export function indicatorText(s: IndicatorState): string | undefined {
  if (s.dictation) return s.dictation;
  if (s.playing) return "▶ speaking";
  return s.route === "bridge" ? "speech: bridge" : undefined;
}

/** A Nerd Font microphone: the footer's mark while speech is idle. */
export const MIC = "\uf130";
const ANSI = { idle: 240, recording: 203, transcribing: 214, speaking: 45 } as const;
const ansi = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;

/**
 * The footer status: always there, so a footer extension (zentui, pi-statusline) places it once under its key,
 * like pi-bgtasks and pi-webtasks. A dim microphone while idle (with `bridge` while the bridge is in use), red
 * `● REC 0:03` while recording, yellow `… transcribing`, the accent `▶ speaking`. Without colour: the words only.
 */
export function statusLine(s: IndicatorState, color: boolean): string {
  const paint = (code: number, text: string) => (color ? ansi(code, text) : text);
  if (s.dictation) return paint(s.dictation.startsWith("●") ? ANSI.recording : ANSI.transcribing, s.dictation);
  if (s.playing) return paint(ANSI.speaking, "▶ speaking");
  return paint(ANSI.idle, s.route === "bridge" ? `${MIC} bridge` : MIC);
}

/** What speech is doing, as the status shows it, and empty when nothing happens: the settings panel's header. */
export function liveState(s: IndicatorState): string {
  return s.dictation ?? (s.playing ? "▶ speaking" : "");
}

/** Pushes the status text to a sink, only when it changes. */
export class Indicator {
  /** The state now. */
  state(): IndicatorState {
    return this.read();
  }

  private last: string | undefined | null = null;
  private readonly listeners = new Set<() => void>();
  /**
   * Whether something else shows the live state now (the spectrum OSD): the panel's header then says nothing
   * of it, so the state is shown in one place. Set by the host.
   */
  shownElsewhere: () => boolean = () => false;

  constructor(
    private readonly read: () => IndicatorState,
    private sink: (text: string | undefined) => void = () => {},
  ) {}

  /** Send to a new sink (a new session's UI); the current text is sent at once. */
  attach(sink: (text: string | undefined) => void): void {
    this.sink = sink;
    this.last = null;
    this.update();
  }

  /** Send the text again, whether or not it changed: what the sink shows may depend on more than the state. */
  refresh(): void {
    this.last = null;
    this.update();
  }

  /** The state now, as `liveState` words it. */
  live(): string {
    return this.shownElsewhere() ? "" : liveState(this.read());
  }

  /** Hear every change of the text; returns the function that stops listening. */
  listen(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(): void {
    const text = indicatorText(this.read());
    if (text === this.last) return;
    this.last = text;
    try {
      this.sink(text);
    } catch {
      /* the UI is gone */
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* a listener's failure is its own */
      }
    }
  }
}
