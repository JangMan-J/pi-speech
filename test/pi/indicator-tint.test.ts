import { describe, expect, it } from "vitest";
import { tintRecordingDot } from "../../src/pi/adapter";

const theme = { fg: (color: "error", text: string) => `<${color}>${text}</${color}>` };

describe("the recording dot", () => {
  it("is drawn in the error colour and the rest of the text is left alone", () => {
    expect(tintRecordingDot("● REC 0:03", theme)).toBe("<error>●</error> REC 0:03");
  });

  it("leaves other status texts and an empty status untouched", () => {
    expect(tintRecordingDot("▶ speaking", theme)).toBe("▶ speaking");
    expect(tintRecordingDot("… transcribing", theme)).toBe("… transcribing");
    expect(tintRecordingDot("speech: bridge", theme)).toBe("speech: bridge");
    expect(tintRecordingDot(undefined, theme)).toBeUndefined();
  });
});
