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

/** What speech is doing, as the status shows it, and empty when nothing happens: the settings panel's header. */
export function liveState(s: IndicatorState): string {
  return s.dictation ?? (s.playing ? "▶ speaking" : "");
}

/** Pushes the status text to a sink, only when it changes. */
export class Indicator {
  private last: string | undefined | null = null;
  private readonly listeners = new Set<() => void>();

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

  /** The state now, as `liveState` words it. */
  live(): string {
    return liveState(this.read());
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
