import { describe, expect, it } from "vitest";
import { featureLine, modelColumns, modelFeatures, vendorOf } from "../../src/engine/features";

/** Descriptions as OpenRouter's catalog gave them on 2026-11-11 (it cuts them short itself). */
const V4_TURBO =
  "Eleven v4 Turbo is a low-latency text-to-speech model from ElevenLabs. It keeps Eleven v4's expressive delivery and audio tags while being tuned for faster generation, with support for 90+ languages...";
const DRAMA =
  "Drama 3 is a text-to-speech model from Fish Audio built for directed voice performances. You write the direction in plain language in square brackets before a line, such as `[nervous,...";
const TURBO_V2 =
  "Eleven Turbo v2 is an English-only, low-latency text-to-speech model from ElevenLabs. It is suited for developer use cases where speed matters and only English is needed, and has a 30,000-character...";
const QWEN =
  "Qwen-Audio-3.0-TTS Plus is Alibaba's higher-quality text-to-speech model, generating spoken audio from text via the DashScope Speech Synthesizer API.";
const SCRIBE =
  "ElevenLabs Scribe v2 is a speech-to-text model that transcribes audio in 90+ languages with word-level timestamps, optional speaker diarization, and audio-event tagging.";
const WHISPER =
  "Whisper Large V3 is OpenAI's open-source automatic speech recognition model offering both audio transcription and translation. It supports 99+ languages and accepts common audio formats including mp3,";

describe("model features from the catalog", () => {
  it("reads inline tags, the language count and low latency from a speech model's description", () => {
    expect(modelFeatures("tts", { id: "elevenlabs/eleven-v4-turbo", description: V4_TURBO })).toEqual({
      features: ["tags", "multilingual", "fast"],
      languages: "90+ langs",
    });
    expect(modelFeatures("tts", { id: "fish-audio/drama-3", description: DRAMA }).features).toEqual(["tags"]);
  });

  it("an English-only model is not multilingual; a model that states nothing has no features", () => {
    expect(modelFeatures("tts", { id: "elevenlabs/eleven-turbo-v2", description: TURBO_V2 })).toEqual({
      features: ["fast"],
      languages: "English",
    });
    expect(modelFeatures("tts", { id: "qwen/qwen-audio-3.0-tts-plus", description: QWEN })).toEqual({ features: [] });
  });

  it("a price of $0 is free; Gemini TTS takes style direction by its documentation", () => {
    expect(modelFeatures("tts", { id: "x/y:free", price: "$0" }).features).toEqual(["free"]);
    expect(modelFeatures("tts", { id: "google/gemini-3.8-flash-tts", description: "" }).features).toEqual([
      "tags",
      "fast",
    ]);
  });

  it("reads timestamps, speakers and translation for transcription models, and never tags", () => {
    expect(modelFeatures("stt", { id: "elevenlabs/scribe-v2", description: SCRIBE })).toEqual({
      features: ["timestamps", "speakers", "multilingual"],
      languages: "90+ langs",
    });
    expect(modelFeatures("stt", { id: "openai/whisper-large-v3", description: WHISPER }).features).toEqual([
      "translate",
      "multilingual",
    ]);
  });

  it("draws the features as one line with the language count and the number of voices", () => {
    const f = modelFeatures("tts", { id: "elevenlabs/eleven-v4-turbo", description: V4_TURBO });
    expect(featureLine({ ...f, voices: Array(21).fill("v") })).toBe("tags · 90+ langs · fast · 21 voices");
    expect(featureLine({ features: ["fast"], languages: "English" })).toBe("fast · English");
    expect(featureLine({})).toBe("");
  });

  it("the columns after the price: the provider, then for a speech model its number of voices", () => {
    expect(modelColumns("tts", { voices: Array(30).fill("v") }, "OpenRouter")).toEqual(["OpenRouter", "30 voices"]);
    // a single voice reads in the singular; an unknown count is one voice, not a blank
    expect(modelColumns("tts", { voices: ["only"] }, "OpenAI")).toEqual(["OpenAI", "1 voice"]);
    expect(modelColumns("tts", {}, "OpenRouter")).toEqual(["OpenRouter", "1 voice"]);
    expect(modelColumns("tts", { voices: [] }, "OpenRouter")).toEqual(["OpenRouter", "1 voice"]);
    // a transcription model: the provider alone
    expect(modelColumns("stt", {}, "Groq")).toEqual(["Groq"]);
  });

  it("names the vendor from the catalog name, else from the id", () => {
    expect(vendorOf("elevenlabs/eleven-v4", "ElevenLabs: Eleven v4")).toBe("ElevenLabs");
    expect(vendorOf("hexgrad/kokoro-82m", "Kokoro 82M")).toBe("hexgrad");
    expect(vendorOf("xai")).toBe("xai");
  });
});
