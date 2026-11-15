/**
 * The spectrum OSD: the live 12 bands of a recording or playback, drawn as a small graph centred above the
 * editor. It has no words: what speech is doing (● REC 0:03, ▶ speaking) is in the footer status.
 */

import type { OsdStyle } from "./settings";

export interface OsdTint {
  dot?(text: string): string;
  accent?(text: string): string;
}

export interface OsdInput {
  style: OsdStyle;
  mode: "recording" | "playing";
  bands: readonly number[];
  tint?: OsdTint;
}

/** Rows of each style. */
export const OSD_ROWS: Record<Exclude<OsdStyle, "off">, number> = { braille: 3, bars: 3, mirror: 4, line: 2 };
/** Columns of each style, in terminal cells. */
export const OSD_COLUMNS: Record<Exclude<OsdStyle, "off">, number> = { braille: 20, bars: 24, mirror: 24, line: 32 };

const EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
// Braille cell bits per column, from the bottom dot (0) to the top dot (3).
const BRAILLE_LEFT = [0x40, 0x04, 0x02, 0x01] as const;
const BRAILLE_RIGHT = [0x80, 0x20, 0x10, 0x08] as const;
// Mirror halves: dots growing up from the centre line (top half) and down from it (bottom half).
const UP = [" ", "⣀", "⣤", "⣶", "⣿"] as const;
const DOWN = [" ", "⠉", "⠛", "⠿", "⣿"] as const;

function clampBand(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

/** `bands` stretched to `count` values by linear interpolation. */
export function resample(bands: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  if (!bands.length) return new Array<number>(count).fill(0);
  if (bands.length === 1) return new Array<number>(count).fill(clampBand(bands[0]));
  const maxSrc = bands.length - 1;
  const maxDst = Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => {
    const pos = (i / maxDst) * maxSrc;
    const lo = Math.floor(pos);
    const hi = Math.min(maxSrc, lo + 1);
    const t = pos - lo;
    return clampBand(bands[lo] * (1 - t) + bands[hi] * t);
  });
}

/** A level of `0..100` in `0..steps`; anything above 0 shows at least one step. */
function quantize(v: number, steps: number): number {
  if (v <= 0) return 0;
  return Math.max(1, Math.min(steps, Math.round((v / 100) * steps)));
}

/** How much of `level` falls in the row `fromBottom` rows up, each holding `perRow` steps. */
const inRow = (level: number, fromBottom: number, perRow: number) =>
  Math.max(0, Math.min(perRow, level - fromBottom * perRow));

function brailleCell(left: number, right: number): string {
  let mask = 0;
  for (let r = 0; r < left; r++) mask |= BRAILLE_LEFT[r];
  for (let r = 0; r < right; r++) mask |= BRAILLE_RIGHT[r];
  return mask === 0 ? " " : String.fromCharCode(0x2800 + mask);
}

/** The graph's rows, top first, untinted; every row is exactly `OSD_COLUMNS[style]` cells. */
export function osdRows(style: Exclude<OsdStyle, "off">, bands: readonly number[]): string[] {
  const rows = OSD_ROWS[style];
  const cols = OSD_COLUMNS[style];
  const out: string[] = [];
  switch (style) {
    case "braille": {
      // Two bands per cell, four dots per row.
      const levels = resample(bands, cols * 2).map((v) => quantize(v, rows * 4));
      for (let row = rows - 1; row >= 0; row--) {
        let s = "";
        for (let c = 0; c < cols; c++) s += brailleCell(inRow(levels[2 * c], row, 4), inRow(levels[2 * c + 1], row, 4));
        out.push(s);
      }
      return out;
    }
    case "bars":
    case "line": {
      const levels = resample(bands, cols).map((v) => quantize(v, rows * 8));
      for (let row = rows - 1; row >= 0; row--) out.push(levels.map((l) => EIGHTHS[inRow(l, row, 8)]).join(""));
      return out;
    }
    case "mirror": {
      // Half the rows grow up from the centre line, half grow down from it, mirrored.
      const half = rows / 2;
      const levels = resample(bands, cols).map((v) => quantize(v, half * 4));
      for (let row = half - 1; row >= 0; row--) out.push(levels.map((l) => UP[inRow(l, row, 4)]).join(""));
      for (let row = 0; row < half; row++) out.push(levels.map((l) => DOWN[inRow(l, row, 4)]).join(""));
      return out;
    }
  }
}

/** The OSD's lines, tinted: red while recording, the accent while playing. None when it is off. */
export function renderOsd({ style, mode, bands, tint }: OsdInput): string[] {
  if (style === "off") return [];
  const color = mode === "recording" ? tint?.dot : tint?.accent;
  return osdRows(style, bands).map((row) => (color ? color(row) : row));
}

/** `lines` centred in `width` cells; `cells` is their width without colour codes. */
export function centre(lines: readonly string[], cells: number, width: number): string[] {
  const pad = " ".repeat(Math.max(0, Math.floor((width - cells) / 2)));
  return lines.map((l) => pad + l);
}
