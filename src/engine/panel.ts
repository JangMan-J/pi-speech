/**
 * The /speech settings panel, Pi-free: a plain view model of the panel (rows, values, live state, the key
 * hints for the current focus) built from engine state, and what each key does. Every change goes through
 * Engine / Speech / ReceiverControl operations; the Pi adapter draws the view model and feeds the keys.
 *
 * Seven tabs organize Main, Read aloud, models, Voice, Hotkeys and Receivers; a model or a voice shows only its
 * name there (prices, features and languages are in the pickers). Mode-locked settings stay in place as dimmed
 * read-only rows naming why; topology-bound routing rows appear in Receivers only while a bridge is active.
 */

import {
  COMMANDS_EDITOR_HEADER,
  formatEditorPrefill,
  parseVocabulary,
  parseVoiceCommands,
  stripEditorComments,
  VOCAB_EDITOR_HEADER,
} from "./dictation-rules";
import type { DownloadChange } from "./downloads";
import type { Engine } from "./engine";
import { errorMessage } from "./env";
import { inlineTags } from "./features";
import type { HistoryMessage } from "./history";
import {
  canLiveDictate,
  type DownloadProgress,
  formatSize,
  isLiveCapableLocalStt,
  isSingleVoicePiper,
  type LocalModel,
  localSttLanguage,
  PIPER_EN_FAMILY,
  piperVoiceLabel,
} from "./local-models";
import {
  buildPickerItems,
  buildPickerView,
  directionOf,
  isModelRow,
  isPricedModel,
  kindOf,
  localModelIds,
  matchItems,
  modelOptionsFor,
  type PickerColumn,
  type PickerContext,
  type PickerItem,
  type PickerRow,
  type PickerView,
  SAME_MODEL,
  SAME_MODEL_LABEL,
  voiceNote,
  XAI_LABEL,
} from "./panel-pickers";
import { REPLACED } from "./player";
import type { SpeechCatalog } from "./provider";
import {
  LENGTH_SECONDS,
  READ_MODES,
  type ReadMode,
  SUMMARY_LENGTHS,
  type SummaryLength,
  TRUNCATE_SECONDS,
} from "./read-aloud";
import { ReadingFailed, readingFailedMessage } from "./reading";
import { hostPort, pairingFault, type ReceiverNotice, type ReceiverSshAction } from "./receiver-control";
import type { RemotePrompts } from "./remote";
import {
  type BridgeMode,
  DIRECTIONS,
  type DirectionSetting,
  type Hotkeys,
  hotkeyId,
  keyLabel,
  LOCAL_MODEL_SORTS,
  MACHINES,
  type Machine,
  MODEL_SORTS,
  OSD_STYLES,
  type OsdStyle,
  pttHotkeyId,
  SOURCES,
  type Source,
} from "./settings";
import { type Direction, languageLabel, type SampleResult, type SettingName } from "./speech";
import type { Surface, SurfaceUi } from "./surface";

export { matchItems, type PickerColumn, type PickerItem, type PickerView, voiceNote, XAI_LABEL };

export type RowId =
  // The main view
  | "readAloud"
  | "speechSource"
  | "speechModel"
  | "voice"
  | "transcriptionSource"
  | "transcription"
  | "dictation"
  | "hotkeys"
  | "bridge"
  | "osdStyle"
  // Dictation options
  | "dictationLive"
  | "language"
  | "dictationSubmitWord"
  | "dictationVocabulary"
  | "dictationCommands"
  | "dictationRedirect"
  // Hotkeys: the actions
  | "speak"
  | "dictate"
  | "ptt"
  // Receivers
  | "bridgeMode"
  | "device"
  | "pairing"
  | "receiver"
  | "remoteReceiver"
  // Manage over SSH
  | "receiverSshHost"
  | "receiverSshUpdate"
  | "receiverSshRestart"
  // Receivers, DIRECTION
  | "playOn"
  | "recordOn"
  | "modelsOn"
  // Read aloud options
  | "readMode"
  | "summarizer"
  | "summaryLength"
  | "truncate";

/** What the panel shows: the main view, or one of its submenus. */
export type MenuId = "main" | MenuMode["menu"];

/** The panel's tabs, in order; Tab and Shift+Tab step through them. */
export type TabId = "main" | "readAloud" | "speechModel" | "voice" | "transcription" | "hotkeys" | "bridge";
export const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "main", label: "Main" },
  { id: "readAloud", label: "Read aloud" },
  { id: "speechModel", label: "Speech model" },
  { id: "voice", label: "Voice" },
  { id: "transcription", label: "Transcription model" },
  { id: "hotkeys", label: "Hotkeys" },
  { id: "bridge", label: "Receivers" },
];

/**
 * The panel's keys, as pi-tui key ids. sort, detail, pageUp and pageDown are KEYS of src/pi/frame.ts, written out
 * because the engine imports nothing of Pi (test/pi checks they match); the rest are the panel's own.
 */
export const PANEL_KEYS = {
  sort: ["ctrl+s"],
  detail: ["ctrl+d"],
  pageUp: ["shift+up", "pageUp"],
  pageDown: ["shift+down", "pageDown"],
  sample: ["ctrl+p"],
  replay: ["ctrl+o"],
  history: ["ctrl+l"],
  stop: ["ctrl+n"],
  transcribe: ["ctrl+t"],
  download: ["ctrl+o"],
  toggleSource: ["ctrl+t"],
  delete: ["alt+o"],
  gpu: ["ctrl+g"],
  unpriced: ["f4"],
} as const;

export interface PanelRow {
  id: RowId;
  label: string;
  value?: string;
  note?: string;
  short?: string;
  alert?: boolean;
  disabled?: boolean;
  muted?: boolean;
  opens?: boolean;
}

export interface SpeakLine {
  value: string;
  cursor: number;
  placeholder: string;
  focused: boolean;
}

export interface InputView {
  label: string;
  value: string;
  cursor: number;
  placeholder: string;
  under?: RowId;
  secret?: boolean;
}

export type StatusTone = "success" | "error" | "warning" | "busy" | "info";

export interface Status {
  tone: StatusTone;
  text: string;
}

export interface Hint {
  key: string;
  action: string;
  optional?: boolean;
}

export interface PanelView {
  title: string;
  state: string;
  menu: MenuId;
  crumb?: string;
  tab: TabId;
  tabs: ReadonlyArray<{ id: TabId; label: string }>;
  keys: { speak: string; dictate: string };
  login?: { prompt: string; secret: boolean; confirm: boolean; value: string; cursor: number };
  rows: PanelRow[];
  selected: number;
  picker?: PickerView;
  input?: InputView;
  speak?: SpeakLine;
  status?: Status;
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
  | "backtab"
  | "speak"
  | "language"
  | "dictate";

export type PanelKey = { key: NamedKey; id?: string } | { text: string; paste?: boolean } | { combo: string };

export interface PanelDeps {
  ui: SurfaceUi;
  close(): void;
  changed(): void;
  successMs?: number;
  hotkeys?: Hotkeys;
  pairingMs?: number;
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

interface PickerState {
  row: PickerRow;
  ids?: string[];
  messages?: HistoryMessage[];
  edit: LineEdit;
  selected: number;
  local?: boolean;
  piper?: boolean;
}

type MenuMode = {
  kind: "menu";
  menu: "hotkeys" | "bridge" | "receiverSsh" | "readAloud" | "dictation";
  selected: number;
  capture?: HotkeyName;
  back?: MenuMode;
};
type HotkeyName = keyof Hotkeys;
type HostInput<P extends "connect" | "receiverSshHost"> = {
  kind: "input";
  purpose: P;
  edit: LineEdit;
  back: Mode;
  hosts: string[];
  next: number;
};

type Mode =
  | { kind: "list" }
  | MenuMode
  | { kind: "picker"; picker: PickerState; back: Mode }
  | { kind: "input"; purpose: "speak"; edit: LineEdit; back: Mode }
  | { kind: "input"; purpose: "language"; voice: string; edit: LineEdit; back: Mode }
  | { kind: "input"; purpose: "transcribe" | "dictation" | "submitWord"; edit: LineEdit; back: Mode }
  | { kind: "input"; purpose: "pairAddress"; edit: LineEdit; back: Mode }
  | { kind: "input"; purpose: "pairCode"; address: string; edit: LineEdit; back: Mode }
  | HostInput<"connect">
  | HostInput<"receiverSshHost">
  | {
      kind: "input";
      purpose: "secret";
      label: string;
      edit: LineEdit;
      back: Mode;
      resolve: (v: string | undefined) => void;
    }
  | { kind: "input"; purpose: "confirm"; question: string; edit: LineEdit; back: Mode; resolve: (v: boolean) => void };

type RowBase = Pick<PanelRow, "id" | "label" | "opens">;

const MAIN_IDS: RowId[] = [
  "readAloud",
  "speechSource",
  "speechModel",
  "voice",
  "transcriptionSource",
  "transcription",
  "dictation",
  "hotkeys",
  "bridge",
  "osdStyle",
];
const HOTKEY_IDS: RowId[] = ["speak", "dictate", "ptt"];
const BRIDGE_IDS: RowId[] = [
  "bridgeMode",
  "device",
  "pairing",
  "receiver",
  "remoteReceiver",
  "playOn",
  "recordOn",
  "modelsOn",
];
const READ_ALOUD_IDS: RowId[] = ["readMode", "summarizer", "summaryLength", "truncate"];
const DICTATION_IDS: RowId[] = [
  "dictationLive",
  "language",
  "dictationSubmitWord",
  "dictationVocabulary",
  "dictationCommands",
  "dictationRedirect",
];

const MENUS: Record<MenuMode["menu"], { title: string; ids: RowId[] }> = {
  hotkeys: { title: "Hotkeys", ids: HOTKEY_IDS },
  bridge: { title: "Receivers", ids: BRIDGE_IDS },
  receiverSsh: { title: "Manage over SSH", ids: ["receiverSshHost", "receiverSshUpdate", "receiverSshRestart"] },
  readAloud: { title: "Read aloud options", ids: READ_ALOUD_IDS },
  dictation: { title: "Dictation options", ids: DICTATION_IDS },
};

const MACHINE_WORDS: Record<Machine, string> = { this: "This machine", remote: "Remote machine" };
const isDirectionRow = (id: RowId): id is DirectionSetting => (DIRECTIONS as readonly RowId[]).includes(id);
const CONNECT_HINT = "ssh Host, user@host, or host:port";
const CONNECT_HOW = "Connect: ssh Host, user@host, or host:port";
const RECEIVER_SSH_HINT = "SSH Host, user@host, or ssh://user@host:port";
const PAIR_FIRST = "Pair first: enter host:port and press Enter; read the 6-digit code on the receiver.";
const PAIR_HOW = "host:port (empty: ssh forward) or Tailscale/LAN address of --network receiver";
const URL_FROM = "Address: Pairing setting, else PI_SPEECH_BRIDGE_URL, else ssh forward 127.0.0.1:47613";
const ADDRESS_HINT = "host:port · empty: ssh forward";
const CODE_HINT = "6-digit pairing code";
const LANGUAGE_HINT = "BCP-47 tag (ja, pt-BR) or auto";
const SUBMIT_WORD_HINT = "trailing trigger phrase · empty: Off";

const SUBMIT_MODES = ["off", "send it", "submit", "custom"] as const;
type SubmitMode = (typeof SUBMIT_MODES)[number];
function submitModeOf(word: string | undefined): SubmitMode {
  if (!word) return "off";
  const lower = word.toLowerCase();
  if (lower === "send it") return "send it";
  if (lower === "submit") return "submit";
  return "custom";
}

const MAIN_CHORD_HINTS: Array<{ key: string; action: string }> = [
  { key: keyLabel(PANEL_KEYS.replay[0]), action: "replay" },
  { key: keyLabel(PANEL_KEYS.history[0]), action: "history" },
  { key: keyLabel(PANEL_KEYS.stop[0]), action: "stop" },
  { key: keyLabel(PANEL_KEYS.transcribe[0]), action: "transcribe" },
];
const HOTKEY_NAMES: Record<HotkeyName, string> = { speak: "Speak", dictate: "Dictate", ptt: "Push-to-talk" };
const OSD_WORDS: Record<OsdStyle, string> = {
  line: "Lines",
  helix: "Helix",
  braille: "Braille",
  prism: "Prism",
  orb: "Orb",
  wave: "Waves",
  off: "Off",
};
const SETTING_OF: Record<"speechModel" | "transcription" | "voice", SettingName> = {
  speechModel: "tts-model",
  transcription: "stt-model",
  voice: "voice",
};
const BRIDGE_MODES: BridgeMode[] = ["auto", "on", "off"];
const SOURCE_WORDS: Record<Source, string> = { provider: "Provider", local: "Local" };
const READ_WORDS: Record<ReadMode, string> = { off: "Off", summary: "Summarized", streaming: "Streaming" };
const LENGTH_WORDS: Record<SummaryLength, string> = {
  minimum: "Minimum ~15 s",
  abridged: "Abridged ~30 s",
  full: "Full ~60 s",
};
const truncateWord = (s: number) => (s ? `${s} s` : "Off");
const READ_INFO: Record<ReadMode, string> = {
  off: "Off.",
  summary: "Speaks a summary when the reply ends.",
  streaming: "Speaks summaries of reasoning steps mid-run.",
};

function cycle<T>(list: readonly T[], current: T, dir: 1 | -1): T {
  const i = list.indexOf(current);
  return list[(Math.max(0, i) + dir + list.length) % list.length];
}
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function downloadLine(id: string, p: DownloadProgress): string {
  if (p.phase === "verifying") return `… verifying ${id}`;
  if (p.phase === "unpacking") return `… unpacking ${id}`;
  const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
  const what = p.file ? `${id}'s ${p.file}` : id;
  return `… downloading ${what} ${pct}% (${formatSize(p.done)} of ${formatSize(p.total)})`;
}

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

function speakError(err: unknown): string {
  return err instanceof ReadingFailed ? readingFailedMessage("Speech", "text", err.reason) : errorMessage(err);
}

interface RowSpec {
  label: string;
  opens?: boolean;
  cycles?: boolean;
  render(home: { kind: "list" } | MenuMode): Omit<PanelRow, "id" | "label" | "opens">;
  hints?(home: { kind: "list" } | MenuMode): Hint[];
  info?(): string;
  activate?(): void;
  step?(dir: 1 | -1): void;
}

export class Panel {
  private mode: Mode = { kind: "list" };
  private selected = 0;
  private readonly bound: Hotkeys;
  rebind = false;
  private transcribing = false;
  private status?: Status;
  private statusTimer?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<RowId, string>();
  private models?: SpeechCatalog;
  private modelsLoad?: Promise<SpeechCatalog>;
  private modelsError?: string;
  private voices?: { model: string; ids?: string[]; error?: string; load: Promise<string[]> };
  private pairTimer?: ReturnType<typeof setInterval>;
  private sampleSeq = 0;
  private playSeq = 0;
  private speaking?: Status;
  private queue: Promise<void> = Promise.resolve();
  private readonly inflight = new Set<Promise<unknown>>();
  private unlisten?: () => void;
  private disposed = false;
  private localModels?: LocalModel[];
  private localLoad?: Promise<LocalModel[]>;
  private localSeq = 0;
  private localApplied = 0;
  private localError?: string;
  private offer?: string;
  private deleting?: string;
  private unlistenDownloads?: () => void;
  private readonly speakEdit = new LineEdit();
  private pendingPrompt?: () => void;
  private receiverMaintenancePending = false;
  private piperSpeakers?: { model: string; ids: string[] };
  /** True while the user picked `piper-en` with no downloaded Piper voice yet (never persisted to settings). */
  private piperFamilyPending = false;
  private submitCustomActive = false;
  private rememberedSubmitCustom?: string;
  private readonly deps: PanelDeps;
  private readonly rowSpecs: Record<RowId, RowSpec>;

  constructor(
    private readonly engine: Engine,
    surfaceOrDeps: Surface | PanelDeps,
    maybeDeps?: PanelDeps,
  ) {
    this.deps = maybeDeps ?? (surfaceOrDeps as PanelDeps);
    this.bound = { ...(this.deps.hotkeys ?? engine.speech.settings.hotkeys) };
    this.rowSpecs = this.buildRowSpecs();
  }

  private get speech() {
    return this.engine.speech;
  }

  private get receivers() {
    return this.engine.receivers;
  }

  private downloadOf(id: string) {
    return this.engine.downloads.get(id);
  }

  open(): void {
    this.unlisten = this.engine.indicator.listen(() => {
      this.spoken();
      this.changed();
    });
    this.track(
      this.loadModels().then(() => {
        if (this.disposed) return;
        return this.speech.models({ refresh: true }).then(
          (c) => {
            if (this.disposed) return;
            this.models = c;
            this.modelsError = undefined;
            if (this.mode.kind === "picker" && !this.mode.picker.local && isModelRow(this.mode.picker.row)) {
              const kind = this.mode.picker.row === "speechModel" ? "tts" : "stt";
              this.mode.picker.ids = c[kind].map((m) => m.id);
            }
            this.changed();
          },
          () => {},
        );
      }),
    );
    this.track(this.loadVoices());
    const s = this.speech.settings;
    if (s.speechSource === "local" || s.transcriptionSource === "local") this.track(this.loadLocal());
    this.probe();
    this.track(this.receivers.refreshLocal(false));
    this.engine.onRemoteChange = this.remoteChanged;
    this.unlistenDownloads = this.engine.downloads.listen((c) => this.downloadChanged(c));
    const d = this.engine.downloads.active.values().next().value;
    if (d) this.setStatus("busy", d.progress ? downloadLine(d.id, d.progress) : `… downloading ${d.id}`);
  }

  private readonly remoteChanged = () => {
    void this.probe();
    this.changed();
  };

  private downloadChanged(change: DownloadChange): void {
    const end = change.end;
    if (!end) {
      const d = this.downloadOf(change.id);
      if (d?.progress) this.setStatus("busy", downloadLine(d.id, d.progress));
      this.changed();
      return;
    }
    if (end.status === "stopped") {
      this.setStatus("info", `Download of ${end.id} stopped; the next download goes on from there`);
    } else if (end.status === "failed") {
      this.setStatus("error", `✗ Download of ${end.id} failed: ${end.error}`);
    } else {
      this.setStatus("success", end.summary ? `✓ ${end.id} downloaded · ${end.summary}` : `✓ ${end.id} downloaded`);
      if (end.direction === "speech") this.piperFamilyPending = false;
      const openPicker = this.mode.kind === "picker" ? this.mode.picker : undefined;
      const highlightedId = openPicker ? this.pickerItems(openPicker)[openPicker.selected]?.id : undefined;
      const m = this.localModels?.find((x) => x.id === end.id);
      if (m) m.downloaded = true;
      if (openPicker && highlightedId) {
        const idx = this.pickerItems(openPicker).findIndex((x) => x.id === highlightedId);
        if (idx >= 0) openPicker.selected = idx;
      }
      if (end.direction === "speech") {
        this.voices = undefined;
        this.track(this.loadVoices());
      }
    }
    this.track(this.loadLocal(true));
    this.changed();
  }

  dispose(): void {
    this.disposed = true;
    this.unlisten?.();
    this.unlistenDownloads?.();
    this.pendingPrompt?.();
    if (this.engine.onRemoteChange === this.remoteChanged) this.engine.onRemoteChange = () => {};
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.stopPairing();
  }

  isCapturingHotkey(): boolean {
    return this.mode.kind === "menu" && this.mode.capture !== undefined;
  }

  inSpeakComposer(): boolean {
    return this.mode.kind === "input" && this.mode.purpose === "speak";
  }

  close(): void {
    if (this.hotkeysChanged()) this.rebind = true;
    this.deps.close();
  }

  dictateNow(): void {
    this.dictate();
  }

  openSpeaker(): void {
    this.mode = { kind: "input", purpose: "speak", edit: this.speakEdit, back: { kind: "list" } };
    this.changed();
  }

  private home(mode: Mode = this.mode): { kind: "list" } | MenuMode {
    return mode.kind === "list" || mode.kind === "menu" ? mode : this.home(mode.back);
  }

  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }

  report(message: string, level: "info" | "warning" | "error"): void {
    const symbol = level === "error" ? "✗ " : level === "warning" ? "! " : "";
    this.setStatus(level, `${symbol}${message}`);
    this.changed();
  }

  // ── Declarative row descriptors ─────────────────────────────────────────

  private buildRowSpecs(): Record<RowId, RowSpec> {
    const s = () => this.speech.settings;
    const val = (id: RowId, actual: string) => this.pending.get(id) ?? actual;
    const directionSpec = (id: DirectionSetting, label: string): RowSpec => ({
      label,
      cycles: true,
      render: () =>
        this.engine.routes.route !== "bridge"
          ? { value: MACHINE_WORDS.this, note: "no bridge in use" }
          : { value: val(id, MACHINE_WORDS[s()[id]]) },
      hints: () => [{ key: "← →", action: "Selects" }],
      step: (dir) => {
        try {
          const notice = this.engine.setDirection(id, cycle(MACHINES, s()[id], dir));
          this.setStatus(
            notice.level === "info" ? "success" : "warning",
            `${notice.level === "info" ? "✓" : "!"} ${notice.message}`,
          );
        } catch (err) {
          this.setStatus("info", errorMessage(err));
          return;
        }
        if (id === "modelsOn") this.reloadLocalAfterRouteChange();
      },
    });
    const hotkeySpec = (name: HotkeyName, label: string, run: () => void): RowSpec => ({
      label,
      render: (home) => this.hotkeyValue(name, home),
      hints: () => {
        if (name === "ptt") {
          const clear: Hint[] = s().hotkeys.ptt ? [{ key: "Backspace", action: "clear" }] : [];
          return [{ key: "k", action: "set key" }, ...clear];
        }
        return [
          { key: "Enter", action: "run" },
          { key: "k", action: "change key" },
        ];
      },
      activate: run,
    });

    return {
      readAloud: {
        label: "Read aloud options",
        opens: true,
        render: () => ({ value: READ_WORDS[this.engine.readAloud.mode] }),
        hints: () => [{ key: "Enter", action: "options" }],
        activate: () => {
          this.mode = { kind: "menu", menu: "readAloud", selected: 0 };
        },
      },
      speechSource: {
        label: "Speech source",
        cycles: true,
        render: () => ({ value: val("speechSource", SOURCE_WORDS[s().speechSource]) }),
        hints: () => [{ key: "← →", action: "Selects" }],
        step: (dir) => this.stepSource("speech", dir),
      },
      speechModel: {
        label: "Speech model",
        opens: true,
        render: () => {
          if (s().speechSource === "local") {
            if (this.piperFamilyPending || isSingleVoicePiper(s().localSpeechModel)) {
              const id = this.piperFamilyPending ? undefined : s().localSpeechModel;
              const alert = id ? this.localRow(id) : { note: "✗ choose a voice", alert: true };
              return { ...alert, value: PIPER_EN_FAMILY };
            }
            return this.localRow(s().localSpeechModel);
          }
          const v = val("speechModel", s().speechModel);
          return { value: this.speech.modelLabel(v), ...this.modelAlert("tts", v) };
        },
        hints: () => [{ key: "Enter", action: "browse" }],
        activate: () => this.openPicker("speechModel"),
      },
      voice: {
        label: "Voice",
        opens: true,
        render: () => {
          const lock = this.voiceLock();
          if (lock) return { value: lock.value, note: lock.note, disabled: true };
          if (s().speechSource === "local") {
            if (this.piperFamilyPending) return { value: "none", note: "✗ choose a voice", alert: true };
            if (isSingleVoicePiper(s().localSpeechModel)) {
              const baseName = piperVoiceLabel(s().localSpeechModel!);
              return { value: s().localSpeechVoice ? `${baseName} · ${s().localSpeechVoice}` : baseName };
            }
            return { value: val("voice", s().localSpeechVoice ?? "default"), ...this.voiceAlert() };
          }
          return { value: val("voice", s().voice), ...this.voiceAlert() };
        },
        hints: () => {
          const lock = this.voiceLock();
          if (lock) return lock.canSample ? this.voiceKeys() : [];
          return [{ key: "Enter", action: "choose" }, ...this.voiceKeys()];
        },
        activate: () => {
          const lock = this.voiceLock();
          if (lock) this.setStatus("info", lock.info);
          else this.openPicker("voice");
        },
        step: (dir) => {
          if (s().speechSource === "local" && isSingleVoicePiper(s().localSpeechModel)) {
            const ps = this.piperSpeakers;
            const speakers = ps && ps.model === s().localSpeechModel ? ps.ids : undefined;
            if (speakers && speakers.length > 1) {
              const cur = s().localSpeechVoice ?? speakers[0]!;
              const next = cycle(speakers, cur, dir);
              this.change("voice", next, async () => `✓ ${await this.speech.setLocalVoice(next)}`);
            }
          }
        },
      },
      transcriptionSource: {
        label: "Transcription source",
        cycles: true,
        render: () => ({ value: val("transcriptionSource", SOURCE_WORDS[s().transcriptionSource]) }),
        hints: () => [{ key: "← →", action: "Selects" }],
        step: (dir) => this.stepSource("transcription", dir),
      },
      transcription: {
        label: "Transcription model",
        opens: true,
        render: () => {
          if (s().transcriptionSource === "local") return this.localRow(s().localTranscriptionModel);
          const v = val("transcription", s().transcriptionModel);
          return { value: this.speech.modelLabel(v), ...this.modelAlert("stt", v) };
        },
        hints: () => [{ key: "Enter", action: "browse" }],
        activate: () => this.openPicker("transcription"),
      },
      dictation: {
        label: "Dictation options",
        opens: true,
        render: () => {
          const live = s().transcriptionSource === "local" && Boolean(s().dictationLive);
          return { value: live ? "Typed" : "Filled", note: this.effectiveDictationLanguage() };
        },
        hints: () => [{ key: "Enter", action: "options" }],
        activate: () => {
          this.mode = { kind: "menu", menu: "dictation", selected: 0 };
        },
      },
      hotkeys: {
        label: "Hotkeys",
        opens: true,
        render: () => {
          const hk = s().hotkeys;
          return {
            value: `${keyLabel(hk.speak)} · ${keyLabel(hk.dictate)}`,
            ...(hk.ptt ? { note: `PTT ${keyLabel(hk.ptt)}`, short: keyLabel(hk.ptt) } : {}),
          };
        },
        hints: () => [{ key: "Enter", action: "keys" }],
        activate: () => {
          this.mode = { kind: "menu", menu: "hotkeys", selected: 0 };
        },
      },
      bridge: {
        label: "Receivers",
        opens: true,
        render: () => this.connectionValue(),
        hints: () => [{ key: "Enter", action: "receivers" }],
        activate: () => {
          this.mode = { kind: "menu", menu: "bridge", selected: 0 };
          this.probe();
          this.startPairing();
          this.track(this.receivers.refreshLocal(true));
        },
      },
      osdStyle: {
        label: "Spectrum OSD",
        cycles: true,
        render: () => ({ value: val("osdStyle", OSD_WORDS[s().osdStyle]) }),
        hints: () => [{ key: "← →", action: "Selects" }],
        step: (dir) => {
          const next = cycle(OSD_STYLES, s().osdStyle, dir);
          this.speech.setOsdStyle(next);
          this.setStatus("success", `✓ Spectrum OSD: ${OSD_WORDS[next]}`);
        },
      },
      // Dictation options
      dictationLive: {
        label: "Output",
        cycles: true,
        render: () => {
          if (s().transcriptionSource !== "local") {
            return {
              value: "Filled",
              note: "Typed requires Local transcription",
              short: "Local STT only",
              disabled: true,
            };
          }
          if (!s().dictationLive) return { value: "Filled" };
          if (!canLiveDictate(s())) return { value: "Typed", note: "choose a local transcription model" };
          const entry = this.localModels?.find((m) => m.id === s().localTranscriptionModel);
          return isLiveCapableLocalStt(entry ?? s().localTranscriptionModel, s().localDevice)
            ? { value: "Typed" }
            : { value: "Typed", note: "chunked; may lag on CPU" };
        },
        hints: () => (s().transcriptionSource === "local" ? [{ key: "← →", action: "Selects" }] : []),
        info: () =>
          s().transcriptionSource === "local"
            ? "Typed: streams into editor. Filled: inserts on stop."
            : "Typed streams into the editor and requires Transcription source: Local.",
        step: () => {
          if (s().transcriptionSource !== "local") {
            this.setStatus("info", "Typed output requires Transcription source: Local");
            return;
          }
          const next = !s().dictationLive;
          this.speech.setDictationLive(next);
          this.setStatus("success", `✓ Dictation output: ${next ? "Typed" : "Filled"}`);
        },
      },
      language: {
        label: "Language",
        render: () => {
          const lock = this.languageLock();
          if (lock) return { value: lock.value, note: lock.note, disabled: true };
          return { value: val("language", s().dictationLanguage ?? "auto") };
        },
        hints: () => (this.languageLock() ? [] : [{ key: "Enter", action: "set" }]),
        info: () => {
          const lock = this.languageLock();
          return lock ? `${lock.info}.` : "BCP-47 tag (en, ja, pt-BR) or auto to detect spoken language.";
        },
        activate: () => {
          const lock = this.languageLock();
          if (lock) this.setStatus("info", lock.info);
          else this.ask("dictation");
        },
        step: () => {
          const lock = this.languageLock();
          if (lock) this.setStatus("info", lock.info);
        },
      },
      dictationSubmitWord: {
        label: "Submit word",
        cycles: true,
        render: () => {
          const cur = s().dictationSubmitWord;
          const mode = submitModeOf(cur);
          if (mode === "custom") return { value: "User-defined", note: cur };
          if (this.submitCustomActive) return { value: "User-defined", note: "Enter sets trigger word" };
          if (mode === "off") return { value: "Off" };
          if (mode === "send it") return { value: "Send it" };
          return { value: "Submit" };
        },
        hints: () => {
          const custom = this.submitCustomActive || submitModeOf(s().dictationSubmitWord) === "custom";
          return [
            { key: "← →", action: "Selects" },
            ...(custom ? [{ key: "Enter", action: "edit", optional: true }] : []),
          ];
        },
        info: () => "Trailing phrase that strips itself and submits.",
        activate: () => {
          if (this.submitCustomActive || submitModeOf(s().dictationSubmitWord) === "custom") this.askSubmitWord();
          else this.step("dictationSubmitWord", 1);
        },
        step: (dir) => {
          const cur = s().dictationSubmitWord;
          const curMode = this.submitCustomActive && submitModeOf(cur) === "off" ? "custom" : submitModeOf(cur);
          if (curMode === "custom" && cur) this.rememberedSubmitCustom = cur;
          const next = cycle(SUBMIT_MODES, curMode, dir);
          if (next === "custom") {
            this.submitCustomActive = true;
            if (this.rememberedSubmitCustom) {
              this.speech.setDictationSubmitWord(this.rememberedSubmitCustom);
              this.setStatus("success", `✓ Submit word: ${this.rememberedSubmitCustom}`);
            } else {
              this.speech.setDictationSubmitWord(undefined);
              this.setStatus("info", "Submit word: User-defined (Enter sets trigger word)");
            }
          } else {
            this.submitCustomActive = false;
            this.speech.setDictationSubmitWord(next === "off" ? undefined : next);
            this.setStatus(
              "success",
              `✓ Submit word: ${next === "off" ? "Off" : next === "send it" ? "Send it" : "Submit"}`,
            );
          }
        },
      },
      dictationVocabulary: {
        label: "Vocabulary",
        opens: true,
        render: () => {
          const vc = parseVocabulary(s().dictationVocabulary);
          const n = vc.terms.length + vc.replacements.length;
          return { value: n ? `${n} term${n === 1 ? "" : "s"}` : "Off" };
        },
        hints: () => [{ key: "Enter", action: "edit list in Pi" }],
        info: () => "Terms or spoken,replacement pairs (pie,Pi · clawed,Claude).",
        activate: () => this.openDictationEditor("vocabulary"),
      },
      dictationRedirect: {
        label: "Redirect",
        cycles: true,
        render: () => ({ value: s().dictationRedirect ? "Focused pane" : "Off" }),
        hints: () => [{ key: "Enter", action: "toggle" }],
        info: () => "Send dictated text to the focused Zellij pane; otherwise type into Pi.",
        step: () => {
          s().dictationRedirect = !s().dictationRedirect;
          this.speech.save();
        },
      },
      dictationCommands: {
        label: "Commands",
        opens: true,
        render: () => {
          const n = parseVoiceCommands(s().dictationCommands).length;
          return { value: n ? `${n} command${n === 1 ? "" : "s"}` : "Off" };
        },
        hints: () => [{ key: "Enter", action: "edit list in Pi" }],
        info: () => "/commands or phrase,/command · runs only when spoken alone.",
        activate: () => this.openDictationEditor("commands"),
      },
      // Hotkeys
      speak: hotkeySpec("speak", "Speak…", () => this.openSpeaker()),
      dictate: hotkeySpec("dictate", "Dictate", () => this.dictate()),
      ptt: hotkeySpec("ptt", "Push-to-talk", () => {
        if (this.mode.kind === "menu") this.mode.capture = "ptt";
      }),
      // Receivers
      bridgeMode: {
        label: "Bridge",
        cycles: true,
        render: () => {
          const v = val("bridgeMode", this.engine.routes.mode);
          const mode = BRIDGE_MODES.find((m) => m === v) ?? "auto";
          return { value: v, ...this.bridgeNote(mode) };
        },
        hints: () => [{ key: "← →", action: "Selects" }],
        step: (dir) => {
          const i = BRIDGE_MODES.indexOf(this.shown("bridgeMode") as BridgeMode);
          const next = BRIDGE_MODES[(i + dir + BRIDGE_MODES.length) % BRIDGE_MODES.length];
          this.change("bridgeMode", next, async () => {
            let notice: Awaited<ReturnType<Engine["setBridge"]>>;
            try {
              notice = await this.engine.setBridge(next);
            } catch (err) {
              if (/no bridge token|check the bridge token/.test(errorMessage(err))) {
                this.openPairing();
                return { tone: "info", text: PAIR_FIRST };
              }
              throw err;
            }
            await this.probe();
            return notice.level === "info" ? `✓ ${notice.message}` : { tone: "error", text: `✗ ${notice.message}` };
          });
        },
      },
      device: {
        label: "Device",
        opens: true,
        cycles: true,
        render: () => this.deviceValue(),
        hints: () => {
          if (this.engine.routes.ssh)
            return [
              { key: "← →", action: "Selects" },
              { key: "Enter", action: "where it comes from" },
            ];
          if (this.receivers.isRemoteDevice()) {
            const expected = this.engine.receiverVersion;
            const u: Hint[] =
              this.receivers.canManageRemote() && this.receivers.isRemoteOutdated()
                ? [{ key: "u", action: `update to v${expected ?? "latest"}` }]
                : [];
            return [
              { key: "← →", action: "Selects" },
              { key: "Enter", action: "reconnect" },
              ...u,
              { key: "x", action: "disconnect" },
            ];
          }
          const x: Hint[] = this.engine.remoteHost ? [{ key: "x", action: "forget" }] : [];
          return [{ key: "← →", action: "Selects" }, { key: "Enter", action: "connect" }, ...x];
        },
        activate: () => {
          if (this.engine.routes.ssh) this.setStatus("info", URL_FROM);
          else this.openConnect();
        },
        step: () => {
          if (this.engine.routes.ssh) {
            const next: BridgeMode = this.engine.routes.route === "bridge" ? "off" : "auto";
            this.change("bridgeMode", next, async () => {
              const notice = await this.engine.setBridge(next);
              await this.probe();
              return notice.level === "info" ? `✓ ${notice.message}` : { tone: "error", text: `✗ ${notice.message}` };
            });
            return;
          }
          if (this.receivers.isRemoteDevice()) {
            if (this.engine.remoteState !== "off") {
              this.disconnect(false);
            } else {
              this.change("bridgeMode", "off", async () => {
                const notice = await this.receivers.switchToLocalDevice();
                this.reloadLocalAfterRouteChange();
                return notice;
              });
            }
          } else if (this.engine.remoteHost) {
            this.connectHost(this.engine.remoteHost);
          } else {
            this.openConnect();
          }
        },
      },
      pairing: {
        label: "Pairing",
        render: () => this.pairingValue(),
        hints: () => [{ key: "Enter", action: "address, pair" }],
        activate: () => {
          this.openPairing();
          this.setStatus("info", PAIR_HOW);
        },
      },
      receiver: {
        label: "Local receiver",
        cycles: true,
        render: () => this.localReceiverValue(),
        hints: () => {
          if (!this.receivers.localStatus?.from) return [{ key: "Enter", action: "fetch" }];
          const u: Hint[] = this.receivers.isLocalOutdated()
            ? [{ key: "Enter / u", action: this.receivers.localUpdateHint() ? "update help" : "update" }]
            : [];
          return [...u, { key: "← →", action: "CPU / GPU" }];
        },
        activate: () => {
          if (!this.receivers.localStatus?.from) this.fetchLocalReceiver();
          else if (this.receivers.isLocalOutdated()) this.updateLocalReceiver();
        },
        step: () => this.toggleLocalEdition(),
      },
      remoteReceiver: {
        label: "Remote receiver",
        cycles: true,
        render: () => this.remoteReceiverValue(),
        hints: () => {
          if (this.receivers.canMaintainRemote()) return [{ key: "Enter", action: "manage over SSH" }];
          const u: Hint[] = this.receivers.isRemoteOutdated() ? [{ key: "Enter / u", action: "update" }] : [];
          const sw: Hint[] = this.receivers.canSwitchRemoteEdition() ? [{ key: "← →", action: "CPU / GPU" }] : [];
          return [...u, ...sw];
        },
        activate: () => {
          if (this.receivers.canMaintainRemote()) this.openReceiverSsh();
          else if (this.receivers.isRemoteOutdated()) this.updateRemoteReceiver();
        },
        step: () => {
          if (this.receivers.canSwitchRemoteEdition()) this.toggleRemoteEdition();
        },
      },
      receiverSshHost: {
        label: "SSH host",
        opens: true,
        render: () => ({ value: this.receivers.maintenanceHost ?? "not set" }),
        hints: () => [{ key: "Enter", action: "choose host" }],
        activate: () => this.editReceiverSshHost(),
      },
      receiverSshUpdate: {
        label: "Install / update",
        render: () => ({ value: "Receiver binary", note: "restarts the service if updated" }),
        hints: () => [{ key: "Enter", action: "install or update" }],
        activate: () => this.maintainReceiver("update"),
      },
      receiverSshRestart: {
        label: "Start / restart",
        render: () => ({ value: "Receiver service", note: "keeps the installed version" }),
        hints: () => [{ key: "Enter", action: "start or restart" }],
        activate: () => this.maintainReceiver("restart"),
      },
      playOn: directionSpec("playOn", "Play audio on"),
      recordOn: directionSpec("recordOn", "Record audio on"),
      modelsOn: directionSpec("modelsOn", "Run models on"),
      // Read aloud options
      readMode: {
        label: "Read",
        cycles: true,
        render: () => ({ value: READ_WORDS[this.engine.readAloud.mode] }),
        hints: () => [{ key: "← →", action: "Selects" }],
        info: () => READ_INFO[this.engine.readAloud.mode],
        step: (dir) => {
          this.engine.setReadMode(cycle(READ_MODES, this.engine.readAloud.mode, dir));
          this.clearStatus();
        },
      },
      summarizer: {
        label: "Summarized by",
        opens: true,
        render: () => {
          const muted = this.engine.readAloud.mode === "off" ? { muted: true } : {};
          if (s().readAloud.summarizer) return { value: s().readAloud.summarizer, ...muted };
          return this.engine.readAloud.mode === "streaming"
            ? { value: "none", note: "✗ choose a model", alert: true }
            : { value: SAME_MODEL_LABEL, ...muted };
        },
        hints: () => [{ key: "Enter", action: "choose summarization model" }],
        info: () => {
          const o = s().readAloud;
          if (this.engine.readAloud.mode === "streaming" && !o.summarizer) {
            return "Streaming needs a separate model for summarization only (Same model cannot summarize mid-run).";
          }
          return o.summarizer
            ? this.engine.readAloud.mode === "streaming"
              ? `Summarization only: additional requests to ${o.summarizer} made per step batch.`
              : `Summarization only: one additional request to ${o.summarizer} per reply.`
            : "Summarization only: same model, same reply. No additional request.";
        },
        activate: () => this.openPicker("summarizer"),
      },
      summaryLength: {
        label: "Length",
        cycles: true,
        render: () => ({
          value: LENGTH_WORDS[s().readAloud.length],
          ...(this.engine.readAloud.mode === "off" ? { muted: true } : {}),
        }),
        hints: () => [{ key: "← →", action: "Selects" }],
        info: () => `~${LENGTH_SECONDS[s().readAloud.length]} s target.`,
        step: (dir) => {
          this.engine.setReadAloudOptions({ length: cycle(SUMMARY_LENGTHS, s().readAloud.length, dir) });
          this.clearStatus();
        },
      },
      truncate: {
        label: "Truncate at",
        cycles: true,
        render: () => ({
          value: truncateWord(s().readAloud.truncate),
          ...(this.engine.readAloud.mode === "off" ? { muted: true } : {}),
        }),
        hints: () => [{ key: "← →", action: "Selects" }],
        info: () => (s().readAloud.truncate ? `Stops at ${s().readAloud.truncate} s.` : "Off."),
        step: (dir) => {
          this.engine.setReadAloudOptions({ truncate: cycle(TRUNCATE_SECONDS, s().readAloud.truncate, dir) });
          this.clearStatus();
        },
      },
    };
  }

  private rowBase(id: RowId): RowBase {
    const spec = this.rowSpecs[id];
    return { id, label: spec.label, ...(spec.opens ? { opens: true } : {}) };
  }

  private menuRows(menu: MenuId): RowBase[] {
    const ids =
      menu === "main"
        ? MAIN_IDS
        : menu === "bridge"
          ? BRIDGE_IDS.filter((id) => {
              if ((id === "bridgeMode" || id === "pairing") && !this.engine.routes.ssh) return false;
              if (id === "remoteReceiver" && !this.receivers.isRemoteDevice()) return false;
              if (isDirectionRow(id) && this.engine.routes.route !== "bridge") return false;
              return true;
            })
          : MENUS[menu].ids;
    return ids.map((id) => this.rowBase(id));
  }

  // ── The view ────────────────────────────────────────────────────────────

  view(): PanelView {
    const home = this.home();
    const baseRows = this.menuRows(home.kind === "list" ? "main" : home.menu);
    if (home.kind === "menu") home.selected = Math.max(0, Math.min(home.selected, Math.max(0, baseRows.length - 1)));
    const rows = baseRows.map((r) => this.row(r, home));
    const view: PanelView = {
      title: "Speech",
      state: this.engine.indicator.live(),
      menu: home.kind === "list" ? "main" : home.menu,
      rows,
      selected: home.kind === "list" ? this.selected : home.selected,
      hints: this.hints(),
      tab: this.tab(),
      tabs: TABS,
      keys: { speak: keyLabel(this.bound.speak), dictate: keyLabel(this.bound.dictate) },
    };
    if (home.kind === "list") {
      const focused = this.mode.kind === "input" && this.mode.purpose === "speak";
      view.speak = {
        value: this.speakEdit.value,
        cursor: this.speakEdit.cursor,
        placeholder: this.takesTags()
          ? "type a message · Enter speaks · [tags] direct this model"
          : "type a message · Enter speaks it",
        focused,
      };
      if (focused) view.selected = -1;
    } else {
      view.crumb = MENUS[home.menu].title;
    }
    if (this.status) view.status = this.status;
    else if (this.mode.kind === "picker" && this.mode.picker.row === "summarizer") {
      const items = this.pickerItems(this.mode.picker);
      const at = items.length ? Math.max(0, Math.min(this.mode.picker.selected, items.length - 1)) : -1;
      const pickedId = at >= 0 ? items[at]?.id : undefined;
      const callNote =
        this.engine.readAloud.mode === "streaming"
          ? `additional requests to ${pickedId ?? "this model"} made per step batch`
          : `one additional request to ${pickedId ?? "this model"} per reply`;
      view.status = {
        tone: "info",
        text:
          pickedId === SAME_MODEL
            ? "Summarization only: same model, same reply (no additional request)."
            : `Summarization only: ${callNote} (your speech model speaks it).`,
      };
    } else if (home.kind === "menu" && (home.menu === "readAloud" || home.menu === "dictation") && this.mode === home) {
      const id = baseRows[home.selected]?.id;
      const info = id ? this.rowSpecs[id].info?.() : undefined;
      if (info) view.status = { tone: "info", text: info };
    }
    if (this.mode.kind === "picker") view.picker = this.pickerView(this.mode.picker);
    if (this.mode.kind === "input") {
      const m = this.mode;
      const input = (label: string, placeholder: string, under?: RowId): InputView => ({
        label,
        value: m.edit.value,
        cursor: m.edit.cursor,
        placeholder,
        ...(under && rows.some((r) => r.id === under) ? { under } : {}),
      });
      switch (m.purpose) {
        case "speak":
          break;
        case "language":
          view.input = input(`Language of ${m.voice}`, LANGUAGE_HINT, m.back.kind === "list" ? "voice" : undefined);
          break;
        case "transcribe":
          view.input = input("Audio file", "wav, mp3, flac, m4a, ogg, webm or aac · the text goes into the editor");
          break;
        case "dictation":
          view.input = input("Spoken language", LANGUAGE_HINT, "language");
          break;
        case "submitWord":
          view.input = input("Submit word", SUBMIT_WORD_HINT, "dictationSubmitWord");
          break;
        case "pairAddress":
          view.input = input("Address", ADDRESS_HINT, this.engine.routes.ssh ? "pairing" : "device");
          break;
        case "connect":
          view.input = input("Connect to", CONNECT_HINT, "device");
          break;
        case "receiverSshHost":
          view.input = input("SSH host", RECEIVER_SSH_HINT, "receiverSshHost");
          break;
        case "secret":
          view.login = { prompt: m.label, secret: true, confirm: false, value: m.edit.value, cursor: m.edit.cursor };
          break;
        case "confirm":
          view.login = { prompt: m.question, secret: false, confirm: true, value: m.edit.value, cursor: m.edit.cursor };
          break;
        case "pairCode":
          view.input = input(`Code from ${m.address}`, CODE_HINT, "pairing");
          break;
      }
      if (m.back.kind === "picker") view.picker = this.pickerView(m.back.picker);
    }
    if (view.picker?.detail && this.mode.kind === "picker" && isModelRow(this.mode.picker.row)) {
      view.hints.splice(Math.max(0, view.hints.length - 1), 0, {
        key: keyLabel(PANEL_KEYS.detail[0]),
        action: "details",
        optional: true,
      });
    }
    return view;
  }

  private tab(mode: Mode = this.mode): TabId {
    if (mode.kind === "menu") {
      return mode.menu === "dictation" ? "main" : mode.menu === "receiverSsh" ? "bridge" : mode.menu;
    }
    if (mode.kind === "picker") {
      return mode.picker.row === "history"
        ? "main"
        : mode.picker.row === "summarizer"
          ? "readAloud"
          : (mode.picker.row as TabId);
    }
    if (mode.kind === "input") {
      if (
        [
          "connect",
          "receiverSshHost",
          "pairAddress",
          "pairCode",
          "secret",
          "confirm",
          "dictation",
          "submitWord",
        ].includes(mode.purpose)
      ) {
        return this.tab(mode.back);
      }
    }
    return "main";
  }

  private arrive(tab: TabId): void {
    if (this.tab() === "hotkeys" && this.hotkeysChanged()) {
      this.close();
      return;
    }
    const row = MAIN_IDS.indexOf(tab as RowId);
    if (row >= 0) this.selected = row;
    this.mode = { kind: "list" };
    if (tab === "main") return;
    if (tab === "speechModel" || tab === "voice" || tab === "transcription") this.openPicker(tab);
    else this.activate(tab);
  }

  private row(base: RowBase, home: { kind: "list" } | MenuMode = this.home()): PanelRow {
    const rendered = this.rowSpecs[base.id].render(home);
    const opens = rendered.disabled ? undefined : base.opens;
    return { id: base.id, label: base.label, ...(opens ? { opens: true } : {}), ...rendered };
  }

  private hotkeyValue(name: HotkeyName, home: { kind: "list" } | MenuMode): Pick<PanelRow, "value" | "note"> {
    if (home.kind === "menu" && home.capture === name) return { value: "press a key…" };
    const key = this.speech.settings.hotkeys[name];
    if (!key) return { value: "off", note: "hold to dictate (Kitty key-release)" };
    return { value: keyLabel(key) };
  }

  private hotkeysChanged(): boolean {
    const saved = this.speech.settings.hotkeys;
    return saved.speak !== this.bound.speak || saved.dictate !== this.bound.dictate;
  }

  private shown(id: RowId): string | undefined {
    return this.row(this.rowBase(id)).value;
  }

  private modelAlert(kind: "tts" | "stt", id: string): Pick<PanelRow, "note" | "alert"> {
    if (!this.models) return this.modelsError ? { note: "✗ models unavailable", alert: true } : {};
    const m = this.models[kind].find((x) => x.id === id);
    if (!m) return { note: this.speech.missingModelNote(id), alert: true };
    if (this.speech.catalogOffline(id)) return { note: "✗ catalog offline", alert: true };
    return {};
  }

  private localRow(id: string | undefined): Pick<PanelRow, "value" | "note" | "alert"> {
    const value = id ?? "none";
    if (!id) return { value, note: "✗ choose a model", alert: true };
    if (this.localError) return { value, note: "✗ local models unavailable", alert: true };
    const m = this.localModels?.find((x) => x.id === id);
    if (this.localModels && !m?.downloaded) return { value, note: "✗ not downloaded", alert: true };
    return { value };
  }

  private voiceAlert(): Pick<PanelRow, "note" | "alert"> {
    const v = this.voices?.model === this.voicesKey() ? this.voices : undefined;
    if (v?.error) return { note: "✗ voices unavailable", alert: true };
    if (v?.ids && v.ids.length === 0) {
      return { note: `✗ ${this.speech.emptyVoicesReason(this.speech.settings.speechModel)}`, alert: true };
    }
    return {};
  }

  private bridgeNote(mode: BridgeMode): Pick<PanelRow, "note" | "short" | "alert"> {
    const routes = this.engine.routes;
    const when = mode === "auto" ? "on over SSH · " : "";
    if (routes.routeFor(mode) === "local") return { note: `${when}plays on This machine`, short: "This machine" };
    const r = this.receivers.health;
    const host = routes.url.replace(/^[a-z]+:\/\//, "");
    const state = !r || r === "checking" ? "… checking" : r.ok ? `✓ ${host}` : "✗ receiver unreachable";
    const alert = typeof r === "object" && !r.ok;
    const where = this.speech.settings.playOn === "remote" ? "plays on the Remote machine" : "bridge in use";
    return { note: `${when}${where} · ${state}`, short: state, ...(alert ? { alert } : {}) };
  }

  private pairingValue(): Pick<PanelRow, "value" | "note" | "short" | "alert" | "opens"> {
    const p = this.receivers.pairing;
    if (!p || p === "checking") return { value: "… checking", opens: true };
    if (p.ok) {
      const expected = this.engine.receiverVersion;
      if (this.receivers.isVersionOutdated(p.version)) {
        return {
          value: `✓ Connected to ${p.address}:${p.port} · ${p.ms} ms`,
          note: `! receiver ${p.version} · update to ${expected}`,
          short: `! update ${expected}`,
          alert: true,
          opens: true,
        };
      }
      return {
        value: `✓ Connected to ${p.address}:${p.port} · ${p.ms} ms`,
        note: `receiver ${p.version}`,
        opens: true,
      };
    }
    const fault = pairingFault(p.reason);
    if (fault === "receiver unreachable") {
      const forwarded = this.engine.routes.ssh && this.receivers.addressFrom() === "default";
      return {
        value: "✗ Receiver unreachable",
        note: forwarded ? "check the receiver and SSH forward" : "check the receiver and address",
        alert: true,
        opens: true,
      };
    }
    return { value: "✗ Re-pair", note: fault, opens: true };
  }

  private deviceValue(): Pick<PanelRow, "value" | "note" | "short" | "alert" | "opens"> {
    const e = this.engine;
    const host = e.remoteHost;
    if (e.routes.ssh) {
      if (e.routes.route !== "bridge") return { value: "Local (this host)", note: "←→ switches to Remote" };
      const at = hostPort(e.routes.url);
      const from = this.receivers.addressFrom();
      if (!at) {
        return from === "pairing"
          ? { value: "Remote · not set", note: "✗ the address set in Pairing is not usable", alert: true }
          : { value: "Remote · not set", note: "✗ PI_SPEECH_BRIDGE_URL is not a URL", alert: true };
      }
      const note = { pairing: "set in Pairing", env: "from PI_SPEECH_BRIDGE_URL", default: "ssh forward" }[from];
      return { value: `Remote · ${at}`, note };
    }
    switch (e.remoteState) {
      case "connecting":
        return { value: `Remote · ${host ?? "…"}`, note: "… connecting", opens: true };
      case "connected": {
        const p = this.receivers.pairing;
        const ms = p && p !== "checking" && p.ok ? ` · ${p.ms} ms` : "";
        return { value: `Remote · ${host ?? "connected"}`, note: `✓ over SSH${ms}`, opens: true };
      }
      case "lost":
      case "failed":
        return {
          value: `Remote · ${host ?? "not connected"}`,
          note: `✗ ${e.remoteError ?? "not connected"}`,
          alert: true,
          opens: true,
        };
    }
    if (this.speech.settings.bridgeAddress && e.routes.route === "bridge") {
      const p = this.pairingValue();
      return {
        value: `Remote · ${this.speech.settings.bridgeAddress}`,
        note: p.note ?? p.value,
        ...(p.alert ? { alert: true } : {}),
        opens: true,
      };
    }
    return { value: "Local", note: host ? `←→ ${host} · Enter connects` : "Enter connects to Remote", opens: true };
  }

  private remoteReceiverValue(): Pick<PanelRow, "value" | "note" | "short" | "alert" | "opens"> {
    const e = this.engine;
    if (e.remoteState === "connecting") return { value: "… checking" };
    const ver = this.receivers.connectedVersion();
    const ed = (this.receivers.connectedEdition() ?? "cpu").toUpperCase();
    if (this.receivers.canMaintainRemote()) {
      const outdated = this.receivers.isRemoteOutdated();
      const p = this.receivers.pairing;
      const unreachable = p && p !== "checking" && !p.ok && pairingFault(p.reason) === "receiver unreachable";
      return {
        value: unreachable ? "✗ unreachable" : ver ? `${ed} v${ver}` : "… checking",
        note: outdated && !unreachable ? `! update to v${e.receiverVersion} · Manage over SSH…` : "Manage over SSH…",
        alert: !!(outdated || unreachable),
        opens: true,
      };
    }
    if (!ver) return { value: `${ed} · … checking` };
    const label = `${ed} v${ver}`;
    if (this.receivers.isRemoteOutdated()) {
      return this.receivers.canManageRemote()
        ? { value: label, note: `! Enter or u updates to v${e.receiverVersion}`, alert: true }
        : { value: label, note: "! update on Remote machine", alert: true };
    }
    const rg = this.receivers.remoteGpu;
    if (ed === "CPU" && rg && this.receivers.canSwitchRemoteEdition()) {
      return { value: label, note: `CUDA ${rg.cuda} ready · ←→ GPU` };
    }
    return { value: label };
  }

  private localReceiverValue(): Pick<PanelRow, "value" | "note" | "short" | "alert"> {
    const st = this.receivers.localStatus;
    if (!st?.from) {
      const sz = this.receivers.localAssetSize();
      return { value: "not downloaded", note: sz ? `Enter fetches (${formatSize(sz)})` : "no binary found" };
    }
    const ed = (st.edition ?? this.speech.settings.localDevice).toUpperCase();
    const label = st.version ? `${ed} v${st.version}` : ed;
    if (this.receivers.isLocalOutdated()) {
      const manual = this.receivers.localUpdateHint();
      return {
        value: label,
        note: manual ? `! ${manual}` : `! Enter or u updates to v${this.engine.receiverVersion}`,
        alert: true,
      };
    }
    const lg = this.receivers.localGpu;
    if (ed === "CPU" && lg?.hardware && lg.target && this.receivers.hasBinaryForTarget(lg.target)) {
      const sz = this.receivers.localAssetSize(lg.target);
      return {
        value: label,
        note: sz ? `CUDA ${lg.cuda} ready (←→ GPU, ${formatSize(sz)})` : `CUDA ${lg.cuda} ready · ←→ GPU`,
      };
    }
    return { value: label, note: st.from };
  }

  private connectionValue(): Pick<PanelRow, "value" | "note" | "short" | "alert"> {
    const routes = this.engine.routes;
    const r = this.receivers.health;
    const expected = this.engine.receiverVersion;
    const answers = (): Pick<PanelRow, "note" | "short" | "alert"> => {
      if (!r || r === "checking") return { note: "… checking" };
      if (!r.ok) return { note: "✗ receiver unreachable", alert: true };
      const ed = r.edition ? `${r.edition.toUpperCase()} ` : "";
      if (this.receivers.isVersionOutdated(r.version)) {
        return { note: `! ${ed}v${r.version} · update to v${expected}`, short: `! → v${expected}`, alert: true };
      }
      return { note: "✓" };
    };
    if (!routes.ssh) {
      if (this.engine.remoteState === "connecting")
        return { value: this.engine.remoteHost ?? "…", note: "… connecting" };
      if (this.engine.remoteState === "lost" || this.engine.remoteState === "failed") {
        return {
          value: this.engine.remoteHost ?? "not connected",
          note: `✗ ${this.engine.remoteError ?? "not connected"}`,
          alert: true,
        };
      }
      if (this.engine.remoteState === "connected") {
        const host = this.engine.remoteHost ?? "connected";
        const p = this.receivers.pairing;
        const ver = this.receivers.connectedVersion();
        const ed = (this.receivers.connectedEdition() ?? "cpu").toUpperCase();
        if (this.receivers.isVersionOutdated(ver) || this.engine.remoteOutdated) {
          return {
            value: host,
            note: `! ${ed} v${ver || "old"} · update to v${expected}`,
            short: `! → v${expected}`,
            alert: true,
          };
        }
        const ms = p && p !== "checking" && p.ok ? ` · ${p.ms} ms` : "";
        return { value: host, note: `✓ ${ed}${ver ? ` v${ver}` : ""}${ms}` };
      }
      if (routes.route === "bridge") {
        return { value: this.speech.settings.bridgeAddress ?? hostPort(routes.url) ?? "bridge", ...answers() };
      }
      const st = this.receivers.localStatus;
      if (st?.from) {
        const ed = (st.edition ?? this.speech.settings.localDevice).toUpperCase();
        const ver = st.version ? ` v${st.version}` : "";
        if (st.version && this.receivers.isVersionOutdated(st.version)) {
          return { value: `Local · ${ed}${ver}`, note: `! update to v${expected}`, alert: true };
        }
        return { value: `Local · ${ed}${ver}` };
      }
      return { value: "Local" };
    }
    if (routes.route !== "bridge") return { value: "Local (this host)", note: "audio and models on this host" };
    return { value: "ssh forward", ...answers() };
  }

  private voiceLock(): { value: string; note: string; info: string; canSample: boolean } | undefined {
    const s = this.speech.settings;
    if (s.speechSource === "local") {
      if (this.isPiperFamilyActive()) return undefined;
      if (!s.localSpeechModel) {
        return {
          value: "none",
          note: "choose a speech model",
          info: "Choose a local speech model first: Speech model",
          canSample: false,
        };
      }
      if (!this.localError) {
        const found = this.localModels?.find((m) => m.id === s.localSpeechModel);
        if (found && !found.downloaded) {
          const shown = this.pending.get("voice") ?? s.localSpeechVoice ?? "default";
          return {
            value: shown,
            note: "download model first",
            info: `${s.localSpeechModel} is not downloaded yet: Speech model`,
            canSample: false,
          };
        }
      }
      const v = this.voices?.model === this.voicesKey() ? this.voices : undefined;
      if (v && !v.error && v.ids !== undefined && v.ids.length <= 1) {
        const shown = this.pending.get("voice") ?? s.localSpeechVoice ?? v.ids[0] ?? "default";
        return {
          value: shown,
          note: "single voice",
          info: `${s.localSpeechModel} has a single voice (Ctrl+P samples it)`,
          canSample: true,
        };
      }
      return undefined;
    }
    if (!this.speech.allowsAnyVoice(s.speechModel)) {
      const v = this.voices?.model === this.voicesKey() ? this.voices : undefined;
      if (v && !v.error && v.ids !== undefined && v.ids.length === 1 && v.ids[0] === "default") {
        return {
          value: "default",
          note: "single voice",
          info: `${this.speech.modelLabel(s.speechModel)} has a single voice (Ctrl+P samples it)`,
          canSample: true,
        };
      }
    }
    return undefined;
  }

  private languageLock(): { value: string; note: string; info: string } | undefined {
    const s = this.speech.settings;
    if (s.transcriptionSource !== "local" || !s.localTranscriptionModel) return undefined;
    const id = s.localTranscriptionModel;
    const entry = this.localModels?.find((m) => m.id === id);
    const mode = localSttLanguage(entry ?? id, entry?.languages);
    if (mode.kind === "selectable") return undefined;
    if (mode.kind === "fixed") {
      return {
        value: mode.language,
        note: mode.language === "en" ? "English-only model" : "fixed by model",
        info: `${id} transcribes ${mode.language} only`,
      };
    }
    return { value: "auto", note: "detected by model", info: `${id} detects the spoken language automatically` };
  }

  private effectiveDictationLanguage(): string {
    return (
      this.languageLock()?.value ?? this.pending.get("language") ?? this.speech.settings.dictationLanguage ?? "auto"
    );
  }

  // ── Pickers ─────────────────────────────────────────────────────────────

  private piperVoices(): LocalModel[] {
    return (this.localModels ?? []).filter((m) => m.kind === "speech" && isSingleVoicePiper(m));
  }

  private isPiperFamilyActive(): boolean {
    const id = this.speech.settings.localSpeechModel;
    const entry = this.localModels?.find((m) => m.id === id);
    return (
      this.speech.settings.speechSource === "local" && (this.piperFamilyPending || isSingleVoicePiper(entry ?? id))
    );
  }

  private activeReceiverEdition(): "cpu" | "gpu" {
    if (this.receivers.isRemoteDevice()) {
      return this.receivers.connectedEdition() ?? (this.receivers.remoteGpu?.hardware ? "gpu" : "cpu");
    }
    return this.speech.settings.localDevice;
  }

  private pickerContext(): PickerContext {
    return {
      settings: this.speech.settings,
      models: this.models,
      localModels: this.localModels,
      edition: this.activeReceiverEdition(),
      modelsRoute: this.engine.routes.modelsRoute,
      piperFamilyPending: this.piperFamilyPending,
      downloadOf: (id) => this.downloadOf(id),
      providerName: (id) => this.speech.providerName(id),
      emptyVoicesReason: (model) => this.speech.emptyVoicesReason(model),
      enrichModel: (option) => this.speech.enrichModel(option),
      voiceLanguage: (model, voice) => this.speech.languageOf(model, voice),
    };
  }

  private pickerItems(p: PickerState): PickerItem[] {
    return buildPickerItems(
      {
        row: p.row,
        ids: p.ids,
        messages: p.messages,
        query: p.edit.value,
        cursor: p.edit.cursor,
        selected: p.selected,
        local: p.local,
        piper: p.piper,
      },
      this.pickerContext(),
    );
  }

  private pickerView(p: PickerState): PickerView {
    return buildPickerView(
      {
        row: p.row,
        ids: p.ids,
        messages: p.messages,
        query: p.edit.value,
        cursor: p.edit.cursor,
        selected: p.selected,
        local: p.local,
        piper: p.piper,
      },
      this.pickerContext(),
    );
  }

  private takesTags(): boolean {
    const s = this.speech.settings;
    if (s.speechSource === "local") {
      const entry = this.localModels?.find((m) => m.id === s.localSpeechModel);
      return inlineTags(entry ?? { id: s.localSpeechModel ?? "" }) !== undefined;
    }
    return this.models?.tts.find((m) => m.id === s.speechModel)?.features?.includes("tags") === true;
  }

  // ── Hints ───────────────────────────────────────────────────────────────

  private hints(): Hint[] {
    const esc = (action: string): Hint => ({ key: "Esc", action });
    const m = this.mode;
    if (m.kind === "input") {
      const action =
        m.purpose === "speak"
          ? "speak"
          : m.purpose === "transcribe"
            ? "transcribe"
            : m.purpose === "pairAddress" || m.purpose === "connect"
              ? "connect"
              : m.purpose === "pairCode"
                ? "pair"
                : m.purpose === "secret"
                  ? "sign in"
                  : m.purpose === "confirm"
                    ? "yes"
                    : "set";
      if (m.purpose === "confirm") return [{ key: "Enter", action }, esc("no")];
      if (m.purpose === "speak") {
        return [{ key: "Enter", action }, ...MAIN_CHORD_HINTS.map((h) => ({ ...h, optional: true })), esc("close")];
      }
      if ((m.purpose === "connect" || m.purpose === "receiverSshHost") && m.hosts.length) {
        return [{ key: "Enter", action }, { key: "↑↓", action: "your ssh Hosts" }, esc("back")];
      }
      return [{ key: "Enter", action }, esc("back")];
    }
    if (m.kind === "picker") {
      const p = m.picker;
      if (!p.ids) return [esc("back")];
      if (p.piper) {
        if (this.pickerItems(p).length === 0) return [esc("back")];
        return [
          { key: "Enter", action: "pick" },
          { key: "Ctrl+O", action: "download" },
          { key: "Alt+O", action: "uninstall" },
          { key: "Ctrl+S", action: "sort", optional: true },
          { key: "Ctrl+P", action: "sample", optional: true },
          esc("back"),
        ];
      }
      if (p.local) {
        const toggle: Hint = { key: "Ctrl+T", action: "provider" };
        const gpuHint: Hint[] = this.receivers.canSwitchLocalGpu()
          ? [{ key: "Ctrl+G", action: "GPU", optional: true }]
          : [];
        if (this.pickerItems(p).length === 0) return [...gpuHint, toggle, esc("back")];
        return [
          { key: "Enter", action: "pick" },
          { key: "Ctrl+O", action: "download" },
          { key: "Alt+O", action: "uninstall" },
          { key: "Ctrl+S", action: "sort", optional: true },
          ...gpuHint,
          toggle,
          esc("back"),
        ];
      }
      const sorting: Hint[] = isModelRow(p.row) ? [{ key: "Ctrl+S", action: "sort", optional: true }] : [];
      const localToggle: Hint[] = isModelRow(p.row) ? [{ key: "Ctrl+T", action: "local", optional: true }] : [];
      const unpricedHint: Hint[] = [];
      if (isModelRow(p.row)) {
        const options = modelOptionsFor(p.row, p.ids, this.models);
        const current =
          p.row === "speechModel" ? this.speech.settings.speechModel : this.speech.settings.transcriptionModel;
        const hidden = options.filter((x) => !isPricedModel(x, current)).length;
        if (hidden > 0) {
          unpricedHint.push({
            key: "F4",
            action: this.speech.settings.showUnpricedModels ? "hide unpriced" : `show ${hidden} unpriced`,
            optional: true,
          });
        }
      }
      if (this.pickerItems(p).length === 0) {
        return p.edit.value
          ? [{ key: "Backspace", action: "" }, ...sorting, ...localToggle, ...unpricedHint, esc("back")]
          : [...sorting, ...localToggle, ...unpricedHint, esc("back")];
      }
      return [
        { key: "Enter", action: p.row === "history" ? "replay" : "pick" },
        ...(p.row === "voice" ? this.voiceKeys() : [...sorting, ...localToggle, ...unpricedHint]),
        { key: "type", action: "to filter" },
        esc("back"),
      ];
    }
    const home = this.home();
    if (home.kind === "menu") return this.menuHints(home);
    const letters: Hint[] = MAIN_CHORD_HINTS.map((h) => ({ ...h, optional: true }));
    const id = MAIN_IDS[this.selected];
    const rowHints = this.rowSpecs[id].hints?.(home) ?? [];
    return [...rowHints, ...letters, esc("close")];
  }

  private menuHints(m: MenuMode): Hint[] {
    const back: Hint = { key: "Esc", action: m.menu === "receiverSsh" ? "Receivers" : "Main" };
    if (m.capture) {
      if (m.capture === "ptt") {
        return [
          { key: "Alt+key / F1-F12", action: "new key for Push-to-talk" },
          ...(this.speech.settings.hotkeys.ptt ? [{ key: "Backspace", action: "clear" }] : []),
          { key: "Esc", action: "cancel" },
        ];
      }
      return [
        { key: "Alt+letter", action: `new key for ${HOTKEY_NAMES[m.capture]}` },
        { key: "Esc", action: "cancel" },
      ];
    }
    const rows = this.menuRows(m.menu);
    const selected = Math.max(0, Math.min(m.selected, Math.max(0, rows.length - 1)));
    const id = rows[selected].id;
    return [...(this.rowSpecs[id].hints?.(m) ?? []), back];
  }

  private voiceKeys(): Hint[] {
    if (this.speech.settings.speechSource === "local") return [{ key: "Ctrl+P", action: "sample", optional: true }];
    return [
      { key: "Ctrl+P", action: "sample", optional: true },
      { key: "F2", action: "language", optional: true },
    ];
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  handle(k: PanelKey): void {
    try {
      const m = this.mode;
      if (m.kind === "menu" && m.capture) this.capture(m, m.capture, k);
      else if (this.chord(k)) {
      } else if ("combo" in k) return;
      else if ("text" in k) this.text(k.text, k.paste === true);
      else this.named(k.key);
    } catch (err) {
      this.setStatus("error", `✗ ${errorMessage(err)}`);
    }
    this.changed();
  }

  private chord(k: PanelKey): boolean {
    const id = "combo" in k ? k.combo : "key" in k ? k.id : undefined;
    if (!id || !Object.values(PANEL_KEYS).some((keys) => (keys as readonly string[]).includes(id))) return false;
    const matches = (name: keyof typeof PANEL_KEYS) => (PANEL_KEYS[name] as readonly string[]).includes(id);
    const m = this.mode;
    if (m.kind === "picker") {
      const p = m.picker;
      const item = this.pickerItems(p)[p.selected];
      if (matches("pageUp") || matches("pageDown")) {
        p.selected = Math.max(0, Math.min(this.pickerItems(p).length - 1, p.selected + (matches("pageUp") ? -10 : 10)));
      } else if (matches("sort") && ((isModelRow(p.row) && !p.local) || p.local || p.piper)) {
        if (p.local || p.piper) this.nextLocalSort(p);
        else this.nextSort(p);
      } else if (matches("toggleSource") && isModelRow(p.row)) {
        this.toggleModelSource(m);
      } else if (matches("unpriced") && isModelRow(p.row) && !p.local) {
        const next = !this.speech.settings.showUnpricedModels;
        this.speech.setShowUnpricedModels(next);
        p.selected = Math.max(0, Math.min(p.selected, Math.max(0, this.pickerItems(p).length - 1)));
        this.setStatus("success", next ? "✓ Showing models without price (saved)" : "✓ Hiding models without price");
      } else if (matches("sample") && p.row === "voice" && item) {
        if (p.piper) {
          const model = this.localModels?.find((x) => x.id === item.id);
          if (!model?.downloaded) {
            this.setStatus("info", `${piperVoiceLabel(item.id)} is not downloaded yet (Ctrl+O downloads)`);
          } else {
            this.piperFamilyPending = false;
            this.speech.setLocalModel("speech", item.id);
            this.sample("");
          }
        } else {
          this.sample(item.id);
        }
      } else if (matches("download") && (p.local || p.piper) && item && item.id !== PIPER_EN_FAMILY) {
        this.downloadKey(item.id);
      } else if (matches("delete") && (p.local || p.piper) && item && item.id !== PIPER_EN_FAMILY) {
        this.deleteKey(item.id);
      } else if (
        matches("gpu") &&
        p.local &&
        !this.receivers.isRemoteDevice() &&
        this.speech.settings.localDevice === "cpu"
      ) {
        this.toggleLocalEdition();
      }
      return true;
    }
    if (m.kind === "list" || (m.kind === "input" && m.purpose === "speak")) {
      if (matches("replay")) {
        this.replay();
        return true;
      }
      if (matches("history")) {
        this.openPicker("history");
        return true;
      }
      if (matches("stop")) {
        this.stop();
        return true;
      }
      if (matches("transcribe")) {
        this.ask("transcribe");
        return true;
      }
      if (matches("sample") && MAIN_IDS[this.selected] === "voice") {
        const lock = this.voiceLock();
        if (lock && !lock.canSample) this.setStatus("info", lock.info);
        else this.sample(this.localVoice()?.voice ?? this.speech.settings.voice);
      }
    }
    return true;
  }

  private named(key: NamedKey): void {
    if (key === "dictate") {
      this.dictate();
      return;
    }
    if (key === "speak") {
      if (this.mode.kind !== "input" || this.mode.purpose !== "speak") this.openSpeaker();
      return;
    }
    const m = this.mode;
    if (key === "tab" || key === "backtab") {
      if (m.kind === "input" && (m.purpose === "secret" || m.purpose === "confirm")) return;
      const at = TABS.findIndex((t) => t.id === this.tab());
      this.arrive(TABS[(at + (key === "tab" ? 1 : -1) + TABS.length) % TABS.length].id);
      return;
    }
    if (m.kind === "input" && m.purpose === "speak") {
      if (key === "down" || key === "up") {
        this.mode = { kind: "list" };
        this.selected = key === "down" ? 0 : MAIN_IDS.length - 1;
      } else if (key === "enter") this.submit(m);
      else if (key === "escape") this.close();
      else m.edit.edit(key);
      return;
    }
    if (m.kind === "input") {
      if (key === "enter") this.submit(m);
      else if (key === "escape") {
        this.mode = m.back;
        if (m.purpose === "secret") m.resolve(undefined);
        if (m.purpose === "confirm") m.resolve(false);
      } else if (
        (key === "up" || key === "down") &&
        (m.purpose === "connect" || m.purpose === "receiverSshHost") &&
        m.hosts.length
      ) {
        if (key === "up") m.next = (m.next - 1 + m.hosts.length) % m.hosts.length;
        m.edit = new LineEdit(m.hosts[m.next % m.hosts.length]);
        if (key === "down") m.next++;
      } else if (m.purpose !== "confirm") m.edit.edit(key);
      return;
    }
    if (m.kind === "picker") {
      const p = m.picker;
      const items = this.pickerItems(p);
      const n = items.length;
      const highlighted = items[Math.min(p.selected, n - 1)];
      if (key === "up" || key === "down") {
        if (n) p.selected = (Math.min(p.selected, n - 1) + (key === "up" ? n - 1 : 1)) % n;
        this.offer = undefined;
        this.deleting = undefined;
      } else if (key === "enter") this.pick(m);
      else if (key === "escape") {
        this.offer = undefined;
        this.deleting = undefined;
        this.mode = m.back;
      } else if (key === "language") {
        if (p.row === "voice" && highlighted && !this.localVoice()) this.askLanguage(highlighted.id);
      } else {
        const before = p.edit.value;
        p.edit.edit(key);
        if (p.edit.value !== before) p.selected = 0;
      }
      return;
    }
    if (m.kind === "menu") {
      const rows = this.menuRows(m.menu);
      m.selected = Math.max(0, Math.min(m.selected, Math.max(0, rows.length - 1)));
      const id = rows[m.selected].id;
      if (key === "up" || key === "down")
        m.selected = (m.selected + (key === "up" ? rows.length - 1 : 1)) % rows.length;
      else if (key === "enter") this.activate(id);
      else if (key === "left" || key === "right") this.step(id, key === "left" ? -1 : 1);
      else if (m.menu === "hotkeys" && id === "ptt" && (key === "backspace" || key === "delete")) this.clearPtt();
      else if (key === "escape") {
        if (m.menu === "hotkeys" && this.hotkeysChanged()) {
          this.rebind = true;
          this.close();
        } else if (m.back) {
          this.mode = m.back;
          this.clearStatus();
        } else this.mode = { kind: "list" };
      }
      return;
    }
    const id = MAIN_IDS[this.selected];
    switch (key) {
      case "up":
      case "down": {
        const next = this.selected + (key === "up" ? -1 : 1);
        if (next < 0 || next >= MAIN_IDS.length) this.openSpeaker();
        else this.selected = next;
        return;
      }
      case "left":
      case "right":
        this.step(id, key === "left" ? -1 : 1);
        return;
      case "enter": {
        if (id === "voice") {
          const lock = this.voiceLock();
          if (lock) {
            this.setStatus("info", lock.info);
            return;
          }
        }
        if (["readAloud", "speechModel", "voice", "transcription", "hotkeys", "bridge"].includes(id)) {
          this.arrive(id as TabId);
        } else {
          this.activate(id);
        }
        return;
      }
      case "language":
        if (id === "voice" && !this.localVoice()) this.askLanguage(this.speech.settings.voice);
        return;
      case "escape":
        this.close();
        return;
    }
  }

  private text(text: string, paste: boolean): void {
    const m = this.mode;
    if (m.kind === "input") {
      if (m.purpose !== "confirm") m.edit.insert(text);
      return;
    }
    if (!paste && text === " " && (m.kind === "list" || m.kind === "menu")) {
      const rows = this.menuRows(m.kind === "list" ? "main" : m.menu);
      const sel = Math.max(0, Math.min(m.kind === "list" ? this.selected : m.selected, Math.max(0, rows.length - 1)));
      const id = rows[sel].id;
      if (this.rowSpecs[id].cycles) this.step(id, 1);
      else this.named("enter");
      return;
    }
    if (m.kind === "picker") {
      m.picker.edit.insert(text);
      m.picker.selected = 0;
      return;
    }
    if (m.kind === "list") {
      this.openSpeaker();
      this.speakEdit.insert(text);
      return;
    }
    if (paste) return;
    const ch = [...text][0];
    if (m.kind === "menu" && m.menu === "hotkeys" && ch === "k") {
      m.capture = HOTKEY_IDS[m.selected] as HotkeyName;
      return;
    }
    if (
      m.kind === "menu" &&
      m.menu === "bridge" &&
      ch === "x" &&
      this.menuRows("bridge")[m.selected]?.id === "device"
    ) {
      this.disconnect();
      return;
    }
    if (m.kind === "menu" && m.menu === "bridge" && ch === "u") {
      const id = this.menuRows("bridge")[m.selected]?.id;
      if (id === "receiver") this.updateLocalReceiver();
      else if (id === "remoteReceiver" && this.receivers.canMaintainRemote()) this.openReceiverSsh();
      else if (id === "remoteReceiver" || (id === "device" && this.receivers.canManageRemote())) {
        this.updateRemoteReceiver();
      }
    }
  }

  private clearPtt(): void {
    const saved = this.speech.settings.hotkeys;
    if (!saved.ptt) {
      this.setStatus("info", "Push-to-talk is already off");
      return;
    }
    const next = { ...saved };
    delete next.ptt;
    this.speech.setHotkeys(next);
    this.setStatus("success", "✓ Push-to-talk is off");
  }

  private capture(m: MenuMode, name: HotkeyName, k: PanelKey): void {
    if ("key" in k && k.key === "escape") {
      m.capture = undefined;
      return;
    }
    if (name === "ptt" && "key" in k && (k.key === "backspace" || k.key === "delete")) {
      m.capture = undefined;
      this.clearPtt();
      return;
    }
    const pressed = "combo" in k ? k.combo : "key" in k ? (k.key === "language" ? "f2" : k.id) : k.text;
    if (!pressed) return;
    m.capture = undefined;
    const key = name === "ptt" ? pttHotkeyId(pressed) : hotkeyId(pressed);
    if (!key) {
      const shown = pressed.length === 1 ? pressed : keyLabel(pressed);
      this.setStatus(
        "error",
        name === "ptt"
          ? `✗ ${shown} cannot be a hotkey: use Alt with a letter or digit, F1–F12, or Alt/Ctrl+Space`
          : `✗ ${shown} cannot be a hotkey: use Alt with a letter or a digit`,
      );
      return;
    }
    const saved = this.speech.settings.hotkeys;
    const others = (["speak", "dictate", "ptt"] as const).filter((n) => n !== name);
    for (const other of others) {
      if (saved[other] && key === saved[other]) {
        this.setStatus("error", `✗ ${keyLabel(key)} is already the key of ${HOTKEY_NAMES[other]}`);
        return;
      }
    }
    if (key === saved[name]) {
      this.setStatus("info", `${HOTKEY_NAMES[name]} is already ${keyLabel(key)}`);
      return;
    }
    this.speech.setHotkeys({ ...saved, [name]: key });
    this.setStatus(
      "success",
      name !== "ptt" && key === this.bound[name]
        ? `✓ ${HOTKEY_NAMES[name]} is ${keyLabel(key)} again`
        : `✓ ${HOTKEY_NAMES[name]} is ${keyLabel(key)}`,
    );
  }

  private ask(purpose: "transcribe" | "dictation"): void {
    this.mode = { kind: "input", purpose, edit: new LineEdit(), back: this.home() };
  }

  private activate(id: RowId): void {
    const spec = this.rowSpecs[id];
    if (spec.activate) spec.activate();
    else this.step(id, 1);
  }

  private step(id: RowId, dir: 1 | -1): void {
    this.rowSpecs[id].step?.(dir);
  }

  private stepSource(direction: Direction, dir: 1 | -1): void {
    const s = this.speech.settings;
    const next = cycle(SOURCES, direction === "speech" ? s.speechSource : s.transcriptionSource, dir);
    const summary = this.speech.setSource(direction, next);
    if (direction === "speech") this.piperFamilyPending = false;
    if (next === "local") this.track(this.loadLocal());
    if (direction === "speech") this.track(this.loadVoices());
    this.setStatus("success", `✓ ${summary}`);
  }

  private reloadLocalAfterRouteChange(): void {
    this.localError = undefined;
    const s = this.speech.settings;
    if (s.speechSource === "local" || s.transcriptionSource === "local") this.track(this.loadLocal(true));
    if (s.speechSource === "local") {
      this.voices = undefined;
      this.track(this.loadVoices());
    }
  }

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

  private pick(m: Extract<Mode, { kind: "picker" }>): void {
    const p = m.picker;
    const item = this.pickerItems(p)[p.selected];
    if (!item) return;
    const row = p.row;
    if (row === "history") {
      this.replayFile(item.id);
      return;
    }
    if ((p.local && isModelRow(row)) || p.piper) {
      this.pickLocal(m, item.id);
      return;
    }
    this.mode = m.back;
    if (row === "summarizer") {
      this.engine.setReadAloudOptions({ summarizer: item.id === SAME_MODEL ? undefined : item.id });
      this.clearStatus();
      return;
    }
    this.change(row, item.id, async () => {
      const summary = await this.speech.set(SETTING_OF[row], item.id);
      if (row === "speechModel") this.track(this.loadVoices());
      return `✓ ${summary}`;
    });
  }

  private nextSort(p: PickerState): void {
    const sorts = MODEL_SORTS;
    this.speech.setModelSort(sorts[(sorts.indexOf(this.speech.settings.modelSort) + 1) % sorts.length]);
    p.selected = 0;
  }

  private nextLocalSort(p: PickerState): void {
    const sorts = LOCAL_MODEL_SORTS;
    this.speech.setLocalModelSort(sorts[(sorts.indexOf(this.speech.settings.localModelSort) + 1) % sorts.length]);
    p.selected = 0;
  }

  private openPicker(row: PickerRow, typed = ""): void {
    const p: PickerState = { row, edit: new LineEdit(typed), selected: 0 };
    const back = this.home();
    this.mode = { kind: "picker", picker: p, back };
    if (row === "history") {
      p.messages = this.speech.messages();
      p.ids = p.messages.map((m) => m.file);
      return;
    }
    if (row === "summarizer") {
      const sameModel = this.engine.readAloud.mode !== "streaming" ? [SAME_MODEL] : [];
      p.ids = [...sameModel, ...this.engine.readAloud.models()];
      return;
    }
    if (row === "voice" && this.isPiperFamilyActive()) {
      p.piper = true;
      const of = (all: LocalModel[]) =>
        all.filter((m) => m.kind === "speech" && isSingleVoicePiper(m)).map((m) => m.id);
      if (this.localModels) p.ids = of(this.localModels);
      this.track(
        this.loadLocal(true).then(
          (all) => {
            p.ids = of(all);
          },
          (err) => {
            if (this.mode.kind === "picker" && this.mode.picker === p) this.mode = back;
            this.setStatus("error", `✗ Local models: ${errorMessage(err)}`);
          },
        ),
      );
      return;
    }
    if (isModelRow(row) && this.sourceOf(row) === "local") {
      p.local = true;
      const kind = directionOf(row);
      const of = (all: LocalModel[]) => localModelIds(kind, all);
      if (this.localModels) p.ids = of(this.localModels);
      this.track(
        this.loadLocal(true).then(
          (all) => {
            p.ids = of(all);
          },
          (err) => {
            if (this.mode.kind === "picker" && this.mode.picker === p) this.mode = back;
            this.setStatus("error", `✗ Local models: ${errorMessage(err)}`);
          },
        ),
      );
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
          if (this.mode.kind === "picker" && this.mode.picker === p) this.mode = back;
          this.setStatus("error", `✗ ${errorMessage(err)}`);
        },
      ),
    );
  }

  private sourceOf(row: "speechModel" | "transcription"): Source {
    const s = this.speech.settings;
    return row === "speechModel" ? s.speechSource : s.transcriptionSource;
  }

  // ── On-device models ────────────────────────────────────────────────────

  private pickLocal(m: Extract<Mode, { kind: "picker" }>, id: string): void {
    if (id === PIPER_EN_FAMILY) {
      const voices = this.piperVoices();
      const current = this.speech.settings.localSpeechModel;
      const downloaded = voices.find((v) => v.id === current && v.downloaded) ?? voices.find((v) => v.downloaded);
      if (downloaded) {
        this.offer = undefined;
        this.piperFamilyPending = false;
        this.mode = m.back;
        this.speech.setLocalModel("speech", downloaded.id);
        this.track(this.loadVoices());
        this.setStatus("success", `✓ Speech model: ${PIPER_EN_FAMILY} (${piperVoiceLabel(downloaded.id)})`);
        return;
      }
      this.piperFamilyPending = true;
      this.openPicker("voice");
      this.setStatus("info", "Choose a Piper English voice to download");
      return;
    }
    const direction: Direction = m.picker.piper
      ? "speech"
      : directionOf(m.picker.row as "speechModel" | "transcription");
    const model = this.localModels?.find((x) => x.id === id);
    if (!model) return;
    this.deleting = undefined;
    if (this.downloadOf(id)) {
      this.setStatus("info", `${id} is still downloading; it can be chosen once it is done`);
      return;
    }
    if (model.downloaded) {
      this.offer = undefined;
      if (direction === "speech") this.piperFamilyPending = false;
      this.mode = m.back;
      const summary = this.speech.setLocalModel(direction, id);
      if (direction === "speech") this.track(this.loadVoices());
      this.setStatus("success", m.picker.piper ? `✓ Voice: ${piperVoiceLabel(id)}` : `✓ ${summary}`);
      return;
    }
    if (this.offer === id) {
      this.startDownload(model, { direction, picker: m });
      return;
    }
    this.offer = id;
    const shown = m.picker.piper ? piperVoiceLabel(id) : id;
    this.setStatus("warning", `! ${shown} is not downloaded (${formatSize(model.size)}) · Enter downloads it`);
  }

  private downloadKey(id: string): void {
    const model = this.localModels?.find((x) => x.id === id);
    if (!model) return;
    if (model.downloaded) {
      this.setStatus("info", `${id} is already downloaded`);
      return;
    }
    this.startDownload(model);
  }

  private toggleModelSource(m: Extract<Mode, { kind: "picker" }>): void {
    const row = m.picker.row as "speechModel" | "transcription";
    const direction = directionOf(row);
    const next: Source = m.picker.local ? "provider" : "local";
    const summary = this.speech.setSource(direction, next);
    if (direction === "speech") this.piperFamilyPending = false;
    this.offer = undefined;
    this.deleting = undefined;
    if (direction === "speech") this.track(this.loadVoices());
    const p: PickerState = { row, edit: new LineEdit(), selected: 0 };
    m.picker = p;
    if (next === "local") {
      p.local = true;
      const of = (all: LocalModel[]) => localModelIds(direction, all);
      if (this.localModels) p.ids = of(this.localModels);
      this.track(
        this.loadLocal(true).then(
          (all) => {
            p.ids = of(all);
          },
          (err) => {
            if (this.mode === m && m.picker === p) this.mode = m.back;
            this.setStatus("error", `✗ Local models: ${errorMessage(err)}`);
          },
        ),
      );
    } else {
      const kind = kindOf(row);
      const ids = this.models?.[kind].map((x) => x.id);
      if (ids) p.ids = ids;
      else {
        this.track(
          this.loadModels().then(
            (c) => {
              p.ids = c[kind].map((x) => x.id);
            },
            (err) => {
              if (this.mode === m && m.picker === p) this.mode = m.back;
              this.setStatus("error", `✗ ${errorMessage(err)}`);
            },
          ),
        );
      }
    }
    this.setStatus("success", `✓ ${summary}`);
  }

  private deleteKey(id: string): void {
    const model = this.localModels?.find((x) => x.id === id);
    if (!model) return;
    this.offer = undefined;
    if (!model.downloaded && !model.partial) {
      this.setStatus("info", `${id} is not downloaded`);
      return;
    }
    if (this.downloadOf(id)) {
      this.setStatus("info", `${id} is downloading`);
      return;
    }
    if (this.deleting !== id) {
      this.deleting = id;
      this.setStatus("warning", `! Alt+O again uninstalls ${id} (${formatSize(model.size)})`);
      return;
    }
    this.deleting = undefined;
    this.setStatus("busy", `… deleting ${id}`);
    this.track(
      this.speech.local
        .delete(id)
        .then(async (freed) => {
          await this.loadLocal(true).catch(() => {});
          if (this.mode.kind === "picker") {
            const idx = this.pickerItems(this.mode.picker).findIndex((x) => x.id === id);
            if (idx >= 0) this.mode.picker.selected = idx;
          }
          this.setStatus("success", `✓ ${id} deleted · ${formatSize(freed)} freed`);
        })
        .catch((err) => this.setStatus("error", `✗ ${id} was not deleted: ${errorMessage(err)}`)),
    );
  }

  private startDownload(
    model: LocalModel,
    chosen?: { direction: Direction; picker: Extract<Mode, { kind: "picker" }> },
  ): void {
    this.offer = undefined;
    let end: Promise<{ status: string }>;
    try {
      end = this.engine.downloads.start(model, chosen?.direction);
    } catch (err) {
      this.setStatus("info", errorMessage(err));
      return;
    }
    this.setStatus("busy", `… downloading ${model.id} (${formatSize(model.size)})`);
    this.track(
      end.then((e) => {
        if (e.status === "done" && chosen && this.mode === chosen.picker) this.mode = chosen.picker.back;
      }),
    );
  }

  // ── Inputs & editors ────────────────────────────────────────────────────

  private askLanguage(voice: string): void {
    this.mode = { kind: "input", purpose: "language", voice, edit: new LineEdit(), back: this.mode };
  }

  private askSubmitWord(): void {
    const cur = this.speech.settings.dictationSubmitWord;
    this.mode = {
      kind: "input",
      purpose: "submitWord",
      edit: new LineEdit(submitModeOf(cur) === "custom" ? (cur ?? "") : ""),
      back: this.home(),
    };
  }

  private openDictationEditor(kind: "vocabulary" | "commands"): void {
    const editor = this.deps.ui.editor;
    if (!editor) {
      this.setStatus("error", "✗ Pi's multi-line editor is not available in this UI");
      return;
    }
    const s = this.speech.settings;
    const title = kind === "vocabulary" ? "Dictation vocabulary" : "Voice slash commands";
    const prefill =
      kind === "vocabulary"
        ? formatEditorPrefill(VOCAB_EDITOR_HEADER, s.dictationVocabulary)
        : formatEditorPrefill(COMMANDS_EDITOR_HEADER, s.dictationCommands);
    this.track(
      editor(title, prefill).then(
        (raw) => {
          if (raw === undefined || this.disposed) return;
          const lines = stripEditorComments(raw);
          if (kind === "vocabulary") {
            this.speech.setDictationVocabulary(lines);
            const vc = parseVocabulary(lines);
            const n = vc.terms.length + vc.replacements.length;
            this.setStatus("success", n ? `✓ Saved ${n} vocabulary term${n === 1 ? "" : "s"}` : "✓ Vocabulary cleared");
          } else {
            this.speech.setDictationCommands(lines);
            const n = parseVoiceCommands(lines).length;
            this.setStatus(
              "success",
              n ? `✓ Saved ${n} voice command${n === 1 ? "" : "s"}` : "✓ Voice commands cleared",
            );
          }
        },
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  private submit(m: Extract<Mode, { kind: "input" }>): void {
    if (m.purpose === "secret") {
      this.mode = m.back;
      m.resolve(m.edit.value);
      return;
    }
    if (m.purpose === "confirm") {
      this.mode = m.back;
      m.resolve(true);
      return;
    }
    if (m.purpose === "connect") {
      this.connect(m);
      return;
    }
    if (m.purpose === "receiverSshHost") {
      const dest = m.edit.value.trim();
      this.receivers.setMaintenanceHost(dest);
      this.mode = m.back;
      this.setStatus(
        "info",
        dest ? `SSH maintenance host: ${dest} · bridge unchanged` : "SSH maintenance host cleared",
      );
      return;
    }
    if (m.purpose === "submitWord") {
      const val = m.edit.value.trim();
      this.submitCustomActive = false;
      this.rememberedSubmitCustom = val && submitModeOf(val) === "custom" ? val : undefined;
      this.track(
        this.speech.set("submit-word", val).then(
          (summary) => {
            if (this.mode === m) this.mode = m.back;
            this.setStatus("success", `✓ ${summary}`);
          },
          (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
        ),
      );
      return;
    }
    if (m.purpose === "pairAddress") {
      this.connectTo(m);
      return;
    }
    const text = m.edit.value.trim();
    if (!text) return;
    if (m.purpose === "pairCode") {
      this.pairWith(m, text.replace(/\s+/g, ""));
      return;
    }
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

  // ── Receivers & pairing (delegated to Engine.receivers) ─────────────────

  private applyNotice(n: ReceiverNotice): void {
    this.setStatus(n.tone, n.text);
  }

  private openConnect(): void {
    const hosts = this.receivers.sshHosts();
    this.mode = {
      kind: "input",
      purpose: "connect",
      edit: new LineEdit(this.engine.remoteHost ?? ""),
      back: this.home(),
      hosts,
      next: 0,
    };
    this.setStatus("info", hosts.length ? `Your ssh Hosts: ${hosts.join(", ")}` : CONNECT_HOW);
  }

  private connectHost(dest: string): void {
    this.setStatus("busy", `… connecting to ${dest}`);
    this.track(
      this.receivers.connectHost(dest, this.remotePrompts()).then(
        (notice) => {
          this.applyNotice(notice);
          this.reloadLocalAfterRouteChange();
        },
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  private connect(m: Extract<Mode, { kind: "input"; purpose: "connect" }>): void {
    const dest = m.edit.value.trim();
    if (!dest) {
      this.setStatus("info", CONNECT_HOW);
      return;
    }
    if (/^[^@\s/]+:\d+$/.test(dest)) {
      const pair: Extract<Mode, { kind: "input"; purpose: "pairAddress" }> = {
        kind: "input",
        purpose: "pairAddress",
        edit: new LineEdit(dest),
        back: m.back,
      };
      this.mode = pair;
      this.connectTo(pair);
      return;
    }
    this.mode = m.back;
    this.connectHost(dest);
  }

  private fetchLocalReceiver(): void {
    const target = `${process.platform}-${process.arch}`;
    this.setStatus("busy", `… fetching pi-speech-receiver (${target})`);
    this.track(
      this.receivers.fetchLocal().then(
        (n) => this.applyNotice(n),
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  private updateLocalReceiver(): void {
    this.setStatus("busy", `… updating local receiver to v${this.engine.receiverVersion}`);
    this.track(
      this.receivers.updateLocal().then(
        (n) => this.applyNotice(n),
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  private toggleLocalEdition(): void {
    this.track(
      this.receivers.switchLocalEdition(this.remotePrompts()).then(
        (n) => this.applyNotice(n),
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  private toggleRemoteEdition(): void {
    this.track(
      this.receivers.switchRemoteEdition(this.remotePrompts()).then(
        (n) => this.applyNotice(n),
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  private updateRemoteReceiver(): void {
    this.track(
      this.receivers.updateRemote(this.remotePrompts()).then(
        (n) => {
          this.applyNotice(n);
          this.reloadLocalAfterRouteChange();
        },
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  private disconnect(forget = true): void {
    this.track(
      this.receivers.disconnect(forget).then(
        (n) => {
          this.applyNotice(n);
          this.reloadLocalAfterRouteChange();
        },
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  private openReceiverSsh(): void {
    const back = this.home();
    if (back.kind !== "menu" || back.menu !== "bridge") return;
    this.mode = { kind: "menu", menu: "receiverSsh", selected: 0, back };
    this.setStatus("info", "Manage the receiver on the Remote machine without changing the bridge");
  }

  private editReceiverSshHost(): void {
    this.mode = {
      kind: "input",
      purpose: "receiverSshHost",
      edit: new LineEdit(this.receivers.maintenanceHost ?? ""),
      back: this.home(),
      hosts: this.receivers.sshHosts(),
      next: 0,
    };
    this.setStatus("info", "Enter the machine running the receiver, not the address of the forward");
  }

  private maintainReceiver(action: ReceiverSshAction): void {
    if (this.receiverMaintenancePending) return;
    const dest = this.receivers.maintenanceHost;
    if (!dest) {
      this.editReceiverSshHost();
      return;
    }
    const home = this.home();
    const active = () => !this.disposed && this.home() === home;
    const report = (notice: ReceiverNotice) => {
      if (active()) this.applyNotice(notice);
      else this.engine.notify(notice.text, notice.tone === "success" ? "info" : notice.tone);
    };
    this.receiverMaintenancePending = true;
    this.setStatus("busy", `… connecting to ${dest}`);
    this.track(
      this.receivers
        .maintainRemote(action, this.remotePrompts(active))
        .then(report, (err) => report({ tone: "error", text: `✗ ${errorMessage(err)}` }))
        .finally(() => {
          this.receiverMaintenancePending = false;
        }),
    );
  }

  private remotePrompts(active = () => !this.disposed): RemotePrompts {
    const ask = <T>(make: (resolve: (v: T) => void, back: Mode) => Mode, none: T) =>
      new Promise<T>((resolve) => {
        if (!active()) return resolve(none);
        this.pendingPrompt = () => resolve(none);
        this.mode = make((v) => {
          this.pendingPrompt = undefined;
          resolve(v);
        }, this.home());
        this.changed();
      });
    return {
      progress: (text) => {
        if (active()) this.setStatus("busy", text);
      },
      password: (who) =>
        ask<string | undefined>(
          (resolve, back) => ({
            kind: "input",
            purpose: "secret",
            label: `Password for ${who}`,
            edit: new LineEdit(),
            back,
            resolve,
          }),
          undefined,
        ),
      confirm: (question) =>
        ask<boolean>(
          (resolve, back) => ({ kind: "input", purpose: "confirm", question, edit: new LineEdit(), back, resolve }),
          false,
        ),
    };
  }

  private openPairing(): void {
    const home = this.home();
    this.mode = {
      kind: "input",
      purpose: "pairAddress",
      edit: new LineEdit(this.speech.settings.bridgeAddress ?? ""),
      back:
        home.kind === "menu"
          ? home
          : {
              kind: "menu",
              menu: "bridge",
              selected: Math.max(
                0,
                this.menuRows("bridge").findIndex((r) => r.id === "device"),
              ),
            },
    };
  }

  private connectTo(m: Extract<Mode, { kind: "input"; purpose: "pairAddress" }>): void {
    const address = m.edit.value.trim();
    this.setStatus("busy", `… connecting to ${address || "the ssh forward"}`);
    this.track(
      this.receivers.pairAddress(address).then(
        (r) => {
          if (r.state === "connected") {
            if (this.mode === m) this.mode = m.back;
            this.setStatus(r.tone, r.text);
            if (r.usedBridge) this.reloadLocalAfterRouteChange();
            return;
          }
          if (this.mode === m) {
            this.mode = { kind: "input", purpose: "pairCode", address: r.address, edit: new LineEdit(), back: m.back };
          }
          const minutes = r.expiresIn >= 60 ? `${Math.round(r.expiresIn / 60)} min` : `${r.expiresIn} s`;
          this.setStatus(
            "info",
            `No token of This machine works there: type the code the receiver at ${r.address} shows on its terminal (it expires in ${minutes})`,
          );
        },
        (err) => this.setStatus("error", `✗ ${errorMessage(err)}`),
      ),
    );
  }

  private pairWith(m: Extract<Mode, { kind: "input"; purpose: "pairCode" }>, code: string): void {
    this.setStatus("busy", "… pairing");
    this.track(
      this.receivers.pairCode(m.address, code).then((r) => {
        if (r.ok) {
          if (this.mode === m) this.mode = m.back;
          this.setStatus(r.tone, r.text);
          this.reloadLocalAfterRouteChange();
          return;
        }
        if (r.kind === "wrong" && r.attemptsLeft !== 0) {
          m.edit.clear();
          const left = r.attemptsLeft === undefined ? "" : ` (${r.attemptsLeft} attempts left)`;
          this.setStatus("error", `✗ ${r.message}${left}`);
          return;
        }
        if (r.kind !== "other") {
          if (this.mode === m) {
            this.mode = { kind: "input", purpose: "pairAddress", edit: new LineEdit(m.address), back: m.back };
          }
          this.setStatus("error", `✗ ${r.message}: Enter asks for a new code`);
          return;
        }
        this.setStatus("error", `✗ ${r.message}`);
      }),
    );
  }

  // ── Speech, playback, dictation ─────────────────────────────────────────

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

  private transcribe(path: string, m: Mode): void {
    if (this.transcribing) return;
    this.transcribing = true;
    this.setStatus("busy", `… transcribing ${path.split(/[\\/]/).pop() || path}`);
    const language = this.speech.settings.dictationLanguage;
    this.track(
      this.speech
        .transcribeFile(path, { cwd: this.deps.ui.cwd, language })
        .then((text) => {
          const transcript = text.trim();
          if (!transcript) throw new Error("no speech was recognized in the audio file");
          if (this.mode === m) this.close();
          this.deps.ui.paste(transcript);
        })
        .catch((err) => this.setStatus("error", `✗ ${errorMessage(err)}`))
        .finally(() => {
          this.transcribing = false;
        }),
    );
  }

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

  private replay(): void {
    const seq = ++this.playSeq;
    const busy = this.setStatus("busy", "♪ speaking…");
    this.track(
      this.engine.replay().then(
        () => {
          if (seq === this.playSeq) this.playing(busy);
        },
        (err) => {
          if (seq === this.playSeq) this.setStatus("error", `✗ ${errorMessage(err)}`);
        },
      ),
    );
  }

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

  private dictate(): void {
    const m = this.mode;
    if (m.kind === "input" && m.purpose === "speak") {
      const edit = m.edit;
      const inComposer = () =>
        !this.disposed && this.mode.kind === "input" && this.mode.purpose === "speak" && this.mode.edit === edit;
      const ui = {
        notify: (message: string, level: "info" | "warning" | "error") => {
          if (inComposer()) {
            this.setStatus(level === "info" ? "info" : "error", level === "info" ? message : `✗ ${message}`);
            this.changed();
          } else {
            this.deps.ui.notify(message, level);
          }
        },
        paste: (text: string) => {
          if (inComposer()) {
            edit.insert(text);
            this.changed();
          } else {
            this.deps.ui.paste(text);
          }
        },
      };
      void this.engine.dictation.toggle(ui).catch((err) => ui.notify(errorMessage(err), "error"));
      return;
    }
    this.close();
    void this.engine.dictation.toggle(this.deps.ui).catch((err) => this.deps.ui.notify(errorMessage(err), "error"));
  }

  private localVoice(): { voice: string } | undefined {
    const s = this.speech.settings;
    return s.speechSource === "local" ? { voice: s.localSpeechVoice ?? "" } : undefined;
  }

  private sample(voice: string): void {
    const seq = ++this.sampleSeq;
    this.setStatus("busy", `♪ sampling ${voice || "default"}…`);
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
        this.modelsLoad = undefined;
        this.modelsError = errorMessage(err);
        throw err;
      },
    );
    return this.modelsLoad;
  }

  private loadLocal(fresh = false): Promise<LocalModel[]> {
    if (fresh) this.localLoad = undefined;
    if (this.localLoad) return this.localLoad;
    const seq = ++this.localSeq;
    this.localLoad = this.speech.local.list().then(
      (all) => {
        if (seq >= this.localApplied) {
          this.localApplied = seq;
          this.localModels = all;
          this.localError = undefined;
          if (this.mode.kind === "picker" && this.mode.picker.piper) {
            this.mode.picker.ids = all.filter((m) => m.kind === "speech" && isSingleVoicePiper(m)).map((m) => m.id);
          } else if (this.mode.kind === "picker" && this.mode.picker.local && isModelRow(this.mode.picker.row)) {
            const kind = directionOf(this.mode.picker.row);
            this.mode.picker.ids = localModelIds(kind, all);
          }
        }
        return this.localModels ?? all;
      },
      (err) => {
        this.localLoad = undefined;
        this.localError = errorMessage(err);
        throw err;
      },
    );
    return this.localLoad;
  }

  private voicesKey(): string {
    const s = this.speech.settings;
    return s.speechSource === "local"
      ? `local:${this.engine.routes.modelsRoute}:${s.localSpeechModel ?? ""}`
      : s.speechModel;
  }

  private currentVoices(): string[] | undefined {
    const v = this.voices;
    return v?.model === this.voicesKey() ? v.ids : undefined;
  }

  private loadVoices(): Promise<string[]> {
    const s = this.speech.settings;
    const model = this.voicesKey();
    if (this.voices?.model === model && !this.voices.error) return this.voices.load;
    const local = s.speechSource === "local" ? s.localSpeechModel : undefined;
    const voices =
      s.speechSource !== "local"
        ? this.speech.voicesFor(model)
        : this.piperFamilyPending || isSingleVoicePiper(local)
          ? this.loadLocal().then((all) => {
              if (local && isSingleVoicePiper(local)) {
                this.speech.localVoices(local).then(
                  (ids) => {
                    this.piperSpeakers = { model: local, ids };
                    this.changed();
                  },
                  () => {},
                );
              }
              return all.filter((m) => m.kind === "speech" && isSingleVoicePiper(m)).map((m) => m.id);
            })
          : local
            ? this.loadLocal().then((all) => {
                const found = all.find((m) => m.id === local);
                return found && !found.downloaded ? [] : this.speech.localVoices(local);
              })
            : Promise.resolve([]);
    const entry: NonNullable<Panel["voices"]> = {
      model,
      load: voices.then(
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

  private probe(): Promise<void> {
    const done = this.receivers.probeHealth(() => this.changed());
    this.track(done);
    return done;
  }

  private startPairing(): void {
    this.stopPairing();
    this.receivers.pairing = "checking";
    this.track(this.receivers.probePairing());
    this.pairTimer = setInterval(() => {
      const home = this.home();
      if (this.disposed || home.kind !== "menu" || (home.menu !== "bridge" && home.menu !== "receiverSsh"))
        this.stopPairing();
      else this.track(this.receivers.probePairing());
    }, this.deps.pairingMs ?? 2000);
    this.pairTimer.unref?.();
  }

  private stopPairing(): void {
    if (this.pairTimer) clearInterval(this.pairTimer);
    this.pairTimer = undefined;
  }

  // ── Plumbing ────────────────────────────────────────────────────────────

  private clearStatus(): void {
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    this.status = undefined;
  }

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
