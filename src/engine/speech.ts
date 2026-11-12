/**
 * Speech operations: the OpenRouter catalog, the OpenAI-compatible endpoints, and the xAI choice, the settings, synthesis into the history
 * and the player, transcription, voice samples in the voice language, and voice-language overrides.
 * Each model belongs to one speech provider; a failure never falls back to another one.
 * Derived in part from pi-openrouter-multimodal (MIT).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { type VoiceLanguage, voiceLanguage, voiceSample } from "../voice-language/index";
import type { KeyRegistry } from "./credentials";
import { buildEndpoints, type Endpoint, endpointNameProblem, PRESETS } from "./endpoints";
import { type Env, errorMessage } from "./env";
import { featureLine } from "./features";
import { type Converter, ffmpegConvert, History, type HistoryMessage, historyDir } from "./history";
import {
  DEFAULT_VOICE,
  fetchSpeechCatalog,
  type ModelOption,
  OpenRouterProvider,
  type SpeechCatalog,
} from "./openrouter";
import { READING_MIN_CHARS, splitForSpeech } from "./pieces";
import type { Player } from "./player";
import type { SpeechProvider } from "./provider";
import { speakInPieces } from "./reading";
import { DEFAULT_SETTINGS, type ModelSort, type Settings, type SettingsFile } from "./settings";
import { XAI_MODEL, XAI_PRICE, XaiProvider } from "./xai";

/** The xAI choice as a model option, offered while Pi holds an xAI login. */
const XAI_OPTION: ModelOption = { id: XAI_MODEL, label: "xAI", price: XAI_PRICE };

/** Used only while the catalog cannot be loaded. */
const FALLBACK_CATALOG: SpeechCatalog = {
  tts: [
    {
      id: "google/gemini-3.8-flash-tts",
      label: "Google: Gemini 3.8 Flash TTS",
      voices: ["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe"],
    },
    { id: "hexgrad/kokoro-82m", label: "Kokoro 82M", voices: ["af_heart", "af_bella", "am_adam", "jf_alpha"] },
  ],
  stt: [
    { id: "openai/whisper-large-v3-turbo", label: "Whisper Large V3 Turbo" },
    { id: "openai/whisper-large-v3", label: "Whisper Large V3" },
  ],
};

/** Retry a failed catalog load at most this often. */
const CATALOG_RETRY_MS = 60_000;

/** Audio formats accepted by /audio/transcriptions, by file extension. */
const AUDIO_FORMATS: Record<string, string> = {
  wav: "wav",
  mp3: "mp3",
  flac: "flac",
  m4a: "m4a",
  ogg: "ogg",
  oga: "ogg",
  webm: "webm",
  aac: "aac",
};

export type SettingName = "tts-model" | "voice" | "stt-model" | "stt-language" | "tools" | "dictation-output";
export const SETTING_NAMES: SettingName[] = [
  "tts-model",
  "voice",
  "stt-model",
  "stt-language",
  "tools",
  "dictation-output",
];

/** A language tag as transcription services take it: `ja`, `pt-BR`. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export interface SpeechResult {
  /** Files of the message that exist, the synthesized one first. */
  files: string[];
  model: string;
  voice: string;
  /** The player that was started, if any. */
  player?: string;
  /** Why the message was not played. */
  notPlayed?: string;
  conversionError?: string;
  /** A reading stopped or replaced before every piece was synthesized: nothing was saved (`files` is empty). */
  stopped?: boolean;
}

export interface SampleResult {
  model: string;
  voice: string;
  /** The language of the sample text. */
  language: string;
  /** The voice language the sample was chosen by. */
  voiceLanguage: VoiceLanguage;
  /** Set when the sample is in English because the voice language is unknown, multilingual, or has no text. */
  notice?: string;
  player?: string;
  notPlayed?: string;
}

export interface SpeechOptions {
  /** Pi's agent directory: credentials may come from its models.json. */
  agentDir: string;
  settingsFile: SettingsFile;
  player: Player;
  env: Env;
  home?: string;
  convert?: Converter;
  fetchCatalog?: () => Promise<SpeechCatalog>;
}

/** The voice that stays when it is offered, else the preferred one when offered, else the first. */
function keepVoice(voices: string[], current: string, preferred: string): string {
  return voices.includes(current) ? current : voices.includes(preferred) ? preferred : voices[0];
}

interface CallOptions {
  signal?: AbortSignal;
}

/** How a voice language is known, for display. */
export function languageSource(vl: VoiceLanguage): string {
  if (vl.status === "override") return "override";
  return vl.evidence ?? "no evidence";
}

/** The voice language for display: a tag, or "unknown" / "multilingual". */
export function languageLabel(vl: VoiceLanguage): string {
  if (vl.status === "unknown" || vl.status === "multilingual") return vl.status;
  return vl.locale ?? vl.language ?? "unknown";
}

export class Speech {
  settings: Settings;
  /** Pi's credential store; set by the adapter. */
  registry?: KeyRegistry;
  /** Hears warnings found while loading, such as a replaced model. */
  onWarning: (message: string) => void = () => {};
  private catalog: SpeechCatalog = FALLBACK_CATALOG;
  private live = false;
  private loading: Promise<void> = Promise.resolve();
  private failedAt = 0;
  private lastSaved?: string[];
  private samples = 0;
  /** Models whose texts could not be read in pieces in this session (e.g. MP3 without a converter). */
  private readonly unchunkable = new Set<string>();
  private readonly history: History;
  private readonly convert: Converter;
  private readonly player: Player;
  private readonly store: SettingsFile;
  private readonly fetchCatalog: () => Promise<SpeechCatalog>;
  private readonly openrouter: OpenRouterProvider;
  private readonly xai: XaiProvider;
  private readonly env: Env;
  /** The OpenAI-compatible endpoints: the built-in ones and the user's. */
  private endpoints: Endpoint[] = [];
  /** The models of the endpoints that answered. */
  private served: SpeechCatalog = { tts: [], stt: [] };
  /** What each endpoint answered at the last load. */
  private endpointState = new Map<string, { tts: number; stt: number } | { error: string } | "no key">();
  private endpointsLoading?: Promise<void>;
  private endpointsFailedAt = 0;

  constructor(opts: SpeechOptions) {
    this.env = opts.env;
    this.openrouter = new OpenRouterProvider(() => this.registry, opts.env, opts.agentDir);
    this.xai = new XaiProvider(() => this.registry);
    this.store = opts.settingsFile;
    this.player = opts.player;
    this.convert = opts.convert ?? ffmpegConvert;
    this.history = new History(historyDir(opts.env, opts.home ?? homedir()), this.convert);
    this.fetchCatalog = opts.fetchCatalog ?? (() => fetchSpeechCatalog());
    this.settings = this.store.load();
  }

  get historyDir(): string {
    return this.history.dir;
  }

  // ── Settings and catalog ───────────────────────────────────────────────

  /** Reload the saved settings and start loading the catalog. */
  start(): void {
    this.settings = this.store.load();
    this.xai.forget();
    this.loading = this.load();
    this.resetEndpoints();
  }

  /** Settles when the catalog is loaded (or could not be); retries a failed load now and then. */
  async ready(): Promise<void> {
    await this.loading;
    if (!this.live && Date.now() - this.failedAt > CATALOG_RETRY_MS) {
      this.loading = this.load();
      await this.loading;
    }
    if (!this.endpointsLoading || (this.endpointsFailedAt && Date.now() - this.endpointsFailedAt > CATALOG_RETRY_MS)) {
      this.endpointsLoading = this.loadEndpoints();
    }
    await this.endpointsLoading;
  }

  /** Rebuild the endpoints from the settings; their models load at the next ready(). */
  private resetEndpoints(): void {
    this.endpoints = buildEndpoints(this.settings.endpoints, () => this.registry, this.env);
    this.served = { tts: [], stt: [] };
    this.endpointState.clear();
    this.endpointsLoading = undefined;
    this.endpointsFailedAt = 0;
  }

  /** Ask every endpoint that can be asked for its models; one that fails leaves the others untouched. */
  private async loadEndpoints(): Promise<void> {
    const endpoints = this.endpoints;
    const served: SpeechCatalog = { tts: [], stt: [] };
    let failed = false;
    await Promise.all(
      endpoints.map(async (e) => {
        if (!(await e.available())) return void this.endpointState.set(e.id, "no key");
        try {
          const cat = await e.catalog();
          served.tts.push(...cat.tts);
          served.stt.push(...cat.stt);
          this.endpointState.set(e.id, { tts: cat.tts.length, stt: cat.stt.length });
        } catch (err) {
          failed = true;
          this.endpointState.set(e.id, { error: errorMessage(err) });
        }
      }),
    );
    if (endpoints !== this.endpoints) return; // replaced while loading
    // Promise.all settles in any order; the lists keep the endpoints' order.
    const rank = (m: ModelOption) => endpoints.findIndex((e) => m.id.startsWith(`${e.id}:`));
    this.served = {
      tts: served.tts.sort((a, b) => rank(a) - rank(b)),
      stt: served.stt.sort((a, b) => rank(a) - rank(b)),
    };
    this.endpointsFailedAt = failed ? Date.now() : 0;
  }

  /** The endpoint a model id names (`groq:whisper-large-v3`), if any. */
  private endpointOf(model: string): Endpoint | undefined {
    const colon = model.indexOf(":");
    return colon > 0 ? this.endpoints.find((e) => e.id === model.slice(0, colon)) : undefined;
  }

  /** A model OpenRouter's catalog does not decide: xai, or one of an endpoint. */
  private outside(model: string): boolean {
    return model === XAI_MODEL || this.endpointOf(model) !== undefined;
  }

  /** Every listed model: OpenRouter's and the endpoints'. */
  private get listed(): SpeechCatalog {
    return { tts: [...this.catalog.tts, ...this.served.tts], stt: [...this.catalog.stt, ...this.served.stt] };
  }

  /** A speech model of an endpoint, or a chat model, whose voices nobody lists: any voice name is passed on. */
  private anyVoice(model: string): boolean {
    const listed = this.listed.tts.find((m) => m.id === model);
    return (this.endpointOf(model) !== undefined || listed?.via === "chat") && !listed?.voices?.length;
  }

  /** The endpoint type a listed model is reached through (a chat model: "chat"); undefined is the audio endpoint. */
  private via(kind: "tts" | "stt", model: string) {
    return this.listed[kind].find((m) => m.id === model)?.via;
  }

  save(): void {
    this.store.save(this.settings);
  }

  private async load(): Promise<void> {
    try {
      const cat = await this.fetchCatalog();
      if (cat.tts.length === 0 || cat.stt.length === 0) throw new Error("catalog lists no speech models");
      this.catalog = cat;
      this.live = true;
      this.reconcile();
    } catch {
      this.failedAt = Date.now();
    }
  }

  /** Replace saved models the loaded catalog no longer lists, and a voice the model does not offer. */
  private reconcile(): void {
    const s = this.settings;
    const fixed: string[] = [];
    const { tts, stt } = this.catalog;
    // xai and the endpoints' models are not in OpenRouter's catalog; such a saved choice stays and is checked when used.
    if (!this.outside(s.speechModel)) {
      if (!tts.some((m) => m.id === s.speechModel)) {
        const next = tts.find((m) => m.id === DEFAULT_SETTINGS.speechModel)?.id ?? tts[0].id;
        fixed.push(`speech model ${s.speechModel} → ${next}`);
        s.speechModel = next;
      }
      const voices = this.voicesOf(s.speechModel);
      if (!voices.includes(s.voice)) {
        const next = keepVoice(voices, s.voice, DEFAULT_SETTINGS.voice);
        fixed.push(`voice ${s.voice} → ${next}`);
        s.voice = next;
      }
    }
    if (!this.outside(s.transcriptionModel) && !stt.some((m) => m.id === s.transcriptionModel)) {
      const next = stt.find((m) => m.id === DEFAULT_SETTINGS.transcriptionModel)?.id ?? stt[0].id;
      fixed.push(`transcription model ${s.transcriptionModel} → ${next}`);
      s.transcriptionModel = next;
    }
    if (fixed.length) {
      this.save();
      this.onWarning(`pi-speech: OpenRouter no longer lists a saved choice; replaced ${fixed.join(", ")}`);
    }
  }

  /** The provider of a model: xAI for xai, its endpoint for `<endpoint>:<model>`, OpenRouter for every other id. */
  private provider(model: string): SpeechProvider {
    return model === XAI_MODEL ? this.xai : (this.endpointOf(model) ?? this.openrouter);
  }

  /** The name of a model's speech provider, for display. */
  providerName(model: string): string {
    return this.provider(model).name;
  }

  /** Whether OpenRouter's catalog is loaded; false while it loads and after a failed load (built-in lists). */
  get catalogLoaded(): boolean {
    return this.live;
  }

  /** Whether a model is one of OpenRouter's while its catalog is not loaded (its entry is then a built-in guess). */
  catalogOffline(model: string): boolean {
    return !this.live && !this.outside(model);
  }

  /** The models offered now: OpenRouter's catalog, the endpoints' models, and xai while Pi holds an xAI login. */
  async models(): Promise<SpeechCatalog> {
    await this.ready();
    const xai = (await this.xai.available()) ? [XAI_OPTION] : [];
    const { tts, stt } = this.listed;
    return { tts: [...tts, ...xai], stt: [...stt, ...xai] };
  }

  /** Voices of a catalog speech model; [DEFAULT_VOICE] for one without voices or not listed. Not for xai. */
  voicesOf(model: string): string[] {
    const m = this.listed.tts.find((x) => x.id === model);
    return m?.voices?.length ? m.voices : [DEFAULT_VOICE];
  }

  /** Voices of a speech model; for xai the xAI voice list (which may be empty), and it throws on failure. */
  async voicesFor(model: string): Promise<string[]> {
    if (model === XAI_MODEL) return (await this.xai.voices()).map((v) => v.id);
    await this.ready();
    return this.voicesOf(model);
  }

  private isSpeechModel(model: string): boolean {
    return this.listed.tts.some((m) => m.id === model);
  }

  /** Requires the xAI login, or the endpoint's key, before such a model is chosen; sends nothing without one. */
  private async requireOffered(model: string): Promise<void> {
    if (this.outside(model)) await this.provider(model).ensureCredential();
  }

  // ── Endpoints ───────────────────────────────────────────────────────────

  /** The endpoints and what each answered; asks them again first. */
  async endpointsReport(): Promise<string> {
    this.endpointsLoading = undefined;
    await this.ready();
    const count = (n: number, noun: string) => `${n} ${noun} model${n === 1 ? "" : "s"}`;
    const rows = this.endpoints.map((e): [string, string, string] => {
      const state = this.endpointState.get(e.id);
      const what =
        state === undefined || state === "no key"
          ? `no key (${e.keyHint})`
          : "error" in state
            ? `✗ ${state.error}`
            : `${count(state.tts, "speech")}, ${count(state.stt, "transcription")}`;
      return [e.id, e.baseUrl, what];
    });
    const w = [0, 1].map((i) => Math.max(...rows.map((r) => r[i].length)));
    return [
      "Speech endpoints (OpenAI audio API); their models are named <endpoint>:<model>:",
      ...rows.map((r) => `  ${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2]}`),
      "Add one: /speech --endpoint <name> <base-url> [key|KEY_ENV]   Remove: /speech --endpoint <name> off",
    ].join("\n");
  }

  /** Add or replace a user-defined endpoint (`key` is the key, or the name of the variable holding it). */
  async setEndpoint(name: string, baseUrl: string, key?: string): Promise<string> {
    const problem = endpointNameProblem(name);
    if (problem) throw new Error(`${name || "(empty)"} cannot name an endpoint: ${problem}`);
    let url: URL | undefined;
    try {
      url = new URL(baseUrl);
    } catch {
      /* reported below */
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw new Error(`${baseUrl} is not a base URL; give one such as http://localhost:8880/v1`);
    }
    const isEnvName = key !== undefined && /^[A-Z_][A-Z0-9_]*$/.test(key);
    this.settings.endpoints[name] = {
      ...this.settings.endpoints[name],
      baseUrl: baseUrl.replace(/\/+$/, ""),
      ...(key === undefined ? {} : isEnvName ? { apiKeyEnv: key } : { apiKey: key }),
    };
    if (key !== undefined) delete this.settings.endpoints[name][isEnvName ? "apiKey" : "apiKeyEnv"];
    this.save();
    this.resetEndpoints();
    await this.ready();
    const state = this.endpointState.get(name);
    if (state && state !== "no key" && "error" in state) {
      return `Endpoint ${name} saved, but it did not answer: ${state.error}`;
    }
    const n = state && state !== "no key" ? state : { tts: 0, stt: 0 };
    if (n.tts + n.stt === 0) {
      return `Endpoint ${name} saved, but its model list names no speech or transcription model; list them as "tts" and "stt" of endpoints.${name} in ${this.store.file}`;
    }
    return `Endpoint ${name}: ${n.tts} speech and ${n.stt} transcription model${n.stt === 1 ? "" : "s"}, named ${name}:<model>`;
  }

  /** Remove a user-defined endpoint; a model of it that is still selected fails when used. */
  async removeEndpoint(name: string): Promise<string> {
    if (!this.settings.endpoints[name]) {
      throw new Error(
        name in PRESETS
          ? `${name} is built in: it is offered while a key for it exists`
          : `No endpoint ${name || "(empty)"}; see /speech --endpoints`,
      );
    }
    delete this.settings.endpoints[name];
    this.save();
    this.resetEndpoints();
    await this.ready();
    return `Endpoint ${name} removed`;
  }

  /** Speech and transcription models with their prices. */
  async modelsReport(): Promise<string> {
    const { tts, stt } = await this.models();
    const line = (m: ModelOption, current: string) => {
      const features = featureLine(m);
      return `${m.id}  ${m.price ?? "price unknown"}${features ? `  ${features}` : ""}${m.id === current ? "  (selected)" : ""}`;
    };
    return [
      "Speech models, price per minute of audio (~ marks an estimate):",
      ...tts.map((m) => line(m, this.settings.speechModel)),
      "",
      "Transcription models, price per minute of audio (~ marks an estimate):",
      ...stt.map((m) => line(m, this.settings.transcriptionModel)),
    ].join("\n");
  }

  async voicesReport(): Promise<string> {
    const model = this.settings.speechModel;
    const voices = await this.voicesFor(model);
    return [`Voices of ${model}:`, ...(voices.length ? voices : ["(xAI lists no voices)"])].join("\n");
  }

  /** The speech lines of the status: models, voice, tools, history. */
  async statusLines(): Promise<string[]> {
    await this.ready();
    const s = this.settings;
    return [
      `Speech model: ${s.speechModel}`,
      `Voice: ${s.voice}`,
      `Transcription model: ${s.transcriptionModel}`,
      `Tools: ${s.tools ? "on" : "off"}`,
      `History: ${this.history.dir}`,
      ...(this.live ? [] : ["(OpenRouter model catalog not loaded; showing built-in lists)"]),
      ...this.endpoints.flatMap((e) => {
        const state = this.endpointState.get(e.id);
        if (!state || state === "no key") return [];
        return "error" in state
          ? [`Endpoint ${e.id}: ✗ ${state.error}`]
          : [`Endpoint ${e.id}: ${state.tts} speech, ${state.stt} transcription`];
      }),
    ];
  }

  /** Change and save one setting; throws (leaving it unchanged) for an invalid value. Returns a summary. */
  async set(name: string, value: string): Promise<string> {
    await this.ready();
    const s = this.settings;
    const list = (xs: string[]) => xs.join(", ");
    switch (name) {
      case "tts-model": {
        await this.requireOffered(value);
        if (value !== XAI_MODEL && !this.isSpeechModel(value)) {
          const offered = (await this.models()).tts.map((m) => m.id);
          throw new Error(`${value || "(empty)"} is not a speech model; choose one of: ${list(offered)}`);
        }
        const voices = await this.voicesFor(value);
        if (voices.length === 0) {
          s.speechModel = value;
          this.save();
          return `Speech model: ${value}; xAI lists no voices, so nothing can be spoken with it now`;
        }
        s.speechModel = value;
        s.voice = keepVoice(voices, s.voice, value === XAI_MODEL ? "eve" : DEFAULT_SETTINGS.voice);
        this.save();
        return `Speech model: ${s.speechModel}, voice: ${s.voice}`;
      }
      case "voice": {
        const voices = await this.voicesFor(s.speechModel);
        if (!voices.includes(value) && !(value && this.anyVoice(s.speechModel))) {
          throw new Error(`${value || "(empty)"} is not a voice of ${s.speechModel}; choose one of: ${list(voices)}`);
        }
        s.voice = value;
        this.save();
        return `Voice: ${value}`;
      }
      case "stt-model": {
        await this.requireOffered(value);
        if (value !== XAI_MODEL && !this.listed.stt.some((m) => m.id === value)) {
          const offered = (await this.models()).stt.map((m) => m.id);
          throw new Error(`${value || "(empty)"} is not a transcription model; choose one of: ${list(offered)}`);
        }
        s.transcriptionModel = value;
        this.save();
        return `Transcription model: ${value}`;
      }
      case "stt-language": {
        if (value === "auto") delete s.dictationLanguage;
        else if (LANGUAGE_TAG.test(value)) s.dictationLanguage = value;
        else throw new Error(`Invalid language tag ${value || "(empty)"}; use a tag such as ja or pt-BR, or auto`);
        this.save();
        return `Dictation language: ${s.dictationLanguage ?? "auto"}`;
      }
      case "tools": {
        if (value !== "on" && value !== "off") throw new Error(`tools must be on or off, not ${value || "empty"}`);
        s.tools = value === "on";
        this.save();
        return `Tools: ${value}`;
      }
      case "dictation-output": {
        const cmd = value.trim();
        if (cmd) s.dictationOutput = cmd;
        else delete s.dictationOutput;
        this.save();
        return `Dictation output: ${cmd ? "your command" : "Pi"}`;
      }
      default:
        throw new Error(`unknown setting ${name || "(none)"}; choose one of: ${list(SETTING_NAMES)}`);
    }
  }

  // ── Voice languages ─────────────────────────────────────────────────────

  /** The saved override, or undefined when none is set or the saved value is not a valid tag. */
  private override(model: string, voice: string): string | undefined {
    const tag = this.settings.languages[model]?.[voice];
    if (!tag) return undefined;
    try {
      voiceLanguage({ model, voice, override: tag });
      return tag;
    } catch {
      return undefined;
    }
  }

  /** The voice language; for xai from the language the xAI voice list gives (once it is loaded). */
  languageOf(model: string, voice: string): VoiceLanguage {
    const language = model === XAI_MODEL ? this.xai.cachedVoices()?.find((v) => v.id === voice)?.language : undefined;
    return voiceLanguage({
      model,
      voice,
      override: this.override(model, voice),
      ...(language ? { metadata: { language } } : {}),
    });
  }

  private async requireVoice(model: string, voice: string): Promise<void> {
    const voices = await this.voicesFor(model);
    if (!voices.includes(voice) && !(voice && this.anyVoice(model))) {
      const valid = voices.length ? voices.join(", ") : "(none listed)";
      throw new Error(`${voice || "(empty)"} is not a voice of ${model}; choose one of: ${valid}`);
    }
  }

  async languagesReport(): Promise<string> {
    const model = this.settings.speechModel;
    const voices = await this.voicesFor(model);
    if (voices.length === 0) return `Voice languages of ${model}:\n(xAI lists no voices)`;
    const lines = voices.map((voice) => {
      const vl = this.languageOf(model, voice);
      return `${voice}: ${languageLabel(vl)} (${languageSource(vl)})`;
    });
    return [`Voice languages of ${model}:`, ...lines].join("\n");
  }

  /** Set (or with "auto" remove) the language override of a voice of the current model. */
  async setLanguage(voice: string, tag: string): Promise<string> {
    await this.ready();
    const model = this.settings.speechModel;
    await this.requireVoice(model, voice);
    const all = this.settings.languages;
    if (tag === "auto") {
      if (all[model]) {
        delete all[model][voice];
        if (Object.keys(all[model]).length === 0) delete all[model];
      }
      this.save();
      const vl = this.languageOf(model, voice);
      return `Language override of ${voice} removed; language: ${languageLabel(vl)} (${languageSource(vl)})`;
    }
    let vl: VoiceLanguage;
    try {
      vl = voiceLanguage({ model, voice, override: tag });
    } catch {
      throw new Error(
        `Invalid language tag "${tag}": use a tag such as "ja" or "pt-BR", or "auto" to remove the override`,
      );
    }
    all[model] = { ...all[model], [voice]: vl.locale ?? vl.language ?? tag };
    this.save();
    return `Language of ${voice}: ${languageLabel(vl)} (override)`;
  }

  // ── Operations ──────────────────────────────────────────────────────────

  /** Model and voice for one synthesis, checked against the catalog or the xAI voice list. */
  private async choose(model?: string, voice?: string): Promise<{ model: string; voice: string }> {
    await this.ready();
    const m = model || this.settings.speechModel;
    if (m === XAI_MODEL) {
      const voices = await this.voicesFor(m);
      if (voices.length === 0) throw new Error("xAI lists no voices; nothing can be spoken with xai now");
      const v = voice || keepVoice(voices, this.settings.voice, "eve");
      await this.requireVoice(m, v);
      return { model: m, voice: v };
    }
    // An endpoint's model is checked by the endpoint when used, as is a voice nobody lists.
    const open = (this.endpointOf(m) !== undefined && !this.isSpeechModel(m)) || this.anyVoice(m);
    if (this.live && !this.endpointOf(m) && !this.isSpeechModel(m)) {
      throw new Error(`${m} is not a speech model; see /speech --models`);
    }
    const voices = this.voicesOf(m);
    const v = voice || (open || voices.includes(this.settings.voice) ? this.settings.voice : voices[0]);
    if (!open && (this.live || this.isSpeechModel(m)) && !voices.includes(v)) {
      throw new Error(
        voices[0] === DEFAULT_VOICE && voices.length === 1
          ? `${m} has no selectable voices; leave the voice unset`
          : `${v} is not a voice of ${m}; choose one of: ${voices.join(", ")}`,
      );
    }
    return { model: m, voice: v };
  }

  /** `language` is the language of the text: a tag, or "auto" to leave it to the service. */
  private async synthesize(text: string, model: string, voice: string, language: string, signal?: AbortSignal) {
    try {
      const via = this.via("tts", model);
      return await this.provider(model).synthesize({ text, model, voice, language, signal, via });
    } catch (err) {
      throw new Error(`Speech synthesis failed: ${errorMessage(err)}`);
    }
  }

  /** Synthesize, save in the history, and play through the player unless `play` is false. Throws on failure. */
  async speak(
    text: string,
    opts: CallOptions & { model?: string; voice?: string; play?: boolean } = {},
  ): Promise<SpeechResult> {
    if (!text.trim()) throw new Error("Nothing to say: the text is empty");
    const { model, voice } = await this.choose(opts.model, opts.voice);
    const play = opts.play !== false;
    await this.provider(model).ensureCredential();
    const ticket = play ? this.player.claim() : undefined;
    // Plain speech never names a language: the text is spoken as written, never translated.
    const audio = await this.synthesize(text, model, voice, "auto", opts.signal);
    let started: Awaited<ReturnType<Player["play"]>> | undefined;
    const saved = await this.history.save(text, audio.audio, audio.format, async (file) => {
      // Playback starts before the conversion to the other format.
      if (play) started = await this.player.play(file, "message", { ticket });
    });
    this.lastSaved = saved.files;
    const result: SpeechResult = { files: saved.files, model, voice };
    if (saved.conversionError) result.conversionError = saved.conversionError;
    if (!play) result.notPlayed = "play was false";
    else if (started?.ok) result.player = started.player;
    else result.notPlayed = started?.reason ?? "playback did not start";
    return result;
  }

  /**
   * Playback-only speech (read-aloud, /speech <text>): a text longer than READING_MIN_CHARS is spoken in pieces
   * that start playing after the first is synthesized, and saved as one message; a shorter one as `speak`.
   * Stopped before every piece was synthesized, it saves nothing and is `stopped`. A failed request throws
   * ReadingFailed with the provider's message.
   */
  async say(text: string, opts: CallOptions = {}): Promise<SpeechResult> {
    if (text.trim().length <= READING_MIN_CHARS) return this.speak(text, opts);
    const { model, voice } = await this.choose();
    if (this.unchunkable.has(model)) return this.speak(text, opts);
    const provider = this.provider(model);
    await provider.ensureCredential();
    const r = await speakInPieces({
      pieces: splitForSpeech(text),
      // Plain speech never names a language, as in `speak`.
      synthesize: (piece, signal) =>
        provider.synthesize({ text: piece, model, voice, language: "auto", signal, via: this.via("tts", model) }),
      player: this.player,
      convert: this.convert,
      save: (wav) => this.history.save(text, wav, "wav"),
      tmpRoot: tmpdir(),
      signal: opts.signal,
    });
    if (r.state === "unchunkable") {
      this.unchunkable.add(model);
      return this.speak(text, opts);
    }
    if (r.state === "stopped") return { files: [], model, voice, stopped: true };
    this.lastSaved = r.saved.files;
    const result: SpeechResult = { files: r.saved.files, model, voice };
    if (r.saved.conversionError) result.conversionError = r.saved.conversionError;
    if (r.player) result.player = r.player;
    else result.notPlayed = r.notPlayed;
    return result;
  }

  /** A short sample of a voice of the current model in its voice language; never saved in the history. */
  async sample(voice?: string, opts: CallOptions = {}): Promise<SampleResult> {
    await this.ready();
    const model = this.settings.speechModel;
    const v = voice || this.settings.voice;
    await this.requireVoice(model, v);
    const vl = this.languageOf(model, v);
    const s = voiceSample(vl, v);
    await this.provider(model).ensureCredential();
    const ticket = this.player.claim();
    const audio = await this.synthesize(s.text, model, v, s.language, opts.signal);
    const file = join(tmpdir(), `pi-speech-sample-${process.pid}-${++this.samples}.${audio.format}`);
    writeFileSync(file, audio.audio);
    const started = await this.player.play(file, "sample", { ticket, cleanup: () => rmSync(file, { force: true }) });
    return {
      model,
      voice: v,
      language: s.language,
      voiceLanguage: vl,
      ...(s.notice ? { notice: s.notice } : {}),
      ...(started.ok ? { player: started.player } : { notPlayed: started.reason }),
    };
  }

  /** The spoken messages of the history, the newest first. */
  messages(): HistoryMessage[] {
    return this.history.list();
  }

  /** How the panel orders its model lists; saved. */
  setModelSort(sort: ModelSort): void {
    this.settings.modelSort = sort;
    this.save();
  }

  /** The last spoken message on disk: from this session, else the newest in the history. */
  lastMessage(): string | undefined {
    return this.lastSaved?.find((f) => existsSync(f)) ?? this.history.newest();
  }

  /** Transcribe an audio file (relative paths from `cwd`, `~` expanded). Throws on failure. */
  async transcribeFile(
    path: string,
    opts: CallOptions & { cwd: string; model?: string; language?: string },
  ): Promise<string> {
    const full = path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : isAbsolute(path)
        ? path
        : resolve(opts.cwd, path);
    const format = AUDIO_FORMATS[extname(full).slice(1).toLowerCase()];
    if (!format)
      throw new Error(`Unsupported audio file ${path}; use one of: ${Object.keys(AUDIO_FORMATS).join(", ")}`);
    await this.provider(opts.model || this.settings.transcriptionModel).ensureCredential();
    let audio: Buffer;
    try {
      audio = readFileSync(full);
    } catch (err) {
      throw new Error(`Cannot read audio file ${path}: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
    }
    return this.transcribeAudio(audio, format, opts);
  }

  /** Transcribe audio held in memory (for example a dictation recording). Throws on failure. */
  async transcribeAudio(
    audio: Buffer,
    format: string,
    opts: CallOptions & { model?: string; language?: string } = {},
  ): Promise<string> {
    const model = opts.model || this.settings.transcriptionModel;
    const provider = this.provider(model);
    await provider.ensureCredential();
    await this.ready();
    if (!this.outside(model) && this.live && !this.catalog.stt.some((m) => m.id === model)) {
      throw new Error(`${model} is not a transcription model; see /speech --models`);
    }
    try {
      const via = this.via("stt", model);
      return await provider.transcribe({ audio, format, model, language: opts.language, signal: opts.signal, via });
    } catch (err) {
      throw new Error(`Transcription failed: ${errorMessage(err)}`);
    }
  }
}
