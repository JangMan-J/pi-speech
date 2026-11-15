import { stripVTControlCharacters } from "node:util";
import { setKittyProtocolActive, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PANEL_KEYS, type Panel, type PanelKey, type PanelView } from "../../src/engine/panel";
import { Surface } from "../../src/engine/surface";
import { registerPi } from "../../src/pi/adapter";
import { KEYS } from "../../src/pi/frame";
import { KeyDecoder, openPanel, panelStyle } from "../../src/pi/panel";
import { fakeOpenRouter, makeEngine } from "../engine/fixtures";

afterEach(() => {
  setKittyProtocolActive(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
};

interface CustomCall {
  component: any;
  options: any;
  closed: Promise<unknown>;
  isDone: () => boolean;
  renders: number;
}

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
    sendUserMessage: vi.fn(async () => {}),
  };
  const customs: CustomCall[] = [];
  let rows: number | undefined;
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    idle: true,
    isIdle: () => ctx.idle,
    reload: vi.fn(async () => {}),
    cwd: "/",
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: {
      notify: vi.fn(),
      setStatus: () => {},
      select: vi.fn(async () => undefined),
      input: vi.fn(async () => undefined),
      pasteToEditor: vi.fn(),
      custom: vi.fn((factory: any, options: any) => {
        let settled = false;
        const entry: CustomCall = {
          component: undefined,
          options,
          closed: Promise.resolve(),
          isDone: () => settled,
          renders: 0,
        };
        entry.closed = new Promise<unknown>((resolve) => {
          const tui = { requestRender: () => entry.renders++, terminal: { rows } };
          entry.component = factory(tui, theme, {}, (result: unknown) => {
            settled = true;
            resolve(result);
          });
        });
        customs.push(entry);
        return entry.closed;
      }),
    },
  };
  const emit = async (e: string) => {
    for (const fn of handlers.get(e) ?? []) await fn({}, ctx);
  };
  return {
    pi,
    ctx,
    commands,
    shortcuts,
    emit,
    customs,
    setRows: (r: number | undefined) => {
      rows = r;
    },
    dock: () => customs[0]!,
    overlays: () => customs.filter((c) => c.options?.overlay),
  };
}

describe("frame key alignment and KeyDecoder", () => {
  it("matches PANEL_KEYS sort, detail, pageUp and pageDown to frame.ts KEYS", () => {
    expect(PANEL_KEYS.sort).toEqual(KEYS.sort);
    expect(PANEL_KEYS.detail).toEqual(KEYS.detail);
    expect(PANEL_KEYS.pageUp).toEqual(KEYS.pageUp);
    expect(PANEL_KEYS.pageDown).toEqual(KEYS.pageDown);
  });

  it("decodes panel chords as { combo } and tab/backtab as named keys in legacy and Kitty encodings", () => {
    const d = new KeyDecoder();
    // Legacy sequences
    expect(d.decode("\x13")).toEqual([{ combo: "ctrl+s" }]);
    expect(d.decode("\x04")).toEqual([{ combo: "ctrl+d" }]);
    expect(d.decode("\x10")).toEqual([{ combo: "ctrl+p" }]);
    expect(d.decode("\x0f")).toEqual([{ combo: "ctrl+o" }]);
    expect(d.decode("\x0c")).toEqual([{ combo: "ctrl+l" }]);
    expect(d.decode("\x0e")).toEqual([{ combo: "ctrl+n" }]);
    expect(d.decode("\x14")).toEqual([{ combo: "ctrl+t" }]);
    expect(d.decode("\x1b[5~")).toEqual([{ combo: "pageUp" }]);
    expect(d.decode("\x1b[6~")).toEqual([{ combo: "pageDown" }]);
    expect(d.decode("\x1b[1;2A")).toEqual([{ combo: "shift+up" }]);
    expect(d.decode("\x1b[1;2B")).toEqual([{ combo: "shift+down" }]);
    expect(d.decode("\x1b[A")).toEqual([{ key: "up" }]);
    expect(d.decode("\t")).toEqual([{ key: "tab" }]);
    expect(d.decode("\x1b[Z")).toEqual([{ key: "backtab", id: "shift+tab" }]);

    // Kitty CSI-u / modified sequences
    setKittyProtocolActive(true);
    expect(d.decode("\x1b[115;5u")).toEqual([{ combo: "ctrl+s" }]);
    expect(d.decode("\x1b[100;5u")).toEqual([{ combo: "ctrl+d" }]);
    expect(d.decode("\x1b[112;5u")).toEqual([{ combo: "ctrl+p" }]);
    expect(d.decode("\x1b[111;5u")).toEqual([{ combo: "ctrl+o" }]);
    expect(d.decode("\x1b[5;1:1~")).toEqual([{ combo: "pageUp" }]);
    expect(d.decode("\x1b[6;1:1~")).toEqual([{ combo: "pageDown" }]);
    expect(d.decode("\x1b[1;2:1A")).toEqual([{ combo: "shift+up" }]);
    expect(d.decode("\x1b[9u")).toEqual([{ key: "tab" }]);
    expect(d.decode("\x1b[9;2u")).toEqual([{ key: "backtab", id: "shift+tab" }]);
    expect(d.decode("\x1b[115;5:3u")).toEqual([]); // key release ignored
  });

  it("respects custom Speak/Dictate hotkeys and collects multi-chunk bracketed paste", () => {
    const d = new KeyDecoder({ speak: "alt+d", dictate: "ctrl+alt+x" });
    expect(d.decode("\x1bd")).toEqual([{ key: "speak", id: "alt+d" }]);
    expect(d.decode("\x1b\x18")).toEqual([{ key: "dictate", id: "ctrl+alt+x" }]);
    expect(d.decode("\x1b[200~part ")).toEqual([]);
    expect(d.decode("two\x1b[201~")).toEqual([{ text: "part two", paste: true }]);
  });
});

describe("floating panes and dock in Pi's TUI", () => {
  it("opens the login overlay when view().login is set and forwards typing, paste, Backspace, Enter and Esc", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    const { engine } = makeEngine();
    const surface = new Surface(engine);
    let tracked: Panel | undefined;
    const panelClosed = openPanel(
      f.ctx,
      engine,
      surface,
      {
        cwd: "/",
        notify: () => {},
        paste: () => {},
        select: async () => undefined,
        input: async () => undefined,
        pick: async () => undefined,
      },
      { NO_COLOR: "1" },
      (p) => {
        tracked = p;
      },
    );
    expect(tracked).toBeDefined();

    let login: PanelView["login"];
    let nextLogin: PanelView["login"];
    let submitted: string | undefined;
    let cancelled = false;
    const baseView = tracked!.view.bind(tracked);
    vi.spyOn(tracked!, "view").mockImplementation(() => ({ ...baseView(), login }));
    vi.spyOn(tracked!, "handle").mockImplementation((k: PanelKey) => {
      if (!login) {
        if ("key" in k && k.key === "enter" && nextLogin) {
          login = nextLogin;
          nextLogin = undefined;
        }
        return;
      }
      if ("text" in k) {
        login = { ...login, value: login.value + k.text, cursor: login.cursor + [...k.text].length };
      } else if ("key" in k) {
        if (k.key === "backspace") {
          const chars = [...login.value];
          chars.pop();
          login = { ...login, value: chars.join(""), cursor: chars.length };
        } else if (k.key === "enter") {
          submitted = login.value;
          login = undefined;
        } else if (k.key === "escape") {
          cancelled = true;
          login = undefined;
        }
      }
    });

    // Trigger via the panel's changed callback (engine.onRemoteChange fires changed()).
    login = { prompt: "Password for alice@box", secret: true, confirm: false, value: "", cursor: 0 };
    engine.onRemoteChange();
    expect(f.overlays()).toHaveLength(1);
    const first = f.overlays()[0]!;
    expect(first.options).toMatchObject({ overlay: true, overlayOptions: { anchor: "center" } });

    const renderPlain = (c: CustomCall) => stripVTControlCharacters(c.component.render(56).join("\n"));
    expect(renderPlain(first)).toContain("Password for alice@box");
    expect(renderPlain(first)).toContain("Enter sign in · Esc cancel");

    first.component.handleInput("s3");
    expect(login?.value).toBe("s3");
    expect(renderPlain(first)).toContain("> ••");
    expect(renderPlain(first)).not.toContain("s3");

    first.component.handleInput("\x1b[200~cr3tX\x1b[201~");
    expect(login?.value).toBe("s3cr3tX");

    first.component.handleInput("\x7f");
    expect(login?.value).toBe("s3cr3t");

    first.component.handleInput("\r");
    expect(submitted).toBe("s3cr3t");
    expect(login).toBeUndefined();
    expect(first.isDone()).toBe(true);

    // Esc cancels and closes a new login prompt triggered after a handled key on the dock.
    nextLogin = { prompt: "Install receiver on box?", secret: false, confirm: true, value: "", cursor: 0 };
    f.dock().component.handleInput("\r");
    expect(f.overlays()).toHaveLength(2);
    const second = f.overlays()[1]!;
    expect(renderPlain(second)).toContain("Install receiver on box?");
    expect(renderPlain(second)).toContain("Enter yes · Esc no");
    second.component.handleInput("\x1b");
    expect(cancelled).toBe(true);
    expect(second.isDone()).toBe(true);

    // Closing the panel while a login pane is open closes the login pane too.
    login = { prompt: "Password again", secret: true, confirm: false, value: "", cursor: 0 };
    engine.onRemoteChange();
    const third = f.overlays()[2]!;
    expect(third.isDone()).toBe(false);
    f.dock().component.dispose();
    await panelClosed;
    expect(third.isDone()).toBe(true);
  });

  it("Ctrl+D opens a floating detail pane when picker.detail is non-empty, and passes through otherwise", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    const { engine } = makeEngine();
    const surface = new Surface(engine);
    let tracked: Panel | undefined;
    const done = openPanel(
      f.ctx,
      engine,
      surface,
      {
        cwd: "/",
        notify: () => {},
        paste: () => {},
        select: async () => undefined,
        input: async () => undefined,
        pick: async () => undefined,
      },
      { NO_COLOR: "1" },
      (p) => {
        tracked = p;
      },
    );

    const forwarded: PanelKey[] = [];
    const baseView = tracked!.view.bind(tracked);
    let withDetail = false;
    vi.spyOn(tracked!, "view").mockImplementation(() => ({
      ...baseView(),
      picker: withDetail
        ? {
            title: "Speech model",
            noun: "models",
            query: "",
            cursor: 0,
            items: [{ id: "vendor/tts-1", label: "TTS One", current: true }],
            selected: 0,
            total: 1,
            loading: false,
            empty: "None",
            detail: "Full model description that wraps cleanly across lines inside the detail overlay box.",
          }
        : undefined,
    }));
    vi.spyOn(tracked!, "handle").mockImplementation((k) => {
      forwarded.push(k);
    });

    // No picker detail -> passed straight to engine.
    f.dock().component.handleInput("\x04");
    expect(forwarded).toEqual([{ combo: "ctrl+d" }]);
    expect(f.overlays()).toHaveLength(0);

    // Picker with detail -> opens floating detail pane; any key closes it.
    withDetail = true;
    f.dock().component.render(140);
    f.dock().component.handleInput("\x04");
    expect(forwarded).toHaveLength(1);
    expect(f.overlays()).toHaveLength(1);
    const pane = f.overlays()[0]!;
    const rendered = stripVTControlCharacters(pane.component.render(60).join("\n"));
    expect(rendered).toContain("TTS One");
    expect(rendered).toContain("Full model description that wraps cleanly");
    expect(rendered).toContain("overlay box.");
    pane.component.handleInput(" ");
    expect(pane.isDone()).toBe(true);

    f.dock().component.dispose();
    await done;
  });

  it("/speech opens the 19-line framed dock (even on a short terminal), speaks from Main, and catches draw errors", async () => {
    const requests = fakeOpenRouter();
    const f = tuiPi();
    f.setRows(12);
    const { engine } = makeEngine();
    registerPi(f.pi, engine, { NO_COLOR: "1" });
    await f.emit("session_start");

    const done = f.commands.get("speech").handler("", f.ctx);
    expect(f.dock().options).toBeUndefined();
    const lines = f.dock().component.render(100);
    expect(lines).toHaveLength(19);
    expect(Math.max(...lines.map((l: string) => visibleWidth(l)))).toBeLessThanOrEqual(100);
    expect(stripVTControlCharacters(lines.join("\n"))).toContain("Speak: >");

    f.dock().component.handleInput("hello frame");
    f.dock().component.handleInput("\r");
    await vi.waitFor(() => expect(requests.filter((r) => r.body?.input)).toHaveLength(1));
    expect(requests.find((r) => r.body?.input)?.body.input).toBe("hello frame");

    expect(panelStyle(theme, {}).accent("x")).toBe("<accent>x</accent>");
    expect(panelStyle(theme, { NO_COLOR: "1" }).accent("x")).toBe("x");

    f.dock().component.handleInput("\x1b");
    await done;
  });

  it("falls back to a one-line error if renderPanel throws, and keeps RPC mode on ctx.ui.select", async () => {
    fakeOpenRouter();
    const f = tuiPi();
    const { engine } = makeEngine();
    const surface = new Surface(engine);
    let tracked: Panel | undefined;
    const done = openPanel(
      f.ctx,
      engine,
      surface,
      {
        cwd: "/",
        notify: () => {},
        paste: () => {},
        select: async () => undefined,
        input: async () => undefined,
        pick: async () => undefined,
      },
      {},
      (p) => {
        tracked = p;
      },
    );
    vi.spyOn(tracked!, "view").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(f.dock().component.render(80)).toEqual(["Speech: cannot draw the panel (boom) · Esc close"]);
    f.dock().component.dispose();
    await done;

    const rpc = tuiPi();
    rpc.ctx.mode = "rpc";
    registerPi(rpc.pi, makeEngine().engine, {});
    await rpc.emit("session_start");
    await rpc.commands.get("speech").handler("", rpc.ctx);
    expect(rpc.ctx.ui.custom).not.toHaveBeenCalled();
    expect(rpc.ctx.ui.select).toHaveBeenCalled();
  });
});
