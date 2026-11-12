/**
 * xAI speech through the user's xAI login in Pi: voices, synthesis, and transcription.
 * The token comes only from Pi's credentials for provider `xai`, is sent only to api.x.ai in the
 * Authorization header, and never appears in an error text.
 */

import { bodyChunks, clipOf, collect } from "./audio-stream";
import { type KeyRegistry, resolveXaiToken } from "./credentials";
import type {
  AudioStream,
  PcmFormat,
  SpeechProvider,
  SynthesisRequest,
  SynthesizedAudio,
  TranscriptionRequest,
} from "./provider";

export const XAI_API = "https://api.x.ai/v1";

/** The one xAI choice, both as speech model and as transcription model. */
export const XAI_MODEL = "xai";

/** xAI publishes no price; none is invented. */
export const XAI_PRICE = "included with your xAI plan (price unknown)";

export const XAI_NO_LOGIN = "No xAI login in Pi: log in to xAI in Pi (/login) to use xai";

/** A voice as the xAI voice list describes it; `language` is provider metadata. */
export interface XaiVoice {
  id: string;
  name?: string;
  language?: string;
  gender?: string;
}

/** Raw PCM arrives while it is produced (WAV arrives in one burst at the end); measured 2026-11-12. */
const OUTPUT_FORMAT = { codec: "pcm", sample_rate: 24000 };
/** xAI's PCM: signed 16-bit little-endian, mono, at the rate asked for. */
const PCM: PcmFormat = { codec: "pcm", rate: OUTPUT_FORMAT.sample_rate, channels: 1 };

const MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
};

/** A 400 whose message is about the credential is a rejected login too. */
const CREDENTIAL_TROUBLE = /api[ -]?key|token|credential|unauthori[sz]ed|authenticat/i;

const headers = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A readable error for a failed reply: a rejected login, or the status and message. Never shows the token. */
async function failure(res: Response, token: string): Promise<Error> {
  let text = await res.text().catch(() => "");
  try {
    const error = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof error === "string" && error) text = error;
  } catch {
    /* not JSON: the text as is */
  }
  text = text.split(token).join("[token]").trim().slice(0, 300);
  if (res.status === 401 || res.status === 403 || (res.status === 400 && CREDENTIAL_TROUBLE.test(text))) {
    return new Error(`the xAI login was rejected (HTTP ${res.status}); log in to xAI again in Pi (/login)`);
  }
  return new Error(`xAI HTTP ${res.status}${text ? `: ${text}` : ""}`);
}

/** The voices of xAI's speech service. Throws on failure. */
export async function listXaiVoices(token: string, signal?: AbortSignal): Promise<XaiVoice[]> {
  const res = await fetch(`${XAI_API}/tts/voices`, {
    method: "GET",
    headers: headers(token),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  if (!res.ok) throw await failure(res, token);
  const data = (await res.json()) as { voices?: Array<Record<string, unknown>> };
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const voices: XaiVoice[] = [];
  for (const v of data.voices ?? []) {
    const id = str(v.voice_id);
    if (!id) continue;
    const voice: XaiVoice = { id };
    for (const key of ["name", "language", "gender"] as const) {
      const value = str(v[key]);
      if (value) voice[key] = value;
    }
    voices.push(voice);
  }
  return voices;
}

/**
 * Synthesize `text` in `voice` as a Stream of PCM; `language` is "auto" or a tag such as "ja". Throws on a
 * failed request; a response that breaks off throws while its chunks are read.
 */
export async function xaiSynthesizeStream(
  token: string,
  req: { text: string; voice: string; language: string },
  signal?: AbortSignal,
): Promise<AudioStream> {
  const res = await fetch(`${XAI_API}/tts`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ text: req.text, voice_id: req.voice, language: req.language, output_format: OUTPUT_FORMAT }),
    signal,
  });
  if (!res.ok) throw await failure(res, token);
  const type = res.headers.get("content-type") ?? "";
  if (type && !/pcm|octet-stream/i.test(type)) {
    res.body?.cancel().catch(() => {});
    throw new Error(`unexpected audio type from xAI: ${type}`);
  }
  if (!res.body) throw new Error("xAI returned no audio");
  return { format: PCM, chunks: bodyChunks(res.body, "xAI") };
}

/** Synthesize `text` in `voice` as one WAV clip. Throws on failure. */
export async function xaiSynthesize(
  token: string,
  req: { text: string; voice: string; language: string },
  signal?: AbortSignal,
): Promise<SynthesizedAudio> {
  const stream = await xaiSynthesizeStream(token, req, signal);
  return clipOf(stream.format, await collect(stream.chunks), "xAI");
}

/** Transcribe audio bytes in `format`, posted as the multipart field `file`. Throws on failure. */
export async function xaiTranscribe(
  token: string,
  audio: Uint8Array,
  format: string,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  const bytes = new Uint8Array(audio.byteLength);
  bytes.set(audio);
  form.append("file", new Blob([bytes], { type: MIME[format] ?? "application/octet-stream" }), `audio.${format}`);
  const res = await fetch(`${XAI_API}/stt`, { method: "POST", headers: headers(token), body: form, signal });
  if (!res.ok) throw await failure(res, token);
  const data = (await res.json()) as { text?: unknown };
  return typeof data.text === "string" ? data.text : "";
}

/** xAI as a speech provider: offered only while Pi holds an xAI credential. */
export class XaiProvider implements SpeechProvider {
  readonly name = "xAI";
  private cache?: XaiVoice[];

  constructor(private readonly registry: () => KeyRegistry | undefined) {}

  /** The token now, or undefined without an xAI login. */
  token(): Promise<string | undefined> {
    return resolveXaiToken(this.registry());
  }

  async available(): Promise<boolean> {
    return (await this.token()) !== undefined;
  }

  private async requireToken(): Promise<string> {
    const token = await this.token();
    if (!token) throw new Error(XAI_NO_LOGIN);
    return token;
  }

  async ensureCredential(): Promise<void> {
    await this.requireToken();
  }

  /** The voice list, fetched once and kept until forget(); a failure is thrown, not kept. */
  async voices(signal?: AbortSignal): Promise<XaiVoice[]> {
    const token = await this.requireToken();
    if (this.cache) return this.cache;
    try {
      this.cache = await listXaiVoices(token, signal);
    } catch (err) {
      throw new Error(`Cannot list the xAI voices: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.cache;
  }

  /** The voice list from the last successful fetch, if any. */
  cachedVoices(): XaiVoice[] | undefined {
    return this.cache;
  }

  forget(): void {
    this.cache = undefined;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesizedAudio> {
    return xaiSynthesize(await this.requireToken(), req, req.signal);
  }

  async synthesizeStream(req: SynthesisRequest): Promise<AudioStream> {
    return xaiSynthesizeStream(await this.requireToken(), req, req.signal);
  }

  async transcribe(req: TranscriptionRequest): Promise<string> {
    return xaiTranscribe(await this.requireToken(), req.audio, req.format, req.signal);
  }
}
