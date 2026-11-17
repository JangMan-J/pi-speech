import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  ansiRgbTint,
  centre,
  holdingPresence,
  OSD_COLUMNS,
  OSD_FADE_TICKS,
  OSD_HOLD_TICKS,
  OSD_ROWS,
  type OsdThemeColors,
  osdRows,
  renderOsd,
} from "../../src/engine/osd";

const STYLES = ["braille", "line", "prism", "helix", "orb", "wave"] as const;
const sample = [10, 30, 60, 90, 100, 80, 50, 25, 15, 40, 70, 20];

describe("the spectrum OSD", () => {
  it("draws nothing when off", () => {
    expect(renderOsd({ style: "off", mode: "recording", bands: sample })).toEqual([]);
  });

  it("is a graph only, at each style's expanded size", () => {
    expect([OSD_COLUMNS.braille, OSD_ROWS.braille]).toEqual([36, 5]);
    expect([OSD_COLUMNS.line, OSD_ROWS.line]).toEqual([39, 5]);
    for (const style of STYLES) {
      const rows = osdRows(style, sample);
      expect(rows, style).toHaveLength(OSD_ROWS[style]);
      for (const r of rows) expect([...r], style).toHaveLength(OSD_COLUMNS[style]);
      expect(rows.join(""), style).not.toMatch(/REC|speaking|[a-z]/);
    }
  });

  it("fills from the bottom: a full band fills every row, silence leaves them blank", () => {
    expect(osdRows("line", [100])).toEqual(Array(5).fill(Array(20).fill("█").join(" ")));
    expect(osdRows("braille", [100]).every((r) => r === "⣿".repeat(36))).toBe(true);
    for (const style of STYLES) expect(osdRows(style, []).join("").trim(), style).toBe("");
    // A low level shows in the bottom row only.
    const low = osdRows("line", [10]);
    expect(low[0].trim()).toBe("");
    expect(low[4].trim()).not.toBe("");
  });

  it("symmetrical waves grow from the centre spine without floating peak caps", () => {
    const waves = osdRows("wave", [100]);
    expect(waves).toHaveLength(5);
    expect(waves.every((r) => r === "⣿".repeat(44))).toBe(true);
    const quiet = osdRows("wave", [18]);
    expect(quiet[0].trim()).toBe("");
    expect(quiet[2].trim()).not.toBe("");
    expect(quiet[4].trim()).toBe("");
  });

  it("is red while recording and the accent while playing under 16-colour fallback", () => {
    const tint = { dot: (t: string) => `<red>${t}</red>`, accent: (t: string) => `<acc>${t}</acc>` };
    expect(renderOsd({ style: "line", mode: "recording", bands: sample, tint })[0]).toMatch(/^<red>.*<\/red>$/);
    expect(renderOsd({ style: "line", mode: "playing", bands: sample, tint })[0]).toMatch(/^<acc>.*<\/acc>$/);
  });

  it("centres its lines in the width it is given", () => {
    expect(centre(["ab", "cd"], 2, 10)).toEqual(["    ab", "    cd"]);
    expect(centre(["abcdef"], 6, 4)).toEqual(["abcdef"]);
  });

  it("renders truecolor and 256-colour multi-tone shaders and phase animation at exact cell width", () => {
    for (const truecolor of [true, false]) {
      const rgb = ansiRgbTint(truecolor);
      for (const mode of ["playing", "recording"] as const) {
        for (const style of STYLES) {
          const lines = renderOsd({
            style,
            mode,
            bands: sample,
            tick: 5,
            tint: { rgb },
          });
          expect(lines, `${style} ${mode}`).toHaveLength(OSD_ROWS[style]);
          for (const line of lines) {
            expect(visibleWidth(line), `${style} ${mode}`).toBe(OSD_COLUMNS[style]);
          }
          expect(lines.join("\n"), `${style} ${mode}`).toContain(truecolor ? "\x1b[38;2;" : "\x1b[38;5;");
        }
      }
    }
    expect(osdRows("helix", sample, 0)).not.toEqual(osdRows("helix", sample, 4));
    expect(osdRows("orb", sample, 0)).not.toEqual(osdRows("orb", sample, 5));

    // Holding pattern on silence: Helix and Orb keep an idle pattern across hold + fade ticks, then vanish at 0.
    expect(holdingPresence(0)).toBe(1);
    expect(holdingPresence(OSD_HOLD_TICKS)).toBeCloseTo(0.82, 2);
    expect(holdingPresence(OSD_HOLD_TICKS + Math.floor(OSD_FADE_TICKS / 2))).toBeGreaterThan(0.2);
    expect(holdingPresence(OSD_HOLD_TICKS + OSD_FADE_TICKS)).toBe(0);

    for (const style of ["helix", "orb"] as const) {
      const held = osdRows(style, [], 6, 1).join("").replace(/\s+/g, "");
      const fading = osdRows(style, [], 12, 0.35).join("").replace(/\s+/g, "");
      const vanished = osdRows(style, [], 20, 0).join("").trim();
      expect(held.length, `${style} held`).toBeGreaterThan(fading.length);
      expect(fading.length, `${style} fading`).toBeGreaterThan(0);
      expect(vanished, `${style} vanished`).toBe("");
    }

    // The Orb's rings are drawn from the trail of levels: sound that was leaves rings in flight, and they travel
    // on after the sound has stopped; no sound in the trail leaves none.
    const inked = (rows: string[]) => rows.join("").replace(/\s+/g, "").length;
    const loud = Array<number>(40).fill(0.7);
    const quiet = Array<number>(40).fill(0);
    expect(inked(osdRows("orb", sample, 6, 1, loud))).toBeGreaterThan(inked(osdRows("orb", sample, 6, 1, quiet)));
    expect(inked(osdRows("orb", [], 6, 1, loud))).toBeGreaterThan(inked(osdRows("orb", [], 6, 1, quiet)));
    for (const r of osdRows("orb", sample, 6, 1, loud)) expect([...r]).toHaveLength(OSD_COLUMNS.orb);

    // Light-theme palette shades toward dark ink and fades reflections toward light surface bg rather than black.
    const lightPalette: OsdThemeColors = {
      appearance: "light",
      bg: [245, 247, 250],
      ink: [40, 44, 50],
      accent: [110, 75, 190],
      error: [205, 35, 60],
      warning: [165, 115, 5],
      success: [40, 140, 90],
      keyword: [35, 120, 165],
      variable: [25, 135, 145],
      string: [180, 85, 20],
      magenta: [200, 60, 165],
    };
    const lightWaves = renderOsd({
      style: "wave",
      mode: "playing",
      bands: [100],
      palette: lightPalette,
      tint: { rgb: ansiRgbTint(true) },
    });
    expect(lightWaves).toHaveLength(OSD_ROWS.wave);
    expect(lightWaves.join("")).toContain("35;120;165"); // light-theme keyword blue, not default dark ink
  });
});
