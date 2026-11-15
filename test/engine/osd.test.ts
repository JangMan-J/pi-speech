import { describe, expect, it } from "vitest";
import { renderOsd } from "../../src/engine/osd";

describe("OSD spectrum renderer", () => {
  const sample = [10, 30, 60, 90, 100, 80, 50, 25, 15, 40, 70, 20];

  it("returns no lines when off", () => {
    expect(renderOsd({ style: "off", mode: "recording", label: "● REC 0:03", bands: sample })).toEqual([]);
  });

  it("renders braille (default), bars, and mirror as 2 lines and line as 1 line", () => {
    const braille = renderOsd({ style: "braille", mode: "recording", label: "● REC 0:03", bands: sample });
    expect(braille).toHaveLength(2);
    expect(braille[0]).toContain("● REC 0:03");
    expect(braille[1].startsWith(" ".repeat("● REC 0:03".length + 2))).toBe(true);

    const bars = renderOsd({ style: "bars", mode: "playing", label: "▶ speaking", bands: sample });
    expect(bars).toHaveLength(2);
    expect(bars[0]).toContain("▶ speaking");
    expect(bars[1]).toMatch(/[▁▂▃▄▅▆▇█]/);

    const mirror = renderOsd({ style: "mirror", mode: "recording", label: "● REC 0:03", bands: sample });
    expect(mirror).toHaveLength(2);
    expect(mirror[0]).toMatch(/[⣀⣤⣶⣿]/);
    expect(mirror[1]).toMatch(/[⠉⠛⠿⣿]/);

    const line = renderOsd({ style: "line", mode: "playing", label: "▶ speaking", bands: sample });
    expect(line).toHaveLength(1);
    expect(line[0]).toMatch(/^▶ speaking {2}[▁▂▃▄▅▆▇█]{12}$/);
  });

  it("handles empty bands cleanly and applies tint callbacks", () => {
    const idle = renderOsd({
      style: "braille",
      mode: "recording",
      label: "● REC 0:00",
      bands: [],
      tint: { dot: (t) => `<err>${t}</err>` },
    });
    expect(idle).toHaveLength(2);
    expect(idle[0]).toContain("<err>●</err> REC 0:00");
  });
});
