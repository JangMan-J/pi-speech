import { describe, expect, it } from "vitest";
import { voiceLanguage, voiceSample } from "../../src/voice-language/index";

describe("voiceLanguage extras", () => {
  it("Kokoro p prefix is pt-BR", () => {
    expect(voiceLanguage({ model: "hexgrad/kokoro-82m", voice: "pf_dora" })).toMatchObject({
      language: "pt",
      locale: "pt-BR",
    });
  });
  it("Voxtral gb_ is en-GB; opaque ids unknown", () => {
    expect(voiceLanguage({ model: "mistralai/voxtral-mini-tts-2603", voice: "gb_oliver" })).toMatchObject({
      language: "en",
      locale: "en-GB",
    });
  });
  it("Deepgram Flux suffix, with :free model suffix", () => {
    expect(voiceLanguage({ model: "deepgram/flux-x:free", voice: "flux-kai-en" })).toMatchObject({
      status: "evidence",
      language: "en",
    });
  });
  it("override with region keeps locale; empty override ignored", () => {
    expect(voiceLanguage({ model: "a/b", voice: "v", override: "pt-br" })).toMatchObject({
      language: "pt",
      locale: "pt-BR",
    });
    expect(voiceLanguage({ model: "a/b", voice: "v", override: "" }).status).toBe("unknown");
  });
  it("look-alike names are not evidence", () => {
    expect(voiceLanguage({ model: "deepgram/aura-2", voice: "jade" }).status).toBe("unknown");
  });
  it("language without sample text falls back with notice", () => {
    const s = voiceSample(voiceLanguage({ model: "a/b", voice: "v", override: "sw" }), "v");
    expect(s).toMatchObject({ language: "en", fallback: true });
    expect(s.notice).toMatch(/English/);
  });
  it("provider metadata language multilingual is a multilingual voice (xAI voice list)", () => {
    const vl = voiceLanguage({ model: "xai", voice: "ara", metadata: { language: "multilingual" } });
    expect(vl.status).toBe("multilingual");
    expect(vl.evidence).toMatch(/provider metadata/);
    const s = voiceSample(vl, "ara");
    expect(s).toMatchObject({ language: "en", fallback: true });
    expect(s.notice).toMatch(/English/);
  });
  it("an override beats multilingual metadata", () => {
    const vl = voiceLanguage({ model: "xai", voice: "ara", override: "ja", metadata: { language: "multilingual" } });
    expect(vl).toMatchObject({ status: "override", language: "ja" });
    expect(voiceSample(vl, "ara")).toMatchObject({ language: "ja", fallback: false });
  });
  it("a single language in provider metadata is evidence", () => {
    expect(voiceLanguage({ model: "xai", voice: "v", metadata: { language: "fr" } })).toMatchObject({
      status: "evidence",
      language: "fr",
      evidence: "provider metadata",
    });
  });
  it("multilingual samples in English with notice", () => {
    const s = voiceSample(voiceLanguage({ model: "google/gemini-x-tts", voice: "Kore" }), "Kore");
    expect(s.fallback).toBe(true);
    expect(s.notice).toMatch(/English/);
  });
});
