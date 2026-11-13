/**
 * The one settings file, `<agent dir>/pi-speech/settings.json`, versioned.
 *
 * Earlier versions kept three files there: `settings.json` without a version, `bridge.json`, and
 * `language-overrides.json`. Loading migrates whatever of them is present: it reads them into the
 * settings, writes the versioned file, and removes the earlier ones at once, so afterwards only the
 * versioned file remains. What read-aloud reads is not a setting (it starts Off in every session); its options are.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EndpointConfig } from "./endpoints";
import {
  DEFAULT_READ_ALOUD,
  type ReadAloudOptions,
  SUMMARY_LENGTHS,
  type SummaryLength,
  TRUNCATE_SECONDS,
} from "./read-aloud";

export const SETTINGS_VERSION = 1;

/** auto: the bridge when Pi runs over SSH, else local. on: always the bridge. off: always local. */
export type BridgeMode = "auto" | "on" | "off";

/**
 * Where something runs while the bridge is in use: This machine (Pi's) or the Remote machine (the receiver's).
 * Without the bridge everything runs on This machine, whatever is saved.
 */
export type Machine = "this" | "remote";
export const MACHINES: Machine[] = ["this", "remote"];

/** Where speech or transcription comes from: a provider over the network, or a model on This machine. */
export type Source = "provider" | "local";
export const SOURCES: Source[] = ["provider", "local"];

/** How the model lists of the panel are ordered. */
export type ModelSort = "price" | "provider" | "features" | "newest" | "name";
export const MODEL_SORTS: ModelSort[] = ["price", "provider", "features", "newest", "name"];

/** The keys of the two Pi shortcuts, as Pi names them (`alt+s`). Pi binds them when the extension loads. */
export interface Hotkeys {
  /** Opens the speak composer. */
  speak: string;
  /** Starts and stops dictation. */
  dictate: string;
}

export const DEFAULT_HOTKEYS: Readonly<Hotkeys> = Object.freeze({ speak: "alt+s", dictate: "alt+z" });

/**
 * A key a hotkey may be set to, in Pi's spelling, or undefined: Alt with a letter or a digit, optionally with
 * Ctrl or Shift as well (`alt+d`, `ctrl+alt+d`). Pi keeps Ctrl alone and Alt with other keys for itself.
 */
export function hotkeyId(key: string): string | undefined {
  const parts = key.trim().toLowerCase().split("+");
  const base = parts.pop() ?? "";
  if (!/^[a-z0-9]$/.test(base)) return undefined;
  const mods = new Set(parts);
  if (!mods.has("alt") || mods.size !== parts.length || [...mods].some((m) => !["ctrl", "alt", "shift"].includes(m)))
    return undefined;
  return [...["ctrl", "alt", "shift"].filter((m) => mods.has(m)), base].join("+");
}

/** A key as the panel shows it: `alt+s` as Alt+S. */
export function keyLabel(key: string): string {
  return key
    .split("+")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join("+");
}

/** Language overrides by speech model, then voice: a language tag such as "ja" or "pt-BR". */
export type LanguageOverrides = Record<string, Record<string, string>>;

export interface Settings {
  speechModel: string;
  /** Voice of the speech model; "default" for models without voices. */
  voice: string;
  transcriptionModel: string;
  /** Whether speech_synthesize and speech_transcribe are active. */
  tools: boolean;
  bridge: BridgeMode;
  languages: LanguageOverrides;
  /** The language spoken into dictation and transcribed files, such as "ja"; undefined leaves it to the model. */
  dictationLanguage?: string;
  /** A command the dictation transcript is handed to (%s is the text); undefined pastes into the editor. */
  dictationOutput?: string;
  modelSort: ModelSort;
  /** User-defined OpenAI-compatible speech endpoints, by name (src/engine/endpoints.ts). */
  endpoints: Record<string, EndpointConfig>;
  /** The keys of Speak and Dictate; a change applies when Pi next loads the extension. */
  hotkeys: Hotkeys;
  /** Who summarizes for read-aloud, how long a summary is, and where reading stops. */
  readAloud: ReadAloudOptions;
  /** Where speech comes from; Local uses `localSpeechModel`. */
  speechSource: Source;
  /** Where transcription comes from; Local uses `localTranscriptionModel`. */
  transcriptionSource: Source;
  /** The on-device speech model (an id of `pi-speech-receiver models list`). */
  localSpeechModel?: string;
  /** A voice of the local speech model (a name of `speak <id> --list-voices`); unset is the model's first voice. */
  localSpeechVoice?: string;
  /** The on-device transcription model. */
  localTranscriptionModel?: string;
  /** With the bridge in use: where audio plays. */
  playOn: Machine;
  /** With the bridge in use: where dictation records. */
  recordOn: Machine;
  /** With the bridge in use: where Local sources run their models. */
  modelsOn: Machine;
  /** macOS: the notice that Option+letter reached Pi as a character has been shown (once per install). */
  optionKeyHintShown?: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  speechModel: "google/gemini-3.8-flash-tts",
  voice: "Kore",
  transcriptionModel: "openai/whisper-large-v3-turbo",
  tools: true,
  bridge: "auto",
  languages: {},
  modelSort: "price",
  endpoints: {},
  hotkeys: DEFAULT_HOTKEYS,
  readAloud: DEFAULT_READ_ALOUD,
  speechSource: "provider",
  transcriptionSource: "provider",
  playOn: "remote",
  recordOn: "remote",
  modelsOn: "remote",
});

/** The saved directions, in the order the panel shows them. */
export const DIRECTIONS = ["playOn", "recordOn", "modelsOn"] as const;
export type DirectionSetting = (typeof DIRECTIONS)[number];

const LEGACY_FILES = ["bridge.json", "language-overrides.json"];

type Json = Record<string, unknown>;

function readJson(file: string): Json | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Json) : undefined;
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const isMode = (v: unknown): v is BridgeMode => v === "auto" || v === "on" || v === "off";
const isSort = (v: unknown): v is ModelSort => MODEL_SORTS.includes(v as ModelSort);
const isSource = (v: unknown): v is Source => SOURCES.includes(v as Source);
const isMachine = (v: unknown): v is Machine => MACHINES.includes(v as Machine);

function languagesFrom(raw: unknown): LanguageOverrides {
  const out: LanguageOverrides = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [model, voices] of Object.entries(raw as Json)) {
    if (!voices || typeof voices !== "object") continue;
    for (const [voice, tag] of Object.entries(voices as Json)) {
      if (typeof tag === "string" && tag) out[model] = { ...out[model], [voice]: tag };
    }
  }
  return out;
}

const strings = (v: unknown): string[] | undefined => {
  const out = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
  return Array.isArray(v) ? out : undefined;
};

function endpointsFrom(raw: unknown): Record<string, EndpointConfig> {
  const out: Record<string, EndpointConfig> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Json)) {
    const v = value as Json | null;
    const baseUrl = v && typeof v === "object" ? str(v.baseUrl) : undefined;
    if (!v || !baseUrl) continue;
    const e: EndpointConfig = { baseUrl };
    const apiKey = str(v.apiKey);
    const apiKeyEnv = str(v.apiKeyEnv);
    if (apiKey) e.apiKey = apiKey;
    if (apiKeyEnv) e.apiKeyEnv = apiKeyEnv;
    for (const key of ["tts", "stt", "voices", "chatTts", "chatStt"] as const) {
      const list = strings(v[key]);
      if (list) e[key] = list;
    }
    out[name] = e;
  }
  return out;
}

/** Saved hotkeys over the defaults; a key that is not a valid hotkey, or both on one key, keeps the default. */
function hotkeysFrom(raw: unknown): Hotkeys {
  const out = { ...DEFAULT_HOTKEYS };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Json;
  const speak = typeof r.speak === "string" ? hotkeyId(r.speak) : undefined;
  const dictate = typeof r.dictate === "string" ? hotkeyId(r.dictate) : undefined;
  if (speak) out.speak = speak;
  if (dictate) out.dictate = dictate;
  return out.speak === out.dictate ? { ...DEFAULT_HOTKEYS } : out;
}

/** Saved read-aloud options over the defaults; a value that is not one of the choices keeps the default. */
function readAloudFrom(raw: unknown): ReadAloudOptions {
  const out: ReadAloudOptions = { ...DEFAULT_READ_ALOUD };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Json;
  const summarizer = str(r.summarizer);
  if (summarizer) out.summarizer = summarizer;
  if (SUMMARY_LENGTHS.includes(r.length as SummaryLength)) out.length = r.length as SummaryLength;
  if (typeof r.truncate === "number" && TRUNCATE_SECONDS.includes(r.truncate)) out.truncate = r.truncate;
  return out;
}

const sameReadAloud = (a: ReadAloudOptions, b: ReadAloudOptions) =>
  a.summarizer === b.summarizer && a.length === b.length && a.truncate === b.truncate;

function copyDefaults(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    languages: {},
    endpoints: {},
    hotkeys: { ...DEFAULT_HOTKEYS },
    readAloud: { ...DEFAULT_READ_ALOUD },
  };
}

export class SettingsFile {
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = join(dir, "settings.json");
  }

  /** The saved settings over the defaults, migrating any earlier files. Never throws. */
  load(): Settings {
    const s = copyDefaults();
    const raw = readJson(this.file);
    let legacy = false;
    if (raw && typeof raw.version === "number") {
      s.speechModel = str(raw.speechModel) ?? s.speechModel;
      s.voice = str(raw.voice) ?? s.voice;
      s.transcriptionModel = str(raw.transcriptionModel) ?? s.transcriptionModel;
      if (typeof raw.tools === "boolean") s.tools = raw.tools;
      if (isMode(raw.bridge)) s.bridge = raw.bridge;
      s.languages = languagesFrom(raw.languages);
      const spoken = str(raw.dictationLanguage);
      if (spoken) s.dictationLanguage = spoken;
      const output = str(raw.dictationOutput);
      if (output) s.dictationOutput = output;
      if (isSort(raw.modelSort)) s.modelSort = raw.modelSort;
      s.endpoints = endpointsFrom(raw.endpoints);
      s.hotkeys = hotkeysFrom(raw.hotkeys);
      s.readAloud = readAloudFrom(raw.readAloud);
      if (isSource(raw.speechSource)) s.speechSource = raw.speechSource;
      if (isSource(raw.transcriptionSource)) s.transcriptionSource = raw.transcriptionSource;
      const localSpeech = str(raw.localSpeechModel);
      if (localSpeech) s.localSpeechModel = localSpeech;
      const localVoice = str(raw.localSpeechVoice);
      if (localVoice) s.localSpeechVoice = localVoice;
      const localTranscription = str(raw.localTranscriptionModel);
      if (localTranscription) s.localTranscriptionModel = localTranscription;
      if (raw.optionKeyHintShown === true) s.optionKeyHintShown = true;
      for (const d of DIRECTIONS) if (isMachine(raw[d])) s[d] = raw[d];
    } else if (raw) {
      // settings.json without a version
      legacy = true;
      s.speechModel = str(raw.ttsModel) ?? s.speechModel;
      s.voice = str(raw.ttsVoice) ?? s.voice;
      s.transcriptionModel = str(raw.sttModel) ?? s.transcriptionModel;
      if (typeof raw.toolsEnabled === "boolean") s.tools = raw.toolsEnabled;
    }
    if (LEGACY_FILES.some((f) => existsSync(join(this.dir, f)))) legacy = true;
    const bridge = readJson(join(this.dir, "bridge.json"));
    if (bridge) {
      if (isMode(bridge.mode)) s.bridge = bridge.mode;
      else if (bridge.route === "bridge") s.bridge = "on";
      else if (bridge.route === "local") s.bridge = "off";
    }
    const overrides = languagesFrom(readJson(join(this.dir, "language-overrides.json")));
    for (const [model, voices] of Object.entries(overrides)) {
      s.languages[model] = { ...s.languages[model], ...voices };
    }
    if (legacy) {
      try {
        this.save(s);
      } catch {
        // Unwritable: the earlier files stay and are read again next time.
      }
    }
    return s;
  }

  /** Write the versioned file atomically, then remove the earlier files. */
  save(s: Settings): void {
    mkdirSync(this.dir, { recursive: true });
    const data = {
      version: SETTINGS_VERSION,
      speechModel: s.speechModel,
      voice: s.voice,
      transcriptionModel: s.transcriptionModel,
      tools: s.tools,
      bridge: s.bridge,
      languages: s.languages,
      ...(s.dictationLanguage ? { dictationLanguage: s.dictationLanguage } : {}),
      ...(s.dictationOutput ? { dictationOutput: s.dictationOutput } : {}),
      ...(s.modelSort !== DEFAULT_SETTINGS.modelSort ? { modelSort: s.modelSort } : {}),
      ...(Object.keys(s.endpoints).length ? { endpoints: s.endpoints } : {}),
      ...(s.hotkeys.speak !== DEFAULT_HOTKEYS.speak || s.hotkeys.dictate !== DEFAULT_HOTKEYS.dictate
        ? { hotkeys: { speak: s.hotkeys.speak, dictate: s.hotkeys.dictate } }
        : {}),
      ...(sameReadAloud(s.readAloud, DEFAULT_READ_ALOUD) ? {} : { readAloud: s.readAloud }),
      ...(s.speechSource !== "provider" ? { speechSource: s.speechSource } : {}),
      ...(s.transcriptionSource !== "provider" ? { transcriptionSource: s.transcriptionSource } : {}),
      ...(s.localSpeechModel ? { localSpeechModel: s.localSpeechModel } : {}),
      ...(s.localSpeechVoice ? { localSpeechVoice: s.localSpeechVoice } : {}),
      ...(s.localTranscriptionModel ? { localTranscriptionModel: s.localTranscriptionModel } : {}),
      ...(s.optionKeyHintShown ? { optionKeyHintShown: true } : {}),
      ...Object.fromEntries(DIRECTIONS.filter((d) => s[d] !== DEFAULT_SETTINGS[d]).map((d) => [d, s[d]])),
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, this.file);
    for (const f of LEGACY_FILES) rmSync(join(this.dir, f), { force: true });
  }
}
