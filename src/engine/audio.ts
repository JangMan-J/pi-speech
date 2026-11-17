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
  /**
   * Fade this playback out over `ms`, then stop it (it ends as cancelled); resolves once asked, not once
   * faded. Where the player cannot fade, it stops at once.
   */
  fadeOut?(ms: number): Promise<void>;
}

export interface StreamOptions {
  /** Fade the start in over this long, and fade out the playback this one replaces (crossfade). */
  fadeMs?: number;
}

export type PlayStart = ({ ok: true } & Playback) | { ok: false; reason: string };

export interface AudioOutput {
  readonly name: string;
  /**
   * Start playing a Stream as its chunks arrive, without waiting for it to finish. Every playback is a Stream
   * (GLOSSARY.md), a saved message replayed included. Never throws: a failure to start is `{ ok: false }`.
   */
  playStream(stream: AudioStream, kind: PlayKind, opts?: StreamOptions): Promise<PlayStart>;
  /** Stop what this output plays: everything, or only one kind. */
  stop(kind?: PlayKind): Promise<void>;
  /** The 12 spectrum bands (`0..100`) of what plays now; undefined when nothing does or it cannot tell. */
  levels?(): number[] | undefined;
}

export interface Recording {
  /** Stop recording and return the audio. Throws a readable Error when nothing usable was recorded. */
  stop(): Promise<{ audio: Buffer; format: "wav" }>;
  /** Stop recording and discard the audio. */
  cancel(): Promise<void>;
  /**
   * Optional: read the audio recorded so far without stopping, for live streaming transcription.
   * Returns undefined when nothing usable has been written yet.
   */
  snapshot?(): Promise<{ audio: Buffer; format: "wav" } | undefined>;
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
  /** The 12 spectrum bands (`0..100`) of the recording now; undefined when none runs or it cannot tell. */
  levels?(): number[] | undefined;
}
