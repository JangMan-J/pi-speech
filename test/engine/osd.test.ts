import { describe, expect, it } from "vitest";
import { centre, OSD_COLUMNS, OSD_ROWS, osdRows, renderOsd } from "../../src/engine/osd";

const STYLES = ["braille", "bars", "mirror", "line"] as const;
const sample = [10, 30, 60, 90, 100, 80, 50, 25, 15, 40, 70, 20];

describe("the spectrum OSD", () => {
  it("draws nothing when off", () => {
    expect(renderOsd({ style: "off", mode: "recording", bands: sample })).toEqual([]);
  });

  it("is a graph only, at each style's size: braille 20×3, bars 24×3, mirror 24×4, line 32×2", () => {
    expect([OSD_COLUMNS.braille, OSD_ROWS.braille]).toEqual([20, 3]);
    for (const style of STYLES) {
      const rows = osdRows(style, sample);
      expect(rows, style).toHaveLength(OSD_ROWS[style]);
      for (const r of rows) expect([...r], style).toHaveLength(OSD_COLUMNS[style]);
      expect(rows.join(""), style).not.toMatch(/REC|speaking|[a-z]/);
    }
  });

  it("fills from the bottom: a full band fills every row, silence leaves them blank", () => {
    expect(osdRows("bars", [100])).toEqual(["█".repeat(24), "█".repeat(24), "█".repeat(24)]);
    expect(osdRows("braille", [100]).every((r) => r === "⣿".repeat(20))).toBe(true);
    for (const style of STYLES) expect(osdRows(style, []).join("").trim(), style).toBe("");
    // A low level shows in the bottom row only.
    const low = osdRows("bars", [10]);
    expect(low[0].trim()).toBe("");
    expect(low[2].trim()).not.toBe("");
  });

  it("mirrors around its centre line", () => {
    const [top2, top1, bottom1, bottom2] = osdRows("mirror", [100]);
    expect([top2, top1, bottom1, bottom2].every((r) => r === "⣿".repeat(24))).toBe(true);
    const quiet = osdRows("mirror", [20]);
    expect(quiet[0].trim()).toBe("");
    expect(quiet[1].trim()).not.toBe("");
    expect(quiet[2].trim()).not.toBe("");
    expect(quiet[3].trim()).toBe("");
  });

  it("is red while recording and the accent while playing", () => {
    const tint = { dot: (t: string) => `<red>${t}</red>`, accent: (t: string) => `<acc>${t}</acc>` };
    expect(renderOsd({ style: "line", mode: "recording", bands: sample, tint })[0]).toMatch(/^<red>.*<\/red>$/);
    expect(renderOsd({ style: "line", mode: "playing", bands: sample, tint })[0]).toMatch(/^<acc>.*<\/acc>$/);
  });

  it("centres its lines in the width it is given", () => {
    expect(centre(["ab", "cd"], 2, 10)).toEqual(["    ab", "    cd"]);
    expect(centre(["abcdef"], 6, 4)).toEqual(["abcdef"]);
  });
});
