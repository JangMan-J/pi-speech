/**
 * A speech provider: a service that synthesizes or transcribes speech for pi-speech. OpenRouter
 * (src/engine/openrouter.ts), every endpoint that follows the OpenAI audio API (src/engine/endpoints.ts),
 * and the xAI login in Pi (src/engine/xai.ts) are its members. Each one keeps
 * its own credential and sends it only to its own service.
 */

import type { ModelKind } from "./features";

/** Voice value for models that list no voices: the request then carries no `voice` at all. */
export const DEFAULT_VOICE = "default";

/** What the panel says of a chat model, before the catalog's own description. */
export const CHAT_NOTE: Record<ModelKind, string> = {
  tts: "A chat model asked to read; a reading that strays from the text is not played.",
  stt: "A chat model asked to transcribe; a few obey a spoken order instead.",
};

/** Synthesized audio in a file format the history keeps. */
export interface SynthesizedAudio {
  audio: Uint8Array;
  /** File format of `audio`. */
  format: "wav" | "mp3";
}

/** Raw signed 16-bit little-endian PCM at `rate` Hz with `channels` interleaved channels. */
export interface PcmFormat {
  codec: "pcm";
  rate: number;
  channels: number;
}

/**
 * The audio format of a Stream: raw PCM, or a file format the player decodes (MP3; a WAV that is not 16-bit
 * PCM).
 */
export type StreamFormat = PcmFormat | { codec: "mp3" } | { codec: "wav" };

/**
 * Audio that arrives while the provider is still producing it (a Stream, see GLOSSARY.md): chunks in order.
 * Iterating throws a readable error when the response breaks off; the request's signal cancels it.
 */
export interface AudioStream {
  format: StreamFormat;
  chunks: AsyncIterable<Uint8Array>;
  /** The saved message this Stream reads, when it is a replay. */
  file?: string;
}

/**
 * The endpoint type a model is reached through when it is not the audio endpoints built for speech and
 * transcription: "chat" is the chat-completions API (src/engine/chat-audio.ts).
 */
export type Via = "chat";

export interface ModelOption {
  id: string;
  /** Human-readable name from the catalog, or the id. */
  label: string;
  /** Voices the model accepts (speech models only), from the catalog's `supported_voices`. */
  voices?: string[];
  /** Price tag in dollars per minute of audio, e.g. "$0.006/min" or "~$0.064/min". */
  price?: string;
  /** Who makes the model, e.g. "ElevenLabs". */
  vendor?: string;
  /** What the catalog says the model offers (src/engine/features.ts); empty when it states nothing. */
  features?: string[];
  /** The languages as the catalog states them: "90+ langs", "English". */
  languages?: string;
  /** The catalog's (short) description. */
  description?: string;
  /** When the model was added to the catalog, in seconds since the epoch. */
  created?: number;
  /** The endpoint type the model is reached through; undefined is the audio endpoint. */
  via?: Via;
  /** Optional display overrides supplied by the owning provider adapter. */
  shortLabel?: string;
  priceLabel?: string;
  pickerNote?: string;
  unpricedExempt?: boolean;
  voicesUnknown?: boolean;
}

export interface SpeechCatalog {
  tts: ModelOption[];
  stt: ModelOption[];
}

export interface SynthesisRequest {
  text: string;
  model: string;
  voice: string;
  /** How the model is reached; undefined is the audio endpoint. */
  via?: Via;
  /** Language of the text: a tag such as "ja", or "auto" to leave it to the service. */
  language: string;
  signal?: AbortSignal;
}

export interface TranscriptionRequest {
  audio: Uint8Array;
  /** File format of `audio`: wav, mp3, flac, m4a, ogg, webm, aac. */
  format: string;
  model: string;
  /** How the model is reached; undefined is the audio endpoint. */
  via?: Via;
  /** ISO-639-1 hint, for providers that take one. */
  language?: string;
  signal?: AbortSignal;
}

export interface SpeechProvider {
  /** For messages, e.g. "OpenRouter". */
  readonly name: string;
  /** Default voice when switching to a model owned by this provider. */
  readonly defaultVoice?: string;
  /** Reason shown when a model owned by this provider returns an empty voice list. */
  readonly emptyVoicesReason?: string;
  /** Whether this provider owns `model` (outside the shared OpenRouter catalog). */
  ownsModel?(model: string): boolean;
  /** Display label for `model` when shown in a row or picker. */
  modelLabel?(model: string): string;
  /** Alert note when `model` is missing from the active catalog. */
  missingModelNote?(model: string): string;
  /** Dynamic voice list for `model`, when the provider fetches voices outside the static catalog. */
  voicesFor?(model: string): Promise<string[]>;
  /** Provider-supplied metadata for voice-language inference (e.g. xAI voice language). */
  voiceLanguageMetadata?(model: string, voice: string): { language?: string } | undefined;
  /** Fill in provider-owned display defaults for a catalog option (e.g. subscription pricing). */
  enrichOption?(option: ModelOption): ModelOption;
  /** Throws a readable error, sending nothing, when this provider's credential is missing. */
  ensureCredential(): Promise<void>;
  /** Throws a readable error on failure. */
  synthesize(req: SynthesisRequest): Promise<SynthesizedAudio>;
  /**
   * Synthesize as a Stream. Resolves once the response has started; a failed request throws a readable error
   * before any audio, a response that breaks off throws while its chunks are read. A service that sends its
   * audio as one whole file at the end gives a Stream of one late chunk.
   */
  synthesizeStream(req: SynthesisRequest): Promise<AudioStream>;
  /** Throws a readable error on failure. */
  transcribe(req: TranscriptionRequest): Promise<string>;
}
