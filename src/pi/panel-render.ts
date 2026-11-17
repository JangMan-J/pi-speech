/**
 * Draws the /speech panel inside the shared picker frame (src/pi/frame.ts): a pure function of the panel's
 * view model (src/engine/panel.ts), the terminal width, and a style. Widths are measured on plain text and
 * styles applied afterwards, so no line is ever wider than `termWidth`, and every state reads the same
 * without colour (symbols and words carry it).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Hint, PanelView, PickerItem, PickerView, StatusTone } from "../engine/panel";
import {
  contentWidth,
  FRAME_ROWS,
  type FrameSort,
  type FrameStyle,
  frameLines,
  type Measure,
  sortArrow,
  spread,
} from "./frame";

export interface PanelStyle {
  accent(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  /** The text cursor in an input. */
  cursor(text: string): string;
  /** The active tab, including its padding. */
  selected(text: string): string;
}

const same = (text: string) => text;

/** No styling at all: what a test or a dumb terminal sees. */
export const PLAIN: PanelStyle = {
  accent: same,
  bold: same,
  dim: same,
  success: same,
  error: same,
  warning: same,
  cursor: same,
  selected: same,
};

/** Below this only a one-line message is drawn. */
export const MIN_WIDTH = 40;
/** Keep the right edge of the table centered (`termWidth / 2`) on fullscreen terminals. */
export const RIGHT_COLS_W = 0;

const CURSOR = "▶ ";
const NO_MARKER = "  ";
const GAP = 2;
/** The label column: two spaces after the longest label, and never narrower than this when room allows. */
const MIN_LABEL = 19;
/** The mark at the end of a row whose Enter opens a list or a submenu. */
const OPENS = " ›";
/** An extra column is never wider than this, so one outlier value is cut rather than stretching the table. */
const COL_CAP = 24;
/** The separator between a value and its note: `value · note`. */
const SEP = " · ";

const width = (text: string) => visibleWidth(text);
const frameMeasure: Measure = { width: visibleWidth, truncate: (text, w) => truncateToWidth(text, w, "…") };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** How many columns the panel's text uses in a terminal this wide. */
export function panelContentWidth(termWidth: number): number {
  return contentWidth(termWidth, RIGHT_COLS_W);
}

/** Plain text cut to `w` columns with …, on grapheme boundaries. */
export function cutText(text: string, w: number): string {
  if (w <= 0) return "";
  if (width(text) <= w) return text;
  if (w === 1) return "…";
  let out = "";
  let used = 0;
  for (const { segment } of graphemes.segment(text)) {
    const sw = width(segment);
    if (used + sw > w - 1) break;
    out += segment;
    used += sw;
  }
  return `${out}…`;
}

/** Plain text word-wrapped to `w` columns without dropping words. */
export function wrapText(text: string, w: number): string[] {
  const room = Math.max(1, w);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let rest = raw.replace(/[ \t\r]+/g, " ").trim();
    if (!rest) {
      out.push("");
      continue;
    }
    while (rest) {
      if (width(rest) <= room) {
        out.push(rest);
        break;
      }
      let segs = "";
      let used = 0;
      let spaceAt = -1;
      for (const { segment } of graphemes.segment(rest)) {
        const sw = width(segment);
        if (used + sw > room) break;
        segs += segment;
        used += sw;
        if (segment === " ") spaceAt = segs.length - 1;
      }
      if (spaceAt > 0) {
        out.push(segs.slice(0, spaceAt).trimEnd());
        rest = rest.slice(spaceAt + 1).trimStart();
      } else {
        const chunk = segs || [...graphemes.segment(rest)][0]?.segment || rest[0];
        out.push(chunk);
        rest = rest.slice(chunk.length).trimStart();
      }
    }
  }
  return out;
}

/** Fit a ` · `-joined cell to `w` columns on whole tokens, dropping trailing ones; a lone long token is cut. */
function fitColumn(cell: string, w: number): string {
  if (width(cell) <= w) return cell;
  const parts = cell.split(SEP);
  if (parts.length === 1) return cutText(cell, w);
  let out = parts[0];
  if (width(out) > w) return cutText(out, w);
  for (let i = 1; i < parts.length; i++) {
    const next = `${out}${SEP}${parts[i]}`;
    if (width(next) > w) break;
    out = next;
  }
  return out;
}

const pad = (text: string, w: number) => text + " ".repeat(Math.max(0, w - width(text)));
const spaces = (n: number) => " ".repeat(Math.max(0, n));

/** The live state: the recording dot in the error colour (as in the footer), speaking in the accent. */
function stateStyle(state: string, s: PanelStyle): (t: string) => string {
  if (state.startsWith("●")) return (t) => (t.startsWith("●") ? s.error("●") + t.slice(1) : t);
  if (state.startsWith("▶")) return s.accent;
  if (state.startsWith("…")) return s.warning;
  return s.dim;
}

function toneStyle(tone: StatusTone, s: PanelStyle): (t: string) => string {
  switch (tone) {
    case "success":
      return s.success;
    case "error":
      return s.error;
    case "warning":
      return s.warning;
    case "busy":
      return s.accent;
    default:
      return same;
  }
}

/** The hints that fit in `w`: optional ones give way first (the last first), then the first ones; Esc stays. */
function hintLine(hints: Hint[], w: number, s: PanelStyle): string {
  if (!hints.length || w <= 0) return "";
  const text = (hs: Hint[]) => hs.map((h) => (h.action ? `${h.key} ${h.action}` : h.key)).join(SEP);
  const kept = [...hints];
  for (let i = kept.length - 1; i >= 0 && width(text(kept)) > w; i--) {
    if (kept[i].optional) kept.splice(i, 1);
  }
  while (kept.length > 1 && width(text(kept)) > w) kept.splice(0, 1);
  return s.dim(cutText(text(kept), w));
}

// ── Values and their notes ───────────────────────────────────────────────

interface Entry {
  value: string;
  note?: string;
  short?: string;
  alert?: boolean;
  opens?: boolean;
}

/**
 * One value drawn tight in `room` columns: `value · note ›`, the note in dim right after the value. When it does
 * not fit the note gives way to its short form, then goes; only then is the value itself cut with …. A row that
 * opens a list keeps its › at the end; an alert keeps its ✗ beside the value when its note is gone.
 */
function drawEntry(e: Entry, room: number, s: PanelStyle, valueStyle: (t: string) => string): string {
  const chev = e.opens ? OPENS : "";
  const chevW = width(chev);
  const chevStyled = chev ? s.dim(chev) : "";
  const factStyle = e.alert ? s.error : s.dim;
  const tails: Array<{ plain: string; styled: string }> = [];
  const fact = (parts: string[]) => {
    const text = parts.length ? SEP + parts.join(SEP) : "";
    tails.push({ plain: text, styled: text ? factStyle(text) : "" });
  };
  if (e.note) fact([e.note]);
  if (e.short) fact([e.short]);
  if (e.alert) tails.push({ plain: " ✗", styled: s.error(" ✗") });
  fact([]);
  for (const t of tails) {
    if (width(e.value) + width(t.plain) + chevW <= room) {
      return valueStyle(e.value) + t.styled + chevStyled;
    }
  }
  const mark = e.alert ? " ✗" : "";
  const v = cutText(e.value, Math.max(0, room - chevW - width(mark)));
  return valueStyle(v) + (mark ? s.error(mark) : "") + chevStyled;
}

/** A text field of at most `room` columns: the text around the cursor, or the placeholder when empty. */
export function renderField(
  value: string,
  cursor: number,
  placeholder: string,
  room: number,
  s: PanelStyle,
): { text: string; width: number } {
  const maxRoom = Math.max(1, room);
  if (!value) {
    const hint = placeholder ? cutText(placeholder, Math.max(0, maxRoom - 2)) : "";
    return { text: s.cursor(" ") + (hint ? ` ${s.dim(hint)}` : ""), width: 1 + (hint ? 1 + width(hint) : 0) };
  }
  const chars = [...value];
  const clamped = Math.max(0, Math.min(cursor, chars.length));
  let start = 0;
  while (start < clamped && width(chars.slice(start, clamped).join("")) + 1 > maxRoom) start++;
  const parts: string[] = [];
  let used = 0;
  for (let i = start; i < chars.length; i++) {
    const cw = width(chars[i]);
    if (used + cw > maxRoom) break;
    parts.push(chars[i]);
    used += cw;
  }
  const at = clamped - start;
  const end = at >= parts.length;
  return {
    text: parts.slice(0, at).join("") + s.cursor(parts[at] ?? " ") + parts.slice(at + 1).join(""),
    width: used + (end ? 1 : 0),
  };
}

// ── Frame parts ──────────────────────────────────────────────────────────

function renderTabs(view: PanelView, w: number, s: PanelStyle): string {
  const tabs = view.tabs;
  if (!tabs.length) return "";
  const at = Math.max(
    0,
    tabs.findIndex((t) => t.id === view.tab),
  );
  const seg = (i: number) => ` ${tabs[i].label} `;
  const fits = (lo: number, hi: number) => {
    let used = 2 + (lo > 0 ? 3 : 0) + (hi < tabs.length - 1 ? 3 : 0);
    for (let i = lo; i <= hi; i++) used += width(seg(i)) + (i > lo ? 1 : 0);
    return used <= w;
  };
  let lo = 0;
  let hi = tabs.length - 1;
  while (hi > at && !fits(lo, hi)) hi--;
  while (lo < at && !fits(lo, hi)) lo++;
  while (hi + 1 < tabs.length && fits(lo, hi + 1)) hi++;
  while (lo > 0 && fits(lo - 1, hi)) lo--;
  const parts: string[] = [];
  for (let i = lo; i <= hi; i++) {
    parts.push(i === at ? s.selected(s.accent(s.bold(seg(i)))) : s.dim(seg(i)));
  }
  return `  ${lo > 0 ? s.dim("<< ") : ""}${parts.join(s.dim("│"))}${hi < tabs.length - 1 ? s.dim(" >>") : ""}`;
}

function renderInput(view: PanelView, w: number, s: PanelStyle): string {
  const line = (label: string, text: string) => `  ${s.dim(`${label}: `)}${s.dim("> ")}${text}`;
  const fitLabel = (raw: string) => cutText(raw, Math.max(1, w - 10));
  const room = (label: string) => Math.max(2, w - 2 - width(`${label}: > `));
  if (view.input) {
    const input = view.input;
    const rawLabel = input.label || view.rows[view.selected]?.label || "Value";
    const label = fitLabel(rawLabel);
    const value = input.secret ? "•".repeat([...input.value].length) : input.value;
    return line(label, renderField(value, input.cursor, input.placeholder, room(label), s).text);
  }
  if (view.picker) {
    const label = fitLabel("Search");
    return line(label, renderField(view.picker.query, view.picker.cursor, "", room(label), s).text);
  }
  if (view.speak) {
    const speak = view.speak;
    const label = fitLabel("Speak");
    const r = room(label);
    const text = speak.focused
      ? renderField(speak.value, speak.cursor, speak.placeholder, r, s).text
      : speak.value
        ? cutText(speak.value, r)
        : s.dim(cutText(speak.placeholder, r));
    return line(label, text);
  }
  return "";
}

/** First of FRAME_ROWS rows shown, keeping the selected row near the middle. */
const windowStart = (selected: number, count: number) =>
  Math.max(0, Math.min(Math.max(0, selected) - Math.floor(FRAME_ROWS / 2), count - FRAME_ROWS));

function renderForm(view: PanelView, w: number, s: PanelStyle): { header: string; rows: string[] } {
  if (!view.rows.length) return { header: "", rows: [] };
  const maxLabel = Math.max(...view.rows.map((r) => width(r.label) + 2));
  const labelW = Math.min(Math.max(8, w - 10), Math.max(MIN_LABEL, maxLabel));
  const room = Math.max(0, w - CURSOR.length - labelW);
  const header = `  ${s.accent("Setting")}`;
  const start = windowStart(view.selected, view.rows.length);
  const rows = view.rows.slice(start, start + FRAME_ROWS).map((r, i) => {
    const on = start + i === view.selected;
    const mark = on ? s.accent(CURSOR) : NO_MARKER;
    if (r.value === undefined) {
      const trimmed = cutText(r.label, Math.max(0, w - CURSOR.length - (r.opens ? width(OPENS) : 0)));
      return mark + (on ? s.accent(s.bold(trimmed)) : trimmed) + (r.opens ? s.dim(OPENS) : "");
    }
    const label = pad(cutText(r.label, labelW - 1), labelW);
    const valueStyle = r.disabled ? s.dim : r.muted ? (on ? same : s.dim) : on ? s.bold : same;
    const entry = drawEntry(
      { value: r.value, note: r.note, short: r.short, alert: r.alert, opens: r.opens },
      room,
      s,
      valueStyle,
    );
    return mark + (on ? s.accent(s.bold(label)) : s.dim(label)) + entry;
  });
  return { header, rows };
}

function renderPicker(p: PickerView, w: number, s: PanelStyle): { header: string; rows: string[] } {
  if (p.loading) return { header: "", rows: [NO_MARKER + s.dim("loading…")] };
  if (!p.items.length) return { header: "", rows: [NO_MARKER + s.dim(cutText(p.empty, Math.max(0, w - 2)))] };

  const columns = p.columns ?? [];
  const provider = (it: PickerItem) => (it.provider ? `[${it.provider}]` : "");
  const rightOf = (it: PickerItem): string[] => [it.price ?? "", ...(it.cols ?? (it.note ? [it.note] : []))];

  const nRight = Math.max(columns.length, ...p.items.map((it) => rightOf(it).length));
  const rightW = Array.from({ length: nRight }, (_, c) => {
    const col = columns[c];
    const first = rightOf(p.items[0])[c] ?? "";
    const uniform =
      Boolean(col?.hideIfUniform) && p.items.length > 1 && p.items.every((it) => (rightOf(it)[c] ?? "") === first);
    const dataMax = uniform ? 0 : Math.min(COL_CAP, Math.max(0, ...p.items.map((it) => width(rightOf(it)[c] ?? ""))));
    const headName = col?.header ?? "";
    return dataMax > 0 ? Math.max(dataMax, headName ? width(headName) + 2 : 0) : 0;
  });

  const provHeader = p.providerHeader ?? "Provider";
  const rawProvW = Math.max(0, ...p.items.map((it) => width(provider(it))));
  let provW = rawProvW > 0 ? Math.max(rawProvW, width(`${provHeader} ▲`)) : 0;

  const calcRightBlock = () => rightW.reduce((sum, cw) => sum + (cw ? GAP + cw : 0), 0);
  const minName = 12;
  for (let c = nRight - 1; c >= 1; c--) {
    if (CURSOR.length + minName + (provW ? GAP + provW : 0) + calcRightBlock() <= w) break;
    rightW[c] = 0;
  }
  if (provW > 0 && CURSOR.length + minName + GAP + provW + calcRightBlock() > w) {
    provW = 0;
  }
  if (rightW[0] > 0 && CURSOR.length + minName + calcRightBlock() > w) {
    const avail = w - CURSOR.length - minName - GAP;
    rightW[0] = avail >= 6 ? avail : 0;
  }

  const provBlock = provW ? GAP + provW : 0;
  const rightBlock = calcRightBlock();
  const noun =
    p.nounHeader ??
    (p.noun === "models" ? "Model" : p.noun === "voices" ? "Voice" : p.noun === "messages" ? "Message" : "Name");
  const nameFloor = Math.max(width(noun) + 2, 8);
  const nameFull = Math.max(nameFloor, ...p.items.map((it) => width(it.label) + 2));
  const maxNameAvail = Math.max(4, w - CURSOR.length - provBlock - rightBlock);
  const nameW = Math.min(maxNameAvail, Math.max(Math.min(minName, maxNameAvail), nameFull));
  const leftW = CURSOR.length + nameW + provBlock;
  const fill = Math.max(0, w - leftW - rightBlock);

  const desc = p.sort?.endsWith("-desc") ?? false;
  const sortKey = p.sort ? (desc ? p.sort.slice(0, -5) : p.sort) : "";
  const arrow = sortArrow(desc ? "desc" : "asc");
  const sortRightIdx = columns.findIndex((col, c) => col.sortKey === sortKey && rightW[c] > 0);
  const sortName = sortKey === "name";
  const sortProv = sortKey === "provider" && provW > 0;

  const head = (text: string, on: boolean) =>
    on ? s.bold(s.accent(text)) + s.bold(s.warning(` ${arrow}`)) : text ? s.accent(text) : "";
  const headW = (text: string, on: boolean) => width(text) + (on ? 2 : 0);

  const nameHeadW = headW(noun, sortName);
  const provHeadW = headW(provHeader, sortProv);
  const midFill = spaces(fill);

  const header =
    NO_MARKER +
    head(noun, sortName) +
    spaces(Math.max(0, nameW - nameHeadW)) +
    (provW ? spaces(GAP) + head(provHeader, sortProv) + spaces(Math.max(0, provW - provHeadW)) : "") +
    midFill +
    rightW
      .map((cw, c) => {
        if (!cw) return "";
        const on = c === sortRightIdx;
        const label = cutText(columns[c]?.header ?? "", Math.max(0, cw - (on ? 2 : 0)));
        return spaces(Math.max(GAP, GAP + cw - headW(label, on))) + head(label, on);
      })
      .join("");

  const start = windowStart(p.selected, p.items.length);
  const rows = p.items.slice(start, start + FRAME_ROWS).map((it, i) => {
    const on = start + i === p.selected;
    const tone = on ? (t: string) => s.accent(s.bold(t)) : it.current ? s.success : same;
    const dotW = it.current ? 2 : 0;
    const name = cutText(it.label, Math.max(1, nameW - (dotW || 1)));
    const dot = it.current ? s.success(s.bold(" ●")) : "";
    const prov = provW ? cutText(provider(it), provW) : "";
    const cells = rightOf(it);
    const right = rightW
      .map((cw, c) => {
        if (!cw) return "";
        const raw = cells[c] ?? "";
        const fitted = c === 0 ? cutText(raw, cw) : fitColumn(raw, cw);
        const cellStyle = c === 0 ? (on ? s.bold : same) : s.dim;
        return spaces(GAP + cw - width(fitted)) + cellStyle(fitted);
      })
      .join("");
    return (
      (on ? s.accent(CURSOR) : NO_MARKER) +
      tone(name) +
      dot +
      spaces(Math.max(0, nameW - width(name) - dotW)) +
      (provW ? spaces(GAP) + (on ? s.accent : s.dim)(pad(prov, provW)) : "") +
      spaces(fill) +
      right
    );
  });

  return { header, rows };
}

function renderStatus(view: PanelView, w: number, s: PanelStyle): string {
  if (view.status) {
    return `  ${toneStyle(view.status.tone, s)(cutText(view.status.text, Math.max(0, w - 2)))}`;
  }
  if (view.picker) {
    const p = view.picker;
    const n = p.items.length;
    const at = n > 0 ? Math.max(0, Math.min(p.selected, n - 1)) : -1;
    const id = at >= 0 ? (p.items[at]?.id ?? "") : "";
    const lead = `  (${at >= 0 ? at + 1 : 0}/${n})${id ? ` ${id}` : ""}`;
    const detail = p.detail ? p.detail.replace(/\s+/g, " ").trim() : "";
    return s.dim(cutText(detail ? `${lead}${SEP}${detail}` : lead, w));
  }
  const n = view.rows.length;
  if (!n) return "";
  const at = view.selected >= 0 && view.selected < n ? view.selected : -1;
  const label = at >= 0 ? view.rows[at].label : "";
  return s.dim(cutText(`  (${at >= 0 ? at + 1 : 0}/${n})${label ? ` ${label}` : ""}`, w));
}

function renderKeys(view: PanelView, w: number, s: PanelStyle): string {
  const note = [
    view.keys.speak ? `${view.keys.speak} speak` : "",
    view.keys.dictate ? `${view.keys.dictate} dictate` : "",
  ]
    .filter(Boolean)
    .join(SEP);
  if (note) {
    const noteRoom = width(note) + 4;
    const required = view.hints.filter((h) => !h.optional);
    const requiredW = width(required.map((h) => (h.action ? `${h.key} ${h.action}` : h.key)).join(SEP));
    if (2 + requiredW + noteRoom <= w) {
      const left = `  ${hintLine(view.hints, w - 2 - noteRoom, s)}`;
      const both = spread(left, s.dim(note), w, frameMeasure);
      if (both) return both;
    }
  }
  return `  ${hintLine(view.hints, Math.max(0, w - 2), s)}`;
}

const SORT_LABELS: Record<string, string> = {
  price: "Price",
  provider: "Provider",
  newest: "Newest",
  name: "Alphabetical",
  recommended: "Recommended",
  size: "Size",
  state: "Downloaded",
};
const MAX_SORT_LABEL_W = Math.max(...Object.values(SORT_LABELS).map((v) => v.length));

function frameSort(sort: string | undefined): FrameSort | undefined {
  if (!sort) return undefined;
  const key = sort.endsWith("-desc") ? sort.slice(0, -5) : sort;
  const label = SORT_LABELS[key] ?? key;
  return { label, maxLabelWidth: MAX_SORT_LABEL_W };
}

/**
 * The panel as 19 framed lines of at most `termWidth` columns, or one line when the terminal is narrower
 * than MIN_WIDTH.
 */
export function renderPanel(view: PanelView, termWidth: number, s: PanelStyle = PLAIN): string[] {
  if (termWidth < MIN_WIDTH) {
    return [cutText(`${view.title}: terminal too narrow · Esc`, Math.max(1, termWidth))];
  }
  const w = panelContentWidth(termWidth);
  const body = view.picker ? renderPicker(view.picker, w, s) : renderForm(view, w, s);
  const frameStyle: FrameStyle = { accent: s.accent, bold: s.bold, border: s.dim };
  return frameLines(
    {
      title: view.title,
      badge: view.state ? stateStyle(view.state, s)(view.state) : undefined,
      tabs: renderTabs(view, w, s),
      sort: frameSort(view.picker?.sort),
      input: renderInput(view, w, s),
      header: body.header,
      rows: body.rows,
      status: renderStatus(view, w, s),
      keys: renderKeys(view, w, s),
    },
    w,
    termWidth,
    frameStyle,
    frameMeasure,
  );
}
