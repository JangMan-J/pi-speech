export type VoiceLanguageStatus = "evidence" | "override" | "unknown" | "multilingual";
export interface VoiceLanguage {
  status: VoiceLanguageStatus;
  language?: string;
  locale?: string;
  evidence?: string;
}

export interface VoiceSample {
  text: string;
  language: string;
  fallback: boolean;
  notice?: string;
}

const TAG = /^([A-Za-z]{2,3})(?:-([A-Za-z]{2}|[0-9]{3}))?$/;

function parseTag(tag: string): { language: string; locale?: string } | undefined {
  const m = TAG.exec(tag.trim());
  if (!m) return undefined;
  const language = m[1].toLowerCase();
  const region = m[2]?.toUpperCase();
  return region ? { language, locale: `${language}-${region}` } : { language };
}

function found(tag: string, evidence: string): VoiceLanguage | undefined {
  const p = parseTag(tag);
  return p ? { status: "evidence", ...p, evidence } : undefined;
}

const KOKORO: Record<string, string> = {
  a: "en-US",
  b: "en-GB",
  e: "es",
  f: "fr",
  h: "hi",
  i: "it",
  j: "ja",
  p: "pt-BR",
  z: "zh",
};

const VOXTRAL: Record<string, string> = { en: "en", gb: "en-GB", fr: "fr" };

const LANGUAGE_NAMES: Record<string, string> = {
  english: "en",
  japanese: "ja",
  french: "fr",
  spanish: "es",
  german: "de",
  italian: "it",
  portuguese: "pt",
  chinese: "zh",
  cantonese: "zh",
  mandarin: "zh",
  hindi: "hi",
  dutch: "nl",
  korean: "ko",
  russian: "ru",
  arabic: "ar",
  turkish: "tr",
  polish: "pl",
  indonesian: "id",
  vietnamese: "vi",
  thai: "th",
  ukrainian: "uk",
  romanian: "ro",
  greek: "el",
  czech: "cs",
  finnish: "fi",
};

function fromScheme(model: string, voice: string): VoiceLanguage | undefined {
  if (model.startsWith("deepgram/aura") || model.startsWith("deepgram/flux")) {
    const m = /-([a-z]{2})$/.exec(voice.toLowerCase());
    return m ? found(m[1], `voice id suffix "-${m[1]}" (Deepgram Aura naming)`) : undefined;
  }
  if (model.startsWith("microsoft/mai-voice")) {
    const m = /^([a-z]{2,3}-[A-Za-z]{2})-/.exec(voice);
    return m ? found(m[1], `voice id locale prefix "${m[1]}" (Microsoft MAI-Voice naming)`) : undefined;
  }
  if (model.startsWith("hexgrad/kokoro")) {
    const m = /^([a-z])[fm]_/.exec(voice);
    const tag = m ? KOKORO[m[1]] : undefined;
    return m && tag ? found(tag, `voice id prefix "${m[1]}" (Kokoro voice table)`) : undefined;
  }
  if (model.startsWith("mistralai/voxtral")) {
    const m = /^(en|gb|fr)_/.exec(voice);
    return m ? found(VOXTRAL[m[1]], `voice id prefix "${m[1]}_" (Mistral Voxtral naming)`) : undefined;
  }
  if (model.startsWith("minimax/speech")) {
    const i = voice.indexOf("_");
    if (i <= 0) return undefined;
    const name = voice
      .slice(0, i)
      .replace(/\s*\(.*\)\s*/, "")
      .toLowerCase();
    const tag = LANGUAGE_NAMES[name];
    return tag ? found(tag, `voice id language name "${voice.slice(0, i)}" (MiniMax naming)`) : undefined;
  }
  return undefined;
}

export function voiceLanguage(input: {
  model: string;
  voice: string;
  override?: string;
  metadata?: { language?: string; languages?: string[] };
}): VoiceLanguage {
  const override = input.override?.trim();
  if (override) {
    const p = parseTag(override);
    if (!p) {
      throw new Error(`Invalid language override "${override}": use a language tag such as "ja" or "pt-BR".`);
    }
    return { status: "override", ...p };
  }

  const md = input.metadata;
  const langs = [...new Set([md?.language, ...(md?.languages ?? [])].filter((l): l is string => !!l?.trim()))];
  if (langs.some((l) => l.trim().toLowerCase() === "multilingual")) {
    // The provider names the voice itself multilingual (xAI's voice list does).
    return { status: "multilingual", evidence: "provider metadata lists the voice as multilingual" };
  }
  if (langs.length === 1) {
    const vl = found(langs[0], "provider metadata");
    if (vl) return vl;
  } else if (langs.length > 1) {
    return { status: "multilingual", evidence: `provider metadata lists several languages: ${langs.join(", ")}` };
  }

  const model = input.model.toLowerCase();
  const scheme = fromScheme(model, input.voice);
  if (scheme) return scheme;

  if (model.startsWith("google/gemini")) {
    return {
      status: "multilingual",
      evidence: "Google documents that every Gemini TTS voice speaks all supported languages",
    };
  }
  return { status: "unknown" };
}

const SAMPLES: Record<string, (v: string) => string> = {
  en: (v) => `Hello, I am the voice ${v}.`,
  ja: (v) => `こんにちは、私は声「${v}」です。`,
  fr: (v) => `Bonjour, je suis la voix ${v}.`,
  es: (v) => `Hola, soy la voz ${v}.`,
  de: (v) => `Hallo, ich bin die Stimme ${v}.`,
  it: (v) => `Ciao, sono la voce ${v}.`,
  pt: (v) => `Olá, eu sou a voz ${v}.`,
  zh: (v) => `你好，我是声音“${v}”。`,
  hi: (v) => `नमस्ते, मैं आवाज़ ${v} हूँ।`,
  nl: (v) => `Hallo, ik ben de stem ${v}.`,
  ko: (v) => `안녕하세요, 저는 ${v} 목소리입니다.`,
  ru: (v) => `Здравствуйте, я голос ${v}.`,
};

export function voiceSample(vl: VoiceLanguage, voice: string): VoiceSample {
  const known = vl.status === "evidence" || vl.status === "override";
  if (known && vl.language && SAMPLES[vl.language]) {
    return { text: SAMPLES[vl.language](voice), language: vl.language, fallback: false };
  }
  let why: string;
  if (known && vl.language) why = `no sample text exists for language "${vl.language}"`;
  else if (vl.status === "multilingual") why = "this voice speaks several languages, so none is preferred";
  else why = "the language of this voice is unknown; set a language override to change it";
  return {
    text: SAMPLES.en(voice),
    language: "en",
    fallback: true,
    notice: `Sample is in English: ${why}.`,
  };
}
