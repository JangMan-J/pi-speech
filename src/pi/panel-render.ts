/**
 * Draws the /speech panel: a pure function of the panel's view model (src/engine/panel.ts), the width, and a
 * style. Widths are measured on plain text and styles applied afterwards, so no line is ever wider than
 * `width`, and every state reads the same without colour (symbols and words carry it).
 *
 * The panel is a dock in the place of Pi's editor, so it stays small: one header line that is also the top
 * rule; then, in the main view, the sections SPEAK (Alt+S), LISTEN (Alt+Z) and SETTINGS, each a quiet heading
 * on its own line above its rows (in a submenu, its rows alone); one status line; and the key hints. The rows
 * share one label column, so their values line up. A value is only the current value (a model or a voice by
 * name: what it costs and offers is in its picker), followed by a note where something is wrong or a submenu
 * explains it, and by › on a row that opens a picker or a submenu.
 *
 * What gives way when the width shrinks, first to last: the headings; then, per row, the note, and only then
 * the value itself (cut with …).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Hint, InputView, PanelRow, PanelView, PickerItem, PickerView, StatusTone } from "../engine/panel";

export interface PanelStyle {
  accent(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  /** The text cursor in an input. */
  cursor(text: string): string;
  /** The whole selected row, including its padding. */
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

/** The panel never draws wider than this. */
export const MAX_WIDTH = 96;
/** Below this only a one-line message is drawn. */
export const MIN_WIDTH = 40;
/** Picker rows shown at once. */
export const PICKER_ROWS = 8;

const MARKER = "▸ ";
const NO_MARKER = "  ";
const GAP = 2;
/** The label column: one space after the longest label, and never narrower than this. */
const MIN_LABEL = 19;
/** The mark at the end of a row whose Enter opens a list or a submenu. */
const OPENS = " ›";
/** Where the input under a row starts. */
const INPUT_INDENT = "    ";

const width = (text: string) => visibleWidth(text);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Plain text cut to `w` columns with …, on grapheme boundaries. */
function cut(text: string, w: number): string {
  if (w <= 0) return "";
  if (width(text) <= w) return text;
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

/** Fit a ` · `-joined cell to `w` columns on whole tokens, dropping trailing ones; a lone long token is cut. */
function fitColumn(cell: string, w: number): string {
  if (width(cell) <= w) return cell;
  const parts = cell.split(" · ");
  if (parts.length === 1) return cut(cell, w);
  let out = parts[0];
  if (width(out) > w) return cut(out, w);
  for (let i = 1; i < parts.length; i++) {
    const next = `${out} · ${parts[i]}`;
    if (width(next) > w) break;
    out = next;
  }
  return out;
}

/** A styled line cut to `w` columns (a safety net: lines are measured before they are styled). */
const clip = (line: string, w: number) => (width(line) <= w ? line : truncateToWidth(line, w, "…"));
const pad = (text: string, w: number) => text + " ".repeat(Math.max(0, w - width(text)));
const spaces = (n: number) => " ".repeat(Math.max(0, n));

/** `left` and `right` on one line of width `w`; the left side gives way. Both are styled after measuring. */
function spread(left: string, right: string, w: number, styleLeft = same, styleRight = same): string {
  const r = cut(right, w);
  const room = w - width(r) - (r ? 1 : 0);
  const l = cut(left, Math.max(0, room));
  return styleLeft(l) + spaces(w - width(l) - width(r)) + (r ? styleRight(r) : "");
}

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
  const text = (hs: Hint[]) => hs.map((h) => (h.action ? `${h.key} ${h.action}` : h.key)).join(" · ");
  const kept = [...hints];
  for (let i = kept.length - 1; i >= 0 && width(text(kept)) > w; i--) if (kept[i].optional) kept.splice(i, 1);
  while (kept.length > 1 && width(text(kept)) > w) kept.splice(0, 1);
  return s.dim(cut(text(kept), w));
}

// ── Values and their notes ───────────────────────────────────────────────

/** A value and what is said after it: a note (or its short form); all optional. */
interface Entry {
  value: string;
  note?: string;
  short?: string;
  alert?: boolean;
  opens?: boolean;
}

/** A drawn value: the styled text and the plain columns it takes. */
interface Drawn {
  text: string;
  width: number;
}

/** The separator between a value and its note: `value · note`. */
const SEP = " · ";

/**
 * One value drawn tight in `room` columns: `value · note ›`, the note in dim right after the value. When it does
 * not fit the note gives way to its short form, then goes; only then is the value itself cut with …. A row that
 * opens a list keeps its › at the end; an alert keeps its ✗ beside the value when its note is gone.
 */
function drawEntry(e: Entry, room: number, s: PanelStyle, valueStyle: (t: string) => string): Drawn {
  const chev = e.opens ? OPENS : "";
  const chevW = width(chev);
  const chevStyled = chev ? s.dim(chev) : "";
  // An alert's facts are drawn in the error colour so the eye finds them; everything else is dim.
  const factStyle = e.alert ? s.error : s.dim;
  // Tails after the value, the richest first, each with the styled text that draws it.
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
      return { text: valueStyle(e.value) + t.styled + chevStyled, width: width(e.value) + width(t.plain) + chevW };
    }
  }
  // Even the value alone with its › does not fit: cut it, keep the › and an alert's ✗.
  const mark = e.alert ? " ✗" : "";
  const v = cut(e.value, Math.max(0, room - chevW - width(mark)));
  return { text: valueStyle(v) + (mark ? s.error(mark) : "") + chevStyled, width: width(v) + width(mark) + chevW };
}

// ── Lines ────────────────────────────────────────────────────────────────

/** A line of the panel; an optional one gives way on a short terminal, the lowest `drop` first. */
interface Line {
  text: string;
  drop?: number;
}

const keep = (text: string): Line => ({ text });
const optional = (drop: number, text = ""): Line => ({ text, drop });

/** The rows, their labels in one column and their values lined up after it. */
function rowTexts(rows: PanelRow[], selected: number, w: number, s: PanelStyle): string[] {
  const labelW = Math.max(MIN_LABEL, ...rows.map((r) => width(r.label) + 1));
  const room = Math.max(0, w - MARKER.length - labelW);
  return rows.map((r, i) => {
    const on = i === selected;
    const marker = on ? s.accent(MARKER) : NO_MARKER;
    const labelStyle = on ? s.bold : s.dim;
    // A submenu row has no value: its › stands right after the label.
    if (r.value === undefined) {
      const label = cut(r.label, w - MARKER.length - (r.opens ? width(OPENS) : 0));
      const line = marker + labelStyle(label) + (r.opens ? s.dim(OPENS) : "");
      return on ? s.selected(pad(line, w)) : line;
    }
    const label = labelStyle(pad(cut(r.label, labelW - 1), labelW));
    const entry = drawEntry(
      { value: r.value, note: r.note, short: r.short, alert: r.alert, opens: r.opens },
      room,
      s,
      on ? s.bold : same,
    );
    const line = marker + label + entry.text;
    return on ? s.selected(pad(line, w)) : line;
  });
}

/** A text field of at most `room` columns: the text around the cursor, or the placeholder when empty. */
function field(value: string, cursor: number, placeholder: string, room: number, s: PanelStyle) {
  if (!value) {
    const hint = cut(placeholder, room - 2);
    return { text: s.cursor(" ") + (hint ? ` ${s.dim(hint)}` : ""), width: 1 + (hint ? 1 + width(hint) : 0) };
  }
  const chars = [...value];
  let start = 0;
  // Scroll so the cursor stays in view (measured in columns, wide characters included).
  while (start < cursor && width(chars.slice(start, cursor).join("")) + 1 > room) start++;
  const parts: string[] = [];
  let used = 0;
  for (let i = start; i < chars.length; i++) {
    const cw = width(chars[i]);
    if (used + cw > room) break;
    parts.push(chars[i]);
    used += cw;
  }
  const at = cursor - start;
  const end = at >= parts.length;
  return {
    text: parts.slice(0, at).join("") + s.cursor(parts[at] ?? " ") + parts.slice(at + 1).join(""),
    width: used + (end ? 1 : 0),
  };
}

function inputLine(input: InputView, w: number, s: PanelStyle): string {
  const label = input.label ? `${input.label}  ` : "";
  const room = w - INPUT_INDENT.length - width(label);
  if (room < 4) return INPUT_INDENT + cut(input.label, w - INPUT_INDENT.length);
  return (
    INPUT_INDENT + (label ? s.bold(label) : "") + field(input.value, input.cursor, input.placeholder, room, s).text
  );
}

/**
 * The rows: in the main view each section under its heading (which carries its hotkey); in a submenu, the rows
 * alone. The headings give way first on a short terminal.
 */
const BODY = "  ";
function homeLines(view: PanelView, w: number, s: PanelStyle): Line[] {
  const cw = Math.max(0, w - BODY.length);
  const drawn = rowTexts(view.rows, view.selected, cw, s);
  const input = view.input;
  const out: Line[] = [];
  let section: string | undefined;
  view.rows.forEach((row, i) => {
    const heading = row.section && view.headings?.[row.section];
    if (heading && row.section !== section) out.push(optional(3, s.dim(cut(heading, w))));
    section = row.section;
    out.push(keep(BODY + drawn[i]));
    if (input?.under === row.id) out.push(keep(BODY + inputLine(input, cw, s)));
  });
  return out;
}

/**
 * The items of a picker as an aligned table, so a long list reads down its columns: the name on the left,
 * the price right-aligned in its own column, then what the item offers (its features, or a voice's language).
 * The columns are sized from the whole list so they do not jump while it scrolls; the name gives way (cut
 * with …) before the price, and the offer is cut last.
 */
/** An extra column is never wider than this, so one outlier value is cut rather than stretching the table. */
const COL_CAP = 24;

function pickerTable(
  items: PickerItem[],
  start: number,
  end: number,
  selected: number,
  w: number,
  s: PanelStyle,
  keepColumns = false,
): string[] {
  const check = "✓ ";
  const prefix = MARKER.length + check.length;
  const room = Math.max(0, w - prefix);
  const priceW = Math.max(0, ...items.map((it) => (it.price ? width(it.price) : 0)));
  const priceCol = priceW ? GAP + priceW : 0;
  // The aligned columns after the price (a model's language, then its voices); each as wide as its widest
  // value, capped. A list without columns (voices, history) keeps its one free-text note instead.
  const useCols = items.some((it) => it.cols !== undefined);
  const colCount = useCols ? Math.max(0, ...items.map((it) => it.cols?.length ?? 0)) : 0;
  // A column every row fills the same way (or leaves empty) carries nothing, so it is dropped (width 0).
  const sameEverywhere = (c: number) => {
    if (keepColumns) return false;
    const first = items[0]?.cols?.[c] ?? "";
    return items.length > 1 && items.every((it) => (it.cols?.[c] ?? "") === first);
  };
  const colW = Array.from({ length: colCount }, (_, c) =>
    sameEverywhere(c) ? 0 : Math.min(COL_CAP, Math.max(0, ...items.map((it) => width(it.cols?.[c] ?? "")))),
  );
  const hasNote = !useCols && items.some((it) => !!it.note);
  const noteGap = hasNote ? GAP : 0;
  const minNote = hasNote ? 6 : 0;
  const nameMax = Math.max(1, ...items.map((it) => width(it.label)));
  // The name gives way first; on a narrow panel whole columns go, from the right, so the rest stay aligned.
  const extraWidth = (k: number) => colW.slice(0, k).reduce((e, cw) => e + (cw ? GAP + cw : 0), 0);
  // Keep a column only while the name still has a usable width (its own, or at least 6 when it is long).
  const nameFloor = Math.min(nameMax, 6);
  let keptCols = colCount;
  while (keptCols > 0 && room - priceCol - extraWidth(keptCols) - noteGap - minNote < nameFloor) keptCols--;
  const extra = extraWidth(keptCols);
  const nameW = Math.max(1, Math.min(nameMax, room - priceCol - extra - noteGap - minNote));
  const noteW = Math.max(0, room - nameW - priceCol - extra - noteGap);
  const lines: string[] = [];
  for (let i = start; i < end; i++) {
    const it = items[i];
    const on = i === selected;
    const strong = on ? s.bold : same;
    const mark = (on ? s.accent(MARKER) : NO_MARKER) + (it.current ? s.success(check) : NO_MARKER);
    const name = strong(pad(cut(it.label, nameW), nameW));
    const price =
      priceW && it.price ? spaces(GAP) + strong(spaces(priceW - width(it.price)) + it.price) : spaces(priceCol);
    let cols = "";
    for (let c = 0; c < keptCols; c++) {
      if (!colW[c]) continue;
      cols += spaces(GAP) + s.dim(pad(fitColumn(it.cols?.[c] ?? "", colW[c]), colW[c]));
    }
    const note = hasNote && it.note && noteW > 0 ? spaces(GAP) + s.dim(cut(it.note, noteW)) : "";
    const line = mark + name + price + cols + note;
    lines.push(on ? s.selected(pad(line, w)) : line);
  }
  return lines;
}

/** Whether the list shows less than everything: a query, or a feature that every shown model has. */
const narrowed = (p: PickerView) => p.query.trim() !== "" || (p.show !== undefined && p.show !== "all");

/** The count on the Find line: `39 models`, `6 of 39 models` while filtering; nothing while loading. */
function countOf(p: PickerView): string {
  if (p.loading) return "";
  // One of a thing reads in the singular: "1 voice", "1 model", "1 message".
  const noun = p.total === 1 ? p.noun.replace(/s$/, "") : p.noun;
  return narrowed(p) ? `${p.items.length} of ${p.total} ${noun}` : `${p.total} ${noun}`;
}

function pickerLines(p: PickerView, w: number, s: PanelStyle, rows: number): Line[] {
  const count = countOf(p);
  const label = "Find: ";
  // A model list says how it is ordered and what it shows; on a narrow panel that gives way to the count.
  const order = p.sort ? `sort ${p.sort} · show ${p.show ?? "all"}` : "";
  const ordered = order !== "" && width(label) + 12 + width(order) + 3 + width(count) + 2 <= w;
  const right = ordered ? `${order}${spaces(3)}${count}` : count;
  const styledRight = ordered
    ? `${s.dim("sort")} ${p.sort} ${s.dim("· show")} ${p.show ?? "all"}${spaces(3)}${s.dim(count)}`
    : s.dim(count);
  const room = w - width(label) - width(right) - 2;
  const query = field(p.query, p.cursor, "", Math.max(1, room), s);
  const gap = Math.max(1, w - width(label) - query.width - width(right));
  const out: Line[] = [keep(s.dim(label) + query.text + spaces(gap) + styledRight)];
  const height = Math.max(1, Math.min(rows, p.total || 1));
  let where = "";
  if (p.loading) out.push(keep(NO_MARKER + s.dim("loading…")));
  else if (p.items.length === 0) out.push(keep(NO_MARKER + s.dim(p.empty)));
  else {
    const n = p.items.length;
    const start = Math.max(0, Math.min(p.selected - Math.floor(height / 2), n - height));
    const end = Math.min(n, start + height);
    for (const line of pickerTable(p.items, start, end, p.selected, w, s, p.keepColumns)) out.push(keep(line));
    if (n > height) where = `${start > 0 ? "↑" : " "} ${start + 1}–${end} of ${n} ${end < n ? "↓" : " "}`;
  }
  // A steady height: the panel does not jump while the list is filtered.
  while (out.length < 1 + height) out.push(optional(1));
  // Under the list: what the catalog says about the highlighted model, and where a long list is.
  if (p.detail !== undefined || p.total > height) {
    out.push(optional(5, spread(p.detail ?? "", where, w, s.dim, s.dim)));
  }
  return out;
}

/** The title, a rule to the right edge, and what speech is doing: `Speech › Voice ─────── ▶ speaking`. */
function headerLine(view: PanelView, w: number, s: PanelStyle): string {
  const sub = view.picker?.title ?? view.crumb;
  const crumb = sub ? ` › ${sub}` : "";
  const state = cut(view.state, Math.max(0, w - 8));
  const taken = state ? width(state) + 1 : 0;
  const title = cut(view.title + crumb, w - taken);
  const a = title.slice(0, view.title.length);
  const b = title.slice(a.length);
  const fill = w - width(title) - taken - 1;
  const rule = fill >= 3 ? ` ${s.dim("─".repeat(fill))}` : spaces(fill + 1);
  return s.accent(s.bold(a)) + (b ? s.bold(b) : "") + rule + (state ? ` ${stateStyle(view.state, s)(state)}` : "");
}

/**
 * The panel as lines of at most `total` columns and `height` rows. On a short terminal the list shows fewer
 * rows, then blank lines, headings and the bottom rule give way; below that, one line asks for a bigger
 * terminal.
 */
export function renderPanel(view: PanelView, total: number, s: PanelStyle = PLAIN, height = Infinity): string[] {
  if (total < MIN_WIDTH) {
    return [cut(`${view.title}: terminal too narrow · Esc`, Math.max(1, total))];
  }
  const w = Math.min(total, MAX_WIDTH);

  // Under the body: an input that belongs to no row, then one line for results (kept free, so the dock
  // does not grow and shrink as they come and go).
  const slot: Line[] = [];
  const input = view.input;
  if (input && !input.under) slot.push(keep(inputLine(input, w, s)));
  // A blank line sets a change confirmation (green) apart from the fixed menu above it.
  slot.push(optional(1));
  slot.push(
    view.status
      ? keep(NO_MARKER + toneStyle(view.status.tone, s)(cut(view.status.text, w - NO_MARKER.length)))
      : optional(1),
  );

  const body: Line[] = [];
  if (view.picker) {
    // Header, filter, the slot and the hints stay; the rows get what is left.
    const fixed = 3 + slot.filter((l) => l.drop === undefined).length;
    body.push(...pickerLines(view.picker, w, s, Math.min(PICKER_ROWS, Math.max(3, height - fixed))));
  } else if (!view.composer) {
    body.push(...homeLines(view, w, s));
  }

  let lines: Line[] = [
    keep(headerLine(view, w, s)),
    ...body,
    ...slot,
    keep(BODY + hintLine(view.hints, w - BODY.length, s)),
    optional(4, s.dim("─".repeat(w))),
  ];
  for (let level = 1; lines.length > height && level <= 5; level++) {
    lines = lines.filter((l) => l.drop === undefined || l.drop > level);
  }
  if (lines.length > height) return [cut(`${view.title}: terminal too small · Esc`, w)];
  return lines.map((l) => clip(l.text, w).replace(/ +$/, ""));
}
