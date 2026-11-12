/**
 * Speech services that follow the OpenAI audio API, the one request format several vendors and most
 * self-hosted servers share:
 *
 *   POST {base}/audio/speech          JSON { model, input, voice, response_format } → audio bytes
 *   POST {base}/audio/transcriptions  multipart { file, model, language } → { text }
 *   GET  {base}/models                { data: [{ id }] }
 *   GET  {base}/audio/voices          a voice list, where the server has one (no vendor is required to)
 *
 * An endpoint is a base URL and, for hosted services, a key. The well-known ones are built in and offered
 * while a key for them exists; any other is added by the user. A model of an endpoint is named
 * `<endpoint>:<model>`, which no OpenRouter id can be (those have a slash before any colon).
 * Each key is sent only to its own base URL, in the Authorization header, and never appears in an error.
 */

import { chatSynthesize, chatTranscribe } from "./chat-audio";
import type { KeyRegistry } from "./credentials";
import type { Env } from "./env";
import { FEATURES, type ModelKind, modelFeatures } from "./features";
import { bearer as auth, failure } from "./http";
import { CHAT_NOTE, DEFAULT_VOICE, type ModelOption, type SpeechCatalog } from "./openrouter";
import type { SpeechProvider, SynthesisRequest, SynthesizedAudio, TranscriptionRequest } from "./provider";
import { joinWav, wrapPcmAsWav } from "./wav";

/** A user-defined endpoint, as saved in the settings. */
export interface EndpointConfig {
  baseUrl: string;
  /** The key itself, or */
  apiKey?: string;
  /** the name of the environment variable that holds it. Neither: the server takes no key. */
  apiKeyEnv?: string;
  /** Speech models, for a server whose model list is missing or cannot tell them apart. */
  tts?: string[];
  /** Transcription models, likewise. */
  stt?: string[];
  /** Voices, for a server that lists none. */
  voices?: string[];
  /** Chat models that give audio, to speak through /chat/completions (src/engine/chat-audio.ts). */
  chatTts?: string[];
  /** Chat models that take audio, to transcribe through /chat/completions. */
  chatStt?: string[];
}

interface Preset {
  title: string;
  baseUrl: string;
  /** Environment variables that may hold the key; Pi's credentials for the endpoint's name are asked too. */
  env: string[];
  /** Voices the vendor documents but does not list over the API, by model. */
  voices?: Array<[RegExp, string[]]>;
}

const OPENAI_VOICES = ["alloy", "ash", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer"];

/** Hosted services that serve the OpenAI audio API; each is offered while a key for it exists. */
export const PRESETS: Record<string, Preset> = {
  openai: {
    title: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    env: ["OPENAI_API_KEY"],
    voices: [
      [/^gpt-(?:4o-)?(?:mini-)?audio/, [...OPENAI_VOICES, "ballad", "verse", "marin", "cedar"].sort()],
      [/^gpt-4o-mini-tts/, [...OPENAI_VOICES, "ballad", "verse", "marin", "cedar"].sort()],
      [/^tts-1/, OPENAI_VOICES],
    ],
  },
  groq: {
    title: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    env: ["GROQ_API_KEY"],
    voices: [
      [/orpheus-v1-english/, ["autumn", "diana", "hannah", "austin", "daniel", "troy"]],
      [/orpheus-arabic-saudi/, ["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"]],
    ],
  },
  together: { title: "Together", baseUrl: "https://api.together.ai/v1", env: ["TOGETHER_API_KEY"] },
  mistral: { title: "Mistral", baseUrl: "https://api.mistral.ai/v1", env: ["MISTRAL_API_KEY"] },
  deepinfra: {
    title: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    env: ["DEEPINFRA_API_KEY", "DEEPINFRA_TOKEN"],
  },
};

/** Names an endpoint cannot take: they would shadow the other providers. */
const RESERVED = ["xai", "openrouter"];
export const ENDPOINT_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Why a name cannot be a user-defined endpoint, or undefined when it can. */
export function endpointNameProblem(name: string): string | undefined {
  if (!ENDPOINT_NAME.test(name)) return "use lowercase letters, digits, and dashes";
  if (RESERVED.includes(name)) return `${name} is taken`;
  return undefined;
}

// ── Telling the models of a list apart ─────────────────────────────────────

/** What a server says a model is for, where it says so (Speaches `task`, Together `type`). */
const TASKS: Record<string, ModelKind> = {
  "text-to-speech": "tts",
  tts: "tts",
  "automatic-speech-recognition": "stt",
  transcribe: "stt",
  transcription: "stt",
  stt: "stt",
  asr: "stt",
};
/** The OpenAI model list has no field for it, so a model is told by its name; others are not offered. */
const STT_ID = /whisper|transcri|\bstt\b|\basr\b|parakeet|canary|moonshine|voxtral/i;
const STT_NOT = /embed|realtime|diariz/i;
const TTS_ID = /\btts\b|text-to-speech|kokoro|orpheus|chatterbox|\bcsm\b|\bsonic\b|piper|xtts/i;
/** Transcription models documented to take many languages; the list itself never says. */
const STT_MULTILINGUAL = /whisper(?!.*(?:\.en|-en)\b)|voxtral|gpt-(?:4o-)?(?:mini-)?transcribe/i;

/** OpenAI's chat models that take and give audio: served on /chat/completions, not on the audio endpoints. */
const CHAT_AUDIO_ID = /^gpt-(?:4o-)?(?:mini-)?audio/;

/** Speech, transcription, or neither (undefined), for one entry of a model list. */
export function kindOfModel(entry: { id: string; task?: unknown; type?: unknown }): ModelKind | undefined {
  for (const stated of [entry.task, entry.type]) {
    const kind = typeof stated === "string" ? TASKS[stated.toLowerCase()] : undefined;
    if (kind) return kind;
  }
  if (STT_ID.test(entry.id)) return STT_NOT.test(entry.id) ? undefined : "stt";
  return TTS_ID.test(entry.id) ? "tts" : undefined;
}

// ── Requests ────────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
};

const isMp3 = (b: Uint8Array) =>
  (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0);

/**
 * Synthesize through POST /audio/speech. WAV is asked for (every known server has it, Groq nothing else);
 * a server that rejects the format by name is asked again for MP3. The reply is told by its bytes, since
 * servers disagree on the Content-Type.
 */
export async function endpointSynthesize(
  ep: { title: string; baseUrl: string; key?: string },
  req: { text: string; model: string; voice: string },
  signal?: AbortSignal,
): Promise<SynthesizedAudio> {
  const send = (format: string) =>
    fetch(`${ep.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { ...auth(ep.key), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        input: req.text,
        ...(req.voice && req.voice !== DEFAULT_VOICE ? { voice: req.voice } : {}),
        response_format: format,
      }),
      signal,
    });
  let res = await send("wav");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if ((res.status !== 400 && res.status !== 422) || !/response_format|format/i.test(body)) {
      throw failure(ep.title, res.status, body, ep.key);
    }
    res = await send("mp3");
    if (!res.ok) throw failure(ep.title, res.status, await res.text().catch(() => ""), ep.key);
  }
  const audio = new Uint8Array(await res.arrayBuffer());
  const type = res.headers.get("content-type") ?? "";
  // A streamed WAV leaves its sizes open (0xFFFFFFFF); joinWav writes them.
  const wav = joinWav([audio]);
  if (wav) return { audio: wav, format: "wav" };
  if (/audio\/(?:pcm|l16)/i.test(type)) {
    const rate = Number(/rate=(\d+)/.exec(type)?.[1] ?? 24000);
    const channels = Number(/channels=(\d+)/.exec(type)?.[1] ?? 1);
    return { audio: wrapPcmAsWav(audio, rate, channels), format: "wav" };
  }
  if (isMp3(audio) || /mp3|mpeg/i.test(type)) return { audio, format: "mp3" };
  throw new Error(`unexpected audio from ${ep.title}: ${type || "no content type"}`);
}

/** Transcribe through POST /audio/transcriptions: the audio as the multipart field `file`. */
export async function endpointTranscribe(
  ep: { title: string; baseUrl: string; key?: string },
  req: { audio: Uint8Array; format: string; model: string; language?: string },
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  const bytes = new Uint8Array(req.audio.byteLength);
  bytes.set(req.audio);
  form.append(
    "file",
    new Blob([bytes], { type: MIME[req.format] ?? "application/octet-stream" }),
    `audio.${req.format}`,
  );
  form.append("model", req.model);
  if (req.language) form.append("language", req.language);
  form.append("response_format", "json");
  const res = await fetch(`${ep.baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: auth(ep.key),
    body: form,
    signal,
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) throw failure(ep.title, res.status, body, ep.key);
  try {
    const text = (JSON.parse(body) as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  } catch {
    return body; // a server that answers plain text
  }
}

/** The ids of a list in any of the shapes servers answer with: an array, or one under data/models/voices. */
function idsOf(json: unknown, keys: string[]): Array<Record<string, unknown> & { id: string }> {
  const j = json as Record<string, unknown> | unknown[] | null;
  const list = Array.isArray(j) ? j : (keys.map((k) => j?.[k]).find(Array.isArray) ?? []);
  const out: Array<Record<string, unknown> & { id: string }> = [];
  for (const item of list as unknown[]) {
    if (typeof item === "string" && item) out.push({ id: item });
    else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const id = [o.id, o.voice_id, o.name].find((v) => typeof v === "string" && v);
      if (typeof id === "string") out.push({ ...o, id });
    }
  }
  return out;
}

async function getJson(ep: { title: string; baseUrl: string; key?: string }, path: string, ms: number) {
  const res = await fetch(`${ep.baseUrl}${path}`, {
    method: "GET",
    headers: auth(ep.key),
    signal: AbortSignal.timeout(ms),
  });
  if (!res.ok) throw failure(ep.title, res.status, await res.text().catch(() => ""), ep.key);
  return (await res.json()) as unknown;
}

// ── An endpoint as a speech provider ───────────────────────────────────────

const isLoopback = (url: string) => {
  try {
    return /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?)$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
};

export class Endpoint implements SpeechProvider {
  /** For messages: "Groq", or the name of a user-defined endpoint. */
  readonly name: string;
  readonly baseUrl: string;
  /** Whether it is one of PRESETS (and so needs a key to be offered). */
  readonly builtIn: boolean;
  private readonly preset?: Preset;

  constructor(
    /** The prefix of its model ids. */
    readonly id: string,
    private readonly config: EndpointConfig | undefined,
    private readonly registry: () => KeyRegistry | undefined,
    private readonly env: Env,
  ) {
    this.preset = config ? undefined : PRESETS[id];
    this.builtIn = this.preset !== undefined;
    this.name = this.preset?.title ?? id;
    this.baseUrl = (config?.baseUrl ?? this.preset?.baseUrl ?? "").replace(/\/+$/, "");
  }

  /** The key now: the configured one, an environment variable, or what Pi holds for this name. */
  async key(): Promise<string | undefined> {
    if (this.config?.apiKey) return this.config.apiKey;
    for (const name of [this.config?.apiKeyEnv, ...(this.preset?.env ?? [])]) {
      if (name && this.env[name]) return this.env[name];
    }
    try {
      return (await this.registry()?.getApiKeyForProvider(this.id)) || undefined;
    } catch {
      return undefined;
    }
  }

  /** How to give it a key, for messages. */
  get keyHint(): string {
    const env = this.config?.apiKeyEnv ?? this.preset?.env[0];
    return `${env ? `set ${env}, or ` : ""}log in to ${this.id} in Pi`;
  }

  /** A built-in endpoint is offered while it has a key; a user-defined one always (it may take none). */
  async available(): Promise<boolean> {
    return !this.builtIn || (await this.key()) !== undefined;
  }

  async ensureCredential(): Promise<void> {
    if (!(await this.available())) throw new Error(`No ${this.name} API key: ${this.keyHint}`);
  }

  private async target() {
    return { title: this.name, baseUrl: this.baseUrl, key: await this.key() };
  }

  /** The model of this endpoint in a full id (`groq:whisper-large-v3` → `whisper-large-v3`). */
  private bare(model: string): string {
    return model.startsWith(`${this.id}:`) ? model.slice(this.id.length + 1) : model;
  }

  /** Its speech and transcription models, from the settings or its model list. Throws on failure. */
  async catalog(): Promise<SpeechCatalog> {
    const ep = await this.target();
    let tts = this.config?.tts;
    let stt = this.config?.stt;
    let chatTts = this.config?.chatTts;
    let chatStt = this.config?.chatStt;
    if (!tts && !stt && !chatTts && !chatStt) {
      const entries = idsOf(await getJson(ep, "/models", 6000), ["data", "models"]).filter((m) => m.active !== false);
      tts = entries.filter((m) => kindOfModel(m) === "tts").map((m) => m.id);
      stt = entries.filter((m) => kindOfModel(m) === "stt").map((m) => m.id);
      chatTts = entries.filter((m) => CHAT_AUDIO_ID.test(m.id)).map((m) => m.id);
      chatStt = chatTts;
    }
    const documented = (model: string) => this.preset?.voices?.find(([re]) => re.test(model))?.[1];
    let listed: string[] | undefined;
    if (!this.config?.voices && (tts ?? []).some((m) => !documented(m))) {
      listed = await getJson(ep, "/audio/voices", 4000)
        .then((j) => idsOf(j, ["voices", "data"]).map((v) => v.id))
        .catch(() => undefined);
    }
    const host = this.baseUrl.replace(/^[a-z]+:\/\//, "");
    const price = isLoopback(this.baseUrl) ? "$0" : undefined;
    const served = price
      ? `Served by ${this.name} (${host}), on this machine.`
      : `Served by ${this.name} (${host}) with your key; its model list states no price.`;
    const option = (kind: ModelKind, model: string, chat = false): ModelOption => {
      const found = modelFeatures(kind, { id: model, price }).features;
      const many = chat || (kind === "stt" && STT_MULTILINGUAL.test(model));
      return {
        id: `${this.id}:${model}`,
        label: model,
        vendor: this.name,
        ...(price ? { price } : {}),
        ...(chat ? { via: "chat" as const } : {}),
        features: FEATURES[kind].filter(
          (f) => (f === "chat" && chat) || (f === "multilingual" && many) || found.includes(f),
        ),
        description: chat ? `${CHAT_NOTE[kind]} ${served}` : served,
      };
    };
    const withVoices = (o: ModelOption, voices?: string[]) => (voices?.length ? { ...o, voices: [...voices] } : o);
    return {
      tts: [
        ...(tts ?? []).map((m) => withVoices(option("tts", m), this.config?.voices ?? documented(m) ?? listed)),
        // /audio/voices lists the voices of the speech endpoint, not of a chat model.
        ...(chatTts ?? []).map((m) => withVoices(option("tts", m, true), this.config?.voices ?? documented(m))),
      ],
      stt: [...(stt ?? []).map((m) => option("stt", m)), ...(chatStt ?? []).map((m) => option("stt", m, true))],
    };
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesizedAudio> {
    await this.ensureCredential();
    if (req.via === "chat") {
      const voice = req.voice && req.voice !== DEFAULT_VOICE ? req.voice : undefined;
      return chatSynthesize(await this.target(), { text: req.text, model: this.bare(req.model), voice }, req.signal);
    }
    return endpointSynthesize(await this.target(), { ...req, model: this.bare(req.model) }, req.signal);
  }

  async transcribe(req: TranscriptionRequest): Promise<string> {
    await this.ensureCredential();
    const target = await this.target();
    if (req.via === "chat") return chatTranscribe(target, { ...req, model: this.bare(req.model) }, req.signal);
    return endpointTranscribe(target, { ...req, model: this.bare(req.model) }, req.signal);
  }
}

/** The endpoints now: the built-in ones, and the user's (a user-defined one of the same name replaces a built-in). */
export function buildEndpoints(
  configured: Record<string, EndpointConfig>,
  registry: () => KeyRegistry | undefined,
  env: Env,
): Endpoint[] {
  const names = [...new Set([...Object.keys(PRESETS), ...Object.keys(configured)])];
  return names.map((name) => new Endpoint(name, configured[name], registry, env));
}
