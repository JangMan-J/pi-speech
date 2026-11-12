/**
 * What a catalog model offers beyond plain speech or transcription, for sorting and filtering the model
 * lists. OpenRouter's catalog has no structured field for this, so the features are read from the model's
 * catalog description (which the catalog cuts short), its id, and its price. A feature that is missing here
 * is "not stated", never "not supported".
 */

export type ModelKind = "tts" | "stt";

/** The features of each kind, in the order they are shown and offered as a filter. */
export const FEATURES: Record<ModelKind, string[]> = {
  tts: ["chat", "tags", "multilingual", "fast", "free"],
  stt: ["chat", "timestamps", "speakers", "autodetect", "translate", "multilingual", "fast", "free"],
};

/** What each feature means, for the README and the help. */
export const FEATURE_MEANING: Record<string, string> = {
  chat: "a chat model that is asked to read or to transcribe, not a model built for it",
  tags: "inline delivery tags or style directions in the text, such as [whispers]",
  multilingual: "more than one language",
  fast: "low latency",
  free: "no charge",
  timestamps: "word or segment timestamps",
  speakers: "speaker labels (diarization)",
  autodetect: "detects the spoken language",
  translate: "can translate while transcribing",
};

export interface FeatureSource {
  id: string;
  description?: string;
  /** The price tag, e.g. "$0" or "~$0.03/min". */
  price?: string;
}

export interface ModelFeatures {
  /** Feature keys of FEATURES[kind], in that order. */
  features: string[];
  /** The languages as the description states them: "90+ langs", "English"; undefined when it does not say. */
  languages?: string;
}

/** Inline direction of the delivery, in the words the catalog descriptions use. */
const TAGS =
  /audio tags|emotion and pace tags|\btags\b|square brackets|parenthetical controls|natural-language (?:controls|text prompt)|style (?:prompts?|instructions?|controls?)|directed voice/i;
/** Models whose documentation (not the cut catalog text) describes inline style direction. */
const TAGS_DOCUMENTED = /^(?:google\/gemini-[\w.-]*tts|canopylabs\/orpheus)/;
const FAST = /low-latency|lower-latency|real-time|\bfast\b|\bspeed\b|(?<!non-)streaming/i;
/** Flash and Turbo are the vendors' names for their fast tier. */
const FAST_ID = /(?:^|[-/])(?:flash|turbo)(?:$|[-:.])/;
const LANGUAGE_COUNT = /(\d+)(\+?) (?:GA )?languages/i;
const MULTILINGUAL = /multilingual|multiple languages|code switching/i;
const ENGLISH_ONLY = /English-only|\bEnglish (?:text-to-speech|speech)|produces English/i;

export function modelFeatures(kind: ModelKind, m: FeatureSource): ModelFeatures {
  const d = m.description ?? "";
  const has = new Set<string>();
  let languages: string | undefined;

  const count = LANGUAGE_COUNT.exec(d);
  if (count && Number(count[1]) > 1) {
    has.add("multilingual");
    languages = `${count[1]}${count[2]} langs`;
  } else if (MULTILINGUAL.test(d)) {
    has.add("multilingual");
  } else if (ENGLISH_ONLY.test(d)) {
    languages = "English";
  }
  if (FAST.test(d) || FAST_ID.test(m.id)) has.add("fast");
  if (m.price === "$0") has.add("free");

  if (kind === "tts") {
    if (TAGS.test(d) || TAGS_DOCUMENTED.test(m.id)) has.add("tags");
  } else {
    if (/timestamp/i.test(d)) has.add("timestamps");
    if (/diariz|speaker/i.test(d)) has.add("speakers");
    if (/language (?:detection|identification)|automatic language/i.test(d)) has.add("autodetect");
    if (/translation/i.test(d)) has.add("translate");
  }
  return { features: FEATURES[kind].filter((f) => has.has(f)), ...(languages ? { languages } : {}) };
}

/** The features as one line: "tags · 90+ langs · fast · 21 voices". */
export function featureLine(m: { features?: string[]; languages?: string; voices?: string[] }): string {
  const parts = (m.features ?? []).map((f) => (f === "multilingual" ? (m.languages ?? f) : f));
  if (m.languages && !m.features?.includes("multilingual")) parts.push(m.languages);
  if (m.voices?.length) parts.push(`${m.voices.length} voice${m.voices.length === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * The aligned columns a model row shows after its price: its language, then (for tts) its voices or (for stt)
 * what it can do. The language is the specific one when a model is trained on a single language, else the
 * count ("90+ langs"), else blank — so a row with no stated language leaves that column empty rather than
 * breaking the table.
 */
export function modelColumns(
  kind: ModelKind,
  m: { id?: string; vendor?: string; features?: string[]; languages?: string; voices?: string[] },
): string[] {
  const language = languageLabel(m);
  if (kind === "tts") {
    // Every model in the list can speak, so it has at least one voice; an unknown count reads "1 voice".
    const n = m.voices?.length || 1;
    return [language, `${n} voice${n === 1 ? "" : "s"}`];
  }
  // The two most telling capabilities; the rest are left to the model's description below the list.
  const can = (m.features ?? []).filter((f) => f !== "multilingual" && f !== "free").slice(0, 2);
  return [language, can.join(" · ")];
}

/**
 * The language column of a model row. Google and qwen speak many languages, so they always read
 * "multilingual"; any other model the catalog does not describe reads "English", its usual single language. A
 * stated language or count (e.g. "90+ langs") on a non-google/qwen model always wins.
 */
function languageLabel(m: { id?: string; vendor?: string; features?: string[]; languages?: string }): string {
  const vendor = (m.vendor ?? (m.id ? vendorOf(m.id) : "")).toLowerCase();
  if (vendor === "google" || vendor === "qwen") return "multilingual";
  return m.languages ?? (m.features?.includes("multilingual") ? "multilingual" : "English");
}

/** The vendor of a model: the part of its catalog name before the colon, else the first part of its id. */
export function vendorOf(id: string, name?: string): string {
  const named = name?.includes(": ") ? name.slice(0, name.indexOf(": ")).trim() : "";
  return named || id.split("/")[0];
}
