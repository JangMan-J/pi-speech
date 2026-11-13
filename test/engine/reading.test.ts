import { describe, expect, it } from "vitest";
import { ReadingFailed, readingFailedMessage } from "../../src/engine/reading";

describe("a failed Reading", () => {
  it("carries its reason", () => {
    const err = new ReadingFailed("OpenRouter answered 402");
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe("OpenRouter answered 402");
  });

  it("is one message: who stopped, why, and that nothing was saved", () => {
    expect(readingFailedMessage("Speech", "text", "OpenRouter answered 402.")).toBe(
      "Speech stopped: OpenRouter answered 402. The text was not saved; " +
        "try /speech --replay for the last saved message, or pick another speech model in /speech.",
    );
  });
});
