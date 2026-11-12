/**
 * The /speech panel in Pi's terminal UI: a dock in the place of the editor (like Pi's own selectors, so it
 * covers nothing of the conversation) that draws the engine's panel view model (src/engine/panel.ts) with
 * src/pi/panel-render.ts and turns terminal input into panel keys. Nothing that happens in here may throw
 * into Pi: drawing and key handling fail into the panel, never out of it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Engine } from "../engine/engine";
import type { Env } from "../engine/env";
import { type NamedKey, Panel, type PanelKey } from "../engine/panel";
import type { Surface, SurfaceUi } from "../engine/surface";
import { MAX_WIDTH, type PanelStyle, renderPanel } from "./panel-render";

type Theme = {
  fg(color: "accent" | "success" | "error" | "warning", text: string): string;
  bold(text: string): string;
  inverse(text: string): string;
};

const same = (text: string) => text;

/** Faint text (SGR 2): an attribute, not a colour, so it stays under NO_COLOR. */
const faint = (text: string) => `\x1b[2m${text}\x1b[22m`;

/**
 * The panel's style from Pi's theme. Dim is the faint attribute, the same with and without colour; with
 * NO_COLOR set no colour is added: bold, faint and the cursor remain.
 */
export function panelStyle(theme: Theme, env: Env): PanelStyle {
  const bold = (t: string) => theme.bold(t);
  const cursor = (t: string) => theme.inverse(t);
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return {
      accent: same,
      bold,
      dim: faint,
      success: same,
      error: same,
      warning: same,
      cursor,
      selected: (t) => cursor(bold(t)),
    };
  }
  return {
    accent: (t) => theme.fg("accent", t),
    bold,
    dim: faint,
    success: (t) => theme.fg("success", t),
    error: (t) => theme.fg("error", t),
    warning: (t) => theme.fg("warning", t),
    cursor,
    selected: (t) => cursor(bold(t)),
  };
}

const NAMED: Array<[Parameters<typeof matchesKey>[1], NamedKey]> = [
  [Key.up, "up"],
  [Key.down, "down"],
  [Key.left, "left"],
  [Key.right, "right"],
  [Key.enter, "enter"],
  [Key.escape, "escape"],
  ["shift+tab", "backtab"],
  [Key.tab, "tab"],
  [Key.backspace, "backspace"],
  [Key.delete, "delete"],
  [Key.home, "home"],
  [Key.end, "end"],
  [Key.f2, "language"],
  ["alt+z", "dictate"],
  ["alt+s", "speak"],
];

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Turns terminal input into panel keys; bracketed paste may arrive in pieces, so it is collected first. */
export class KeyDecoder {
  private paste?: string;

  decode(data: string): PanelKey[] {
    if (this.paste === undefined && data.includes(PASTE_START)) {
      const [before, after] = [data.slice(0, data.indexOf(PASTE_START)), data.slice(data.indexOf(PASTE_START) + 6)];
      this.paste = "";
      return [...(before ? this.decode(before) : []), ...this.decode(after)];
    }
    if (this.paste !== undefined) {
      this.paste += data;
      const end = this.paste.indexOf(PASTE_END);
      if (end === -1) return [];
      const text = this.paste.slice(0, end);
      const rest = this.paste.slice(end + PASTE_END.length);
      this.paste = undefined;
      return [...(text ? [{ text, paste: true }] : []), ...(rest ? this.decode(rest) : [])];
    }
    for (const [id, key] of NAMED) if (matchesKey(data, id)) return [{ key }];
    const plain = data.length > 0 && [...data].every((c) => c >= " " && c !== "\x7f");
    const printable = decodeKittyPrintable(data) ?? (plain ? data : undefined);
    return printable ? [{ text: printable }] : [];
  }
}

/** The dock leaves this many columns free on its left, in line with Pi's own text, from this width on. */
const MARGIN = 1;
const MARGIN_FROM = 80;
/** Rows of the terminal the dock never takes: Pi's footer. */
const KEPT_ROWS = 3;

/**
 * Open the panel in the place of Pi's editor; settles when it closes. `track` hears the panel while it is
 * open. With `speak` it opens on the speak composer, and Esc closes it.
 */
export function openPanel(
  ctx: ExtensionContext,
  engine: Engine,
  surface: Surface,
  ui: SurfaceUi,
  env: Env,
  track: (panel: Panel | undefined) => void,
  speak = false,
): Promise<void> {
  return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      panel.dispose();
      track(undefined);
      done(undefined);
    };
    const panel = new Panel(engine, surface, {
      ui,
      close,
      changed: () => {
        if (!closed) tui.requestRender();
      },
    });
    const style = panelStyle(theme as unknown as Theme, env);
    const keys = new KeyDecoder();
    track(panel);
    panel.open();
    if (speak) panel.openSpeaker(true);
    return {
      render(width: number): string[] {
        try {
          const rows = tui.terminal?.rows;
          const height = rows ? Math.max(1, rows - KEPT_ROWS) : Number.POSITIVE_INFINITY;
          // A narrow terminal needs every column for the values and prices.
          const margin = width >= MARGIN_FROM ? MARGIN : 0;
          const lines = renderPanel(panel.view(), Math.min(width - margin, MAX_WIDTH), style, height);
          return margin ? lines.map((line) => " ".repeat(margin) + line) : lines;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return [truncateToWidth(`Speech: cannot draw the panel (${reason}) · Esc close`, Math.max(1, width), "…")];
        }
      },
      invalidate() {},
      handleInput(data: string) {
        try {
          for (const k of keys.decode(data)) panel.handle(k);
        } catch {
          // The panel reports its own failures; a decoding failure only loses the key.
        }
        if (!closed) tui.requestRender();
      },
      dispose() {
        close();
      },
    };
  });
}
