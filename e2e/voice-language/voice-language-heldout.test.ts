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
  en: ["hi", "hello", "this", "is", "i", "am", "the", "my", "voice"],
  fr: ["bonjour", "je", "le", "la", "les", "est", "de", "suis", "voix", "c'est", "salut"],
  es: ["hola", "soy", "es", "el", "la", "de", "voz", "una", "esta"],
  de: ["hallo", "ich", "bin", "ist", "der", "die", "das", "und", "stimme"],
  it: ["ciao", "sono", "è", "il", "la", "di", "voce", "una", "questa"],
  pt: ["olá", "ola", "sou", "é", "o", "a", "de", "voz", "uma", "esta"],
  nl: ["hallo", "ik", "ben", "is", "de", "het", "een", "stem", "dit"],
};
function looksLike(lang: string, text: string): boolean {
  if (SCRIPT[lang]) return SCRIPT[lang].test(text);
  const words = text.toLowerCase().split(/[^\p{L}']+/u);
  return (WORDS[lang] ?? []).some((w) => words.includes(w));
}

describe("evidence generalizes within each family", () => {
  it.each([
    ["deepgram/aura-2", "aura-2-izanami-ja", "ja", undefined],
    ["deepgram/aura-2", "aura-2-hector-fr", "fr", undefined],
    ["deepgram/aura-2", "aura-2-viktoria-de", "de", undefined],
    ["deepgram/aura-2", "aura-2-cesare-it", "it", undefined],
    ["deepgram/aura-2", "aura-2-beatrix-nl", "nl", undefined],
    ["deepgram/aura-2", "aura-2-zzyzx-ja", "ja", undefined],
    ["deepgram/flux-tts", "flux-meena-en", "en", undefined],
    ["microsoft/mai-voice-2.1-flash", "fr-FR-Soleil:MAI-Voice-2.1-Flash", "fr", "fr-FR"],
    ["microsoft/mai-voice-2", "de-DE-Klaus:MAI-Voice-2", "de", "de-DE"],
    ["microsoft/mai-voice-2.1", "pt-BR-Luana:MAI-Voice-2.1", "pt", "pt-BR"],
    ["microsoft/mai-voice-2.1", "ja-JP-Newname:MAI-Voice-2.1", "ja", "ja-JP"],
    ["microsoft/mai-voice-2.1", "zh-CN-Mei:MAI-Voice-2.1", "zh", "zh-CN"],
    ["hexgrad/kokoro-82m", "jm_kumo", "ja", undefined],
    ["hexgrad/kokoro-82m", "jf_newvoice", "ja", undefined],
    ["hexgrad/kokoro-82m", "ef_dora", "es", undefined],
    ["hexgrad/kokoro-82m", "zf_xiaoxiao", "zh", undefined],
    ["hexgrad/kokoro-82m", "hm_omega", "hi", undefined],
    ["hexgrad/kokoro-82m", "if_sara", "it", undefined],
    ["hexgrad/kokoro-82m", "pm_alex", "pt", "pt-BR"],
    ["hexgrad/kokoro-82m", "am_adam", "en", "en-US"],
    ["mistralai/voxtral-mini-tts-3-0", "gb_jane_sarcasm", "en", "en-GB"],
    ["mistralai/voxtral-mini-tts-3-0", "en_paul_happy", "en", undefined],
    ["mistralai/voxtral-mini-tts-2603", "fr_marie_curious", "fr", undefined],
    ["minimax/speech-2.8-turbo", "English_Jovialman", "en", undefined],
  ])("%s %s → %s", (model, voice, lang, locale) => {
    const vl = voiceLanguage({ model, voice });
    expect(vl.status).toBe("evidence");
    expect(vl.language).toBe(lang);
    if (locale) expect(vl.locale).toBe(locale);
    expect(typeof vl.evidence === "string" && vl.evidence.length > 3).toBe(true);
  });

  it("a variant suffix on the model id keeps the family", () => {
    expect(voiceLanguage({ model: "deepgram/aura-2:free", voice: "aura-2-ama-ja" }).language).toBe("ja");
  });
});

describe("no evidence outside the documented schemes", () => {
  it.each([
    ["acme/tts-1", "aura-2-ama-ja"],
    ["acme/tts-1", "fr-FR-Marc:MAI-Voice-2.1"],
    ["acme/tts-1", "ef_dora"],
    ["acme/tts-1", "fr_marie_sad"],
    ["acme/tts-1", "English_CalmWoman"],
    ["x-ai/grok-voice-tts-1.0", "ara"],
    ["canopylabs/orpheus-3b-0.1-ft", "tara"],
    ["sesame/csm-1b", "read_speech_a"],
    ["assemblyai/assemblyai-tts-1", "aai-donatien"],
    ["qwen/qwen-audio-3.0-tts-flash", "loongjohn"],
    ["heygen/heygen-voice-1-turbo:free", "jade"],
    ["elevenlabs/eleven-v3", "japanese_girl"],
    ["mistralai/voxtral-mini-tts-3-0", "voice_478"],
    ["hexgrad/kokoro-82m", "xx_unknownprefix"],
  ])("%s %s is not evidence", (model, voice) => {
    const vl = voiceLanguage({ model, voice });
    expect(["unknown", "multilingual"]).toContain(vl.status);
    expect(vl.language).toBeUndefined();
  });

  it("every Gemini TTS voice is multilingual", () => {
    for (const voice of ["Zephyr", "Puck", "Sulafat"]) {
      const vl = voiceLanguage({ model: "google/gemini-3.8-flash-tts", voice });
      expect(vl.status).toBe("multilingual");
      expect(vl.language).toBeUndefined();
    }
  });
});

describe("override and metadata details", () => {
  it("an override with a region keeps the locale", () => {
    expect(voiceLanguage({ model: "x-ai/grok-voice-tts-1.0", voice: "eve", override: "pt-BR" })).toMatchObject({
      status: "override",
      language: "pt",
      locale: "pt-BR",
    });
  });
  it("override wins over metadata and multilingual", () => {
    expect(voiceLanguage({ model: "acme/tts", voice: "v", metadata: { language: "de" }, override: "ja" }).language).toBe("ja");
    expect(voiceLanguage({ model: "google/gemini-3.8-flash-tts", voice: "Kore", override: "ko" })).toMatchObject({
      status: "override",
      language: "ko",
    });
  });
  it.each(["", "japanese", "j", "12", "ja_JP_x", "fr-FRANCE-x"])("invalid override %j throws", (o) => {
    if (o === "") {
      // an empty override means "no override"
      expect(voiceLanguage({ model: "deepgram/aura-2", voice: "aura-2-ama-ja", override: o }).status).not.toBe("override");
      return;
    }
    expect(() => voiceLanguage({ model: "deepgram/aura-2", voice: "aura-2-ama-ja", override: o })).toThrow();
  });
  it("metadata outranks naming schemes", () => {
    expect(voiceLanguage({ model: "deepgram/aura-2", voice: "aura-2-ama-ja", metadata: { language: "en" } }).language).toBe("en");
  });
  it("one-element languages list is evidence", () => {
    expect(voiceLanguage({ model: "acme/tts", voice: "v", metadata: { languages: ["it"] } })).toMatchObject({
      status: "evidence",
      language: "it",
    });
  });
  it("multilingual metadata carries no language", () => {
    expect(voiceLanguage({ model: "acme/tts", voice: "v", metadata: { languages: ["en", "ja"] } }).language).toBeUndefined();
  });
});

describe("samples", () => {
  it.each(["en", "ja", "fr", "es", "de", "it", "pt", "zh", "hi", "nl", "ko", "ru"])("override %s samples in %s", (lang) => {
    const s = voiceSample(voiceLanguage({ model: "x-ai/grok-voice-tts-1.0", voice: "rex", override: lang }), "rex");
    expect(s.language).toBe(lang);
    expect(s.fallback).toBe(false);
    expect(s.notice).toBeUndefined();
    if (SCRIPT[lang] || WORDS[lang]) expect(looksLike(lang, s.text)).toBe(true);
    expect(s.text).toContain("rex");
  });

  it("sample texts differ by language", () => {
    const texts = new Set(
      ["en", "ja", "fr", "es", "de", "it", "pt", "zh", "hi", "nl", "ko", "ru"].map(
        (l) => voiceSample(voiceLanguage({ model: "a/b", voice: "v", override: l }), "v").text,
      ),
    );
    expect(texts.size).toBe(12);
  });

  it("a language without sample text falls back to English with a notice", () => {
    const s = voiceSample(voiceLanguage({ model: "a/b", voice: "v", override: "sw" }), "v");
    expect(s).toMatchObject({ language: "en", fallback: true });
    expect(s.notice && /english/i.test(s.notice)).toBe(true);
  });

  it("multilingual voices sample in English with a notice", () => {
    const s = voiceSample(voiceLanguage({ model: "google/gemini-3.8-flash-tts", voice: "Puck" }), "Puck");
    expect(s).toMatchObject({ language: "en", fallback: true });
    expect(s.notice && /english/i.test(s.notice)).toBe(true);
    expect(looksLike("en", s.text)).toBe(true);
  });

  it("evidence with a locale samples in the base language", () => {
    const s = voiceSample(
      voiceLanguage({ model: "microsoft/mai-voice-2.1", voice: "es-MX-Valeria:MAI-Voice-2.1" }),
      "es-MX-Valeria:MAI-Voice-2.1",
    );
    expect(s.language).toBe("es");
    expect(s.fallback).toBe(false);
  });

  it("is pure: same input, same output, no mutation", () => {
    const input = { model: "deepgram/aura-2", voice: "aura-2-ama-ja" };
    const copy = JSON.stringify(input);
    expect(voiceLanguage(input)).toEqual(voiceLanguage(input));
    expect(JSON.stringify(input)).toBe(copy);
  });
});
