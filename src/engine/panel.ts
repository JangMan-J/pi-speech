/**
 * The /speech settings panel, Pi-free: a plain view model of the panel (rows, values, notes, live state,
 * the key hints for the current focus) built from engine state, and what each key does. Every change goes
 * through the same engine operations as the `/speech --` actions. The Pi adapter draws the view model and
 * feeds the keys; nothing here knows about terminals.
 */

import { basename } from "node:path";
import type { BridgeHealth } from "../bridge/index";
import type { VoiceLanguage } from "../voice-language/index";
import type { Engine } from "./engine";
import { errorMessage } from "./env";
import { FEATURES, featureLine, type ModelKind, modelColumns, vendorOf } from "./features";
import type { HistoryMessage } from "./history";
import type { ModelOption, SpeechCatalog } from "./openrouter";
import { REPLACED } from "./player";
import { priceValue } from "./pricing";
import { type BridgeMode, MODEL_SORTS, type ModelSort } from "./settings";
import { languageLabel, type SampleResult, type SettingName } from "./speech";
import { ReadingFailed, readingFailedMessage } from "./stream";
import type { Surface, SurfaceUi } from "./surface";
import { XAI_MODEL } from "./xai";

export type RowId =
  | "speak"
  | "replay"
  | "history"
  | "stop"
  | "speechModel"
  | "voice"
  | "readAloud"
  | "dictate"
  | "transcribe"
  | "transcription"
  | "language"
  | "output"
  | "audio"
  | "tools";

/** What the rows are grouped by: turning text into speech, speech into text, and how the plugin is wired. */
export type SectionId = "speak" | "listen" | "system";

export interface PanelRow {
  id: RowId;
  section: SectionId;
  group: "action" | "setting";
  label: string;
  /** The key that runs an action. */
  key?: string;
  /** The value of a setting, as shown (the xai model as xAI Grok). */
  value?: string;
  /** A model row: the price per minute of audio, shown first (or what is wrong with it, starting with ✗). */
  price?: string;
  /** Secondary facts: the provider of a model, the voice language, the resolved audio route. */
  note?: string;
  /** A shorter note, for when the note does not fit. */
  short?: string;
  /** Something is wrong or unavailable; the note (or price) says what, starting with ✗. */
  alert?: boolean;
  /** Enter opens a list to choose from (drawn with ›); the other settings change in place. */
  opens?: boolean;
}

export interface PickerItem {
  /** The value saved when it is picked. */
  id: string;
  /** How it is shown and matched: the id, or a name for it (xAI Grok for xai). */
  label: string;
  /** A model: the price per minute of audio, or `price unknown`. */
  price?: string;
  /** The features of a model (`tags · 90+ langs · fast`), or the language of a voice. Used to search. */
  note?: string;
  /** Aligned columns drawn after the price (a model's language, then its voices or what it can do). */
  cols?: string[];
  current: boolean;
}

export interface PickerView {
  title: string;
  /** A model list: how it is ordered (Tab changes it): `price`, `provider`, `features`, `newest`, `name`. */
  sort?: string;
  /** A model list: the feature every shown model has (Shift+Tab changes it), or `all`. */
  show?: string;
  /** A model list: what the catalog says about the highlighted model; empty when it says nothing. */
  detail?: string;
  /** What the items are, for the count: `models`, `voices`, `messages`. */
  noun: string;
  query: string;
  cursor: number;
  /** The matches of the query, best first. */
  items: PickerItem[];
  selected: number;
  /** All choices, before filtering. */
  total: number;
  loading: boolean;
  /** What to say when `items` is empty. */
  empty: string;
}

export interface InputView {
  label: string;
  value: string;
  cursor: number;
  placeholder: string;
  /** The row the input is drawn under; none: under the list. */
  under?: RowId;
}

export type StatusTone = "success" | "error" | "warning" | "busy" | "info";

export interface Status {
  tone: StatusTone;
  /** One line, starting with its symbol (✓, ✗, !, ♪) where it has one. */
  text: string;
}

export interface Hint {
  key: string;
  /** What the key does; empty when the key says it (Backspace). */
  action: string;
  /** Given up first when the line is too narrow. */
  optional?: boolean;
}

export interface PanelView {
  title: string;
  /** What speech is doing: ▶ speaking, ● REC m:ss, … transcribing; empty when nothing happens. */
  state: string;
  rows: PanelRow[];
  selected: number;
  picker?: PickerView;
  input?: InputView;
  /** A dedicated repeated-speaking composer; the settings and picker rows are hidden. */
  composer?: boolean;
  status?: Status;
  /** The keys that work in the current focus; Esc is always last. */
  hints: Hint[];
}

export type NamedKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "enter"
  | "escape"
  | "tab"
  | "backspace"
  | "delete"
  | "home"
  | "end"
  /** Shift+Tab, the feature filter of a model list. */
  | "backtab"
  /** Alt+S, the speak composer. */
  | "speak"
  /** F2, the voice-language key. */
  | "language"
  /** Alt+Z, the dictation key. */
  | "dictate";

/** A key: a named one, or typed (or pasted) text. */
export type PanelKey = { key: NamedKey } | { text: string; paste?: boolean };

const isWordChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** Whether `query` is spelled by runs of `text` that each start a word (`elevenv3` in `eleven-v3`). */
function wordRuns(query: string[], text: string[]): boolean {
  const seen = new Set<string>();
  const from = (qi: number, ti: number, inRun: boolean): boolean => {
    if (qi === query.length) return true;
    const key = `${qi} ${ti} ${inRun}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (inRun && text[ti] === query[qi] && from(qi + 1, ti + 1, true)) return true;
    for (let j = ti; j < text.length; j++) {
      if (text[j] === query[qi] && !isWordChar(text[j - 1]) && from(qi + 1, j + 1, true)) return true;
    }
    return false;
  };
  return from(0, 0, false);
}

/** How well one query word matches a text: 0 a whole word, 1 the start of a word, 2 otherwise; undefined: not. */
function matchTier(word: string, text: string): number | undefined {
  const t = text.toLowerCase();
  const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (t === word || words.includes(word)) return 0;
  if (t.startsWith(word) || words.some((w) => w.startsWith(word))) return 1;
  if (t.includes(word) || wordRuns([...word], [...t])) return 2;
  return undefined;
}

/**
 * The items matching every word of the query (case-insensitive): a word matches a whole word of the text, the
 * start of one, a part of the text, or runs that each start a word. Whole words rank first, then starts of
 * words, then the rest; the list's own order holds within each.
 */
export function matchItems<T>(items: T[], query: string, text: (item: T) => string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  const tiers: T[][] = [[], [], []];
  for (const item of items) {
    const t = text(item);
    let worst = 0;
    for (const w of words) {
      const tier = matchTier(w, t);
      worst = tier === undefined ? -1 : Math.max(worst, tier);
      if (worst < 0) break;
    }
    if (worst >= 0) tiers[worst].push(item);
  }
  return tiers.flat();
}

export interface PanelDeps {
  /** Where results go once the panel has closed, and what dictation pastes into. */
  ui: SurfaceUi;
  /** Close the panel. */
  close(): void;
  /** The view changed: draw it again. */
  changed(): void;
  /** How long a success line stays. */
  successMs?: number;
}

/** A one-line text field: the value and the cursor, in code points. */
class LineEdit {
  private chars: string[];
  cursor: number;

  constructor(value = "") {
    this.chars = [...value];
    this.cursor = this.chars.length;
  }

  get value(): string {
    return this.chars.join("");
  }

  insert(text: string): void {
    const clean = [...text.replace(/[\r\n\t]+/g, " ")].filter((c) => c >= " " && c !== "\x7f");
    this.chars.splice(this.cursor, 0, ...clean);
    this.cursor += clean.length;
  }

  clear(): void {
    this.chars = [];
    this.cursor = 0;
  }

  /** Apply an editing key; returns whether it was one. */
  edit(key: NamedKey): boolean {
    switch (key) {
      case "backspace":
        if (this.cursor > 0) this.chars.splice(--this.cursor, 1);
        return true;
      case "delete":
        this.chars.splice(this.cursor, 1);
        return true;
      case "left":
        this.cursor = Math.max(0, this.cursor - 1);
        return true;
      case "right":
        this.cursor = Math.min(this.chars.length, this.cursor + 1);
        return true;
      case "home":
        this.cursor = 0;
        return true;
      case "end":
        this.cursor = this.chars.length;
        return true;
      default:
        return false;
    }
  }
}

/** The settings chosen from a list. */
type ListRow = "speechModel" | "transcription" | "voice";
/** Everything the list view shows: those settings, and the spoken messages of the history. */
type PickerRow = ListRow | "history";

interface PickerState {
  row: PickerRow;
  /** The choices (for the history, the files); undefined while they load. */
  ids?: string[];
  /** The history: its messages, in the order of `ids`. */
  messages?: HistoryMessage[];
  /** A model list: the feature every shown model has, or `all`. */
  show: string;
  edit: LineEdit;
  selected: number;
}

type Mode =
  | { kind: "list" }
  | { kind: "picker"; picker: PickerState }
  | { kind: "input"; purpose: "speak"; edit: LineEdit; back: Mode; standalone?: boolean }
  | { kind: "input"; purpose: "language"; voice: string; edit: LineEdit; back: Mode }
  | { kind: "input"; purpose: "transcribe" | "dictation" | "output"; edit: LineEdit; back: Mode };

const ROWS: Array<Pick<PanelRow, "id" | "section" | "group" | "label" | "key" | "opens">> = [
  { id: "speak", section: "speak", group: "action", label: "Speak…", key: "Alt+S" },
  { id: "replay", section: "speak", group: "action", label: "Replay last", key: "r" },
  { id: "history", section: "speak", group: "action", label: "History…", key: "h" },
  { id: "stop", section: "speak", group: "action", label: "Stop", key: "s" },
  { id: "speechModel", section: "speak", group: "setting", label: "Speech model", opens: true },
  { id: "voice", section: "speak", group: "setting", label: "Voice", opens: true },
  { id: "readAloud", section: "speak", group: "setting", label: "Read replies aloud" },
  { id: "dictate", section: "listen", group: "action", label: "Dictate", key: "Alt+Z" },
  { id: "transcribe", section: "listen", group: "action", label: "Transcribe file…", key: "t" },
  { id: "transcription", section: "listen", group: "setting", label: "Transcription", opens: true },
  { id: "language", section: "listen", group: "setting", label: "Dictation language", opens: true },
  { id: "output", section: "listen", group: "setting", label: "Dictation output", opens: true },
  { id: "audio", section: "system", group: "setting", label: "Play audio on" },
  { id: "tools", section: "system", group: "setting", label: "Agent tools" },
];

/**
 * The lines of the panel as indexes into `rows`: the actions of a section share one line (a toolbar), every
 * setting has its own. ↑↓ move between lines, ←→ within a toolbar.
 */
export function rowLines(rows: Array<Pick<PanelRow, "group" | "section">>): number[][] {
  const lines: number[][] = [];
  rows.forEach((r, i) => {
    const last = lines.at(-1);
    const head = last ? rows[last[0]] : undefined;
    if (last && head && r.group === "action" && head.group === "action" && head.section === r.section) last.push(i);
    else lines.push([i]);
  });
  return lines;
}
const LINES = rowLines(ROWS);

const PICKER_ROWS: ListRow[] = ["speechModel", "transcription", "voice"];
const isPickerRow = (id: RowId): id is ListRow => (PICKER_ROWS as RowId[]).includes(id);
const isModelRow = (row: PickerRow): row is "speechModel" | "transcription" =>
  row === "speechModel" || row === "transcription";
const kindOf = (row: "speechModel" | "transcription"): ModelKind => (row === "speechModel" ? "tts" : "stt");
const SETTING_OF: Record<ListRow, SettingName> = {
  speechModel: "tts-model",
  transcription: "stt-model",
  voice: "voice",
};
const LABEL_OF: Record<PickerRow, string> = {
  speechModel: "Speech model",
  transcription: "Transcription",
  voice: "Voice",
  history: "History",
};
const LANGUAGE_HINT = "a tag such as ja or pt-BR, or auto";
const OUTPUT_HINT = "a command; %s is the dictation text · empty uses Pi's input box";

/** The bridge modes in the order ←→ step through them, with the words the panel shows. */
const AUDIO_MODES: BridgeMode[] = ["auto", "on", "off"];
const AUDIO_WORDS: Record<BridgeMode, string> = { auto: "auto", on: "bridge", off: "local" };

const PRICE_UNKNOWN = "price unknown";
/** The name the panel shows for the xai model (the saved id stays xai). */
export const XAI_LABEL = "xAI Grok";

const onOff = (on: boolean) => (on ? "on" : "off");
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** A model as the panel shows it. */
const modelLabel = (id: string) => (id === XAI_MODEL ? XAI_LABEL : id);

/** The voice language, and `set by you` only when you set it: `ja`, `ja · set by you`, `multilingual`, `unknown`. */
export function voiceNote(vl: VoiceLanguage): string {
  switch (vl.status) {
    case "override":
      return `${languageLabel(vl)} · set by you`;
    case "unknown":
      return "unknown";
    case "multilingual":
      return "multilingual";
    default:
      return languageLabel(vl);
  }
}

/** The price a model row shows: xAI is on your subscription, a `$0` model is free, else the per-minute price. */
function priceOf(m: { id: string; price?: string }): string {
  if (m.id === XAI_MODEL) return "subscription";
  const p = m.price ?? PRICE_UNKNOWN;
  return p === "$0" ? "free" : p;
}

const cmp = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
const priceRank = (m: ModelOption) =>
  m.id === XAI_MODEL ? Number.POSITIVE_INFINITY : (priceValue(m.price) ?? Number.POSITIVE_INFINITY);
const vendor = (m: ModelOption) => m.vendor ?? vendorOf(m.id);
const byName = (a: ModelOption, b: ModelOption) => modelLabel(a.id).localeCompare(modelLabel(b.id));
/** Cheapest first, an unknown price last, the same price by name. */
const byPrice = (a: ModelOption, b: ModelOption) => cmp(priceRank(a), priceRank(b)) || byName(a, b);

/** The orders of a model list. Within one vendor, or one number of features, the cheapest comes first. */
const MODEL_ORDER: Record<ModelSort, (a: ModelOption, b: ModelOption) => number> = {
  price: byPrice,
  provider: (a, b) => vendor(a).localeCompare(vendor(b), undefined, { sensitivity: "base" }) || byPrice(a, b),
  features: (a, b) => cmp(b.features?.length ?? 0, a.features?.length ?? 0) || byPrice(a, b),
  newest: (a, b) => cmp(b.created ?? 0, a.created ?? 0) || byName(a, b),
  name: byName,
};

/** A played sample, briefly; a fallback to English says why (the rule of the voice sample). */
function sampleLine(r: SampleResult): string {
  if (!r.notice) return `✓ sampled ${r.voice} in ${r.language}`;
  const vl = r.voiceLanguage;
  const why =
    vl.status === "multilingual"
      ? "multilingual voice"
      : vl.status === "unknown"
        ? "language unknown"
        : `no ${languageLabel(vl)} sample text`;
  return `✓ sampled ${r.voice} in English · ${why}`;
}

/** What a failed Speak… says. */
function speakError(err: unknown): string {
  return err instanceof ReadingFailed ? readingFailedMessage("Speech", "text", err.reason) : errorMessage(err);
}

export class Panel {
  private mode: Mode = { kind: "list" };
  private selected = 0;
  /** The column ↑↓ return to in a toolbar. */
  private col = 0;
  private transcribing = false;
  private status?: Status;
  private statusTimer?: ReturnType<typeof setTimeout>;
  /** Values being saved, shown at once. */
  private readonly pending = new Map<RowId, string>();
  private models?: SpeechCatalog;
  private modelsLoad?: Promise<SpeechCatalog>;
  private modelsError?: string;
  private voices?: { model: string; ids?: string[]; error?: string; load: Promise<string[]> };
  private receiver?: BridgeHealth | "checking";
  private probeSeq = 0;
  private sampleSeq = 0;
  /** Speak… and Replay: a newer one, or Stop, replaces the line of an older one. */
  private playSeq = 0;
  /** A spoken text that is playing: its line turns to ✓ Spoken when the playback ends. */
  private speaking?: Status;
  private queue: Promise<void> = Promise.resolve();
  private readonly inflight = new Set<Promise<unknown>>();
  private unlisten?: () => void;
  private disposed = false;

  constructor(
    private readonly engine: Engine,
    private readonly surface: Surface,
    private readonly deps: PanelDeps,
  ) {}

  private get speech() {
    return this.engine.speech;
  }

  /** Start: follow the live state, load the model lists and voices, and check the receiver when it is used. */
  open(): void {
    this.unlisten = this.engine.indicator.listen(() => {
      this.spoken();
      this.changed();
    });
    this.track(this.loadModels());
    this.track(this.loadVoices());
    this.probe();
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    if (this.statusTimer) clearTimeout(this.statusTimer);
  }

  /** Open the repeated-speaking composer. Standalone mode closes on Esc instead of returning to settings. */
  openSpeaker(standalone = false): void {
    this.mode = { kind: "input", purpose: "speak", edit: new LineEdit(), back: { kind: "list" }, standalone };
    this.changed();
  }

  /** Settles when every operation started so far has finished. */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  /** A notification from the engine while the panel is open: one line in the panel instead of a toast. */
  report(message: string, level: "info" | "warning" | "error"): void {
    const symbol = level === "error" ? "✗ " : level === "warning" ? "! " : "";
    this.setStatus(level, `${symbol}${message}`);
    this.changed();
  }

  // ── The view ────────────────────────────────────────────────────────────

  view(): PanelView {
    const view: PanelView = {
      title: "Speech",
      state: this.engine.indicator.live(),
      rows: ROWS.map((r) => this.row(r)),
      selected: this.selected,
      hints: this.hints(),
    };
    if (this.status) view.status = this.status;
    if (this.mode.kind === "picker") view.picker = this.pickerView(this.mode.picker);
    if (this.mode.kind === "input") {
      const m = this.mode;
      const input = (label: string, placeholder: string, under?: RowId): InputView => ({
        label,
        value: m.edit.value,
        cursor: m.edit.cursor,
        placeholder,
        ...(under ? { under } : {}),
      });
      switch (m.purpose) {
        case "speak":
          view.title = "Speak";
          view.composer = true;
          view.input = input(
            "",
            this.takesTags()
              ? "type a message · Enter speaks · [tags] direct this model"
              : "type a message · Enter speaks · keep typing",
          );
          break;
        case "language":
          view.input = input(`Language of ${m.voice}`, LANGUAGE_HINT, m.back.kind === "list" ? "voice" : undefined);
          break;
        case "transcribe":
          view.input = input(
            "Audio file",
            "wav, mp3, flac, m4a, ogg, webm or aac · the text goes into the editor",
            "transcribe",
          );
          break;
        case "dictation":
          view.input = input("Spoken language", LANGUAGE_HINT, "language");
          break;
        case "output":
          view.input = input("Dictation output", OUTPUT_HINT, "output");
          break;
      }
      if (m.back.kind === "picker") view.picker = this.pickerView(m.back.picker);
    }
    return view;
  }

  private row(base: (typeof ROWS)[number]): PanelRow {
    const s = this.speech.settings;
    const value = (actual: string) => this.pending.get(base.id) ?? actual;
    switch (base.id) {
      case "speechModel": {
        const v = value(s.speechModel);
        return { ...base, value: modelLabel(v), ...this.modelNote("tts", v) };
      }
      case "transcription": {
        const v = value(s.transcriptionModel);
        return { ...base, value: modelLabel(v), ...this.modelNote("stt", v) };
      }
      case "voice": {
        const v = value(s.voice);
        return { ...base, value: v, ...this.voiceRowNote(v) };
      }
      case "audio": {
        const v = value(AUDIO_WORDS[this.engine.routes.mode]);
        const mode = AUDIO_MODES.find((m) => AUDIO_WORDS[m] === v) ?? "auto";
        return { ...base, value: v, ...this.audioNote(mode) };
      }
      case "readAloud":
        return { ...base, value: onOff(this.engine.readAloud.enabled) };
      case "language":
        return {
          ...base,
          value: value(s.dictationLanguage ?? "auto"),
          note: s.dictationLanguage ? "sent with dictation and transcribed files" : "the model detects it",
        };
      case "tools":
        return { ...base, value: value(onOff(s.tools)), note: "lets the agent speak and transcribe" };
      case "output":
        return s.dictationOutput
          ? { ...base, value: "User-defined", note: s.dictationOutput }
          : { ...base, value: "Pi", note: "into Pi's input box" };
      default:
        return { ...base };
    }
  }

  /** The value a row shows now, a pending one included. */
  private shown(id: RowId): string | undefined {
    const base = ROWS.find((r) => r.id === id);
    return base ? this.row(base).value : undefined;
  }

  /** Price and provider of a model, or why it is not offered. */
  private modelNote(kind: "tts" | "stt", id: string): Pick<PanelRow, "price" | "note" | "alert"> {
    if (!this.models) return this.modelsError ? { note: "✗ models unavailable", alert: true } : { note: "loading…" };
    const m = this.models[kind].find((x) => x.id === id);
    if (!m) {
      return id === XAI_MODEL ? { note: "✗ xAI: no login", alert: true } : { note: "✗ not offered", alert: true };
    }
    const provider = this.speech.providerName(id);
    if (this.speech.catalogOffline(id)) {
      return { price: "✗ catalog offline", note: provider, alert: true };
    }
    // What the model offers, as far as the catalog says; where it says nothing, who serves it.
    // `free` is already the price.
    const features = m.features?.filter((f) => f !== "free");
    return { price: priceOf(m), note: featureLine({ features, languages: m.languages }) || provider };
  }

  private voiceRowNote(voice: string): Pick<PanelRow, "note" | "alert"> {
    const model = this.speech.settings.speechModel;
    const v = this.voices?.model === model ? this.voices : undefined;
    if (v?.error) return { note: "✗ voices unavailable", alert: true };
    if (model === XAI_MODEL && !v?.ids) return { note: "loading…" };
    if (v?.ids && v.ids.length === 0) return { note: "✗ xAI lists no voices", alert: true };
    return { note: voiceNote(this.speech.languageOf(model, voice)) };
  }

  /** Where audio goes in a mode: this machine, or the bridge with the receiver's state. */
  private audioNote(mode: BridgeMode): Pick<PanelRow, "note" | "short" | "alert"> {
    const routes = this.engine.routes;
    if (routes.routeFor(mode) === "local") {
      const where = routes.ssh ? "Pi host" : "this machine";
      return { note: mode === "auto" ? `→ ${where}` : where };
    }
    const r = this.receiver;
    const host = routes.url.replace(/^[a-z]+:\/\//, "");
    const state = !r || r === "checking" ? "… checking" : r.ok ? `✓ ${host}` : "✗ receiver unreachable";
    const alert = typeof r === "object" && !r.ok;
    return { note: mode === "auto" ? `→ bridge ${state}` : state, short: state, ...(alert ? { alert } : {}) };
  }

  /** The models of a model list as the catalog has them (a model it does not list keeps its id). */
  private modelOptions(p: PickerState & { row: "speechModel" | "transcription" }): ModelOption[] {
    const listed = this.models?.[kindOf(p.row)] ?? [];
    return (p.ids ?? []).map((id) => listed.find((m) => m.id === id) ?? { id, label: id });
  }

  private pickerItems(p: PickerState): PickerItem[] {
    const s = this.speech.settings;
    if (p.row === "history") {
      const all = (p.messages ?? []).map(
        (m): PickerItem => ({ id: m.file, label: `${m.time}  ${m.title}`, current: false }),
      );
      return matchItems(all, p.edit.value, (i) => i.label);
    }
    if (p.row === "voice") {
      const all = (p.ids ?? []).map(
        (id): PickerItem => ({
          id,
          label: id,
          // One column, so a list whose voices all share a language drops it instead of repeating it.
          cols: [voiceNote(this.speech.languageOf(s.speechModel, id))],
          current: id === s.voice,
        }),
      );
      return matchItems(all, p.edit.value, (i) => i.id);
    }
    const current = p.row === "speechModel" ? s.speechModel : s.transcriptionModel;
    const options = this.modelOptions({ ...p, row: p.row });
    const shown = p.show === "all" ? options : options.filter((m) => m.features?.includes(p.show));
    const kind = kindOf(p.row);
    const items = [...shown].sort(MODEL_ORDER[s.modelSort]).map((m): PickerItem => {
      const note = m.id === XAI_MODEL ? "xAI login" : featureLine(m);
      const cols = m.id === XAI_MODEL ? ["xAI login"] : modelColumns(kind, m);
      return {
        id: m.id,
        label: modelLabel(m.id),
        price: priceOf(m),
        ...(note ? { note } : {}),
        cols,
        current: m.id === current,
      };
    });
    // Typing finds a model by its name, its id, or what it offers (tags, fast, …).
    return matchItems(items, p.edit.value, (i) => `${i.label === i.id ? i.id : `${i.label} ${i.id}`} ${i.note ?? ""}`);
  }

  private pickerView(p: PickerState): PickerView {
    const items = this.pickerItems(p);
    const selected = Math.max(0, Math.min(p.selected, items.length - 1));
    const none =
      p.row === "history"
        ? "Nothing spoken yet"
        : p.row === "voice" && this.speech.settings.speechModel === XAI_MODEL
          ? "xAI lists no voices"
          : "None offered";
    const view: PickerView = {
      title: LABEL_OF[p.row],
      noun: p.row === "voice" ? "voices" : p.row === "history" ? "messages" : "models",
      query: p.edit.value,
      cursor: p.edit.cursor,
      items,
      selected,
      total: p.ids?.length ?? 0,
      loading: !p.ids,
      empty: p.ids?.length === 0 ? none : "No matches",
    };
    if (isModelRow(p.row)) {
      const id = items[selected]?.id;
      const m = this.modelOptions({ ...p, row: p.row }).find((x) => x.id === id);
      view.sort = this.speech.settings.modelSort;
      view.show = p.show;
      view.detail =
        id === XAI_MODEL ? "Speech through your xAI login in Pi; xAI publishes no price." : (m?.description ?? "");
    }
    return view;
  }

  /** Whether the speech model takes inline delivery tags, as far as its catalog entry says. */
  private takesTags(): boolean {
    const id = this.speech.settings.speechModel;
    return this.models?.tts.find((m) => m.id === id)?.features?.includes("tags") === true;
  }

  private hints(): Hint[] {
    const esc = (action: string): Hint => ({ key: "Esc", action });
    const m = this.mode;
    if (m.kind === "input") {
      const action = m.purpose === "speak" ? "speak" : m.purpose === "transcribe" ? "transcribe" : "set";
      return [{ key: "Enter", action }, esc(m.purpose === "speak" && m.standalone ? "close" : "back")];
    }
    if (m.kind === "picker") {
      const p = m.picker;
      if (!p.ids) return [esc("back")];
      const sorting: Hint[] = isModelRow(p.row)
        ? [
            { key: "Tab", action: "sort", optional: true },
            { key: "Shift+Tab", action: "show", optional: true },
          ]
        : [];
      if (this.pickerItems(p).length === 0) {
        return p.edit.value ? [{ key: "Backspace", action: "" }, ...sorting, esc("back")] : [...sorting, esc("back")];
      }
      return [
        { key: "Enter", action: p.row === "history" ? "replay" : "pick" },
        ...(p.row === "voice" ? this.voiceKeys() : sorting),
        { key: "type", action: "to filter" },
        esc("back"),
      ];
    }
    const close = esc("close");
    const others: Hint = { key: "←→", action: "more", optional: true };
    switch (ROWS[this.selected].id) {
      case "speak":
        return [{ key: "Enter", action: "type messages to speak" }, others, close];
      case "replay":
        return [{ key: "Enter", action: "play the last message again" }, others, close];
      case "history":
        return [{ key: "Enter", action: "replay an earlier message" }, others, close];
      case "stop":
        return [{ key: "Enter", action: "stop what is playing" }, others, close];
      case "dictate":
        return [{ key: "Enter", action: "record, then insert the text" }, others, close];
      case "transcribe":
        return [{ key: "Enter", action: "insert the text of an audio file" }, others, close];
      case "voice":
        return [{ key: "Enter", action: "choose" }, ...this.voiceKeys(), close];
      case "speechModel":
      case "transcription":
        return [{ key: "Enter", action: "browse, sort and filter" }, close];
      case "language":
      case "output":
        return [{ key: "Enter", action: "set" }, close];
      case "audio":
        return [{ key: "←→", action: AUDIO_MODES.map((mode) => AUDIO_WORDS[mode]).join(" · ") }, close];
      default:
        return [{ key: "←→", action: "on/off" }, close];
    }
  }

  private voiceKeys(): Hint[] {
    return [
      { key: "Tab", action: "sample", optional: true },
      { key: "F2", action: "language", optional: true },
    ];
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  /** One key. Never throws: a failure becomes the status line. */
  handle(k: PanelKey): void {
    try {
      if ("text" in k) this.text(k.text, k.paste === true);
      else this.named(k.key);
    } catch (err) {
      this.setStatus("error", `✗ ${errorMessage(err)}`);
    }
    this.changed();
  }

  private named(key: NamedKey): void {
    if (key === "dictate") {
      this.dictate();
      return;
    }
    if (key === "speak") {
      // Alt+S: the composer from anywhere; in the composer it changes nothing.
      if (this.mode.kind !== "input" || this.mode.purpose !== "speak") this.openSpeaker();
      return;
    }
    const m = this.mode;
    if (m.kind === "input") {
      if (key === "enter") this.submit(m);
      else if (key === "escape") {
        if (m.purpose === "speak" && m.standalone) this.deps.close();
        else this.mode = m.back;
      } else m.edit.edit(key);
      return;
    }
    if (m.kind === "picker") {
      const p = m.picker;
      const items = this.pickerItems(p);
      const n = items.length;
      const highlighted = items[Math.min(p.selected, n - 1)];
      if (key === "up" || key === "down") {
        if (n) p.selected = (Math.min(p.selected, n - 1) + (key === "up" ? n - 1 : 1)) % n;
      } else if (key === "enter") this.pick(p);
      else if (key === "escape") this.mode = { kind: "list" };
      else if (key === "tab") {
        if (p.row === "voice" && highlighted) this.sample(highlighted.id);
        else if (isModelRow(p.row)) this.nextSort(p);
      } else if (key === "backtab") {
        if (isModelRow(p.row)) this.nextShow({ ...p, row: p.row }, p);
      } else if (key === "language") {
        if (p.row === "voice" && highlighted) this.askLanguage(highlighted.id);
      } else {
        const before = p.edit.value;
        p.edit.edit(key);
        if (p.edit.value !== before) p.selected = 0;
      }
      return;
    }
    const id = ROWS[this.selected].id;
    switch (key) {
      case "up":
      case "down": {
        // Line by line; a toolbar is entered at the column it was left at.
        const at = LINES.findIndex((line) => line.includes(this.selected));
        const line = LINES[(at + (key === "up" ? LINES.length - 1 : 1)) % LINES.length];
        this.selected = line[Math.min(this.col, line.length - 1)];
        return;
      }
      case "left":
      case "right": {
        const line = LINES.find((l) => l.includes(this.selected)) ?? [this.selected];
        if (line.length === 1) {
          this.step(id, key === "left" ? -1 : 1);
          return;
        }
        this.col = (line.indexOf(this.selected) + (key === "left" ? line.length - 1 : 1)) % line.length;
        this.selected = line[this.col];
        return;
      }
      case "enter":
        this.activate(id);
        return;
      case "tab":
        if (id === "voice") this.sample(this.speech.settings.voice);
        return;
      case "language":
        if (id === "voice") this.askLanguage(this.speech.settings.voice);
        return;
      case "escape":
        this.deps.close();
        return;
    }
  }

  /** Typed text: into an input or a picker's filter; on a picker row it opens the picker with it typed. */
  private text(text: string, paste: boolean): void {
    const m = this.mode;
    if (m.kind === "input") {
      m.edit.insert(text);
      return;
    }
    if (m.kind === "picker") {
      m.picker.edit.insert(text);
      m.picker.selected = 0;
      return;
    }
    const id = ROWS[this.selected].id;
    if (isPickerRow(id)) {
      this.openPicker(id, text);
      return;
    }
    if (paste) return;
    // The keys of the actions; on the other rows typing does nothing.
    const ch = [...text][0];
    if (ch === "s") this.stop();
    else if (ch === "r") this.replay();
    else if (ch === "h") this.openPicker("history");
    else if (ch === "t") this.ask("transcribe");
  }

  /** Ask for the file to transcribe, or the dictation language, on the line under its row. */
  private ask(purpose: "transcribe" | "dictation"): void {
    this.mode = { kind: "input", purpose, edit: new LineEdit(), back: { kind: "list" } };
  }

  private activate(id: RowId): void {
    switch (id) {
      case "speak":
        this.openSpeaker();
        return;
      case "stop":
        this.stop();
        return;
      case "replay":
        this.replay();
        return;
      case "dictate":
        this.dictate();
        return;
      case "transcribe":
        this.ask("transcribe");
        return;
      case "language":
        this.ask("dictation");
        return;
      case "output":
        this.askOutput();
        return;
      case "history":
      case "speechModel":
      case "transcription":
      case "voice":
        this.openPicker(id);
        return;
      default:
        this.step(id, 1);
        return;
    }
  }

  // ── Changes, through the engine's operations ────────────────────────────

  /** ←→ on a setting: toggle, or step through the audio modes. Picker rows have long lists: nothing. */
  private step(id: RowId, dir: 1 | -1): void {
    if (id === "readAloud") {
      const on = !this.engine.readAloud.enabled;
      this.engine.readAloud.enabled = on;
      this.setStatus("success", `✓ Read replies aloud: ${onOff(on)}`);
    } else if (id === "tools") {
      const on = this.shown("tools") !== "on";
      this.change("tools", onOff(on), async () => `✓ ${await this.engine.setTools(on)}`);
    } else if (id === "audio") {
      const i = AUDIO_MODES.findIndex((m) => AUDIO_WORDS[m] === this.shown("audio"));
      const next = AUDIO_MODES[(i + dir + AUDIO_MODES.length) % AUDIO_MODES.length];
      this.change("audio", AUDIO_WORDS[next], async () => {
        const notice = await this.engine.setBridge(next);
        await this.probe();
        return notice.level === "info" ? `✓ ${notice.message}` : { tone: "error", text: `✗ ${notice.message}` };
      });
    }
  }

  /** Show `value` in the row at once, save it in turn (changes run one after another), then report. */
  private change(id: RowId, value: string, op: () => Promise<string | Status>): void {
    this.pending.set(id, value);
    const run = this.queue.then(async () => {
      try {
        const r = await op();
        if (typeof r === "string") this.setStatus("success", r);
        else this.setStatus(r.tone, r.text);
      } catch (err) {
        this.setStatus("error", `✗ ${errorMessage(err)}`);
      } finally {
        if (this.pending.get(id) === value) this.pending.delete(id);
      }
    });
    this.queue = run;
    this.track(run);
  }

  private pick(p: PickerState): void {
    const item = this.pickerItems(p)[p.selected];
    if (!item) return;
    const row = p.row;
    if (row === "history") {
      // The list stays open: several messages can be replayed one after another.
      this.replayFile(item.id);
      return;
    }
    this.mode = { kind: "list" };
    this.change(row, item.id, async () => {
      const summary = await this.speech.set(SETTING_OF[row], item.id);
      if (row === "speechModel") this.track(this.loadVoices());
      return `✓ ${summary}`;
    });
  }

  /** Tab in a model list: the next order, saved for the next time. */
  private nextSort(p: PickerState): void {
    const sorts = MODEL_SORTS;
    this.speech.setModelSort(sorts[(sorts.indexOf(this.speech.settings.modelSort) + 1) % sorts.length]);
    p.selected = 0;
  }

  /** Shift+Tab in a model list: show only the models with the next feature that any of them has, then all. */
  private nextShow(models: PickerState & { row: "speechModel" | "transcription" }, p: PickerState): void {
    const offered = this.modelOptions(models);
    const shows = ["all", ...FEATURES[kindOf(models.row)].filter((f) => offered.some((m) => m.features?.includes(f)))];
    p.show = shows[(shows.indexOf(p.show) + 1) % shows.length];
    p.selected = 0;
  }

  /** Open a picker, with `typed` already in its filter; the selection starts at the top. */
  private openPicker(row: PickerRow, typed = ""): void {
    const p: PickerState = { row, edit: new LineEdit(typed), selected: 0, show: "all" };
    this.mode = { kind: "picker", picker: p };
    if (row === "history") {
      p.messages = this.speech.messages();
      p.ids = p.messages.map((m) => m.file);
      return;
    }
    const kind = row === "speechModel" ? "tts" : "stt";
    const ids = row === "voice" ? this.currentVoices() : this.models?.[kind].map((m) => m.id);
    if (ids) {
      p.ids = ids;
      return;
    }
    const load = row === "voice" ? this.loadVoices() : this.loadModels().then((c) => c[kind].map((m) => m.id));
    this.track(
      load.then(
        (loaded) => {
          p.ids = loaded;
        },
        (err) => {
          if (this.mode.kind === "picker" && this.mode.picker === p) this.mode = { kind: "list" };
          this.setStatus("error", `✗ ${errorMessage(err)}`);
        },
      ),
    );
  }

  private askLanguage(voice: string): void {
    this.mode = { kind: "input", purpose: "language", voice, edit: new LineEdit(), back: this.mode };
  }

  private askOutput(): void {
    this.mode = {
      kind: "input",
      purpose: "output",
      edit: new LineEdit(this.speech.settings.dictationOutput ?? ""),
      back: { kind: "list" },
    };
  }

  private submit(m: Extract<Mode, { kind: "input" }>): void {
    if (m.purpose === "output") {
      // Empty clears it back to Pi, so the empty guard below must not apply here.
      this.track(
        this.speech.set("dictation-output", m.edit.value.trim()).then(
          (summary) => {
            if (this.mode === m) this.mode = m.back;
            this.setStatus("success", `✓ ${summary}`);
          },
          (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
        ),
      );
      return;
    }
    const text = m.edit.value.trim();
    if (!text) return;
    if (m.purpose === "speak") {
      m.edit.clear();
      this.speakText(text);
      return;
    }
    if (m.purpose === "transcribe") {
      this.transcribe(text, m);
      return;
    }
    if (m.purpose === "dictation") {
      this.track(
        this.speech.set("stt-language", text).then(
          (summary) => {
            if (this.mode === m) this.mode = m.back;
            this.setStatus("success", `✓ ${summary}`);
          },
          (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
        ),
      );
      return;
    }
    if (m.purpose !== "language") return;
    this.track(
      this.speech.setLanguage(m.voice, text).then(
        (summary) => {
          if (this.mode === m) this.mode = m.back;
          this.setStatus("success", `✓ ${summary}`);
        },
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  /** Speak… in the panel: ♪ speaking… while it is synthesized and plays, then ✓ Spoken, or what failed. */
  private speakText(text: string): void {
    const seq = ++this.playSeq;
    const busy = this.setStatus("busy", "♪ speaking…");
    this.track(
      this.speech.say(text).then(
        (r) => {
          if (seq !== this.playSeq) return;
          if (r.stopped) this.setStatus("info", "Stopped");
          else if (r.player) this.playing(busy);
          else this.setStatus("warning", `! Saved, but not played: ${r.notPlayed ?? "unknown reason"}`);
        },
        (err) => {
          if (seq === this.playSeq) this.setStatus("error", `✗ ${speakError(err)}`);
        },
      ),
    );
  }

  /**
   * Transcribe file…: the transcript goes into the editor, so the panel closes once it is there. A failure
   * stays in the panel, with the path still in the field.
   */
  private transcribe(path: string, m: Mode): void {
    if (this.transcribing) return;
    this.transcribing = true;
    this.setStatus("busy", `… transcribing ${basename(path)}`);
    const language = this.speech.settings.dictationLanguage;
    this.track(
      this.speech
        .transcribeFile(path, { cwd: this.deps.ui.cwd, language })
        .then((text) => {
          const transcript = text.trim();
          if (!transcript) throw new Error("no speech was recognized in the audio file");
          if (this.mode === m) this.deps.close();
          this.deps.ui.paste(transcript);
        })
        .catch((err) => this.setStatus("error", `✗ ${errorMessage(err)}`))
        .finally(() => {
          this.transcribing = false;
        }),
    );
  }

  /** A message of the history: the same lines as Speak…. */
  private replayFile(file: string): void {
    const seq = ++this.playSeq;
    const busy = this.setStatus("busy", "♪ speaking…");
    this.track(
      this.engine.player.play(file, "message").then(
        (started) => {
          if (seq !== this.playSeq) return;
          if (started.ok) this.playing(busy);
          else this.setStatus("error", `✗ Replay did not start: ${started.reason}`);
        },
        (err) => {
          if (seq === this.playSeq) this.setStatus("error", `✗ ${errorMessage(err)}`);
        },
      ),
    );
  }

  /** Replay last in the panel: the same lines as Speak…; a refusal says why. */
  private replay(): void {
    const seq = ++this.playSeq;
    const busy = this.setStatus("busy", "♪ speaking…");
    const quiet: SurfaceUi = { ...this.deps.ui, notify: () => {} };
    this.track(
      this.surface.replay(quiet).then(
        () => {
          if (seq === this.playSeq) this.playing(busy);
        },
        (err) => {
          if (seq === this.playSeq) this.setStatus("error", `✗ ${errorMessage(err)}`);
        },
      ),
    );
  }

  /** The playback of `line` started: it becomes ✓ Spoken once nothing plays (unless something replaced it). */
  private playing(line: Status): void {
    this.speaking = line;
    this.spoken();
  }

  private spoken(): void {
    const line = this.speaking;
    if (!line || this.engine.player.playing) return;
    this.speaking = undefined;
    if (this.status === line) this.setStatus("success", "✓ Spoken");
  }

  private stop(): void {
    this.playSeq++;
    this.speaking = undefined;
    this.track(
      this.engine.player
        .stop()
        .then((was) => (was ? this.setStatus("success", "✓ Stopped") : this.setStatus("info", "Nothing was playing"))),
    );
  }

  /** Dictate closes the panel and toggles dictation exactly like Alt+Z (which needs the editor). */
  private dictate(): void {
    this.deps.close();
    void this.engine.dictation.toggle(this.deps.ui).catch((err) => this.deps.ui.notify(errorMessage(err), "error"));
  }

  /** A sample of `voice` (the `--sample` rules); a newer sample replaces the line of an older one. */
  private sample(voice: string): void {
    const seq = ++this.sampleSeq;
    this.setStatus("busy", `♪ sampling ${voice}…`);
    const mine = () => seq === this.sampleSeq;
    this.track(
      this.speech.sample(voice).then(
        (r) => {
          if (!mine()) return;
          if (r.player) this.setStatus("success", sampleLine(r));
          else if (r.notPlayed === REPLACED) this.setStatus("info", `Sample of ${voice} replaced`);
          else this.setStatus("error", `✗ Sample not played: ${r.notPlayed ?? "unknown reason"}`);
        },
        (err) => {
          if (mine()) this.setStatus("error", `✗ ${errorMessage(err)}`);
        },
      ),
    );
  }

  // ── Loading ─────────────────────────────────────────────────────────────

  private loadModels(): Promise<SpeechCatalog> {
    this.modelsLoad ??= this.speech.models().then(
      (c) => {
        this.models = c;
        this.modelsError = undefined;
        return c;
      },
      (err) => {
        // The next picker opening tries again.
        this.modelsLoad = undefined;
        this.modelsError = errorMessage(err);
        throw err;
      },
    );
    return this.modelsLoad;
  }

  private currentVoices(): string[] | undefined {
    const v = this.voices;
    return v?.model === this.speech.settings.speechModel ? v.ids : undefined;
  }

  /** The voices of the current speech model (for xai the xAI voice list, which also gives the languages). */
  private loadVoices(): Promise<string[]> {
    const model = this.speech.settings.speechModel;
    if (this.voices?.model === model && !this.voices.error) return this.voices.load;
    const entry: NonNullable<Panel["voices"]> = {
      model,
      load: this.speech.voicesFor(model).then(
        (ids) => {
          entry.ids = ids;
          return ids;
        },
        (err) => {
          entry.error = errorMessage(err);
          throw err;
        },
      ),
    };
    this.voices = entry;
    return entry.load;
  }

  /** Check the receiver when the route is the bridge. */
  private probe(): Promise<void> {
    const seq = ++this.probeSeq;
    if (this.engine.routes.route !== "bridge") {
      this.receiver = undefined;
      return Promise.resolve();
    }
    this.receiver = "checking";
    const done = this.engine.routes.bridge.health().then(
      (h) => {
        if (seq === this.probeSeq) this.receiver = h;
      },
      (err) => {
        if (seq === this.probeSeq) this.receiver = { ok: false, reason: errorMessage(err) };
      },
    );
    this.track(done);
    return done;
  }

  // ── Plumbing ────────────────────────────────────────────────────────────

  private setStatus(tone: StatusTone, text: string): Status {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    const status = { tone, text: oneLine(text) };
    this.status = status;
    if (tone === "success") {
      this.statusTimer = setTimeout(() => {
        if (this.status === status) this.status = undefined;
        this.changed();
      }, this.deps.successMs ?? 4000);
      this.statusTimer.unref?.();
    }
    return status;
  }

  /** Follow an operation: redraw when it settles; its failure is already reported (or deliberately ignored). */
  private track(p: Promise<unknown>): void {
    const tracked = p.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(tracked);
    void tracked.then(() => {
      this.inflight.delete(tracked);
      this.changed();
    });
  }

  private changed(): void {
    if (this.disposed) return;
    try {
      this.deps.changed();
    } catch {
      /* the UI is gone */
    }
  }
}
