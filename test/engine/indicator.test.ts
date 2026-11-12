import { describe, expect, it } from "vitest";
import { Indicator, type IndicatorState, indicatorText } from "../../src/engine/indicator";

describe("the status indicator", () => {
  it("is empty when idle on the local route and names the bridge when idle there", () => {
    expect(indicatorText({ playing: false, route: "local" })).toBeUndefined();
    expect(indicatorText({ playing: false, route: "bridge" })).toBe("speech: bridge");
  });

  it("shows speaking while a playback runs, on either route", () => {
    expect(indicatorText({ playing: true, route: "local" })).toBe("▶ speaking");
    expect(indicatorText({ playing: true, route: "bridge" })).toBe("▶ speaking");
  });

  it("shows dictation above everything else", () => {
    expect(indicatorText({ dictation: "● REC 0:03", playing: true, route: "bridge" })).toBe("● REC 0:03");
    expect(indicatorText({ dictation: "… transcribing", playing: false, route: "local" })).toBe("… transcribing");
  });

  it("sends only changes, and the current text to a new sink", () => {
    const state: IndicatorState = { playing: false, route: "local" };
    const sent: Array<string | undefined> = [];
    const ind = new Indicator(
      () => state,
      (t) => sent.push(t),
    );
    ind.update();
    ind.update();
    state.playing = true;
    ind.update();
    ind.update();
    expect(sent).toEqual([undefined, "▶ speaking"]);
    const other: Array<string | undefined> = [];
    ind.attach((t) => other.push(t));
    expect(other).toEqual(["▶ speaking"]);
  });
});
