/**
 * The /speech panel in Pi's terminal UI: a dock in the place of the editor (like Pi's own selectors, so it
 * covers nothing of the conversation) that draws the engine's panel view model (src/engine/panel.ts) with
 * src/pi/panel-render.ts and turns terminal input into panel keys. Nothing that happens in here may throw
 * into Pi: drawing and key handling fail into the panel, never out of it.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  decodeKittyPrintable,
  isKeyRelease,
  Key,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Engine } from "../engine/engine";
import type { Env } from "../engine/env";
import { type NamedKey, PANEL_KEYS, Panel, type PanelKey } from "../engine/panel";
import { DEFAULT_HOTKEYS, type Hotkeys } from "../engine/settings";
import type { Surface, SurfaceUi } from "../engine/surface";
import { cutText, type PanelStyle, panelContentWidth, renderField, renderPanel, wrapText } from "./panel-render";

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
];

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Non-modifier key ids that reach the engine as `{ combo: id }`. */
const BARE_COMBOS = new Set<string>(["pageUp", "pageDown"]);

/**
 * Turns terminal input into panel keys; bracketed paste may arrive in pieces, so it is collected first. The
 * Speak and Dictate hotkeys are the keys Pi has bound to them; chords, pageUp/pageDown and function keys come
 * through as `{ combo: id }`.
 */
export class KeyDecoder {
  private paste?: string;
  private readonly named: Array<[Parameters<typeof matchesKey>[1], NamedKey]>;

  constructor(hotkeys: Hotkeys = DEFAULT_HOTKEYS) {
    this.named = [
      ...NAMED,
      [hotkeys.dictate as Parameters<typeof matchesKey>[1], "dictate"],
      [hotkeys.speak as Parameters<typeof matchesKey>[1], "speak"],
    ];
  }

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
    if (isKeyRelease(data)) return [];
    const id = parseKey(data);
    for (const [match, key] of this.named) {
      if (matchesKey(data, match)) return [id?.includes("+") ? { key, id } : { key }];
    }
    const plain = data.length > 0 && [...data].every((c) => c >= " " && c !== "\x7f");
    const printable = decodeKittyPrintable(data) ?? (plain ? data : undefined);
    if (printable) return [{ text: printable }];
    return id && (id.includes("+") || BARE_COMBOS.has(id) || /^f([1-9]|1[0-2])$/.test(id)) ? [{ combo: id }] : [];
  }
}

const DETAIL_PANE_WIDTH = 60;
/** Rows between the bottom of the terminal and the last list row: Pi's footer plus the frame's bottom chrome. */
const DETAIL_PANE_LIFT = 6;
const LOGIN_PANE_WIDTH = 56;

function boxEdge(
  left: string,
  label: string,
  right: string,
  inner: number,
  s: PanelStyle,
  labelStyle: (t: string) => string,
): string {
  const tag = label ? ` ${cutText(label, Math.max(1, inner - 2))} ` : "";
  const fill = Math.max(0, inner + 1 - visibleWidth(tag));
  return s.dim(`${left}─`) + (tag ? labelStyle(tag) : "") + s.dim(`${"─".repeat(fill)}${right}`);
}

function boxRow(content: string, plainWidth: number, inner: number, s: PanelStyle): string {
  const clipped = plainWidth > inner ? truncateToWidth(content, inner, "…") : content;
  const fill = " ".repeat(Math.max(0, inner - Math.min(plainWidth, inner)));
  return `${s.dim("│")} ${clipped}${fill} ${s.dim("│")}`;
}

function renderBox(
  width: number,
  title: string,
  body: Array<{ styled: string; w: number }>,
  footer: string,
  s: PanelStyle,
): string[] {
  if (width < 10) return [cutText(title, Math.max(1, width))];
  const inner = Math.max(6, width - 4);
  const blank = boxRow("", 0, inner, s);
  return [
    boxEdge("╭", title, "╮", inner, s, (t) => s.accent(s.bold(t))),
    blank,
    ...body.map((line) => boxRow(line.styled, line.w, inner, s)),
    blank,
    boxEdge("╰", footer, "╯", inner, s, s.dim),
  ];
}

function detailOverlayOptions(lastTermWidth: number | undefined) {
  if (lastTermWidth !== undefined) {
    const textW = panelContentWidth(lastTermWidth);
    if (textW < lastTermWidth) {
      return {
        anchor: "bottom-left" as const,
        width: DETAIL_PANE_WIDTH,
        offsetX: Math.max(0, Math.floor((textW - DETAIL_PANE_WIDTH) / 2)),
        offsetY: -DETAIL_PANE_LIFT,
      };
    }
  }
  return { anchor: "bottom-center" as const, width: DETAIL_PANE_WIDTH, offsetY: -DETAIL_PANE_LIFT };
}

/**
 * Open the panel in the place of Pi's editor; settles when it closes, with true when it closed on leaving
 * Hotkeys with a changed key (Pi must load the extension again to bind it). `track` hears the panel while it
 * is open. It opens with the cursor on the Speak line, its first entry.
 */
export function openPanel(
  ctx: ExtensionContext,
  engine: Engine,
  surface: Surface,
  ui: SurfaceUi,
  env: Env,
  track: (panel: Panel | undefined) => void,
  hotkeys: Hotkeys = DEFAULT_HOTKEYS,
  onChanged?: () => void,
): Promise<boolean> {
  return ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
    let closed = false;
    let lastTermWidth: number | undefined;
    let detailClose: (() => void) | undefined;
    let loginOpen = false;
    let loginClose: (() => void) | undefined;
    let panel: Panel | undefined;

    const openDetail = (title: string, detail: string) => {
      if (closed || detailClose) return;
      void ctx.ui
        .custom<void>(
          (_paneTui, paneTheme, _kb, closePane) => {
            const paneStyle = panelStyle(paneTheme as unknown as Theme, env);
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              if (detailClose === finish) detailClose = undefined;
              closePane();
              if (!closed) tui.requestRender();
            };
            detailClose = finish;
            if (closed) finish();
            return {
              focused: true,
              render(width: number): string[] {
                const inner = Math.max(6, width - 4);
                const lines = wrapText(detail, inner).map((l) => ({ styled: l, w: visibleWidth(l) }));
                return renderBox(width, title, lines, "any key closes", paneStyle);
              },
              invalidate() {},
              handleInput(data: string) {
                if (isKeyRelease(data)) return;
                finish();
              },
            };
          },
          { overlay: true, overlayOptions: detailOverlayOptions(lastTermWidth) },
        )
        .catch(() => {
          detailClose = undefined;
        });
    };

    const syncLogin = () => {
      if (!panel) return;
      if (closed || !panel.view().login) {
        if (loginClose) loginClose();
        return;
      }
      if (loginOpen) return;
      loginOpen = true;
      const activePanel = panel;
      void ctx.ui
        .custom<void>(
          (paneTui, paneTheme, _kb, closePane) => {
            const paneStyle = panelStyle(paneTheme as unknown as Theme, env);
            const paneKeys = new KeyDecoder(hotkeys);
            let finished = false;
            const finish = () => {
              if (finished) return;
              finished = true;
              loginOpen = false;
              if (loginClose === finish) loginClose = undefined;
              closePane();
              if (!closed) tui.requestRender();
            };
            loginClose = finish;
            if (closed || !activePanel.view().login) finish();
            return {
              focused: true,
              render(width: number): string[] {
                const { login, menu } = activePanel.view();
                if (!login) return [];
                const inner = Math.max(6, width - 4);
                const promptLines = wrapText(login.prompt, inner).map((l) => ({ styled: l, w: visibleWidth(l) }));
                const body: Array<{ styled: string; w: number }> = [...promptLines];
                if (!login.confirm) {
                  const shown = login.secret ? "•".repeat([...login.value].length) : login.value;
                  const drawn = renderField(shown, login.cursor, "", Math.max(2, inner - 2), paneStyle);
                  body.push({ styled: "", w: 0 });
                  body.push({ styled: `${paneStyle.dim("> ")}${drawn.text}`, w: 2 + drawn.width });
                }
                const hints = login.confirm ? "Enter yes · Esc no" : "Enter sign in · Esc cancel";
                body.push({ styled: "", w: 0 });
                const cutHints = cutText(hints, inner);
                body.push({ styled: paneStyle.dim(cutHints), w: visibleWidth(cutHints) });
                return renderBox(width, menu === "receiverSsh" ? "Manage over SSH" : "Connect", body, "", paneStyle);
              },
              invalidate() {},
              handleInput(data: string) {
                try {
                  for (const k of paneKeys.decode(data)) activePanel.handle(k);
                } catch {
                  // A decoding failure only loses the key.
                }
                if (closed || !activePanel.view().login) {
                  finish();
                } else {
                  paneTui.requestRender();
                  tui.requestRender();
                }
              },
            };
          },
          { overlay: true, overlayOptions: { anchor: "center", width: LOGIN_PANE_WIDTH } },
        )
        .catch(() => {
          loginOpen = false;
          loginClose = undefined;
        });
    };

    const close = () => {
      if (closed) return;
      closed = true;
      detailClose?.();
      loginClose?.();
      panel?.dispose();
      track(undefined);
      done(panel?.rebind ?? false);
    };

    panel = new Panel(engine, surface, {
      ui,
      close,
      changed: () => {
        syncLogin();
        onChanged?.();
        if (!closed) tui.requestRender();
      },
      hotkeys,
    });
    const style = panelStyle(theme as unknown as Theme, env);
    const keys = new KeyDecoder(hotkeys);
    track(panel);
    panel.open();
    panel.openSpeaker();
    syncLogin();
    return {
      render(width: number): string[] {
        try {
          lastTermWidth = width;
          return renderPanel(panel.view(), width, style);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return [truncateToWidth(`Speech: cannot draw the panel (${reason}) · Esc close`, Math.max(1, width), "…")];
        }
      },
      invalidate() {},
      handleInput(data: string) {
        try {
          for (const k of keys.decode(data)) {
            if ("combo" in k && (PANEL_KEYS.detail as readonly string[]).includes(k.combo)) {
              const v = panel.view();
              const p = v.picker;
              const detail = p?.detail?.trim();
              if (p && detail) {
                const at = p.items.length ? Math.max(0, Math.min(p.selected, p.items.length - 1)) : -1;
                openDetail((at >= 0 ? p.items[at]?.label : undefined) || p.title || v.title, detail);
                continue;
              }
            }
            panel.handle(k);
          }
        } catch {
          // The panel reports its own failures; a decoding failure only loses the key.
        }
        syncLogin();
        if (!closed) tui.requestRender();
      },
      dispose() {
        close();
      },
    };
  });
}
