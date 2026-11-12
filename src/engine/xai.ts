/**
 * xAI speech through the user's xAI login in Pi: voices, synthesis, and transcription.
 * The token comes only from Pi's credentials for provider `xai`, is sent only to api.x.ai in the
 * Authorization header, and never appears in an error text.
 */

import { type KeyRegistry, resolveXaiToken } from "./credentials";
import type { SpeechProvider, SynthesisRequest, SynthesizedAudio, TranscriptionRequest } from "./provider";

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

/** Ask for WAV so the history's WAV comes straight from the service. */
const OUTPUT_FORMAT = { codec: "wav", sample_rate: 24000 };

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

/** Synthesize `text` in `voice`; `language` is "auto" or a tag such as "ja". Throws on failure. */
export async function xaiSynthesize(
  token: string,
  req: { text: string; voice: string; language: string },
  signal?: AbortSignal,
): Promise<SynthesizedAudio> {
  const res = await fetch(`${XAI_API}/tts`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify({ text: req.text, voice_id: req.voice, language: req.language, output_format: OUTPUT_FORMAT }),
    signal,
  });
  if (!res.ok) throw await failure(res, token);
  const audio = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type") || "audio/mpeg";
  if (/wav/i.test(type)) return { audio, format: "wav" };
  if (/mp3|mpeg/i.test(type)) return { audio, format: "mp3" };
  throw new Error(`unexpected audio type from xAI: ${type}`);
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

  async transcribe(req: TranscriptionRequest): Promise<string> {
    return xaiTranscribe(await this.requireToken(), req.audio, req.format, req.signal);
  }
}
