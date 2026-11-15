/**
 * Spectrum levels of a playback or recording on this machine: the bundled binary writes its latest 12 bands
 * (`0..100`, one byte each) to the file named by PI_SPEECH_LEVELS_FILE while it plays or records; the OSD reads
 * them. Through the bridge the receiver serves the same bands at `/v1/levels`.
 */

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const LEVELS_ENV = "PI_SPEECH_LEVELS_FILE";
export const BANDS = 12;

/** The levels file of this process's playback or recording. */
export function levelsFile(kind: "play" | "record", dir = tmpdir()): string {
  return join(dir, `pi-speech-${process.pid}-${kind}.levels`);
}

/** The bands in a levels file; undefined when it is missing or not yet written. */
export function readLevels(file: string): number[] | undefined {
  try {
    const bytes = readFileSync(file);
    return bytes.length >= BANDS ? Array.from(bytes.subarray(0, BANDS)) : undefined;
  } catch {
    return undefined;
  }
}

export function removeLevels(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    /* gone already */
  }
}
