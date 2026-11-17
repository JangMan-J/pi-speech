/**
 * OpenRouter speech, transcription, and model-catalog requests. Derived from pi-openrouter-multimodal (MIT).
 * The API key is sent only to OpenRouter, only in the Authorization header.
 */

import { clipOf, collect, streamFromBody } from "./audio-stream";
import { dispatchSynthesize, dispatchSynthesizeStream, dispatchTranscribe } from "./chat-audio";
import { type KeyRegistry, resolveApiKey } from "./credentials";
import { type Env, errorMessage } from "./env";
import { FEATURES, type ModelKind, modelFeatures, vendorOf } from "./features";
import { bearer, errorText } from "./http";
import { chatPriceTag, type OpenRouterPricing, priceTag } from "./pricing";
import {
  type AudioStream,
  CHAT_NOTE,
  DEFAULT_VOICE,
  type ModelOption,
  type SpeechCatalog,
  type SpeechProvider,
  type SynthesisRequest,
  type SynthesizedAudio,
  type TranscriptionRequest,
} from "./provider";

export { CHAT_NOTE, DEFAULT_VOICE, type ModelOption, type SpeechCatalog, type SynthesizedAudio } from "./provider";
export { wrapPcmAsWav } from "./wav";

export const OPENROUTER_API = "https://openrouter.ai/api/v1";

interface CatalogModel {
  id: string;
  name?: string;
  description?: string;
  created?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  /** The API paths the model is served on, e.g. "/api/v1/audio/speech". */
  endpoints?: string[] | null;
  supported_voices?: string[] | null;
  pricing?: OpenRouterPricing;
}

const CHAT_PATH = "/api/v1/chat/completions";
/** A model that makes music gives audio too, but reads nothing. */
const MUSIC = /\bmusic\b/i;
/**
 * Voices of the chat models that speak: their catalog entries list none. OpenAI's are the names its API
 * gave for these models on 2026-11-12; a voice it no longer takes is refused with the names it does.
 */
const CHAT_VOICES: Array<[RegExp, string[]]> = [
  [
    /^~?openai\//,
    ["alloy", "ash", "ballad", "cedar", "coral", "echo", "fable", "marin", "nova", "onyx", "sage", "shimmer", "verse"],
  ],
];

function openRouterError(status: number, body: string, apiKey: string): Error {
  const text = errorText(body, apiKey);
  if (status === 401 || status === 403) {
    return new Error(`OpenRouter rejected the API key (HTTP ${status})${text ? `: ${text}` : ""}`);
  }
  return new Error(`HTTP ${status}${text ? `: ${text}` : ""}`);
}

/**
 * The models that speak and the models that transcribe, by the endpoint type each is served on:
 * the audio endpoints (output modality `speech` or `transcription`), else the chat-completions API for a
 * model that gives audio (speech) or takes audio and gives text (transcription). Throws on failure.
 */
export async function fetchSpeechCatalog(signal?: AbortSignal): Promise<SpeechCatalog> {
  const res = await fetch(`${OPENROUTER_API}/models?output_modalities=all`, {
    signal: signal ?? AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`model catalog: HTTP ${res.status}`);
  const data = (await res.json()) as { data?: CatalogModel[] };
  const tts: ModelOption[] = [];
  const stt: ModelOption[] = [];
  const option = (m: CatalogModel, kind: ModelKind): ModelOption => {
    const price = priceTag(m.pricing, kind, m.id);
    const description = typeof m.description === "string" ? m.description.replace(/\s+/g, " ").trim() : undefined;
    return {
      id: m.id,
      label: m.name || m.id,
      price,
      vendor: vendorOf(m.id, m.name),
      ...modelFeatures(kind, { id: m.id, description, price }),
      ...(description ? { description } : {}),
      ...(typeof m.created === "number" ? { created: m.created } : {}),
    };
  };
  const chatOption = (m: CatalogModel, kind: ModelKind): ModelOption => {
    const price = chatPriceTag(m.pricing, kind, m.id);
    const about = typeof m.description === "string" ? m.description.replace(/\s+/g, " ").trim() : "";
    // Its description is about chat, not about this use: only the id and the price say anything here.
    const found = modelFeatures(kind, { id: m.id, price }).features;
    return {
      id: m.id,
      label: m.name || m.id,
      price,
      vendor: vendorOf(m.id, m.name),
      via: "chat",
      features: FEATURES[kind].filter((f) => f === "chat" || f === "multilingual" || found.includes(f)),
      description: about ? `${CHAT_NOTE[kind]} ${about}` : CHAT_NOTE[kind],
      ...(typeof m.created === "number" ? { created: m.created } : {}),
    };
  };
  for (const m of data.data ?? []) {
    const inp = m.architecture?.input_modalities ?? [];
    const out = m.architecture?.output_modalities ?? [];
    // A router (its price is negative) hands the audio to a model nobody chose.
    const chat = m.endpoints?.includes(CHAT_PATH) === true && !(Number(m.pricing?.prompt) < 0);
    if (out.includes("speech")) {
      const voices = m.supported_voices?.length ? [...m.supported_voices] : undefined;
      tts.push({ ...option(m, "tts"), voices });
    } else if (chat && out.includes("audio") && !MUSIC.test(`${m.name ?? ""} ${m.description ?? ""}`)) {
      const voices = CHAT_VOICES.find(([re]) => re.test(m.id))?.[1];
      tts.push({ ...chatOption(m, "tts"), ...(voices ? { voices: [...voices] } : {}) });
    }
    if (out.includes("transcription")) stt.push(option(m, "stt"));
    else if (chat && inp.includes("audio") && out.includes("text")) stt.push(chatOption(m, "stt"));
  }
  return { tts, stt };
}

/**
 * Synthesize `text` as a Stream. PCM is requested (lossless); models that reject the PCM format by name
 * (e.g. MiniMax) are asked again for MP3. Whether the audio arrives over time or in one burst at the end is
 * up to the model's maker; both come the same way. `voice` DEFAULT_VOICE (or empty) omits the voice.
 * Throws a readable error when the request fails; a response that breaks off throws while it is read.
 */
export async function synthesizeStream(
  apiKey: string,
  text: string,
  model: string,
  voice: string,
  signal?: AbortSignal,
): Promise<AudioStream> {
  const request = (format: string) =>
    fetch(`${OPENROUTER_API}/audio/speech`, {
      method: "POST",
      headers: { ...bearer(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: text,
        ...(voice && voice !== DEFAULT_VOICE ? { voice } : {}),
        response_format: format,
      }),
      signal,
    });

  let res = await request("pcm");
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    if (res.status !== 400 || !/response_format/.test(errBody)) throw openRouterError(res.status, errBody, apiKey);
    res = await request("mp3");
    if (!res.ok) throw openRouterError(res.status, await res.text().catch(() => ""), apiKey);
  }
  return streamFromBody(res.body, res.headers.get("content-type") || "audio/mpeg", "OpenRouter");
}

/** Synthesize `text` as one clip: PCM wrapped as WAV, or MP3 (see synthesizeStream). Throws a readable error. */
export async function synthesize(
  apiKey: string,
  text: string,
  model: string,
  voice: string,
  signal?: AbortSignal,
): Promise<SynthesizedAudio> {
  const stream = await synthesizeStream(apiKey, text, model, voice, signal);
  return clipOf(stream.format, await collect(stream.chunks), "OpenRouter");
}

/** Transcribe audio bytes in `format` (wav, mp3, flac, m4a, ogg, webm, aac). Throws on failure. */
export async function transcribe(
  apiKey: string,
  audio: Uint8Array,
  format: string,
  model: string,
  language?: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${OPENROUTER_API}/audio/transcriptions`, {
    method: "POST",
    headers: { ...bearer(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input_audio: { data: Buffer.from(audio).toString("base64"), format },
      ...(language ? { language } : {}),
    }),
    signal,
  });
  if (!res.ok) throw openRouterError(res.status, await res.text().catch(() => ""), apiKey);
  const data = (await res.json()) as { text?: unknown };
  return typeof data.text === "string" ? data.text : "";
}

export const OPENROUTER_NO_KEY =
  "No OpenRouter API key found: set OPENROUTER_API_KEY, log in to openrouter in Pi, or add providers.openrouter.apiKey to models.json";

/** OpenRouter as a speech provider: every model of its catalog. The voice language is not sent. */
export class OpenRouterProvider implements SpeechProvider {
  readonly name = "OpenRouter";
  readonly defaultVoice = DEFAULT_VOICE;

  constructor(
    private readonly registry: () => KeyRegistry | undefined,
    private readonly env: Env,
    private readonly agentDir: string,
  ) {}

  private async key(): Promise<string> {
    const key = await resolveApiKey(this.registry(), this.env, this.agentDir);
    if (!key) throw new Error(OPENROUTER_NO_KEY);
    return key;
  }

  async ensureCredential(): Promise<void> {
    await this.key();
  }

  private target(key: string) {
    return { title: this.name, baseUrl: OPENROUTER_API, key };
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesizedAudio> {
    const key = await this.key();
    return dispatchSynthesize(this.target(key), req, req.model, () => this.audioStream(key, req));
  }

  async synthesizeStream(req: SynthesisRequest): Promise<AudioStream> {
    const key = await this.key();
    return dispatchSynthesizeStream(this.target(key), req, req.model, () => this.audioStream(key, req));
  }

  private async audioStream(key: string, req: SynthesisRequest): Promise<AudioStream> {
    try {
      return await synthesizeStream(key, req.text, req.model, req.voice, req.signal);
    } catch (err) {
      const msg = errorMessage(err);
      const hint = /does not exist/.test(msg)
        ? ' (only models with "speech" output work here; see /speech --models)'
        : "";
      throw new Error(`${msg}${hint}`);
    }
  }

  async transcribe(req: TranscriptionRequest): Promise<string> {
    const key = await this.key();
    return dispatchTranscribe(this.target(key), req, req.model, () =>
      transcribe(key, req.audio, req.format, req.model, req.language, req.signal),
    );
  }
}
