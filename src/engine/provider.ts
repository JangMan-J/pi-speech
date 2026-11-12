/**
 * A speech provider: a service that synthesizes or transcribes speech for pi-speech. OpenRouter
 * (src/engine/openrouter.ts), every endpoint that follows the OpenAI audio API (src/engine/endpoints.ts),
 * and the xAI login in Pi (src/engine/xai.ts) are its members. Each one keeps
 * its own credential and sends it only to its own service.
 */

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

/** The audio format of a Stream. */
export type StreamFormat = PcmFormat;

/**
 * Audio that arrives while the provider is still producing it (a Stream, see GLOSSARY.md): chunks in order.
 * Iterating throws a readable error when the response breaks off; the request's signal cancels it.
 */
export interface AudioStream {
  format: StreamFormat;
  chunks: AsyncIterable<Uint8Array>;
}

/**
 * The endpoint type a model is reached through when it is not the audio endpoints built for speech and
 * transcription: "chat" is the chat-completions API (src/engine/chat-audio.ts).
 */
export type Via = "chat";

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
  /** Throws a readable error, sending nothing, when this provider's credential is missing. */
  ensureCredential(): Promise<void>;
  /** Throws a readable error on failure. */
  synthesize(req: SynthesisRequest): Promise<SynthesizedAudio>;
  /**
   * Optional: synthesize as a Stream. Resolves once the response has started; a failed request throws a
   * readable error before any audio, a response that breaks off throws while its chunks are read.
   */
  synthesizeStream?(req: SynthesisRequest): Promise<AudioStream>;
  /** Throws a readable error on failure. */
  transcribe(req: TranscriptionRequest): Promise<string>;
}
