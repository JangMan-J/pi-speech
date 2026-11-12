import { describe, expect, it } from "vitest";
import { chatPriceTag, perMinute, priceTag, priceValue } from "../../src/engine/pricing";

// Ported from pi-openrouter-multimodal test/unit/priceTag.test.ts (speech and transcription cases).
describe("priceTag", () => {
  it("normalizes speech models to dollars per minute of audio", () => {
    // per character (ElevenLabs v3, $0.00008/char): 800 chars/min, estimated
    expect(priceTag({ prompt: "0.00008", completion: "0" }, "tts", "elevenlabs/eleven-v3")).toBe("~$0.064/min");
    // per second of output audio (Seed Audio, $0.0025/s): exact
    expect(priceTag({ prompt: "0", completion: "0.0025" }, "tts", "bytedance-seed/seed-audio-1-0")).toBe("$0.15/min");
    // per token (Gemini TTS): 25 audio tokens/s out + 250 text tokens/min in, estimated
    expect(priceTag({ prompt: "0.000001", completion: "0.00002" }, "tts", "google/gemini-3.1-flash-tts-preview")).toBe(
      "~$0.03/min",
    );
  });

  it("normalizes transcription models to dollars per minute of audio", () => {
    // per second (Whisper-1, $0.0001/s)
    expect(priceTag({ prompt: "0.0001", completion: "0" }, "stt", "openai/whisper-1")).toBe("$0.006/min");
    // per hour (MAI-Transcribe 2 lists $0.10)
    expect(priceTag({ prompt: "0.1", completion: "0" }, "stt", "microsoft/mai-transcribe-2")).toBe("$0.0017/min");
    // per token: OpenAI audio in at 10 tokens/s, Gemini at 25 tokens/s; estimated
    expect(priceTag({ prompt: "0.0000025", completion: "0.00001" }, "stt", "openai/gpt-4o-transcribe")).toBe(
      "~$0.004/min",
    );
    expect(priceTag({ prompt: "0.000002", completion: "0.000012" }, "stt", "google/gemini-3.5-transcribe")).toBe(
      "~$0.006/min",
    );
    expect(priceTag({ prompt: "0", completion: "0" }, "stt")).toBe("$0");
  });

  it("shows nothing without usable pricing", () => {
    expect(priceTag(undefined, "tts")).toBeUndefined();
    expect(priceTag({ prompt: "-1" }, "stt")).toBeUndefined();
    expect(priceTag({ prompt: "abc" }, "tts")).toBeUndefined();
  });
});

// The catalog's prices on 2026-11-12, next to what a 32-second recording (or a 5-second reading) cost.
describe("chatPriceTag", () => {
  it("estimates a chat model that takes audio by the audio tokens its maker counts per second", () => {
    // Gemini: 25 tokens/s; the request cost $0.0020/min
    expect(
      chatPriceTag(
        { prompt: "0.000000825", completion: "0.000004125", audio: "0.000000825" },
        "stt",
        "google/gemini-3.8-flash",
      ),
    ).toBe("~$0.0023/min");
    // Gemini 2.x: 32 tokens/s; $0.0026/min
    expect(
      chatPriceTag(
        { prompt: "0.0000003", completion: "0.0000025", audio: "0.000001" },
        "stt",
        "google/gemini-2.5-flash",
      ),
    ).toBe("~$0.0025/min");
    // OpenAI: 10 tokens/s; $0.021/min
    expect(
      chatPriceTag({ prompt: "0.0000025", completion: "0.00001", audio: "0.000032" }, "stt", "openai/gpt-audio"),
    ).toBe("~$0.022/min");
    // Mistral bills the audio by the second; $0.0059/min
    expect(
      chatPriceTag(
        { prompt: "0.0000001", completion: "0.0000003", audio: "0.0001" },
        "stt",
        "mistralai/voxtral-small-24b-2507",
      ),
    ).toBe("~$0.0061/min");
    // no audio price: the audio is billed as prompt tokens, about 12.5 a second; $0.00046/min
    expect(chatPriceTag({ prompt: "0.00000015", completion: "0.0000015" }, "stt", "perceptron/perceptron-mk1.5")).toBe(
      "~$0.00049/min",
    );
  });

  it("estimates a chat model that speaks by 20 audio tokens a second", () => {
    // the readings cost $0.083/min and $0.0041/min
    expect(
      chatPriceTag(
        { prompt: "0.0000025", completion: "0.00001", audio: "0.000032", audio_output: "0.000064" },
        "tts",
        "openai/gpt-audio",
      ),
    ).toBe("~$0.08/min");
    expect(
      chatPriceTag(
        { prompt: "0.0000006", completion: "0.0000024", audio: "0.0000006", audio_output: "0.0000024" },
        "tts",
        "openai/gpt-audio-mini",
      ),
    ).toBe("~$0.0036/min");
  });

  it("is free at no price, and nothing without a usable one", () => {
    expect(chatPriceTag({}, "stt", "nvidia/nemotron:free")).toBe("$0");
    expect(chatPriceTag({ prompt: "0", completion: "0" }, "tts")).toBe("$0");
    expect(chatPriceTag(undefined, "stt")).toBeUndefined();
    expect(chatPriceTag({ prompt: "-1", completion: "-1" }, "stt", "openrouter/auto")).toBeUndefined();
    expect(chatPriceTag({ prompt: "abc" }, "tts")).toBeUndefined();
  });
});

describe("perMinute", () => {
  it("keeps two decimals from a dollar up and two significant digits below", () => {
    expect(perMinute(1.234, false)).toBe("$1.23/min");
    expect(perMinute(0.01234, true)).toBe("~$0.012/min");
  });
});

describe("priceValue", () => {
  it("reads the dollars per minute of a price tag, estimates included; anything else has none", () => {
    expect(priceValue("$0")).toBe(0);
    expect(priceValue("~$0.014/min")).toBe(0.014);
    expect(priceValue("$1.50/min")).toBe(1.5);
    expect(priceValue("price unknown")).toBeUndefined();
    expect(priceValue(undefined)).toBeUndefined();
  });
});
