/**
 * Pure picker view-model projection, filtering, sorting, and typed column definitions for the /speech panel.
 */

import type { VoiceLanguage } from "../voice-language/index";
import type { ActiveDownload } from "./downloads";
import { featureLine, inlineTags, type ModelKind, vendorOf } from "./features";
import type { HistoryMessage } from "./history";
import { formatSize, isSingleVoicePiper, type LocalModel, PIPER_EN_FAMILY, piperVoiceLabel } from "./local-models";
import { priceValue } from "./pricing";
import type { ModelOption, SpeechCatalog } from "./provider";
import type { LocalModelSort, ModelSort, Settings } from "./settings";
import { type Direction, languageLabel } from "./speech";

export interface PickerColumn {
  header: string;
  sortKey?: string;
  hideIfUniform?: boolean;
}

export interface PickerItem {
  /** The value saved when it is picked. */
  id: string;
  /** How it is shown and matched: the id, or a name for it (xAI Grok for xai). */
  label: string;
  /** Provider badge shown in the `[Provider]` column when present. */
  provider?: string;
  /** First right-aligned column value (price per minute or archive size). */
  price?: string;
  /** Searchable metadata (`tags · 90+ langs · fast`, or voice language). */
  note?: string;
  /** Remaining right-aligned columns after `price`. */
  cols?: string[];
  current: boolean;
}

export interface PickerView {
  title: string;
  /** A model list: how it is ordered (Ctrl+S changes it): `price`, `provider`, `newest`, `name`. */
  sort?: string;
  /** A model list: what the catalog says about the highlighted model; empty when it says nothing. */
  detail?: string;
  /** What the items are, for the count: `models`, `voices`, `messages`. */
  noun: string;
  /** Column header for the primary label column (`Model`, `Voice`, `Message`). */
  nounHeader?: string;
  /** Column header for `PickerItem.provider` when present (`Provider`). */
  providerHeader?: string;
  /** Typed definitions for `[price, ...cols]` right-aligned columns. */
  columns?: PickerColumn[];
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

export type ListRow = "speechModel" | "transcription" | "voice";
export type PickerRow = ListRow | "history" | "summarizer";

export interface PickerInput {
  row: PickerRow;
  ids?: string[];
  messages?: HistoryMessage[];
  query: string;
  cursor: number;
  selected: number;
  local?: boolean;
  piper?: boolean;
}

export const XAI_LABEL = "xAI Grok";
export const SAME_MODEL = "same";
export const SAME_MODEL_LABEL = "Same model";
const PRICE_UNKNOWN = "unknown";

export const isModelRow = (row: PickerRow): row is "speechModel" | "transcription" =>
  row === "speechModel" || row === "transcription";
export const kindOf = (row: "speechModel" | "transcription"): ModelKind => (row === "speechModel" ? "tts" : "stt");
export const directionOf = (
  row: "speechModel" | "transcription" | "speechSource" | "transcriptionSource",
): Direction => (row === "speechModel" || row === "speechSource" ? "speech" : "transcription");
export const modelLabel = (id: string, catalog?: SpeechCatalog) => {
  const found = catalog?.tts.find((m) => m.id === id) ?? catalog?.stt.find((m) => m.id === id);
  return found?.shortLabel ?? id;
};
export const isPricedModel = (m: ModelOption, current?: string) =>
  Boolean(m.unpricedExempt) || Boolean(m.price) || m.id === current;

const LABEL_OF: Record<PickerRow, string> = {
  speechModel: "Speech model",
  transcription: "Transcription model",
  voice: "Voice",
  history: "History",
  summarizer: "Summarized by",
};

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

function fallbackRank(id: string, edition: "cpu" | "gpu"): number {
  if (edition === "gpu") {
    if (id.startsWith("orpheus-") || id.startsWith("zonos3-") || id.startsWith("qwen3-tts-")) return 0;
    if (id.startsWith("phonon-") || id.startsWith("kokoro-")) return 1;
    return 2;
  }
  if (id.startsWith("phonon-") || id.startsWith("kokoro-")) return 0;
  if (id.startsWith("orpheus-") || id.startsWith("zonos3-") || id.startsWith("qwen3-tts-")) return 2;
  return 1;
}

function localModelRank(m: LocalModel, edition: "cpu" | "gpu"): number {
  const explicit = edition === "gpu" ? m.gpuRank : m.cpuRank;
  return explicit ?? fallbackRank(m.id, edition);
}

function piperRecRank(m: LocalModel): number {
  const multi = (m.speakers ?? 0) > 1 || /libritts|vctk|semaine|aru/.test(m.id) ? 2 : 0;
  const medium = m.id.endsWith("-medium") ? 1 : 0;
  return multi + medium;
}

type LocalSortable = {
  item: PickerItem;
  size: number;
  stateRank: number;
  ready: boolean;
  recRank: number;
};

function compareLocal(sort: LocalModelSort): (a: LocalSortable, b: LocalSortable) => number {
  return (a, b) => {
    switch (sort) {
      case "size":
        return a.size - b.size || a.item.id.localeCompare(b.item.id);
      case "size-desc":
        return b.size - a.size || a.item.id.localeCompare(b.item.id);
      case "state":
        return a.stateRank - b.stateRank || a.item.id.localeCompare(b.item.id);
      case "state-desc":
        return b.stateRank - a.stateRank || a.item.id.localeCompare(b.item.id);
      case "name":
        return a.item.label.localeCompare(b.item.label);
      case "name-desc":
        return b.item.label.localeCompare(a.item.label);
      default:
        return (
          Number(b.item.current) - Number(a.item.current) ||
          Number(b.ready) - Number(a.ready) ||
          a.recRank - b.recRank ||
          a.item.id.localeCompare(b.item.id)
        );
    }
  };
}

function priceOf(m: ModelOption): string {
  if (m.priceLabel) return m.priceLabel;
  const p = m.price ?? PRICE_UNKNOWN;
  return p === "$0" ? "free" : p;
}

const cmp = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
const priceRank = (m: ModelOption) =>
  m.unpricedExempt ? Number.POSITIVE_INFINITY : (priceValue(m.price) ?? Number.POSITIVE_INFINITY);
const vendor = (m: ModelOption) => m.vendor ?? vendorOf(m.id);
const byName = (a: ModelOption, b: ModelOption) => (a.shortLabel ?? a.id).localeCompare(b.shortLabel ?? b.id);
const byPrice = (a: ModelOption, b: ModelOption) => cmp(priceRank(a), priceRank(b)) || byName(a, b);
const byPriceDesc = (a: ModelOption, b: ModelOption) => {
  const pa = priceRank(a);
  const pb = priceRank(b);
  if (!Number.isFinite(pa) && !Number.isFinite(pb)) return byName(a, b);
  if (!Number.isFinite(pa)) return 1;
  if (!Number.isFinite(pb)) return -1;
  return cmp(pb, pa) || byName(a, b);
};

const MODEL_ORDER: Record<ModelSort, (a: ModelOption, b: ModelOption) => number> = {
  price: byPrice,
  "price-desc": byPriceDesc,
  provider: (a, b) => vendor(a).localeCompare(vendor(b), undefined, { sensitivity: "base" }) || byPrice(a, b),
  "provider-desc": (a, b) => vendor(b).localeCompare(vendor(a), undefined, { sensitivity: "base" }) || byPrice(a, b),
  newest: (a, b) => cmp(b.created ?? 0, a.created ?? 0) || byName(a, b),
  name: byName,
  "name-desc": (a, b) => byName(b, a),
};

export interface PickerContext {
  settings: Settings;
  models?: SpeechCatalog;
  localModels?: LocalModel[];
  edition: "cpu" | "gpu";
  modelsRoute: "local" | "bridge";
  modelHost?: string;
  piperFamilyPending: boolean;
  downloadOf(id: string): ActiveDownload | undefined;
  providerName(id: string): string;
  emptyVoicesReason(model: string): string;
  enrichModel?(option: ModelOption): ModelOption;
  voiceLanguage(model: string, voice: string): VoiceLanguage;
}

export function localModelIds(kind: Direction, all: LocalModel[]): string[] {
  const ofKind = all.filter((m) => m.kind === kind);
  if (kind !== "speech") return ofKind.map((m) => m.id);
  const ids: string[] = [];
  let addedPiper = false;
  for (const m of ofKind) {
    if (isSingleVoicePiper(m)) {
      if (!addedPiper) {
        ids.push(PIPER_EN_FAMILY);
        addedPiper = true;
      }
    } else {
      ids.push(m.id);
    }
  }
  return ids;
}

export function modelOptionsFor(
  row: "speechModel" | "transcription",
  ids: readonly string[] | undefined,
  catalog: SpeechCatalog | undefined,
  enrich?: (option: ModelOption) => ModelOption,
): ModelOption[] {
  const listed = catalog?.[kindOf(row)] ?? [];
  return (ids ?? []).map((id) => {
    const opt = listed.find((m) => m.id === id) ?? { id, label: id };
    return enrich ? enrich(opt) : opt;
  });
}

export function buildPickerItems(p: PickerInput, ctx: PickerContext): PickerItem[] {
  const s = ctx.settings;
  const stateRankOf = (m: LocalModel) => (m.downloaded ? 0 : ctx.downloadOf(m.id)?.id === m.id ? 1 : m.partial ? 2 : 3);
  const dlState = (m: LocalModel) => {
    const d = ctx.downloadOf(m.id);
    return d?.id === m.id
      ? d.progress?.phase === "progress" && d.progress.total
        ? `downloading ${Math.floor((d.progress.done / d.progress.total) * 100)}%`
        : (d.progress?.phase ?? "downloading")
      : m.downloaded
        ? "downloaded"
        : m.partial
          ? "partly downloaded"
          : "not downloaded";
  };

  if (p.piper) {
    const models = (p.ids ?? []).flatMap((id) => ctx.localModels?.find((m) => m.id === id) ?? []);
    const rows = models.map((m): LocalSortable => {
      const state = dlState(m);
      return {
        item: {
          id: m.id,
          label: piperVoiceLabel(m),
          price: formatSize(m.size),
          note: `${m.name} ${state}`,
          cols: [state],
          current: m.id === s.localSpeechModel,
        },
        size: m.size,
        stateRank: stateRankOf(m),
        ready: m.downloaded,
        recRank: piperRecRank(m),
      };
    });
    const sorted = [...rows].sort(compareLocal(s.localModelSort)).map((r) => r.item);
    return matchItems(sorted, p.query, (i) => `${i.label} ${i.id} ${i.note ?? ""}`);
  }

  if (p.local && isModelRow(p.row)) {
    const current = p.row === "speechModel" ? s.localSpeechModel : s.localTranscriptionModel;
    const piperVoices = (ctx.localModels ?? []).filter((m) => m.kind === "speech" && isSingleVoicePiper(m));
    const rows = (p.ids ?? []).flatMap((id): LocalSortable[] => {
      if (id === PIPER_EN_FAMILY) {
        if (!piperVoices.length) return [];
        const dlCount = piperVoices.filter((x) => x.downloaded).length;
        const active = piperVoices.some((x) => x.id === current) || ctx.piperFamilyPending;
        const minSize = Math.min(...piperVoices.map((x) => x.size));
        const groupRank = Math.min(...piperVoices.map((x) => localModelRank(x, ctx.edition)));
        return [
          {
            item: {
              id: PIPER_EN_FAMILY,
              label: PIPER_EN_FAMILY,
              price: "67–116 MB",
              note: `Piper English (${piperVoices.length} voices, choose in Voice)`,
              cols: [`${dlCount}/${piperVoices.length} downloaded`, "en", ""],
              current: active,
            },
            size: minSize,
            stateRank: dlCount > 0 ? 0 : 3,
            ready: dlCount > 0,
            recRank: groupRank,
          },
        ];
      }
      const m = ctx.localModels?.find((x) => x.id === id);
      if (!m) return [];
      const state = dlState(m);
      const langs = m.languages.includes("mul")
        ? "many langs"
        : m.languages.length > 4
          ? `${m.languages.length} langs`
          : m.languages.join(" ");
      return [
        {
          item: {
            id: m.id,
            label: m.id,
            price: formatSize(m.size),
            note: `${m.name} ${state}`,
            cols: [state, langs, p.row === "speechModel" ? (inlineTags(m) ?? "") : ""],
            current: m.id === current,
          },
          size: m.size,
          stateRank: stateRankOf(m),
          ready: m.downloaded,
          recRank: localModelRank(m, ctx.edition),
        },
      ];
    });
    const sorted = [...rows].sort(compareLocal(s.localModelSort)).map((r) => r.item);
    return matchItems(sorted, p.query, (i) => `${i.label} ${i.note ?? ""}`);
  }

  if (p.row === "history") {
    const all = (p.messages ?? []).map(
      (m): PickerItem => ({ id: m.file, label: `${m.time}  ${m.title}`, current: false }),
    );
    return matchItems(all, p.query, (i) => i.label);
  }

  if (p.row === "summarizer") {
    const current = s.readAloud.summarizer ?? SAME_MODEL;
    const all = (p.ids ?? []).map(
      (id): PickerItem => ({ id, label: id === SAME_MODEL ? SAME_MODEL_LABEL : id, current: id === current }),
    );
    return matchItems(all, p.query, (i) => i.label);
  }

  if (p.row === "voice" && s.speechSource === "local") {
    const ids = p.ids ?? [];
    const current = s.localSpeechVoice ?? ids[0];
    const all = ids.map(
      (id, i): PickerItem => ({ id, label: id, cols: [i === 0 ? "default" : ""], current: id === current }),
    );
    return matchItems(all, p.query, (i) => i.id);
  }

  if (p.row === "voice") {
    const all = (p.ids ?? []).map(
      (id): PickerItem => ({
        id,
        label: id,
        cols: [voiceNote(ctx.voiceLanguage(s.speechModel, id))],
        current: id === s.voice,
      }),
    );
    return matchItems(all, p.query, (i) => i.id);
  }

  const current = p.row === "speechModel" ? s.speechModel : s.transcriptionModel;
  const options = modelOptionsFor(p.row, p.ids, ctx.models, ctx.enrichModel);
  const shown = s.showUnpricedModels ? options : options.filter((m) => isPricedModel(m, current));
  const kind = kindOf(p.row);
  const items = [...shown].sort(MODEL_ORDER[s.modelSort]).map((m): PickerItem => {
    const note = m.pickerNote ?? featureLine(m);
    const provider = ctx.providerName(m.id);
    const cols =
      kind === "tts"
        ? m.voicesUnknown
          ? ["", inlineTags(m) ?? ""]
          : [`${m.voices?.length || 1} voice${(m.voices?.length || 1) === 1 ? "" : "s"}`, inlineTags(m) ?? ""]
        : [];
    return {
      id: m.id,
      label: m.shortLabel ?? m.id,
      provider,
      price: priceOf(m),
      ...(note ? { note } : {}),
      cols,
      current: m.id === current,
    };
  });
  return matchItems(items, p.query, (i) => `${i.label === i.id ? i.id : `${i.label} ${i.id}`} ${i.note ?? ""}`);
}

export function buildPickerView(p: PickerInput, ctx: PickerContext): PickerView {
  const items = buildPickerItems(p, ctx);
  const selected = Math.max(0, Math.min(p.selected, items.length - 1));
  const none =
    p.row === "history"
      ? "Nothing spoken yet"
      : p.row === "voice" && ctx.settings.speechSource === "local"
        ? ctx.settings.localSpeechModel
          ? "The model lists no voices"
          : "Choose a local speech model first"
        : p.row === "voice"
          ? ctx.emptyVoicesReason(ctx.settings.speechModel)
          : "None offered";

  const noun = p.row === "voice" ? "voices" : p.row === "history" ? "messages" : "models";
  const nounHeader = p.row === "voice" ? "Voice" : p.row === "history" ? "Message" : "Model";
  const view: PickerView = {
    title: LABEL_OF[p.row],
    noun,
    nounHeader,
    query: p.query,
    cursor: p.cursor,
    items,
    selected,
    total: p.ids?.length ?? 0,
    loading: !p.ids,
    empty: p.ids?.length === 0 ? none : "No matches",
  };

  if (p.piper) {
    view.columns = [
      { header: "Size", sortKey: "size" },
      { header: "State", sortKey: "state" },
    ];
    view.sort = ctx.settings.localModelSort;
    view.detail = "Piper English · downloads per voice";
    if (p.ids?.length === 0) view.empty = "No Piper English voices in catalogue";
  } else if (p.local) {
    view.columns = [
      { header: "Size", sortKey: "size" },
      { header: "State", sortKey: "state" },
      { header: "Languages" },
      ...(p.row === "speechModel" ? [{ header: "Tags" }] : []),
    ];
    view.sort = ctx.settings.localModelSort;
    view.detail = `Models on ${ctx.modelHost ?? (ctx.modelsRoute === "bridge" ? "receiver" : "Pi host")}`;
    if (p.ids?.length === 0) view.empty = "No local models of this kind";
  } else if (isModelRow(p.row)) {
    view.providerHeader = "Provider";
    view.columns =
      p.row === "speechModel"
        ? [{ header: "Price", sortKey: "price" }, { header: "Voices" }, { header: "Tags" }]
        : [{ header: "Price", sortKey: "price" }];
    const id = items[selected]?.id;
    const options = modelOptionsFor(p.row, p.ids, ctx.models, ctx.enrichModel);
    const current = p.row === "speechModel" ? ctx.settings.speechModel : ctx.settings.transcriptionModel;
    const m = options.find((x) => x.id === id);
    view.sort = ctx.settings.modelSort;
    const desc = m?.description ?? "";
    const hiddenCount = ctx.settings.showUnpricedModels ? 0 : options.filter((x) => !isPricedModel(x, current)).length;
    if (hiddenCount > 0) {
      const note = `${hiddenCount} ${hiddenCount === 1 ? "model" : "models"} without price hidden · F4 shows them`;
      view.detail = desc ? `${desc} · ${note}` : note;
    } else {
      view.detail = desc;
    }
  } else if (p.row === "voice") {
    view.columns =
      ctx.settings.speechSource === "local"
        ? [{ header: "" }, { header: "" }]
        : [{ header: "" }, { header: "Language", hideIfUniform: true }];
  } else {
    view.columns = [];
  }
  return view;
}
