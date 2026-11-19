/**
 * The speech settings Jing's Zellij plugin keeps in `<config>/zellij/pi-speech.json`.
 *
 * Mirrors the speech-settings pane of Jing's `crates/jing-plugin`: the same file, the same keys and the same
 * key aliases (in the order `osd.rs` reads them), so pi-speech and the pane can read what the other saved.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Settings, Source } from "./settings";

export const JING_CONFIG_NAME = "pi-speech.json";

/** `$XDG_CONFIG_HOME/zellij/pi-speech.json`, else `$HOME/.config/zellij/pi-speech.json`, else undefined. */
export function jingConfigPath(env: Record<string, string | undefined>): string | undefined {
  const config = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, ".config") : undefined);
  return config ? join(config, "zellij", JING_CONFIG_NAME) : undefined;
}

export interface JingSpeechConfig {
  ttsSource?: Source;
  sttSource?: Source;
  model?: string;
  voice?: string;
  sttModel?: string;
  providerTtsModel?: string;
  providerVoice?: string;
  providerSttModel?: string;
  url?: string;
}

type StringKey = Exclude<keyof JingSpeechConfig, "ttsSource" | "sttSource">;

const STRING_ALIASES: [StringKey, string[]][] = [
  ["model", ["model", "localSpeechModel", "speech_model"]],
  ["voice", ["voice", "localSpeechVoice", "speech_voice"]],
  ["sttModel", ["sttModel", "localTranscriptionModel", "speech_stt_model"]],
  ["providerTtsModel", ["providerTtsModel", "speechModel"]],
  ["providerVoice", ["providerVoice"]],
  ["providerSttModel", ["providerSttModel", "transcriptionModel"]],
  ["url", ["url", "bridgeAddress", "speech_url"]],
];

function firstString(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function firstSource(o: Record<string, unknown>, keys: string[]): Source | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v !== "string") continue;
    const t = v.trim().toLowerCase();
    if (t === "local" || t === "provider") return t;
  }
  return undefined;
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** The settings in a parsed `pi-speech.json`; anything not a JSON object gives none. */
export function parseJingConfig(raw: unknown): JingSpeechConfig {
  if (!isObject(raw)) return {};
  const c: JingSpeechConfig = {};
  const tts = firstSource(raw, ["ttsSource", "speechSource"]);
  if (tts) c.ttsSource = tts;
  const stt = firstSource(raw, ["sttSource", "transcriptionSource"]);
  if (stt) c.sttSource = stt;
  for (const [key, aliases] of STRING_ALIASES) {
    const v = firstString(raw, aliases);
    if (v) c[key] = v;
  }
  return c;
}

function readObject(file: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isObject(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** The settings in `file`, or undefined when it is missing, unreadable or not JSON. Never throws. */
export function readJingConfig(file: string): JingSpeechConfig | undefined {
  try {
    if (!existsSync(file)) return undefined;
    return parseJingConfig(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Copies Jing's settings into `s` (not `url`: Pi keeps its own bridge address). True when anything changed. */
export function applyJingConfig(s: Settings, c: JingSpeechConfig): boolean {
  let changed = false;
  const set = <K extends keyof Settings>(key: K, v: Settings[K] | undefined) => {
    if (v === undefined || s[key] === v) return;
    s[key] = v;
    changed = true;
  };
  set("speechSource", c.ttsSource);
  set("transcriptionSource", c.sttSource);
  set("localSpeechModel", c.model);
  set("localSpeechVoice", c.voice);
  set("localTranscriptionModel", c.sttModel);
  set("speechModel", c.providerTtsModel);
  set("voice", c.providerVoice);
  set("transcriptionModel", c.providerSttModel);
  return changed;
}

/** The keys Jing's `save_config_script` writes, from `s`. */
export function jingConfigFrom(s: Settings): Record<string, string> {
  return {
    ttsSource: s.speechSource,
    sttSource: s.transcriptionSource,
    ...(s.localSpeechModel ? { model: s.localSpeechModel } : {}),
    ...(s.localSpeechVoice ? { voice: s.localSpeechVoice } : {}),
    ...(s.localTranscriptionModel ? { sttModel: s.localTranscriptionModel } : {}),
    providerTtsModel: s.speechModel,
    providerVoice: s.voice,
    providerSttModel: s.transcriptionModel,
  };
}

/** Saves `s` into `file` atomically, keeping keys it does not set (such as `url`). Throws only on fs errors. */
export function writeJingConfig(file: string, s: Settings): void {
  const d = { ...(readObject(file) ?? {}), ...jingConfigFrom(s) };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(d, null, 2)}\n`);
  renameSync(tmp, file);
}
