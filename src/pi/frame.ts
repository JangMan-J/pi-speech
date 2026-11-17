/**
 * The frame the pickers of this tool suite share (pi-picks, pi-hashline, pi-speech), so they look and behave
 * alike. Each repository carries an identical copy of this file: change it in one and copy it to the others.
 *
 * The frame owns what must not differ between tools: which lines there are and in what order, the rules, the
 * title line, the number of list rows, and how wide the text is. A tool supplies the content of each line,
 * already styled and already fitted to the text width.
 *
 *   ─ Title ───────────────────────────────────────── badge ─
 *     Tab │ Tab │ Tab
 *   ──────────────────────────────────────────────────────────
 *     Search: >
 *     Column headers
 *     FRAME_ROWS list rows
 *     (n/m) the selected item
 *   ──────────────────────────────────────────────────────────
 *     keys                                              notes
 *   ──────────────────────────────────────────────────────────
 *
 * It imports nothing: text is measured and cut by the `Measure` a tool passes in (pi-tui's `visibleWidth` and
 * `truncateToWidth`), so the file can be tested without Pi.
 */

/** Widest terminal a picker fills edge to edge. */
export const WINDOW_W = 128;
/** List rows shown at once; the frame always draws this many, so its height never changes. */
export const FRAME_ROWS = 10;
/** Columns kept between a line's text and a note on its right, and between that note and the text edge. */
const NOTE_GAP = 2;

/**
 * The keys every picker of the suite gives the same meaning, as pi-tui key ids. A tool matches these instead of
 * writing the keys out, binds its own actions to other keys, and never gives one of these another meaning.
 *
 * Not listed because no tool matches them itself: ↑ and ↓ move and wrap around; Enter is the selected row's main
 * action; Esc goes back one level and, at the top, closes; ← and → switch tabs while the text field is empty,
 * and change the value of a row that has one to step through.
 *
 * Typing goes to the text field, so a tool's own actions are Ctrl chords or function keys. Free for them: Ctrl+N,
 * Ctrl+O, Ctrl+P, Ctrl+T, Ctrl+L and F1 to F12. Not usable: Ctrl+C (Pi cancels with it); Ctrl+H, Ctrl+I, Ctrl+J,
 * Ctrl+M and Ctrl+[ (terminals send them for Backspace, Tab, Enter and Esc); Ctrl+Z; and the keys the text field
 * edits with (Ctrl+A, B, E, K, U, W, Y and Alt+B, D, F, Y).
 */
export const KEYS = {
	/** Ten rows up or down, without wrapping. */
	pageUp: ["shift+up", "pageUp"],
	pageDown: ["shift+down", "pageDown"],
	nextTab: ["tab"],
	prevTab: ["shift+tab"],
	/** The next sort order; the column that governs it carries the arrow. */
	sort: ["ctrl+s"],
	/** A floating pane about the selected row. */
	detail: ["ctrl+d"],
	/** Put the selected row back to its default. */
	reset: ["ctrl+r"],
	/** Clear what the user set on every row of the current tab. */
	clearTab: ["ctrl+x"],
	/** Mark or unmark the selected row, as a favorite is. */
	mark: ["ctrl+f"],
} as const;

export interface Measure {
	/** Columns the text takes on screen, styling excluded. */
	width(text: string): number;
	/** The text cut to at most `width` columns, styling kept. */
	truncate(text: string, width: number): string;
}

export interface FrameStyle {
	/** The title and the outer rules. */
	accent(text: string): string;
	bold(text: string): string;
	/** The inner rules. */
	border(text: string): string;
}

export type SortDir = "asc" | "desc";

/** Sort direction arrow for column headers (`"▲"` ascending, `"▼"` descending). */
export function sortArrow(dir: SortDir): "▲" | "▼" {
	return dir === "desc" ? "▼" : "▲";
}

export interface FrameSort {
	/** Human label for the active sort order (`"Price"`, `"Alphabetical"`, `"Recommended"`, `"Size"`, `"Downloaded"`). */
	label: string;
	/** Width in columns of the longest label in this picker, anchoring `Sort:` so the largest value ends at the right edge. */
	maxLabelWidth?: number;
}

export interface FrameParts {
	/** Plain text. */
	title: string;
	/** A short state on the right of the title line, already styled. Dropped when the line is too narrow for it. */
	badge?: string;
	tabs: string;
	/** Active sort order, cut into the top rule at the right edge of `width` when present. */
	sort?: FrameSort;
	/** The one text field: a search, or whatever the tool's main input is. */
	input: string;
	header: string;
	/** At most FRAME_ROWS rows; the frame pads the rest. */
	rows: string[];
	/** One line about the selected item. */
	status: string;
	keys: string;
}

/**
 * How many columns a picker's text uses in a terminal this wide. A window is filled edge to edge. A wider screen
 * would put its whole width between a name and the columns on its right, so there the text stops at WINDOW_W
 * until the terminal's midline passes those columns (`rightColsW` wide in all), and from then on they stay
 * centred on it. Only the rules and the title line run the full width.
 */
export function contentWidth(termWidth: number, rightColsW: number): number {
	if (termWidth <= WINDOW_W) return termWidth;
	return Math.max(WINDOW_W, Math.ceil((termWidth + rightColsW) / 2));
}

/**
 * `left` and `right` on one line of `width` columns, `right` ending NOTE_GAP columns before the edge.
 * Undefined when they do not fit NOTE_GAP columns apart: the caller decides what gives way.
 */
export function spread(left: string, right: string, width: number, measure: Measure): string | undefined {
	const gap = width - measure.width(left) - measure.width(right) - NOTE_GAP;
	return gap >= NOTE_GAP ? left + " ".repeat(gap) + right : undefined;
}

/** The top rule with the title (`─ Title`) and optional `badge` and `Sort: <label>` cut in. */
function titleLine(p: FrameParts, width: number, termWidth: number, style: FrameStyle, measure: Measure): string {
	const lead = "─ ";
	const rule = (n: number) => (n > 0 ? style.accent("─".repeat(n)) : "");
	const title = measure.truncate(p.title, Math.max(1, width - lead.length));
	const used = lead.length + measure.width(title);
	const start = style.accent(lead) + style.bold(style.accent(title));
	const sort = p.sort?.label ? p.sort : undefined;
	const prefix = "Sort: ";
	const labelW = sort ? measure.width(sort.label) : 0;
	const maxLabelW = sort ? Math.max(labelW, sort.maxLabelWidth ?? 0) : 0;
	const sortStart = sort ? width - (measure.width(prefix) + maxLabelW) : width;
	const sortFits = sort !== undefined && sortStart - 1 - (used + 1) >= 3;

	const badgeEnd = sortFits ? sortStart - 1 - NOTE_GAP : width - NOTE_GAP;
	const badgeFill = p.badge ? badgeEnd - measure.width(p.badge) - 1 - (used + 1) : 0;
	const showBadge = Boolean(p.badge && badgeFill >= 3);

	if (sortFits && sort) {
		const sortText = `${style.border(prefix)}${style.bold(style.accent(sort.label))}`;
		const sortUsed = sortStart + measure.width(prefix) + labelW;
		const tail = Math.max(0, termWidth - sortUsed);
		const trail = tail === 0 ? "" : tail === 1 ? " " : ` ${rule(tail - 1)}`;
		if (showBadge && p.badge) {
			return `${start} ${rule(badgeFill)} ${p.badge} ${rule(NOTE_GAP - 1)} ${sortText}${trail}`;
		}
		const fill = sortStart - 1 - (used + 1);
		return `${start} ${rule(fill)} ${sortText}${trail}`;
	}
	if (!showBadge || !p.badge) return used + 1 < termWidth ? `${start} ${rule(termWidth - used - 1)}` : start;
	return `${start} ${rule(badgeFill)} ${p.badge} ${rule(termWidth - badgeEnd - 1)}`;
}

/**
 * The picker as lines. `width` is the text width (`contentWidth` of the terminal) the parts were fitted to;
 * `termWidth` is how far the rules run.
 */
export function frameLines(p: FrameParts, width: number, termWidth: number, style: FrameStyle, measure: Measure): string[] {
	const rows = p.rows.slice(0, FRAME_ROWS);
	while (rows.length < FRAME_ROWS) rows.push("");
	const inner = style.border("─".repeat(termWidth));
	const text = (line: string) => measure.truncate(line, width);
	return [
		measure.truncate(titleLine(p, width, termWidth, style, measure), termWidth),
		text(p.tabs),
		inner,
		text(p.input),
		text(p.header),
		...rows.map(text),
		text(p.status),
		inner,
		text(p.keys),
		style.accent("─".repeat(termWidth)),
	];
}
