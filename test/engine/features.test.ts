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

  it("the language column: google and qwen read multilingual, other unlabeled models read English", () => {
    const lang = (m: Parameters<typeof modelColumns>[1]) => modelColumns("tts", m)[0];
    // google and qwen always read multilingual, even with no stated language
    expect(lang({ id: "google/gemini-3.8-flash-tts" })).toBe("multilingual");
    expect(lang({ id: "qwen/qwen-audio-3.0-tts-plus" })).toBe("multilingual");
    // another provider with nothing stated falls back to English
    expect(lang({ id: "deepgram/flux-tts" })).toBe("English");
    expect(lang({ id: "elevenlabs/eleven-flash-v2" })).toBe("English");
    // a stated language or count on a non-google/qwen model still wins
    expect(lang({ id: "elevenlabs/eleven-flash-v2.5", languages: "32 langs" })).toBe("32 langs");
    expect(lang({ id: "x/y", features: ["multilingual"] })).toBe("multilingual");
    // the voices column is unchanged
    expect(modelColumns("tts", { id: "google/x", voices: Array(30).fill("v") })[1]).toBe("30 voices");
    // a provider with a single voice reads in the singular
    expect(modelColumns("tts", { id: "x/y", voices: ["only"] })[1]).toBe("1 voice");
    // a tts model with no known voice count defaults to "1 voice" rather than a blank entry
    expect(modelColumns("tts", { id: "fish-audio/x" })[1]).toBe("1 voice");
    expect(modelColumns("tts", { id: "fish-audio/x", voices: [] })[1]).toBe("1 voice");
    // a transcription row aggregates to its two most telling capabilities, the rest left to the description
    expect(
      modelColumns("stt", { id: "d/n", features: ["timestamps", "speakers", "autodetect", "translate", "fast"] })[1],
    ).toBe("timestamps · speakers");
  });

  it("names the vendor from the catalog name, else from the id", () => {
    expect(vendorOf("elevenlabs/eleven-v4", "ElevenLabs: Eleven v4")).toBe("ElevenLabs");
    expect(vendorOf("hexgrad/kokoro-82m", "Kokoro 82M")).toBe("hexgrad");
    expect(vendorOf("xai")).toBe("xai");
  });
});
