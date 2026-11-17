import { describe, expect, it } from "vitest";
import { lookupOpenAiPrice, OpenAiPricingCache, parseOpenAiPricing } from "../../src/engine/openai-pricing";

const SAMPLE_MD = `
Realtime & Audio

| Model | Modality | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| gpt-audio-1.5 | Audio | $32.00 | $64.00 | - |
| gpt-audio-1.5 | Text | $2.50 | $10.00 | - |
| gpt-audio | Audio | $32.00 | $64.00 | - |
| gpt-audio | Text | $2.50 | $10.00 | - |
| gpt-4o-mini-tts | Audio | - | $12.00 | - |
| gpt-4o-mini-tts | Text | $0.60 | - | - |
| tts-1 | Text | $15.00 / 1M characters | - | - |
| tts-1-hd | Text | $30.00 / 1M characters | - | - |

Transcription

| Model | Use case | Input | Output | Estimated cost |
| --- | --- | --- | --- | --- |
| gpt-live-transcribe | Live transcription | - | - | $0.017 / minute |
| gpt-transcribe | Transcription | - | - | $0.0045 / minute |
| gpt-4o-transcribe | Transcription | $2.50 | $10.00 | $0.006 / minute |
| gpt-4o-mini-transcribe | Transcription | $1.25 | $5.00 | $0.003 / minute |
| gpt-4o-transcribe-diarize | Transcription + diarization | $2.50 | $10.00 | $0.006 / minute |
| Whisper | Transcription | - | - | $0.006 / minute |
`;

describe("OpenAI pricing parser", () => {
  it("parses TTS, chat audio, and transcription rates and matches dated model snapshots", () => {
    const table = parseOpenAiPricing(SAMPLE_MD);
    expect(lookupOpenAiPrice(table, "tts", "tts-1")).toBe("~$0.012/min");
    expect(lookupOpenAiPrice(table, "tts", "tts-1-1106")).toBe("~$0.012/min");
    expect(lookupOpenAiPrice(table, "tts", "tts-1-hd")).toBe("~$0.024/min");
    expect(lookupOpenAiPrice(table, "tts", "gpt-4o-mini-tts")).toBe("~$0.015/min");
    expect(lookupOpenAiPrice(table, "tts", "gpt-4o-mini-tts-2025-12-15")).toBe("~$0.015/min");
    expect(lookupOpenAiPrice(table, "tts", "gpt-audio")).toMatch(/^~\$0\.\d+\/min$/);
    expect(lookupOpenAiPrice(table, "tts", "gpt-audio-1.5")).toMatch(/^~\$0\.\d+\/min$/);

    expect(lookupOpenAiPrice(table, "stt", "whisper-1")).toBe("$0.006/min");
    expect(lookupOpenAiPrice(table, "stt", "gpt-4o-transcribe")).toBe("$0.006/min");
    expect(lookupOpenAiPrice(table, "stt", "gpt-4o-transcribe-2025-03-20")).toBe("$0.006/min");
    expect(lookupOpenAiPrice(table, "stt", "gpt-4o-mini-transcribe")).toBe("$0.003/min");
    expect(lookupOpenAiPrice(table, "stt", "gpt-4o-transcribe-diarize")).toBe("$0.006/min");
    expect(lookupOpenAiPrice(table, "stt", "gpt-transcribe")).toBe("$0.0045/min");
    expect(lookupOpenAiPrice(table, "stt", "unknown-custom-model")).toBeUndefined();
  });

  it("isolates cached pricing per OpenAiPricingCache instance", async () => {
    let calls = 0;
    const fetchStub = (async () => {
      calls++;
      return new Response(SAMPLE_MD, { status: 200 });
    }) as unknown as typeof fetch;
    const a = new OpenAiPricingCache();
    const b = new OpenAiPricingCache();
    await a.fetch(fetchStub);
    await a.fetch(fetchStub);
    expect(calls).toBe(1);
    await b.fetch(fetchStub);
    expect(calls).toBe(2);
  });
});
