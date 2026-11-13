/**
 * What a Reading (GLOSSARY.md) ends with, shared by its callers. A Reading plays as one Stream; it is built in
 * reading-stream.ts.
 */

import type { SavedMessage } from "./history";

export type ReadingResult =
  /** Every piece arrived and the message was saved; `player` once it started playing. */
  | { state: "saved"; saved: SavedMessage; player?: string; notPlayed?: string }
  /** Stopped or replaced before every piece had arrived: nothing saved. */
  | { state: "stopped" };

/** A Reading ended by a failure: nothing plays after it and nothing was saved. `reason` says what failed. */
export class ReadingFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The one error shown for a failed Reading: `who` stopped, why, and that `what` was not saved. */
export function readingFailedMessage(who: string, what: string, reason: string): string {
  return (
    `${who} stopped: ${reason.trim().replace(/\.+$/, "")}. The ${what} was not saved; ` +
    "try /speech --replay for the last saved message, or pick another speech model in /speech."
  );
}
