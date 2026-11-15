import type { OsdStyle } from "./settings";

export interface OsdTint {
  dot?(text: string): string;
  accent?(text: string): string;
  dim?(text: string): string;
}

export interface OsdInput {
  style: OsdStyle;
  mode: "recording" | "playing";
  label: string;
  bands: readonly number[];
  tint?: OsdTint;
}

const BARS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const LINE_BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const MIRROR_TOP = [" ", "⣀", "⣤", "⣶", "⣿"] as const;
const MIRROR_BOTTOM = [" ", "⠉", "⠛", "⠿", "⣿"] as const;

// Braille cell bits per column, indexed from bottom dot (0) to top dot (3).
const BRAILLE_LEFT = [0x40, 0x04, 0x02, 0x01] as const;
const BRAILLE_RIGHT = [0x80, 0x20, 0x10, 0x08] as const;

function resample(bands: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  if (!bands.length) return new Array<number>(count).fill(0);
  if (bands.length === 1) return new Array<number>(count).fill(clampBand(bands[0]));
  const out = new Array<number>(count);
  const maxSrc = bands.length - 1;
  const maxDst = Math.max(1, count - 1);
  for (let i = 0; i < count; i++) {
    const pos = (i / maxDst) * maxSrc;
    const lo = Math.floor(pos);
    const hi = Math.min(maxSrc, lo + 1);
    const t = pos - lo;
    out[i] = clampBand(bands[lo] * (1 - t) + bands[hi] * t);
  }
  return out;
}

function clampBand(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function quantize(v: number, steps: number): number {
  if (v <= 0) return 0;
  return Math.max(1, Math.min(steps, Math.round((v / 100) * steps)));
}

function brailleCell(leftRows: number, rightRows: number): string {
  let mask = 0;
  for (let r = 0; r < leftRows && r < 4; r++) mask |= BRAILLE_LEFT[r];
  for (let r = 0; r < rightRows && r < 4; r++) mask |= BRAILLE_RIGHT[r];
  return mask === 0 ? " " : String.fromCharCode(0x2800 + mask);
}

function styleLabel(mode: "recording" | "playing", label: string, tint?: OsdTint): string {
  if (mode === "recording" && label.startsWith("●") && tint?.dot) {
    return tint.dot("●") + label.slice(1);
  }
  if (mode === "playing" && label.startsWith("▶") && tint?.accent) {
    return tint.accent("▶") + label.slice(1);
  }
  return label;
}

/** Render the live spectrum OSD lines (0, 1, or 2 lines) for `aboveEditor` placement. */
export function renderOsd({ style, mode, label, bands, tint }: OsdInput): string[] {
  if (style === "off") return [];

  const badge = styleLabel(mode, label, tint);
  const pad = " ".repeat([...label].length);
  const colorGraph = (s: string) => {
    if (mode === "recording") return tint?.dot ? tint.dot(s) : s;
    return tint?.accent ? tint.accent(s) : s;
  };

  switch (style) {
    case "line": {
      const vals = resample(bands, 12);
      const graph = vals.map((v) => LINE_BARS[Math.max(0, Math.min(7, Math.round((v / 100) * 7)))]).join("");
      return [`${badge}  ${colorGraph(graph)}`];
    }

    case "bars": {
      const vals = resample(bands, 16);
      let top = "";
      let bottom = "";
      for (const v of vals) {
        const lvl = quantize(v, 16);
        top += BARS[Math.max(0, lvl - 8)];
        bottom += BARS[Math.min(8, lvl)];
      }
      return [`${badge}  ${colorGraph(top)}`, `${pad}  ${colorGraph(bottom)}`];
    }

    case "mirror": {
      const vals = resample(bands, 16);
      let top = "";
      let bottom = "";
      for (const v of vals) {
        const lvl = quantize(v, 4);
        top += MIRROR_TOP[lvl];
        bottom += MIRROR_BOTTOM[lvl];
      }
      return [`${badge}  ${colorGraph(top)}`, `${pad}  ${colorGraph(bottom)}`];
    }

    case "braille": {
      const vals = resample(bands, 24);
      let top = "";
      let bottom = "";
      for (let i = 0; i < vals.length; i += 2) {
        const l = quantize(vals[i], 8);
        const r = quantize(vals[i + 1] ?? 0, 8);
        top += brailleCell(Math.max(0, l - 4), Math.max(0, r - 4));
        bottom += brailleCell(Math.min(4, l), Math.min(4, r));
      }
      return [`${badge}  ${colorGraph(top)}`, `${pad}  ${colorGraph(bottom)}`];
    }
  }
}
