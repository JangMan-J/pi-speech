import { describe, expect, it } from "vitest";
import { voiceLanguage, voiceSample } from "../../src/voice-language/index";

const SCRIPT: Record<string, RegExp> = {
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  zh: /[\u4e00-\u9fff]/,
  hi: /[\u0900-\u097f]/,
  ko: /[\uac00-\ud7af]/,
  ru: /[\u0400-\u04ff]/,
};
const WORDS: Record<string, string[]> = {
  fr: ["bonjour", "je", "le", "la", "les", "est", "de", "suis", "voix"],
  es: ["hola", "soy", "es", "el", "la", "de", "voz", "una"],
  de: ["hallo", "ich", "bin", "ist", "der", "die", "das", "und", "stimme"],
};
function looksLike(lang: string, text: string): boolean {
  if (SCRIPT[lang]) return SCRIPT[lang].test(text);
  const words = text.toLowerCase().split(/[^\p{L}]+/u);
  return (WORDS[lang] ?? []).some((w) => words.includes(w));
}

describe("voice-specific evidence", () => {
  it.each([
    ["deepgram/aura-2", "aura-2-ama-ja", "ja"],
    ["deepgram/aura-2", "aura-2-agathe-fr", "fr"],
    ["deepgram/aura-2", "aura-2-agustina-es", "es"],
    ["hexgrad/kokoro-82m", "jf_alpha", "ja"],
    ["hexgrad/kokoro-82m", "ff_siwis", "fr"],
    ["mistralai/voxtral-mini-tts-2603", "fr_marie_neutral", "fr"],
    ["minimax/speech-2.8-hd", "English_CalmWoman", "en"],
  ])("%s %s is %s", (model, voice, lang) => {
    const vl = voiceLanguage({ model, voice });
    expect(vl.status).toBe("evidence");
    expect(vl.language).toBe(lang);
    expect(vl.evidence && vl.evidence.length > 0).toBe(true);
  });

  it("MAI voices carry their locale", () => {
    const vl = voiceLanguage({ model: "microsoft/mai-voice-2.1", voice: "es-MX-Valeria:MAI-Voice-2.1" });
    expect(vl).toMatchObject({ status: "evidence", language: "es", locale: "es-MX" });
  });

  it("Kokoro b prefix is British English", () => {
    expect(voiceLanguage({ model: "hexgrad/kokoro-82m", voice: "bf_emma" })).toMatchObject({ language: "en", locale: "en-GB" });
  });
});

describe("honest unknown and multilingual", () => {
  it("opaque names are unknown", () => {
    expect(voiceLanguage({ model: "x-ai/grok-voice-tts-1.0", voice: "eve" }).status).toBe("unknown");
    expect(voiceLanguage({ model: "heygen/heygen-voice-1", voice: "nadine" }).status).toBe("unknown");
    expect(voiceLanguage({ model: "mistralai/voxtral-mini-tts-3-0", voice: "voice_3150" }).status).toBe("unknown");
  });
  it("unknown voices carry no language", () => {
    expect(voiceLanguage({ model: "x-ai/grok-voice-tts-1.0", voice: "eve" }).language).toBeUndefined();
  });
  it("Gemini voices are multilingual with evidence and no language", () => {
    const vl = voiceLanguage({ model: "google/gemini-3.1-flash-tts-preview", voice: "Kore" });
    expect(vl.status).toBe("multilingual");
    expect(vl.language).toBeUndefined();
    expect(vl.evidence && vl.evidence.length > 0).toBe(true);
  });
  it("a scheme counts only for its own model family", () => {
    expect(voiceLanguage({ model: "acme/new-tts", voice: "jf_alpha" }).status).toBe("unknown");
  });
});

describe("overrides and metadata", () => {
  it("an override wins over evidence", () => {
    expect(voiceLanguage({ model: "deepgram/aura-2", voice: "aura-2-ama-ja", override: "fr" })).toMatchObject({
      status: "override",
      language: "fr",
    });
  });
  it("an override applies to unknown voices", () => {
    expect(voiceLanguage({ model: "x-ai/grok-voice-tts-1.0", voice: "ara", override: "es" })).toMatchObject({
      status: "override",
      language: "es",
    });
  });
  it("an invalid override throws", () => {
    expect(() => voiceLanguage({ model: "x-ai/grok-voice-tts-1.0", voice: "ara", override: "Japanese please" })).toThrow();
  });
  it("one metadata language is evidence; several are multilingual", () => {
    expect(voiceLanguage({ model: "acme/tts", voice: "v1", metadata: { language: "de" } })).toMatchObject({
      status: "evidence",
      language: "de",
    });
    expect(voiceLanguage({ model: "acme/tts", voice: "v1", metadata: { languages: ["de", "fr"] } }).status).toBe(
      "multilingual",
    );
  });
});

describe("voice samples", () => {
  it.each([
    ["deepgram/aura-2", "aura-2-ama-ja", "ja"],
    ["hexgrad/kokoro-82m", "ff_siwis", "fr"],
    ["deepgram/aura-2", "aura-2-agustina-es", "es"],
  ])("%s %s samples in %s", (model, voice, lang) => {
    const s = voiceSample(voiceLanguage({ model, voice }), voice);
    expect(s.language).toBe(lang);
    expect(s.fallback).toBe(false);
    expect(looksLike(lang, s.text)).toBe(true);
    expect(s.text).toContain(voice);
  });
  it("unknown voices sample in English and say so", () => {
    const s = voiceSample(voiceLanguage({ model: "x-ai/grok-voice-tts-1.0", voice: "eve" }), "eve");
    expect(s.language).toBe("en");
    expect(s.fallback).toBe(true);
    expect(s.notice && /english/i.test(s.notice)).toBe(true);
  });
  it("an override changes the sample language", () => {
    const s = voiceSample(voiceLanguage({ model: "x-ai/grok-voice-tts-1.0", voice: "eve", override: "de" }), "eve");
    expect(s.language).toBe("de");
    expect(s.fallback).toBe(false);
    expect(looksLike("de", s.text)).toBe(true);
  });
});
