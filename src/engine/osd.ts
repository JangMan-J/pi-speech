/**
 * The spectrum OSD: the live 12 bands of a recording or playback, drawn as an animated graph centred above
 * the editor. It has no words: what speech is doing (● REC 0:03, ▶ speaking) is in the footer status.
 *
 * Seven visualizers: crisp high-contrast `Lines` and `Braille`, counter-twisting 3D `Helix`, chromatic
 * segmented `Prism` towers, ringed radial `Orb`, and symmetric braille `Waves`, with clean 256-colour,
 * 16-colour, and NO_COLOR fallbacks.
 */

import type { OsdStyle } from "./settings";

export type Rgb = readonly [number, number, number];

export interface OsdTint {
  dot?(text: string): string;
  accent?(text: string): string;
  /** Style `text` with foreground `fg` and optional background `bg` RGB. */
  rgb?(fg: Rgb, text: string, bg?: Rgb): string;
}

export interface OsdThemeColors {
  appearance: "dark" | "light";
  /** Terminal/surface background for fading reflections and silence decay in the right lightness direction. */
  bg: Rgb;
  /** Primary high-contrast foreground (`text`) for peak tips and crossover highlights. */
  ink: Rgb;
  accent: Rgb;
  error: Rgb;
  warning: Rgb;
  success: Rgb;
  keyword: Rgb;
  variable: Rgb;
  string: Rgb;
  magenta: Rgb;
}

export interface OsdInput {
  style: OsdStyle;
  mode: "recording" | "playing";
  bands: readonly number[];
  /** Monotonic frame tick (~21 fps) for phase-animated styles (`helix`, `orb`). */
  tick?: number;
  /** Holding-pattern presence (`0..1`) during silence pauses before vanishing (`0` hides immediately). */
  presence?: number;
  /** The overall level (`0..1`) of the latest ticks, the newest first: the Orb's rings are drawn from it. */
  trail?: readonly number[];
  /** Optional theme-derived semantic colours (falls back to built-in dark palette when omitted). */
  palette?: OsdThemeColors;
  tint?: OsdTint;
}

/** Silence ticks (~48 ms each) spent holding steady (~1.6 s) and contracting to vanish (~1.8 s, ~3.45 s total). */
export const OSD_HOLD_TICKS = 34;
export const OSD_FADE_TICKS = 38;

/** Compute holding-pattern presence (`1` active -> `0` vanished) after `silenceTicks` consecutive silent frames. */
export function holdingPresence(silenceTicks: number): number {
  if (silenceTicks <= 0) return 1;
  if (silenceTicks <= OSD_HOLD_TICKS) return 1 - (silenceTicks / OSD_HOLD_TICKS) * 0.18;
  const fade = 1 - (silenceTicks - OSD_HOLD_TICKS) / OSD_FADE_TICKS;
  return fade <= 0 ? 0 : 0.82 * fade;
}

/** Rows of each style. */
export const OSD_ROWS: Record<Exclude<OsdStyle, "off">, number> = {
  braille: 5,
  line: 5,
  prism: 5,
  helix: 5,
  orb: 7,
  wave: 5,
};

/** Columns of each style, in terminal cells. */
export const OSD_COLUMNS: Record<Exclude<OsdStyle, "off">, number> = {
  braille: 36,
  line: 39,
  prism: 44,
  helix: 44,
  orb: 36,
  wave: 44,
};

const EIGHTHS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const BRICKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆"] as const;
// Braille cell bits per column, from the bottom dot (0) to the top dot (3).
const BRAILLE_LEFT = [0x40, 0x04, 0x02, 0x01] as const;
const BRAILLE_RIGHT = [0x80, 0x20, 0x10, 0x08] as const;
// Braille cell bits per column, from the top dot (0) to the bottom dot (3) for 2D subpixel canvases.
const BRAILLE_TOP_LEFT = [0x01, 0x02, 0x04, 0x40] as const;
const BRAILLE_TOP_RIGHT = [0x08, 0x10, 0x20, 0x80] as const;

// ── Colour ramps & ANSI tinting ───────────────────────────────────────────

const DEFAULT_PALETTE: OsdThemeColors = {
  appearance: "dark",
  bg: [14, 16, 24],
  ink: [238, 248, 255],
  accent: [180, 105, 255],
  error: [255, 52, 88],
  warning: [255, 208, 62],
  success: [62, 238, 152],
  keyword: [58, 122, 255],
  variable: [0, 222, 245],
  string: [255, 142, 38],
  magenta: [255, 86, 205],
};

interface ResolvedRamps {
  playV: readonly Rgb[];
  playH: readonly Rgb[];
  recV: readonly Rgb[];
  recH: readonly Rgb[];
  prismPlay: readonly Rgb[];
  prismRec: readonly Rgb[];
  bg: Rgb;
  ink: Rgb;
  appearance: "dark" | "light";
  p: OsdThemeColors;
}

function resolveRamps(palette: OsdThemeColors = DEFAULT_PALETTE): ResolvedRamps {
  return {
    playV: [palette.keyword, palette.variable, palette.success, palette.ink],
    playH: [palette.keyword, palette.variable, palette.success, palette.accent, palette.magenta],
    recV: [palette.error, palette.string, palette.warning, palette.ink],
    recH: [palette.error, palette.string, palette.warning, palette.magenta],
    prismPlay: [
      palette.error,
      palette.string,
      palette.warning,
      palette.success,
      palette.variable,
      palette.keyword,
      palette.accent,
      palette.magenta,
    ],
    prismRec: [
      palette.error,
      palette.magenta,
      palette.string,
      palette.warning,
      palette.success,
      palette.variable,
      palette.accent,
    ],
    bg: palette.bg,
    ink: palette.ink,
    appearance: palette.appearance,
    p: palette,
  };
}

/** Boost colour saturation slightly so prose-tuned theme tokens read vividly on thin braille/bar strokes. */
export function vividRgb([r, g, b]: Rgb, boost = 1.22): Rgb {
  const mean = (r + g + b) / 3;
  return [byte(mean + (r - mean) * boost), byte(mean + (g - mean) * boost), byte(mean + (b - mean) * boost)];
}

const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const u = clamp01(t);
  return [byte(a[0] + (b[0] - a[0]) * u), byte(a[1] + (b[1] - a[1]) * u), byte(a[2] + (b[2] - a[2]) * u)];
}

/** Fade `c` toward `bg` as `keep` goes `1 -> 0` (works on both dark and light terminal backgrounds). */
function fadeTowardBg(c: Rgb, bg: Rgb, keep: number): Rgb {
  return mix(bg, c, clamp01(keep));
}

function ramp(stops: readonly Rgb[], t: number): Rgb {
  const u = clamp01(t) * (stops.length - 1);
  const lo = Math.floor(u);
  const hi = Math.min(stops.length - 1, lo + 1);
  return lo === hi ? stops[lo] : mix(stops[lo], stops[hi], u - lo);
}

function xterm256([r, g, b]: Rgb): number {
  const qr = Math.round((r / 255) * 5);
  const qg = Math.round((g / 255) * 5);
  const qb = Math.round((b / 255) * 5);
  return 16 + 36 * qr + 6 * qg + qb;
}

/** Build an ANSI foreground (+ optional background) RGB tint function for truecolor or 256-colour terminals. */
export function ansiRgbTint(truecolor = true): NonNullable<OsdTint["rgb"]> {
  if (truecolor) {
    return (fg, text, bg) =>
      bg
        ? `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]};48;2;${bg[0]};${bg[1]};${bg[2]}m${text}\x1b[39;49m`
        : `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m${text}\x1b[39m`;
  }
  return (fg, text, bg) =>
    bg
      ? `\x1b[38;5;${xterm256(fg)};48;5;${xterm256(bg)}m${text}\x1b[39;49m`
      : `\x1b[38;5;${xterm256(fg)}m${text}\x1b[39m`;
}

/** Synthetic mid-forward speech-like 12-band wave for previewing OSD styles while cycling settings. */
export function previewBands(tick: number): number[] {
  return Array.from({ length: 12 }, (_, i) => {
    const u = (i + 0.6) / 12.2;
    const contour = Math.sin(u * Math.PI) ** 0.85 * (i < 2 ? 0.72 + i * 0.14 : 1);
    const wave1 = 0.5 + 0.5 * Math.sin(tick * 0.42 - i * 0.65);
    const wave2 = 0.5 + 0.5 * Math.cos(tick * 0.27 + i * 0.95);
    return Math.round(8 + 90 * contour * (0.56 * wave1 + 0.44 * wave2));
  });
}

// ── Signal & geometry helpers ─────────────────────────────────────────────

interface Cell {
  ch: string;
  fg?: Rgb;
  bg?: Rgb;
}

function clampBand(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

function maxLevel(bands: readonly number[]): number {
  let m = 0;
  for (const v of bands) {
    const c = clampBand(v);
    if (c > m) m = c;
  }
  return m;
}

function meanSlice(bands: readonly number[], from: number, to: number): number {
  if (!bands.length) return 0;
  const lo = Math.max(0, Math.min(bands.length - 1, from));
  const hi = Math.max(lo, Math.min(bands.length - 1, to));
  let sum = 0;
  for (let i = lo; i <= hi; i++) sum += clampBand(bands[i]);
  return sum / (hi - lo + 1) / 100;
}

/** Sharpen inter-band contrast without inflating ceiling levels so peaks keep natural headroom. */
function punchBands(bands: readonly number[]): number[] {
  if (!bands.length) return [];
  const clamped = bands.map(clampBand);
  const mean = clamped.reduce((a, b) => a + b, 0) / clamped.length;
  return clamped.map((c) => {
    if (c <= 0) return 0;
    if (c >= 100) return 100;
    const contrast = c + (c - mean) * 0.28;
    return Math.round(clamp01(contrast / 100) ** 0.96 * 100);
  });
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

function blankGrid(rows: number, cols: number): Cell[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ch: " " })));
}

function dualAxisColor(ramps: ResolvedRamps, mode: "recording" | "playing", xFrac: number, yFrac: number): Rgb {
  const h = ramp(mode === "recording" ? ramps.recH : ramps.playH, xFrac);
  const v = ramp(mode === "recording" ? ramps.recV : ramps.playV, yFrac);
  return mix(h, v, 0.52 + yFrac * 0.28);
}

// ── Per-style cell grids ──────────────────────────────────────────────────

function buildCells(
  style: Exclude<OsdStyle, "off">,
  mode: "recording" | "playing",
  bands: readonly number[],
  tick: number,
  presence: number,
  palette?: OsdThemeColors,
  trail?: readonly number[],
): Cell[][] {
  const rows = OSD_ROWS[style];
  const cols = OSD_COLUMNS[style];
  const rec = mode === "recording";
  const ramps = resolveRamps(palette);
  const { p, bg, ink } = ramps;

  switch (style) {
    case "braille": {
      // 36x5 high-density braille (72x20 subpixels) with sharpened harmonic contrast.
      const punched = punchBands(bands);
      const levels = resample(punched, cols * 2).map((v) => quantize(v, rows * 4));
      const out: Cell[][] = [];
      for (let row = rows - 1; row >= 0; row--) {
        const yFrac = rows > 1 ? row / (rows - 1) : 0.5;
        const line: Cell[] = [];
        for (let c = 0; c < cols; c++) {
          const ch = brailleCell(inRow(levels[2 * c], row, 4), inRow(levels[2 * c + 1], row, 4));
          line.push(ch === " " ? { ch } : { ch, fg: dualAxisColor(ramps, mode, c / Math.max(1, cols - 1), yFrac) });
        }
        out.push(line);
      }
      return out;
    }

    case "line": {
      // 20 crisp 1-cell vertical lines separated by 1-cell air gaps (20 * 2 - 1 = 39 cols, 40 eighth-steps tall).
      const count = 20;
      const punched = punchBands(bands);
      const levels = resample(punched, count).map((v) => quantize(v, rows * 8));
      const out: Cell[][] = [];
      for (let row = rows - 1; row >= 0; row--) {
        const yFrac = rows > 1 ? row / (rows - 1) : 0;
        const line: Cell[] = [];
        for (let i = 0; i < count; i++) {
          const fill = inRow(levels[i], row, 8);
          const ch = EIGHTHS[fill];
          line.push(ch === " " ? { ch } : { ch, fg: dualAxisColor(ramps, mode, i / (count - 1), yFrac) });
          if (i < count - 1) line.push({ ch: " " });
        }
        out.push(line);
      }
      return out;
    }

    case "wave": {
      // Symmetric braille soundwave centred on a spine: paired lobes grow from the middle row.
      const halfRows = Math.floor(rows / 2);
      const punched = punchBands(bands);
      const levels = resample(punched, cols * 2).map((v) => quantize(v, halfRows * 4 + 2));
      const brailleHalf = (topHalf: boolean, left: number, right: number) => {
        if (topHalf) return brailleCell(left, right);
        let mask = 0;
        for (let r = 0; r < left; r++) mask |= BRAILLE_LEFT[3 - r];
        for (let r = 0; r < right; r++) mask |= BRAILLE_RIGHT[3 - r];
        return mask === 0 ? " " : String.fromCharCode(0x2800 + mask);
      };
      const lobeColor = (c: number, distFromSpine: number): Rgb => {
        const core = ink;
        const edge = ramp(rec ? ramps.recH : ramps.playH, c / Math.max(1, cols - 1));
        return mix(core, edge, clamp01(distFromSpine));
      };
      const out: Cell[][] = [];
      for (let row = halfRows - 1; row >= 0; row--) {
        const dist = (row + 1) / halfRows;
        const line: Cell[] = [];
        for (let c = 0; c < cols; c++) {
          const l = inRow(Math.max(0, levels[2 * c] - 2), row, 4);
          const r = inRow(Math.max(0, levels[2 * c + 1] - 2), row, 4);
          const ch = brailleHalf(true, l, r);
          line.push(ch === " " ? { ch } : { ch, fg: lobeColor(c, dist) });
        }
        out.push(line);
      }
      const spine: Cell[] = [];
      for (let c = 0; c < cols; c++) {
        const l = levels[2 * c];
        const r = levels[2 * c + 1];
        let mask = 0;
        if (l >= 1) mask |= BRAILLE_LEFT[1] | BRAILLE_LEFT[2];
        if (l >= 2) mask |= BRAILLE_LEFT[0] | BRAILLE_LEFT[3];
        if (r >= 1) mask |= BRAILLE_RIGHT[1] | BRAILLE_RIGHT[2];
        if (r >= 2) mask |= BRAILLE_RIGHT[0] | BRAILLE_RIGHT[3];
        const ch = mask === 0 ? " " : String.fromCharCode(0x2800 + mask);
        spine.push(ch === " " ? { ch } : { ch, fg: lobeColor(c, 0.12) });
      }
      out.push(spine);
      for (let row = 0; row < halfRows; row++) {
        const dist = (row + 1) / halfRows;
        const line: Cell[] = [];
        for (let c = 0; c < cols; c++) {
          const l = inRow(Math.max(0, levels[2 * c] - 2), row, 4);
          const r = inRow(Math.max(0, levels[2 * c + 1] - 2), row, 4);
          const ch = brailleHalf(false, l, r);
          line.push(ch === " " ? { ch } : { ch, fg: lobeColor(c, dist) });
        }
        out.push(line);
      }
      return out;
    }

    case "prism": {
      // 15 discrete 2-cell segmented LED towers separated by 1-cell air gaps (15 * 3 - 1 = 44 cols).
      const towers = 15;
      const punched = punchBands(bands);
      const levels = resample(punched, towers).map((v) => quantize(v, rows * 6));
      const prismStops = rec ? ramps.prismRec : ramps.prismPlay;
      const out: Cell[][] = [];
      for (let row = rows - 1; row >= 0; row--) {
        const yFrac = rows > 1 ? row / (rows - 1) : 0;
        const line: Cell[] = [];
        for (let t = 0; t < towers; t++) {
          const baseHue = ramp(prismStops, t / (towers - 1));
          const brickFg = mix(baseHue, ink, yFrac * 0.36);
          const fill = inRow(levels[t], row, 6);
          const cell: Cell = fill > 0 ? { ch: BRICKS[fill], fg: brickFg } : { ch: " " };
          line.push(cell, cell);
          if (t < towers - 1) line.push({ ch: " " });
        }
        out.push(line);
      }
      return out;
    }

    case "helix": {
      // 88x20 subpixel braille canvas: counter-twisting 3D double helix with a gentle holding braid on silence.
      const subW = cols * 2;
      const subH = rows * 4;
      const live = maxLevel(bands) > 0;
      const hold = live ? 1 : clamp01(presence);
      if (hold <= 0) return blankGrid(rows, cols);

      const env = live ? resample(punchBands(bands), subW) : new Array<number>(subW).fill(0);
      const avgE = live ? meanSlice(bands, 1, bands.length - 1) : 0;
      // Subpixel tag: 0 empty, 1 strand A, 2 strand B, 3 base-pair rung, 4 crossover (A + B).
      const canvas = Array.from({ length: subH }, () => new Uint8Array(subW));
      const depthA = new Float32Array(subW);
      const cx = (subW - 1) / 2;
      const cy = (subH - 1) / 2;
      const phase = tick * (live ? 0.38 : 0.24);
      // During the vanish tail (`hold < 0.78`), zip the ends smoothly inward toward the centre.
      const halfSpan = (subW / 2) * clamp01(hold / 0.78);
      const idleBreath = 1 + 0.18 * Math.sin(tick * 0.16);
      const dim = live ? 1 : 0.32 + 0.58 * hold ** 1.2;

      for (let x = 0; x < subW; x++) {
        const distFromCenter = Math.abs(x - cx);
        if (distFromCenter > halfSpan) continue;
        const spanU = halfSpan > 0.5 ? 0.5 + (x - cx) / (2 * halfSpan) : 0.5;
        const taper = Math.sin(clamp01(spanU) * Math.PI) ** 0.52;
        const a = clamp01((env[x] / 100) * 0.8 + avgE * 0.18) * taper;
        const idleAmp = 1.45 * idleBreath * hold * taper;
        const amp = Math.min(cy - 0.5, idleAmp + a * (cy - 1.9));
        const theta = x * 0.145 - phase;
        const s = Math.sin(theta);
        const z = Math.cos(theta);
        depthA[x] = z;
        const yA = cy - s * amp;
        const yB = cy + s * amp;
        const baseR = live ? (z >= 0 ? 0.85 : 0.52) : (z >= 0 ? 0.68 : 0.45) * Math.min(1, hold + 0.25);
        const baseRB = live ? (z < 0 ? 0.85 : 0.52) : (z < 0 ? 0.68 : 0.45) * Math.min(1, hold + 0.25);
        const rA = baseR + a * 0.58;
        const rB = baseRB + a * 0.58;

        if (x % 6 === 0 && Math.abs(yA - yB) >= 3.2 && a > 0.14) {
          const lo = Math.max(0, Math.ceil(Math.min(yA, yB)) + 1);
          const hi = Math.min(subH - 1, Math.floor(Math.max(yA, yB)) - 1);
          for (let y = lo; y <= hi; y += 2) canvas[y][x] = 3;
        }
        for (let y = 0; y < subH; y++) {
          const hitA = Math.abs(y - yA) <= rA;
          const hitB = Math.abs(y - yB) <= rB;
          if (hitA && hitB) canvas[y][x] = 4;
          else if (hitA) canvas[y][x] = 1;
          else if (hitB) canvas[y][x] = 2;
        }
      }

      const strandA1 = rec ? p.error : p.variable;
      const strandA2 = rec ? p.magenta : p.success;
      const strandB1 = rec ? p.string : p.accent;
      const strandB2 = rec ? p.warning : p.magenta;
      const crossFg = mix(ink, rec ? p.warning : p.variable, 0.22);
      const rungFg = fadeTowardBg(rec ? p.error : p.keyword, bg, 0.58);

      const out: Cell[][] = [];
      for (let row = 0; row < rows; row++) {
        const line: Cell[] = [];
        for (let c = 0; c < cols; c++) {
          let mask = 0;
          let countA = 0;
          let countB = 0;
          let countCross = 0;
          for (let dy = 0; dy < 4; dy++) {
            const y = row * 4 + dy;
            const tl = canvas[y][2 * c];
            const tr = canvas[y][2 * c + 1];
            if (tl) {
              mask |= BRAILLE_TOP_LEFT[dy];
              if (tl === 4) countCross++;
              else if (tl === 1) countA++;
              else if (tl === 2) countB++;
            }
            if (tr) {
              mask |= BRAILLE_TOP_RIGHT[dy];
              if (tr === 4) countCross++;
              else if (tr === 1) countA++;
              else if (tr === 2) countB++;
            }
          }
          if (mask === 0) {
            line.push({ ch: " " });
            continue;
          }
          const ch = String.fromCharCode(0x2800 + mask);
          const u = c / Math.max(1, cols - 1);
          const z = depthA[2 * c];
          let fg: Rgb;
          if (countCross > 0 || (countA > 0 && countB > 0)) {
            fg = fadeTowardBg(crossFg, bg, dim);
          } else if (countA >= countB && countA > 0) {
            fg = fadeTowardBg(mix(strandA1, strandA2, u), bg, (0.76 + 0.24 * (z * 0.5 + 0.5)) * dim);
          } else if (countB > 0) {
            fg = fadeTowardBg(mix(strandB1, strandB2, u), bg, (0.76 + 0.24 * (-z * 0.5 + 0.5)) * dim);
          } else {
            fg = fadeTowardBg(rungFg, bg, dim);
          }
          line.push({ ch, fg });
        }
        out.push(line);
      }
      return out;
    }

    case "orb":
      return orbCells(rows, cols, rec, bands, tick, presence, ramps, trail);
  }
}

const TAU = Math.PI * 2;
// What a subpixel of the orb canvas belongs to.
const ORB_CORE = 1;
const ORB_HALO = 2;
const ORB_HALO_MID = 3;
const ORB_HALO_DIM = 4;
/** How much of its colour a halo subpixel of each kind keeps, by `tag - ORB_HALO`. */
const HALO_KEEP = [1, 0.66, 0.32];
/**
 * What the halo does while there is sound: `rings` sends a ring outwards for each stretch of sound; `ripple` keeps
 * one loop and runs a wave around it.
 */
const ORB_HALO_STYLE = "rings" as "rings" | "ripple";
/** The ripple: how far the loop swings at full sound, in subpixels, and how many waves run around it. */
const HALO_RIPPLE = 2.6;
const HALO_WAVES = 7;
/**
 * The rings: one leaves every RING_EVERY ticks, RING_START subpixels wide to each side, and grows by RING_SPEED a
 * tick; RING_FLAT is its height for its width, and RING_DASH the length a broken ring repeats over.
 */
const RING_EVERY = 6;
const RING_START = 6;
const RING_SPEED = 1.1;
const RING_FLAT = 0.36;
const RING_DASH = 9;
/**
 * How strongly the live spectrum coils a ring: at the loudest band its radius grows by this fraction of its base.
 * A ring dissipates as it travels too: `RING_FADE_HEADROOM` kills its density a little before the outer edge.
 */
const COIL_DEPTH = 0.6;
const RING_FADE_HEADROOM = 1.15;

/**
 * The Orb, an energy core on a 72x28 braille subpixel canvas:
 * - a hollow core ring that grows with the voice's lower mids, with a nucleus that lights when there is energy;
 * - six flares turning around it, each reaching as far as the spectrum says at its angle (low bands on one side
 *   of the turning axis, high bands on the other, mirrored);
 * - a halo in a slowly rocking frame: a still loop around the core on silence; while there is sound, rings that
 *   leave the core and travel outwards. Each coils with the live spectrum (its radius at every angle follows that
 *   band) and dissipates as it goes, thinning to dashes and dimming until it is gone near the edge (ORB_HALO_STYLE).
 * On silence the flares are gone, the rings in flight travel on, and core and loop keep turning, then draw in to
 * a point and vanish. `trail` is the overall level (`0..1`) of the latest ticks, the newest first; without it the
 * rings all follow the level now.
 */
function orbCells(
  rows: number,
  cols: number,
  rec: boolean,
  bands: readonly number[],
  tick: number,
  presence: number,
  ramps: ResolvedRamps,
  trail: readonly number[] | undefined,
): Cell[][] {
  const subW = cols * 2;
  const subH = rows * 4;
  const live = maxLevel(bands) > 0;
  const hold = live ? 1 : clamp01(presence);
  if (hold <= 0) return blankGrid(rows, cols);
  const { p, bg, ink } = ramps;

  const lowMid = live ? meanSlice(bands, 1, 4) : 0;
  const mid = live ? meanSlice(bands, 3, 8) : 0;
  const high = live ? meanSlice(bands, 8, 11) : 0;
  const energy = lowMid * 0.35 + mid * 0.45 + high * 0.2;
  const angular = live ? resample(punchBands(bands), 16) : new Array<number>(16).fill(0);
  const cx = (subW - 1) / 2;
  const cy = (subH - 1) / 2;
  const idleBreath = 1 + 0.12 * Math.sin(tick * 0.15);
  const rCore = live ? 2.2 + lowMid * 3.1 : Math.max(0.55, 2.35 * idleBreath * clamp01(hold * 1.15));
  const rMax = cy - 0.2;
  const rot = tick * (live ? 0.095 : 0.065);
  const dim = live ? 1 : 0.45 + 0.55 * hold ** 1.1;
  /** The spectrum at `theta` (0..1), folded around the turning axis and blended between neighbouring bands. */
  const spectrumAt = (theta: number): number => {
    const turn = (((theta - rot + Math.PI) % TAU) + TAU) % TAU;
    const pos = (Math.abs(turn - Math.PI) / Math.PI) * (angular.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(angular.length - 1, lo + 1);
    return (angular[lo] * (1 - (pos - lo)) + angular[hi] * (pos - lo)) / 100;
  };
  const canvas = Array.from({ length: subH }, () => new Uint8Array(subW));

  for (let y = 0; y < subH; y++) {
    for (let x = 0; x < subW; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      if (r > rMax + 3.0) continue;
      const onCoreRim = Math.abs(r - rCore) <= (live ? 1.22 : 0.95);
      const onNucleus = live
        ? r <= rCore * 0.62 && energy > 0.18
        : r <= 0.95 && (hold < 0.35 || Math.sin(tick * 0.2) > -0.25);
      let onRay = false;
      if (live) {
        const theta = Math.atan2(dy, dx);
        // The angle from the turning axis, 0..1 on both sides of it. The remainder must not go negative: it did
        // once the axis had turned far enough, and every flare then followed the highest band alone.
        const turn = (((theta - rot + Math.PI) % TAU) + TAU) % TAU;
        const pos = (Math.abs(turn - Math.PI) / Math.PI) * (angular.length - 1);
        const lo = Math.floor(pos);
        const hi = Math.min(angular.length - 1, lo + 1);
        const bandVal = ((angular[lo] * (1 - (pos - lo)) + angular[hi] * (pos - lo)) / 100) ** 0.78;
        const spoke = Math.cos(6 * (theta - rot));
        const rRay = rCore + 1.1 + bandVal * (rMax + 1.8 - rCore) * (0.55 + 0.45 * Math.max(0, spoke));
        onRay = r > rCore + 0.4 && r <= rRay && (spoke > 0.08 || r <= rCore + 2.2 + bandVal * 3.4);
      }
      if (onCoreRim || onNucleus || onRay) canvas[y][x] = ORB_CORE;
    }
  }

  // The halo's frame rocks slowly, the same with and without sound, so nothing jumps when the voice stops.
  const tilt = Math.sin(tick * 0.05) * 0.18;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  /**
   * Draw a loop `a` subpixels wide to each side, `at(phi)` high, in the halo's frame. It is drawn along its own
   * length, so it is as thick at its tips as across the middle; `keep` leaves gaps by the distance run.
   */
  const loop = (a: number, at: (phi: number) => number, tag: number, keep?: (run: number) => boolean) => {
    const steps = Math.ceil(a * 8);
    for (let i = 0; i < steps; i++) {
      const phi = (i / steps) * TAU;
      if (keep && !keep(phi * a)) continue;
      const ex = a * Math.cos(phi);
      const ey = at(phi);
      const x0 = Math.floor(cx + ex * cosT - ey * sinT);
      const y = Math.floor(cy + ex * sinT + ey * cosT);
      // Its upper arc is the far side: the core hides it.
      const far = Math.sin(phi) < 0;
      // Two subpixels wide and one tall: a fine line on its long runs that stays solid where it turns.
      for (const x of [x0, x0 + 1]) {
        if (x < 0 || x >= subW || y < 0 || y >= subH || canvas[y][x]) continue;
        if (far && Math.hypot(x - cx, y - cy) <= rCore + 0.55) continue;
        canvas[y][x] = tag;
      }
    }
  };
  const still = live ? 1 : clamp01((hold - 0.15) / 0.85);
  /** Like `loop`, but the radius is a function of the angle so a ring can coil with the spectrum. */
  const loopRadius = (radiusAt: (phi: number) => number, tag: number, keep: (run: number) => boolean, maxR: number) => {
    const steps = Math.ceil(maxR * 8);
    for (let i = 0; i < steps; i++) {
      const phi = (i / steps) * TAU;
      const r = radiusAt(phi);
      // Dash by arc length so the breaks are a fixed physical size whatever the ring's radius.
      if (!keep(phi * r)) continue;
      const ex = r * Math.cos(phi);
      const ey = r * RING_FLAT * Math.sin(phi);
      const x0 = Math.floor(cx + ex * cosT - ey * sinT);
      const y = Math.floor(cy + ex * sinT + ey * cosT);
      const far = Math.sin(phi) < 0;
      for (const x of [x0, x0 + 1]) {
        if (x < 0 || x >= subW || y < 0 || y >= subH || canvas[y][x]) continue;
        if (far && Math.hypot(x - cx, y - cy) <= rCore + 0.55) continue;
        canvas[y][x] = tag;
      }
    }
  };
  if (ORB_HALO_STYLE === "ripple") {
    if (live || hold > 0.2) {
      const a = live ? 10.5 + (mid * 0.6 + high * 0.4) * (cx - 12.0) : 3.2 + 7.8 * still;
      const b = live ? 2.2 + lowMid * 2.1 : 1.0 + 1.25 * still;
      const ripple = live ? (mid * 0.6 + high * 0.4) ** 0.8 * HALO_RIPPLE : 0;
      loop(a, (phi) => b * Math.sin(phi) + ripple * Math.sin(HALO_WAVES * phi - tick * 0.5), ORB_HALO);
    }
  } else {
    // On silence, the still loop around the core.
    if (!live && hold > 0.2) loop(3.2 + 7.8 * still, (phi) => (1.0 + 1.25 * still) * Math.sin(phi), ORB_HALO);
    // Rings leave the core one after another and travel outwards: each is as strong as the sound was when it
    // left, so a loud stretch is a solid ring and a soft one a broken ring, and a pause is a gap between them.
    // Each coils with the live spectrum, and dissipates as it travels: density and brightness both die before the
    // outer edge, so a ring never hangs around the frame at full strength.
    for (let age = tick % RING_EVERY; RING_START + age * RING_SPEED <= cx; age += RING_EVERY) {
      let level = live ? energy : 0;
      if (trail?.length) {
        level = 0;
        // The loudest tick of the stretch the ring stands for, so no syllable falls between two rings.
        const half = Math.floor(RING_EVERY / 2);
        for (let k = age - half; k <= age + half; k++) level = Math.max(level, trail[k] ?? 0);
      }
      if (level < 0.1) continue;
      const a = RING_START + age * RING_SPEED;
      const fade = 1 - (a - RING_START) / (cx - RING_START);
      const tag = fade > 0.66 ? ORB_HALO : fade > 0.33 ? ORB_HALO_MID : ORB_HALO_DIM;
      // Dissipate outward: `solid` is the dash density, gone a little before the ring reaches the edge.
      const solid = clamp01(0.3 + level * 1.2) * clamp01(fade * RING_FADE_HEADROOM);
      loopRadius(
        (phi) => a * (1 + COIL_DEPTH * spectrumAt(phi)),
        tag,
        (run) => run % RING_DASH < RING_DASH * solid,
        cx,
      );
    }
  }

  const orbStops: readonly Rgb[] = rec ? [ink, p.warning, p.string, p.error] : [ink, p.variable, p.keyword, p.accent];
  const haloFg = rec ? p.magenta : p.success;

  const out: Cell[][] = [];
  for (let row = 0; row < rows; row++) {
    const line: Cell[] = [];
    for (let c = 0; c < cols; c++) {
      let mask = 0;
      const hits = [0, 0, 0, 0, 0];
      for (let dy = 0; dy < 4; dy++) {
        const y = row * 4 + dy;
        const tl = canvas[y][2 * c];
        const tr = canvas[y][2 * c + 1];
        if (tl) {
          mask |= BRAILLE_TOP_LEFT[dy];
          hits[tl]++;
        }
        if (tr) {
          mask |= BRAILLE_TOP_RIGHT[dy];
          hits[tr]++;
        }
      }
      if (mask === 0) {
        line.push({ ch: " " });
        continue;
      }
      const cellR = Math.hypot(2 * c + 0.5 - cx, row * 4 + 1.5 - cy);
      // A cell has one colour: the halo's when most of its dots are the halo's, as bright as its brightest ring.
      const halo = [ORB_HALO, ORB_HALO_MID, ORB_HALO_DIM].find((tag) => hits[tag] > 0);
      const isHalo = halo !== undefined && hits[ORB_HALO] + hits[ORB_HALO_MID] + hits[ORB_HALO_DIM] > hits[ORB_CORE];
      const rawFg = isHalo ? haloFg : ramp(orbStops, cellR / (rMax + 2));
      // Denser chroma: saturate the themed stop so thin braille strokes read solid, not pastel.
      const denseFg = vividRgb(mix(rawFg, ink, 0.12), 1.34);
      const keep = dim * (isHalo ? HALO_KEEP[halo - ORB_HALO] : 1);
      line.push({ ch: String.fromCharCode(0x2800 + mask), fg: fadeTowardBg(denseFg, bg, keep) });
    }
    out.push(line);
  }
  return out;
}

function sameRgb(a: Rgb | undefined, b: Rgb | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function paintRow(cells: readonly Cell[], rgb: NonNullable<OsdTint["rgb"]>): string {
  let out = "";
  let i = 0;
  while (i < cells.length) {
    const { fg, bg } = cells[i];
    let run = cells[i].ch;
    let j = i + 1;
    while (j < cells.length && sameRgb(cells[j].fg, fg) && sameRgb(cells[j].bg, bg)) {
      run += cells[j].ch;
      j++;
    }
    out += fg ? rgb(fg, run, bg) : run;
    i = j;
  }
  return out;
}

/** The graph's rows, top first, untinted; every row is exactly `OSD_COLUMNS[style]` cells. */
export function osdRows(
  style: Exclude<OsdStyle, "off">,
  bands: readonly number[],
  tick = 0,
  presence = 0,
  trail?: readonly number[],
): string[] {
  return buildCells(style, "playing", bands, tick, presence, undefined, trail).map((row) =>
    row.map((c) => c.ch).join(""),
  );
}

/** The OSD's lines, multi-colour shaded when `tint.rgb` is given, 1-colour when `dot`/`accent` is given, else plain. */
export function renderOsd({ style, mode, bands, tick = 0, presence = 0, trail, palette, tint }: OsdInput): string[] {
  if (style === "off") return [];
  if (tint?.rgb) {
    const rgb = tint.rgb;
    return buildCells(style, mode, bands, tick, presence, palette, trail).map((row) => paintRow(row, rgb));
  }
  const color = mode === "recording" ? tint?.dot : tint?.accent;
  return osdRows(style, bands, tick, presence, trail).map((row) => (color ? color(row) : row));
}

/** `lines` centred in `width` cells; `cells` is their width without colour codes. */
export function centre(lines: readonly string[], cells: number, width: number): string[] {
  const pad = " ".repeat(Math.max(0, Math.floor((width - cells) / 2)));
  return lines.map((l) => pad + l);
}
