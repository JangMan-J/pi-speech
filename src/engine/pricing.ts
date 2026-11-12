/**
 * Price tags for speech and transcription models, in USD per minute of audio.
 * Derived from pi-openrouter-multimodal (MIT).
 *
 * OpenRouter's audio prices use one unit per model and the API does not name it. These rules were
 * verified on 2026-10-30 against OpenRouter's per-request cost for every speech and transcription model:
 *   speech         prompt only        → per input character        (exact per character)
 *   speech         completion only    → per second of output audio (exact)
 *   speech         prompt+completion  → per token, 25 audio tokens/s out (Gemini TTS)
 *   transcription  prompt only        → per second of input audio; per hour when ≥ $0.01 (exact)
 *   transcription  prompt+completion  → per token: audio in at 10 tokens/s (OpenAI) or 25 tokens/s (Gemini)
 * Converting characters or tokens to minutes needs a speech rate, so those values are estimates ("~").
 */

/** OpenRouter per-unit prices, as decimal strings in USD. */
export type OpenRouterPricing = Record<string, string | undefined>;

/** Characters of input text per minute of generated speech (measured median 820 across 35 models). */
const SPOKEN_CHARS_PER_MIN = 800;
/** Audio tokens per second: Gemini measured 25 (speech out and transcription in); OpenAI transcription in 10. */
const AUDIO_TOKENS_PER_SEC_GEMINI = 25;
const AUDIO_TOKENS_PER_SEC_OPENAI = 10;
/** Text tokens per minute of speech (measured ~265 on a 16 s transcript). */
const TEXT_TOKENS_PER_MIN = 250;
/** A per-second rate this high is really per hour (MAI-Transcribe lists $0.10 and $0.36). */
const PER_HOUR_THRESHOLD = 0.01;

/** USD per minute → "$0.15/min", or "~$0.072/min" for an estimate. */
export function perMinute(usd: number, estimate: boolean): string {
  const s = usd >= 1 ? usd.toFixed(2) : String(Number(usd.toPrecision(2)));
  return `${estimate ? "~" : ""}$${s}/min`;
}

/** Dollars per minute of audio for a speech ("tts") or transcription ("stt") model. */
export function priceTag(
  pricing: OpenRouterPricing | undefined,
  kind: "tts" | "stt",
  modelId = "",
): string | undefined {
  if (!pricing) return undefined;
  const p = Number(pricing.prompt ?? 0);
  const c = Number(pricing.completion ?? 0);
  if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) return undefined;
  if (p === 0 && c === 0) return "$0";
  const audioTokensPerMin =
    60 * (modelId.startsWith("openai/") ? AUDIO_TOKENS_PER_SEC_OPENAI : AUDIO_TOKENS_PER_SEC_GEMINI);
  if (kind === "tts") {
    if (p > 0 && c > 0) return perMinute(c * audioTokensPerMin + p * TEXT_TOKENS_PER_MIN, true);
    if (c > 0) return perMinute(c * 60, false);
    return perMinute(p * SPOKEN_CHARS_PER_MIN, true);
  }
  if (c > 0) return perMinute(p * audioTokensPerMin + c * TEXT_TOKENS_PER_MIN, true);
  return p >= PER_HOUR_THRESHOLD ? perMinute(p / 60, false) : perMinute(p * 60, false);
}

/** Audio tokens per second of speech a chat model gives (OpenAI, measured 20.0). */
const CHAT_SPEECH_TOKENS_PER_SEC = 20;
/**
 * Audio tokens a chat model counts per second of audio it takes in, by maker; the catalog does not say.
 * Measured 2026-11-12 on a 32-second recording for every chat model that takes audio: Gemini 2.x 32, later
 * Gemini 25 to 26, OpenAI 10, Mistral 1 (it bills by the second), the others 6 to 20. With these the
 * estimate was within a factor of two of the request's cost for 27 of 31 models (median 0.98 of it); the
 * rest think before they write, which is not counted.
 */
const CHAT_HEARD_TOKENS_PER_SEC: Array<[RegExp, number]> = [
  [/^~?openai\//, AUDIO_TOKENS_PER_SEC_OPENAI],
  [/^~?google\/gemini-2\./, 32],
  [/^~?google\//, AUDIO_TOKENS_PER_SEC_GEMINI],
  [/^~?mistralai\//, 1],
];
const CHAT_HEARD_TOKENS_PER_SEC_OTHER = 12.5;

/**
 * Dollars per minute of audio for a chat model that speaks ("tts") or takes audio ("stt"): always an
 * estimate, since it is billed by the token. `audio` is the price of an audio token taken in and
 * `audio_output` of one given out, where the catalog has them; else the text prices hold.
 */
export function chatPriceTag(
  pricing: OpenRouterPricing | undefined,
  kind: "tts" | "stt",
  modelId = "",
): string | undefined {
  if (!pricing) return undefined;
  const num = (v: string | undefined, fallback: number) => (v === undefined || v === "" ? fallback : Number(v));
  const p = num(pricing.prompt, 0);
  const c = num(pricing.completion, 0);
  const heard = num(pricing.audio, p);
  const spoken = num(pricing.audio_output, c);
  if (![p, c, heard, spoken].every((n) => Number.isFinite(n) && n >= 0)) return undefined;
  if (kind === "tts") {
    if (spoken === 0 && c === 0 && p === 0) return "$0";
    // The words spoken are billed once more as text, and the text read as a prompt.
    return perMinute(spoken * 60 * CHAT_SPEECH_TOKENS_PER_SEC + (c + p) * TEXT_TOKENS_PER_MIN, true);
  }
  if (heard === 0 && c === 0 && p === 0) return "$0";
  const perSec = CHAT_HEARD_TOKENS_PER_SEC.find(([re]) => re.test(modelId))?.[1] ?? CHAT_HEARD_TOKENS_PER_SEC_OTHER;
  return perMinute(heard * 60 * perSec + c * TEXT_TOKENS_PER_MIN, true);
}

/** The dollars per minute of a price tag ("$0", "~$0.014/min"); undefined for anything else. */
export function priceValue(tag: string | undefined): number | undefined {
  const m = /^~?\$(\d+(?:\.\d+)?)(?:\/min)?$/.exec(tag ?? "");
  return m ? Number(m[1]) : undefined;
}
