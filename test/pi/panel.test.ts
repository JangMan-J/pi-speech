import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerPi } from "../../src/pi/adapter";
import { KeyDecoder, panelStyle } from "../../src/pi/panel";
import { fakeOpenRouter, makeEngine } from "../engine/fixtures";

afterEach(() => vi.unstubAllGlobals());

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};

/** Pi with a terminal UI whose `custom` overlay can be drawn and typed into. */
function tuiPi() {
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const handlers = new Map<string, Array<(e: any, ctx: any) => unknown>>();
  const pi: any = {
    registerCommand: (name: string, o: any) => commands.set(name, o),
    registerTool: () => {},
    registerShortcut: (name: string, o: any) => shortcuts.set(name, o),
    on: (e: string, fn: any) => handlers.set(e, [...(handlers.get(e) ?? []), fn]),
    getActiveTools: () => [],
    setActiveTools: () => {},
  };
  const notes: Array<{ message: string; type?: string }> = [];
  const overlay: {
    component?: any;
    options?: any;
    closed?: Promise<void>;
    renders: number;
    rows?: number;
  } = { renders: 0 };
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    cwd: "/",
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: {
      notify: (message: string, type?: string) => notes.push({ message, type }),
      setStatus: () => {},
      select: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      pasteToEditor: vi.fn(),
      custom: vi.fn((factory: any, options: any) => {
        overlay.options = options;
        overlay.closed = new Promise<void>((resolve) => {
          const tui = { requestRender: () => overlay.renders++, terminal: { rows: overlay.rows } };
          overlay.component = factory(tui, theme, {}, () => resolve());
        });
        return overlay.closed;
      }),
    },
  };
  const emit = async (e: string) => {
    for (const fn of handlers.get(e) ?? []) await fn({}, ctx);
  };
  const screen = (width = 100) => overlay.component.render(width).join("\n");
  return { pi, ctx, commands, shortcuts, emit, notes, overlay, screen };
}

describe("the panel in Pi's terminal UI", () => {
  it("/speech alone opens one dock in the editor's place instead of the menu; Esc closes it", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    const { engine } = makeEngine();
    registerPi(f.pi, engine, {});
    await f.emit("session_start");
    const done = f.commands.get("speech").handler("", f.ctx);
    expect(f.ctx.ui.custom).toHaveBeenCalledTimes(1);
    // not an overlay: nothing floats over the conversation
    expect(f.overlay.options).toBeUndefined();
    expect(f.ctx.ui.select).not.toHaveBeenCalled();
    expect(f.screen()).toMatch(/Speech[\s\S]*Speak…[\s\S]*Agent tools/);
    f.overlay.component.handleInput("\x1b");
    await done;
  });

  it("Alt+S opens a persistent speak composer, not the settings list", async () => {
    const requests = fakeOpenRouter();
    const f = tuiPi();
    registerPi(f.pi, makeEngine().engine, { NO_COLOR: "1" });
    await f.emit("session_start");
    const done = f.shortcuts.get("alt+s").handler(f.ctx);
    expect(stripVTControlCharacters(f.screen())).toContain("Speak");
    expect(f.screen()).not.toMatch(/Speech model|Agent tools/);
    f.overlay.component.handleInput("first message");
    f.overlay.component.handleInput("\r");
    f.overlay.component.handleInput("second message");
    f.overlay.component.handleInput("\r");
    await vi.waitFor(() => expect(requests.filter((r) => r.body?.input)).toHaveLength(2));
    expect(requests.filter((r) => r.body?.input).map((r) => r.body.input)).toEqual(["first message", "second message"]);
    expect(f.screen()).not.toMatch(/Speech model|Agent tools/);
    f.overlay.component.handleInput("\x1b");
    await done;
  });

  it("draws a compact dock: one column of margin, the header as the top rule, three sections, no box", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    registerPi(f.pi, makeEngine().engine, { NO_COLOR: "1" });
    await f.emit("session_start");
    const done = f.commands.get("speech").handler("", f.ctx);
    const lines: string[] = stripVTControlCharacters(f.overlay.component.render(120).join("\n")).split("\n");
    expect(lines[0]).toMatch(/^ Speech ─+$/);
    expect(lines[0]).toHaveLength(97);
    expect(lines.filter((l) => /^ (SPEAK|LISTEN|SYSTEM)$/.test(l))).toHaveLength(3);
    expect(lines.join("\n")).not.toMatch(/[│╭╰]/);
    expect(lines.length).toBeLessThanOrEqual(20);
    f.overlay.component.handleInput("\x1b");
    await done;
  });

  it("Tab and Shift+Tab sort and filter the model list from the keyboard", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    const { engine } = makeEngine();
    registerPi(f.pi, engine, { NO_COLOR: "1" });
    await f.emit("session_start");
    const done = f.commands.get("speech").handler("", f.ctx);
    const c = f.overlay.component;
    const screen = () => stripVTControlCharacters(f.screen(120));
    c.handleInput("\x1b[B"); // down: Speech model
    c.handleInput("\r");
    await vi.waitFor(() => expect(screen()).toMatch(/sort price · show all {3}3 models/));
    c.handleInput("\t");
    expect(screen()).toMatch(/sort provider · show all/);
    expect(engine.speech.settings.modelSort).toBe("provider");
    c.handleInput("\x1b[Z"); // Shift+Tab
    expect(screen()).toMatch(/sort provider · show tags {3}1 of 3 models/);
    expect(screen()).toMatch(/▸ ✓ google\/gemini-3\.8-flash-tts +~\$0\.03\/min {2}multilingual {2}2 voices/);
    expect(screen()).toMatch(/Gemini 3\.8 Flash TTS is a text-to-speech model from Google\./);
    c.handleInput("\x1b");
    c.handleInput("\x1b");
    await done;
  });

  it("draws with the theme, and without colour when NO_COLOR is set", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    registerPi(f.pi, makeEngine().engine, { NO_COLOR: "1" });
    await f.emit("session_start");
    const done = f.commands.get("speech").handler("", f.ctx);
    const text = f.screen();
    expect(text).not.toMatch(/<accent>|<dim>/);
    expect(text).toContain("▸ ");
    expect(text).toContain("\x1b[7m\x1b[1m▸ Speak… (Alt+S)");
    f.overlay.component.handleInput("\x1b");
    await done;
    const coloured = panelStyle(theme, {});
    expect(coloured.accent("x")).toBe("<accent>x</accent>");
    // dim is the faint attribute, with colour and without
    expect(coloured.dim("x")).toBe("\x1b[2mx\x1b[22m");
    expect(coloured.selected("x")).toBe("\x1b[7m\x1b[1mx\x1b[22m\x1b[27m");
    expect(panelStyle(theme, { NO_COLOR: "1" }).dim("x")).toBe("\x1b[2mx\x1b[22m");
  });

  it("keys change settings in place; engine notifications land in the panel, not in toasts", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    const { engine } = makeEngine();
    registerPi(f.pi, engine, {});
    await f.emit("session_start");
    const done = f.commands.get("speech").handler("", f.ctx);
    const c = f.overlay.component;
    c.handleInput("\x1b[A"); // up: wraps to Agent tools
    c.handleInput("\x1b[C"); // right
    await vi.waitFor(() => expect(engine.speech.settings.tools).toBe(false));
    expect(stripVTControlCharacters(f.screen())).toMatch(/Agent tools\s+off/);
    engine.notify("Playback failed (local): boom", "error");
    expect(f.notes).toEqual([]);
    expect(f.screen()).toContain("✗ Playback failed (local): boom");
    c.handleInput("\x1b");
    await done;
    engine.notify("after the panel", "info");
    expect(f.notes).toEqual([{ message: "after the panel", type: "info" }]);
  });

  it("never draws wider than it is given, and never throws while drawing", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    registerPi(f.pi, makeEngine().engine, {});
    await f.emit("session_start");
    const done = f.commands.get("speech").handler("", f.ctx);
    for (const w of [1, 20, 39, 40, 55, 69, 70, 78, 120]) {
      const lines: string[] = f.overlay.component.render(w);
      expect(Math.max(...lines.map((l) => visibleWidth(l))), `width ${w}`).toBeLessThanOrEqual(w);
    }
    f.overlay.component.handleInput("\x1b");
    await done;
  });

  it("fits a short terminal: never more lines than rows", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    f.overlay.rows = 15;
    registerPi(f.pi, makeEngine().engine, {});
    await f.emit("session_start");
    const done = f.commands.get("speech").handler("", f.ctx);
    const lines: string[] = f.overlay.component.render(100);
    // Pi's footer keeps its rows
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.join("\n")).toMatch(/Speech[\s\S]*Agent tools[\s\S]*Esc close/);
    f.overlay.component.handleInput("\x1b");
    await done;
  });

  it("in RPC mode /speech alone keeps the menu of dialogs", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    f.ctx.mode = "rpc";
    registerPi(f.pi, makeEngine().engine, {});
    await f.emit("session_start");
    await f.commands.get("speech").handler("", f.ctx);
    expect(f.ctx.ui.custom).not.toHaveBeenCalled();
    expect(f.ctx.ui.select).toHaveBeenCalledWith("Speech", expect.arrayContaining(["Stop", "Replay last"]));
  });
});

describe("decoding keys", () => {
  it("names the keys the panel uses", () => {
    const d = new KeyDecoder();
    expect(d.decode("\x1b[A")).toEqual([{ key: "up" }]);
    expect(d.decode("\x1b[B")).toEqual([{ key: "down" }]);
    expect(d.decode("\x1b[D")).toEqual([{ key: "left" }]);
    expect(d.decode("\x1b[C")).toEqual([{ key: "right" }]);
    expect(d.decode("\r")).toEqual([{ key: "enter" }]);
    expect(d.decode("\x1b")).toEqual([{ key: "escape" }]);
    expect(d.decode("\t")).toEqual([{ key: "tab" }]);
    expect(d.decode("\x7f")).toEqual([{ key: "backspace" }]);
    expect(d.decode("\x1bz")).toEqual([{ key: "dictate" }]);
    expect(d.decode("\x1bs")).toEqual([{ key: "speak" }]);
    expect(d.decode("\x1b[Z")).toEqual([{ key: "backtab" }]);
    expect(d.decode("\x1bOQ")).toEqual([{ key: "language" }]);
    expect(d.decode("\x1b[12~")).toEqual([{ key: "language" }]);
  });

  it("passes typed text, drops other control input, and collects a bracketed paste", () => {
    const d = new KeyDecoder();
    expect(d.decode("s")).toEqual([{ text: "s" }]);
    expect(d.decode("l")).toEqual([{ text: "l" }]);
    expect(d.decode("é")).toEqual([{ text: "é" }]);
    expect(d.decode("\x01")).toEqual([]);
    expect(d.decode("\x1b[200~hello ")).toEqual([]);
    expect(d.decode("world\x1b[201~")).toEqual([{ text: "hello world", paste: true }]);
  });
});
