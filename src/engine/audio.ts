/**
 * Audio outputs (players) and inputs (microphones). "local" is the Pi host; the playback bridge is the
 * user's playback machine. Which one is used is decided by the route (see routes.ts), never by fallback.
 */

import type { AudioStream } from "./provider";

export type PlayKind = "message" | "sample";

export type PlayOutcome = { state: "completed" } | { state: "failed"; error: string } | { state: "cancelled" };

export interface Playback {
  /** What plays it, for messages such as "Playing with mpv". */
  player: string;
  /** Settles when playback ends; never rejects. */
  done: Promise<PlayOutcome>;
  /** Stop this playback; it then ends as cancelled. */
  stop(): Promise<void>;
}

export type PlayStart = ({ ok: true } & Playback) | { ok: false; reason: string };

export interface AudioOutput {
  readonly name: string;
  /**
   * Start playing a Stream as its chunks arrive, without waiting for it to finish. Every playback is a Stream
   * (GLOSSARY.md), a saved message replayed included. Never throws: a failure to start is `{ ok: false }`.
   */
  playStream(stream: AudioStream, kind: PlayKind): Promise<PlayStart>;
  /** Stop what this output plays: everything, or only one kind. */
  stop(kind?: PlayKind): Promise<void>;
}

export interface Recording {
  /** Stop recording and return the audio. Throws a readable Error when nothing usable was recorded. */
  stop(): Promise<{ audio: Buffer; format: "wav" }>;
  /** Stop recording and discard the audio. */
  cancel(): Promise<void>;
  /**
   * Optional: settles when the recording ends by itself before `stop()` or `cancel()` (for example the
   * recorder crashed), with a readable reason. It never settles for a recording that is stopped or cancelled.
   */
  ended?: Promise<string>;
}

export interface AudioInput {
  readonly name: string;
  /** Start recording the microphone. Throws a readable Error when it cannot. */
  start(): Promise<Recording>;
}
