import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../src/engine/engine";
import { matchItems, Panel, type PanelKey, type PanelView } from "../../src/engine/panel";
import type { Hotkeys } from "../../src/engine/settings";
import { Surface } from "../../src/engine/surface";
import { fakeOpenRouter, fakeReceiver, makeEngine, STAND_IN_BINARY, scriptedUi } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

/** The rows of the main view, in order. */
const ROWS = [
  "Read aloud options",
  "Speech source",
  "Speech model",
  "Voice",
  "Transcription source",
  "Transcription model",
  "Dictation language",
  "Dictation output",
  "Hotkeys",
  "Bridge connection",
];

/** The rows of Hotkeys: every action. */
const ACTIONS = ["Speak…", "Dictate", "Replay last", "History…", "Stop", "Transcribe file…"];

const XAI_TOKEN = "xai-login-token-abcdef";

/** xAI answers voices and speech; OpenRouter as in the fixtures. */
function fakeXai() {
  const openrouter = fakeOpenRouter();
  const or = globalThis.fetch as (url: string, init?: RequestInit) => Promise<Response>;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (!url.startsWith("https://api.x.ai/")) return or(url, init);
      if (url.endsWith("/v1/tts/voices")) {
        return Response.json({ voices: [{ voice_id: "eve", name: "Eve", language: "multilingual" }] });
      }
      return new Response(new Uint8Array(100), { headers: { "content-type": "audio/wav" } });
    }),
  );
  return openrouter;
}

function open(
  env: Record<string, string> = {},
  opts: { xai?: boolean; before?: (e: Engine) => void; hotkeys?: Hotkeys } = {},
) {
  const requests = opts.xai === undefined ? fakeOpenRouter() : fakeXai();
  const made = makeEngine(env);
  if (opts.xai !== undefined) {
    const token = opts.xai ? XAI_TOKEN : undefined;
    made.engine.speech.registry = { getApiKeyForProvider: async (p: string) => (p === "xai" ? token : undefined) };
  }
  opts.before?.(made.engine);
  const { ui, notes, pasted } = scriptedUi();
  const close = vi.fn();
  const changed = vi.fn();
  const panel = new Panel(made.engine, new Surface(made.engine), {
    ui,
    close,
    changed,
    ...(opts.hotkeys ? { hotkeys: opts.hotkeys } : {}),
  });
  panel.open();
  const press = async (...keys: Array<PanelKey | string>) => {
    for (const k of keys) panel.handle(typeof k === "string" ? { key: k as never } : k);
    await panel.idle();
  };
  const type = async (text: string) => press({ text });
  const row = (label: string, v: PanelView = panel.view()) => v.rows.find((r) => r.label === label);
  const selectedLabel = () => panel.view().rows[panel.view().selected].label;
  /**
   * Select the row `label`: in the main view, or in Hotkeys for an action (entering it from the main view),
   * or in Bridge connection for Bridge.
   */
  const goTo = async (label: string) => {
    const menu = ACTIONS.includes(label) ? "hotkeys" : label === "Bridge" ? "bridge" : "main";
    if (panel.view().menu !== menu && panel.view().menu !== "main") await press("escape");
    if (menu !== "main" && panel.view().menu === "main") {
      await goTo(menu === "hotkeys" ? "Hotkeys" : "Bridge connection");
      await press("enter");
    }
    for (let i = 0; i < panel.view().rows.length && selectedLabel() !== label; i++) await press("down");
    expect(selectedLabel()).toBe(label);
  };
  const hint = () =>
    panel
      .view()
      .hints.map((h) => (h.action ? `${h.key} ${h.action}` : h.key))
      .join(" · ");
  const picked = () => {
    const p = panel.view().picker;
    return p?.items[p.selected];
  };
  return {
    ...made,
    requests,
    panel,
    ui,
    notes,
    pasted,
    close,
    changed,
    press,
    type,
    row,
    selectedLabel,
    goTo,
    hint,
    picked,
  };
}

const settingsOf = (work: string) =>
  JSON.parse(readFileSync(join(work, "agent", "pi-speech", "settings.json"), "utf8"));

describe("the panel view model: the main view", () => {
  it("has the title, no state when nothing happens, and SPEAK, LISTEN and SETTINGS with their keys", async () => {
    const p = open();
    await p.panel.idle();
    const v = p.panel.view();
    expect(v.title).toBe("Speech");
    expect(v.menu).toBe("main");
    expect(v.crumb).toBeUndefined();
    expect(v.state).toBe("");
    expect(v.rows.map((r) => r.label)).toEqual(ROWS);
    expect(v.headings).toEqual({ speak: "SPEAK (Alt+S)", listen: "LISTEN (Alt+Z)", settings: "SETTINGS" });
    expect(v.rows.filter((r) => r.section === "speak").map((r) => r.label)).toEqual(ROWS.slice(0, 4));
    expect(v.rows.filter((r) => r.section === "listen").map((r) => r.label)).toEqual(ROWS.slice(4, 8));
    expect(v.rows.filter((r) => r.section === "settings").map((r) => r.label)).toEqual(ROWS.slice(8));
    expect(v.selected).toBe(0);
    expect(Object.fromEntries(v.rows.map((r) => [r.label, r.value]))).toEqual({
      "Read aloud options": "Off",
      "Speech source": "Provider",
      "Speech model": "google/gemini-3.8-flash-tts",
      Voice: "Kore",
      "Transcription source": "Provider",
      "Transcription model": "openai/whisper-large-v3-turbo",
      "Dictation language": "auto",
      "Dictation output": "Pi",
      Hotkeys: undefined,
      "Bridge connection": undefined,
    });
  });

  it("the section headings carry the keys Pi has bound", async () => {
    const p = open({}, { hotkeys: { speak: "ctrl+alt+s", dictate: "alt+d" } });
    expect(p.panel.view().headings).toMatchObject({ speak: "SPEAK (Ctrl+Alt+S)", listen: "LISTEN (Alt+D)" });
  });

  it("marks the rows whose Enter opens a picker or a submenu, and only those", async () => {
    const p = open();
    const opens = p.panel
      .view()
      .rows.filter((r) => r.opens)
      .map((r) => r.label);
    expect(opens).toEqual([
      "Read aloud options",
      "Speech model",
      "Voice",
      "Transcription model",
      "Dictation output",
      "Hotkeys",
      "Bridge connection",
    ]);
  });

  it("shows only the name of a model or a voice: no price, features, provider or language", async () => {
    const p = open();
    await p.panel.idle();
    await p.engine.speech.set("tts-model", "hexgrad/kokoro-82m");
    await p.engine.speech.set("voice", "jf_alpha");
    await p.engine.speech.setLanguage("jf_alpha", "fr");
    for (const label of ["Speech model", "Voice", "Transcription model"]) {
      const r = p.row(label);
      expect(r?.note, label).toBeUndefined();
      expect(Object.keys(r ?? {}).sort(), label).toEqual(["id", "label", "opens", "section", "value"]);
    }
    expect(p.row("Speech model")?.value).toBe("hexgrad/kokoro-82m");
    expect(p.row("Voice")?.value).toBe("jf_alpha");
  });

  it("shows the xai model as xAI Grok; the saved id stays xai", async () => {
    const p = open({}, { xai: true });
    await p.goTo("Speech model");
    await p.press("enter", { text: "xai" }, "enter");
    expect(p.engine.speech.settings.speechModel).toBe("xai");
    expect(settingsOf(p.work).speechModel).toBe("xai");
    expect(p.row("Speech model")).toMatchObject({ value: "xAI Grok" });
    expect(p.row("Speech model")?.note).toBeUndefined();
    expect(p.row("Voice")).toMatchObject({ value: "eve" });
  });

  it("a saved xai choice without the login is shown as unavailable, with the reason", async () => {
    const p = open(
      {},
      {
        xai: false,
        before: (e) => {
          e.speech.settings.speechModel = "xai";
        },
      },
    );
    await p.panel.idle();
    expect(p.row("Speech model")).toMatchObject({ value: "xAI Grok", note: "✗ xAI: no login", alert: true });
    expect(p.row("Voice")).toMatchObject({ note: "✗ voices unavailable", alert: true });
    await p.goTo("Voice");
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.panel.view().status).toMatchObject({ tone: "error", text: expect.stringMatching(/^✗ No xAI login/) });
  });

  it("model lists that cannot load are a ✗ note on the model rows", async () => {
    const p = open(
      {},
      {
        before: (e) => {
          e.speech.models = async () => {
            throw new Error("offline");
          };
        },
      },
    );
    await p.panel.idle();
    expect(p.row("Transcription model")).toMatchObject({ note: "✗ models unavailable", alert: true });
    expect(p.row("Speech model")).toMatchObject({ note: "✗ models unavailable", alert: true });
  });
});

describe("the panel view model: keys in the main view", () => {
  it("↑↓ move row by row and wrap", async () => {
    const p = open();
    await p.press("up");
    expect(p.selectedLabel()).toBe("Bridge connection");
    await p.press("down");
    expect(p.selectedLabel()).toBe("Read aloud options");
    for (const label of ROWS.slice(1)) {
      await p.press("down");
      expect(p.selectedLabel()).toBe(label);
    }
  });

  it("Read aloud options is a submenu: Read, Summarized by, Length, Truncate at", async () => {
    const p = open();
    expect(p.row("Read aloud options")).toMatchObject({ value: "Off", opens: true });
    await p.press("enter");
    const v = p.panel.view();
    expect(v.menu).toBe("readAloud");
    expect(v.crumb).toBe("Read aloud options");
    expect(v.rows.map((r) => [r.label, r.value, !!r.opens])).toEqual([
      ["Read", "Off", false],
      ["Summarized by", "Same model", true],
      ["Length", "Abridged ~30 s", false],
      ["Truncate at", "Off", false],
    ]);
    expect(v.status).toEqual({ tone: "info", text: "Off: nothing is read aloud." });
    expect(p.hint()).toBe("←→ Off · Summary · Thinking · All · Esc back");
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
    expect(p.selectedLabel()).toBe("Read aloud options");
  });

  it("Read cycles Off, Summary, Thinking and All in place with Enter and ←→; one line says what it does", async () => {
    const p = open();
    await p.press("enter");
    const lines: Array<[string | undefined, string | undefined]> = [];
    for (let i = 0; i < 4; i++) {
      await p.press(i === 3 ? "enter" : "right");
      lines.push([p.row("Read")?.value, p.panel.view().status?.text]);
    }
    expect(lines).toEqual([
      ["Summary", "Reads the model's spoken summary of its reply."],
      ["Thinking", "Reads a spoken summary of the reasoning, then of the reply."],
      ["All", "Reads the whole reply."],
      ["Off", "Off: nothing is read aloud."],
    ]);
    await p.press("left");
    expect(p.engine.readAloud.mode).toBe("all");
    await p.press("escape");
    expect(p.row("Read aloud options")?.value).toBe("All");
    expect(p.notes).toEqual([]);
  });

  it("Length and Truncate at cycle in place, are saved, and their lines say what they promise", async () => {
    const p = open();
    await p.press("enter", "down", "down");
    expect(p.panel.view().status?.text).toBe("Best effort: about 30 s.");
    expect(p.hint()).toBe("←→ Minimum · Abridged · Full · Esc back");
    await p.press("right");
    expect(p.row("Length")?.value).toBe("Full ~60 s");
    expect(p.panel.view().status?.text).toBe("Best effort: about 60 s.");
    await p.press("enter");
    expect(p.row("Length")?.value).toBe("Minimum ~15 s");
    await p.press("down");
    expect(p.panel.view().status?.text).toBe("Off: length not guaranteed.");
    expect(p.hint()).toBe("←→ Off · 15 s · 30 s · 60 s · 120 s · Esc back");
    await p.press("right", "right");
    expect(p.row("Truncate at")?.value).toBe("30 s");
    expect(p.panel.view().status?.text).toBe("Stops at 30 s, at a sentence end.");
    await p.press("left", "left", "left");
    expect(p.row("Truncate at")?.value).toBe("120 s");
    const saved = JSON.parse(readFileSync(join(p.work, "agent", "pi-speech", "settings.json"), "utf8"));
    expect(saved.readAloud).toEqual({ length: "minimum", truncate: 120 });
  });

  it("Summarized by opens a picker of Same model and the user's Pi models", async () => {
    const p = open();
    p.engine.readAloud.models = () => ["anthropic/claude-haiku", "openai/gpt-mini"];
    await p.press("enter", "down");
    expect(p.panel.view().status?.text).toBe("Same model, same reply. No extra request.");
    expect(p.hint()).toBe("Enter choose a model · Esc back");
    await p.press("right");
    expect(p.panel.view().picker).toBeUndefined();
    await p.press("enter");
    const picker = p.panel.view().picker;
    expect(picker?.title).toBe("Summarized by");
    expect(picker?.items.map((i) => [i.label, i.current])).toEqual([
      ["Same model", true],
      ["anthropic/claude-haiku", false],
      ["openai/gpt-mini", false],
    ]);
    await p.type("haiku");
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.row("Summarized by")?.value).toBe("anthropic/claude-haiku");
    expect(p.panel.view().status?.text).toBe("Extra request to anthropic/claude-haiku per reply.");
    expect(p.engine.speech.settings.readAloud.summarizer).toBe("anthropic/claude-haiku");
    await p.press("enter", "enter");
    expect(p.row("Summarized by")?.value).toBe("Same model");
    expect(p.engine.speech.settings.readAloud.summarizer).toBeUndefined();
  });

  it("the source rows cycle Provider and Local, each on its own, saved at once", async () => {
    const p = open({ PI_SPEECH_BINARY: join(tmpdir(), "no-such-receiver") });
    await p.goTo("Transcription source");
    await p.press("right");
    expect(p.row("Transcription source")?.value).toBe("Local");
    expect(p.row("Speech source")?.value).toBe("Provider");
    expect(p.panel.view().status).toEqual({ tone: "success", text: "✓ Transcription source: Local" });
    expect(settingsOf(p.work)).toMatchObject({ transcriptionSource: "local" });
    expect(settingsOf(p.work).speechSource).toBeUndefined();
    await p.goTo("Speech source");
    await p.press("enter");
    expect(p.row("Speech source")?.value).toBe("Local");
    expect(p.panel.view().status).toEqual({
      tone: "warning",
      text: "! Speech source: Local · local speech is not available yet",
    });
    expect(p.row("Speech model")).toMatchObject({
      value: "none",
      note: "✗ local speech not available yet",
      alert: true,
    });
    // Without the binary the local model rows say so.
    expect(p.row("Transcription model")).toMatchObject({ value: "none", note: "✗ local models unavailable" });
    await p.press("left");
    expect(p.row("Speech source")?.value).toBe("Provider");
    expect(p.row("Speech model")?.value).toBe("google/gemini-3.8-flash-tts");
    expect(settingsOf(p.work)).toMatchObject({ transcriptionSource: "local" });
  });

  it("a Local model list without the binary goes back and says why", async () => {
    const p = open({ PI_SPEECH_BINARY: join(tmpdir(), "no-such-receiver") });
    p.engine.speech.setSource("transcription", "local");
    await p.goTo("Transcription model");
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.panel.view().status?.text).toMatch(/^✗ Local models: PI_SPEECH_BINARY .* is not an executable$/);
  });

  it("←→ on a picker row do nothing", async () => {
    const p = open();
    await p.goTo("Voice");
    await p.press("right", "left");
    expect(p.row("Voice")?.value).toBe("Kore");
    expect(p.panel.view().picker).toBeUndefined();
  });

  it("typing on a picker row opens its picker with that character typed, l included", async () => {
    const p = open();
    await p.goTo("Transcription model");
    await p.type("1");
    const picker = p.panel.view().picker;
    expect(picker).toMatchObject({ title: "Transcription model", query: "1" });
    expect(picker?.items.map((i) => i.id)).toEqual(["openai/whisper-1"]);
    await p.press("enter");
    expect(p.row("Transcription model")?.value).toBe("openai/whisper-1");
    await p.goTo("Voice");
    await p.type("l");
    expect(p.panel.view().picker).toMatchObject({ title: "Voice", query: "l" });
    expect(p.panel.view().input).toBeUndefined();
  });

  it("typing on a value row does nothing but the action keys", async () => {
    const p = open();
    await p.type("x");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.panel.view().input).toBeUndefined();
    expect(p.row("Read aloud options")?.value).toBe("Off");
  });

  it("F2 on the Voice row asks for the voice language (a tag or auto); the voice picker shows it", async () => {
    const p = open();
    await p.goTo("Voice");
    await p.press("language");
    const input = p.panel.view().input;
    expect(input?.label).toMatch(/Kore/);
    expect(input?.under).toBe("voice");
    expect(input?.placeholder).toMatch(/ja/);
    expect(input?.placeholder).toMatch(/auto/);
    expect(p.hint()).toBe("Enter set · Esc back");
    await p.type("xx-yyy");
    await p.press("enter");
    expect(p.panel.view().status?.tone).toBe("error");
    expect(p.panel.view().input).toBeDefined();
    for (let i = 0; i < 6; i++) await p.press("backspace");
    await p.type("ja");
    await p.press("enter");
    expect(p.panel.view().input).toBeUndefined();
    expect(p.row("Voice")?.note).toBeUndefined();
    await p.press("enter");
    expect(p.panel.view().picker?.items.find((i) => i.id === "Kore")?.cols?.[0]).toBe("ja · set by you");
  });

  it("F2 on other rows does nothing", async () => {
    const p = open();
    await p.goTo("Speech model");
    await p.press("language");
    expect(p.panel.view().input).toBeUndefined();
  });

  it("Tab on the Voice row samples the current voice; on other rows it does nothing", async () => {
    const p = open();
    await p.press("tab");
    expect(p.requests.filter((r) => r.url.endsWith("/audio/speech"))).toHaveLength(0);
    await p.goTo("Voice");
    await p.press("tab");
    expect(p.requests.at(-1)?.body.voice).toBe("Kore");
  });

  it("the sample line names the sample language, and why it is English when it falls back", async () => {
    const p = open();
    await p.engine.speech.set("tts-model", "hexgrad/kokoro-82m");
    await p.engine.speech.set("voice", "jf_alpha");
    await p.goTo("Voice");
    await p.press("tab");
    expect(p.panel.view().status?.text).toBe("✓ sampled jf_alpha in ja");
    await p.engine.speech.set("tts-model", "x-ai/grok-voice-tts-1.0");
    await p.press("tab");
    expect(p.panel.view().status?.text).toMatch(/^✓ sampled \w+ in English · language unknown$/);
  });

  it("a failed sample is a ✗ line in the panel, not a notification", async () => {
    const p = open();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("quota", { status: 402 })),
    );
    await p.goTo("Voice");
    await p.press("tab");
    expect(p.panel.view().status).toMatchObject({ tone: "error", text: expect.stringMatching(/^✗ .*402/) });
    expect(p.notes).toEqual([]);
  });

  it("the hints follow the row; Esc is last", async () => {
    const p = open();
    const hints: Record<string, string> = {
      "Read aloud options": "Enter what is read and how · Esc close",
      "Speech source": "←→ Provider · Local · Esc close",
      "Speech model": "Enter browse, sort and filter · Esc close",
      Voice: "Enter choose · Tab sample · F2 language · Esc close",
      "Transcription source": "←→ Provider · Local · Esc close",
      "Transcription model": "Enter browse, sort and filter · Esc close",
      "Dictation language": "Enter set · Esc close",
      "Dictation output": "Enter set · Esc close",
      Hotkeys: "Enter run actions, change keys · Esc close",
      "Bridge connection": "Enter where audio plays · Esc close",
    };
    for (const label of ROWS) {
      await p.goTo(label);
      expect(p.hint(), label).toBe(hints[label]);
    }
  });

  it("the picker hints follow its state: loaded, no match, loading", async () => {
    const p = open();
    await p.goTo("Voice");
    await p.press("enter");
    expect(p.hint()).toBe("Enter pick · Tab sample · F2 language · type to filter · Esc back");
    expect(
      p.panel
        .view()
        .hints.filter((h) => h.optional)
        .map((h) => h.key),
    ).toEqual(["Tab", "F2"]);
    await p.type("zz");
    expect(p.hint()).toBe("Backspace · Esc back");
    await p.press("escape", "up");
    await p.press("enter");
    expect(p.hint()).toBe("Enter pick · Tab sort · Shift+Tab show · type to filter · Esc back");
    await p.engine.speech.set("tts-model", "hexgrad/kokoro-82m");
    let release!: () => void;
    p.engine.speech.voicesFor = () =>
      new Promise((r) => {
        release = () => r(["A"]);
      });
    await p.press("escape", "down");
    p.panel.handle({ key: "enter" });
    expect(p.panel.view().picker?.loading).toBe(true);
    expect(p.hint()).toBe("Esc back");
    release();
    await p.panel.idle();
  });

  it("Esc closes the panel; the header follows the live state", async () => {
    const p = open();
    await p.engine.speech.speak("words");
    expect(p.panel.view().state).toBe("▶ speaking");
    expect(p.changed).toHaveBeenCalled();
    await p.type("s");
    expect(p.panel.view().state).toBe("");
    await p.press("escape");
    expect(p.close).toHaveBeenCalled();
  });

  it("an engine notification while open becomes the status line", async () => {
    const p = open();
    p.panel.report("Playback failed (local): boom", "error");
    expect(p.panel.view().status).toEqual({ tone: "error", text: "✗ Playback failed (local): boom" });
  });

  it("after dispose it no longer listens to the engine", async () => {
    const p = open();
    await p.panel.idle();
    p.panel.dispose();
    p.changed.mockClear();
    await p.engine.speech.speak("words");
    expect(p.changed).not.toHaveBeenCalled();
  });
});

describe("the panel view model: Bridge connection", () => {
  it("is a submenu holding the bridge mode, which cycles auto, on, off in place and is saved", async () => {
    const p = open();
    await p.panel.idle();
    await p.goTo("Bridge connection");
    await p.press("enter");
    const v = p.panel.view();
    expect(v).toMatchObject({ menu: "bridge", crumb: "Bridge connection", selected: 0 });
    expect(v.headings).toBeUndefined();
    expect(p.row("Bridge")).toMatchObject({ value: "auto", note: "on over SSH · plays on This machine" });
    expect(p.hint()).toBe("←→ auto · on · off · Esc back");
    p.engine.routes.bridge.health = async () => ({ ok: false, reason: "connection refused" });
    await p.press("right");
    // an unreachable receiver keeps the mode, and says why
    expect(p.row("Bridge")?.value).toBe("auto");
    expect(p.panel.view().status).toMatchObject({
      tone: "error",
      text: expect.stringMatching(/^✗ .*connection refused/),
    });
    p.engine.routes.bridge.health = async () => ({ ok: true, version: "0.1.0" });
    await p.press("right");
    expect(p.row("Bridge")).toMatchObject({ value: "on", note: "plays on the Remote machine · ✓ 127.0.0.1:47613" });
    await p.press("enter");
    expect(p.row("Bridge")).toMatchObject({ value: "off", note: "plays on This machine" });
    expect(settingsOf(p.work).bridge).toBe("off");
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
    expect(p.selectedLabel()).toBe("Bridge connection");
    expect(p.close).not.toHaveBeenCalled();
  });

  it("over SSH auto plays on the Remote machine; an unreachable receiver is a ✗ note", async () => {
    const p = open(
      { SSH_CONNECTION: "1 2 3 4" },
      {
        before: (e) => {
          e.routes.bridge.health = async () => ({ ok: false, reason: "connection refused" });
        },
      },
    );
    await p.panel.idle();
    await p.goTo("Bridge");
    expect(p.row("Bridge")).toMatchObject({
      value: "auto",
      note: "on over SSH · plays on the Remote machine · ✗ receiver unreachable",
      alert: true,
    });
  });
});

describe("the panel view model: Hotkeys", () => {
  it("lists every action with its key; the submenu has its own title and hints", async () => {
    const p = open();
    await p.goTo("Hotkeys");
    await p.press("enter");
    const v = p.panel.view();
    expect(v).toMatchObject({ menu: "hotkeys", crumb: "Hotkeys", selected: 0 });
    expect(v.rows.map((r) => [r.label, r.value])).toEqual([
      ["Speak…", "Alt+S"],
      ["Dictate", "Alt+Z"],
      ["Replay last", "r"],
      ["History…", "h"],
      ["Stop", "s"],
      ["Transcribe file…", "t"],
    ]);
    expect(p.hint()).toBe("Enter run · k change key · Esc back");
    await p.press("down");
    expect(p.hint()).toBe("Enter run · k change key · Esc back");
    await p.press("down");
    expect(p.hint()).toBe("Enter run · Esc back");
    await p.press("up", "up", "up");
    expect(p.selectedLabel()).toBe("Transcribe file…");
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
    expect(p.selectedLabel()).toBe("Hotkeys");
  });

  it("Speak… opens a dedicated composer; Enter speaks and clears it; Esc returns to Hotkeys", async () => {
    const p = open();
    await p.goTo("Speak…");
    await p.press("enter");
    expect(p.panel.view()).toMatchObject({ title: "Speak", composer: true });
    expect(p.panel.view().input).toMatchObject({ value: "" });
    expect(p.hint()).toBe("Enter speak · Esc back");
    await p.type("panel hello");
    await p.press("up", "down");
    p.panel.handle({ key: "enter" });
    expect(p.panel.view().input?.value).toBe("");
    expect(p.panel.view().status).toMatchObject({ tone: "busy", text: "♪ speaking…" });
    await p.type("second message");
    await p.press("enter");
    await p.panel.idle();
    expect(p.requests.filter((r) => r.body?.input).map((r) => r.body.input)).toEqual(["panel hello", "second message"]);
    expect(p.close).not.toHaveBeenCalled();
    p.local.end(1, { state: "completed" });
    await vi.waitFor(() => expect(p.panel.view().status).toMatchObject({ tone: "success", text: "✓ Spoken" }));
    await p.press("escape");
    expect(p.panel.view().menu).toBe("hotkeys");
    expect(p.panel.view().composer).toBeUndefined();
    expect(p.selectedLabel()).toBe("Speak…");
    expect(p.notes).toEqual([]);
  });

  it("a failed Speak is one ✗ line in the panel", async () => {
    const p = open();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("quota", { status: 402 })),
    );
    await p.press("speak");
    await p.type("hello");
    await p.press("enter");
    expect(p.panel.view().status).toMatchObject({ tone: "error", text: expect.stringMatching(/^✗ .*402/) });
    expect(p.close).not.toHaveBeenCalled();
    expect(p.notes).toEqual([]);
  });

  it("the composer says when the speech model takes inline tags", async () => {
    const p = open();
    await p.panel.idle();
    await p.press("speak");
    expect(p.panel.view().input?.placeholder).toMatch(/\[tags\] direct this model/);
    await p.press("escape");
    await p.engine.speech.set("tts-model", "hexgrad/kokoro-82m");
    await p.press("speak");
    expect(p.panel.view().input?.placeholder).not.toMatch(/tags/);
  });

  it("the Speak key opens the composer from the main view and from a picker", async () => {
    const p = open();
    await p.press("speak");
    expect(p.panel.view()).toMatchObject({ title: "Speak", composer: true });
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
    await p.goTo("Voice");
    await p.press("enter", "speak");
    expect(p.panel.view().composer).toBe(true);
    expect(p.panel.view().picker).toBeUndefined();
  });

  it("Replay last plays the last message from Enter and from r; the panel stays open", async () => {
    const p = open();
    await p.engine.speech.speak("earlier words");
    p.local.end(0, { state: "completed" });
    await p.type("r");
    expect(p.close).not.toHaveBeenCalled();
    expect(p.local.plays).toHaveLength(2);
    expect(p.panel.view().status?.text).toBe("♪ speaking…");
    p.local.end(1, { state: "completed" });
    await vi.waitFor(() => expect(p.panel.view().status?.text).toBe("✓ Spoken"));
    await p.goTo("Replay last");
    await p.press("enter");
    expect(p.local.plays).toHaveLength(3);
    p.local.end(2, { state: "completed" });
    await p.type("r");
    expect(p.local.plays).toHaveLength(4);
    expect(p.close).not.toHaveBeenCalled();
    expect(p.notes).toEqual([]);
  });

  it("Stop leaves the panel open; Replay with nothing to replay is refused in the panel", async () => {
    const p = open();
    await p.goTo("Stop");
    await p.press("enter");
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.view().status?.text).toMatch(/nothing was playing/i);
    await p.type("r");
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.view().status).toMatchObject({ tone: "error", text: expect.stringMatching(/^✗ Nothing to replay/) });
  });

  it("Stop while speaking says Stopped, not Spoken", async () => {
    const p = open();
    await p.press("speak");
    await p.type("words");
    await p.press("enter");
    await p.press("escape");
    await p.type("s");
    expect(p.panel.view().status?.text).toBe("✓ Stopped");
    await new Promise((r) => setTimeout(r, 10));
    expect(p.panel.view().status?.text).toBe("✓ Stopped");
  });

  it("Dictate closes the panel and starts dictation, from Hotkeys and from its key", async () => {
    const q = open();
    await q.goTo("Dictate");
    await q.press("enter");
    expect(q.close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(q.notes.at(-1)?.message).toMatch(/no microphone here/));
    const k = open();
    k.panel.handle({ key: "dictate" });
    expect(k.close).toHaveBeenCalledTimes(1);
  });

  it("History… opens the history; Esc returns to Hotkeys", async () => {
    const p = open();
    await p.engine.speech.speak("first words");
    await p.goTo("History…");
    await p.press("enter");
    expect(p.panel.view().picker).toMatchObject({ title: "History", total: 1 });
    await p.press("escape");
    expect(p.panel.view().menu).toBe("hotkeys");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.selectedLabel()).toBe("History…");
  });

  it("Transcribe file… asks for the path under its row in Hotkeys", async () => {
    const p = open();
    await p.goTo("Transcribe file…");
    await p.press("enter");
    expect(p.panel.view().input).toMatchObject({ label: "Audio file", under: "transcribe" });
    await p.press("escape");
    expect(p.panel.view().menu).toBe("hotkeys");
  });

  it("k changes the key of Speak: saved in the settings at once; leaving Hotkeys closes the panel to rebind it", async () => {
    const p = open();
    await p.goTo("Speak…");
    await p.type("k");
    expect(p.row("Speak…")?.value).toBe("press a key…");
    expect(p.hint()).toBe("Alt+letter new key for Speak · Esc cancel");
    await p.press({ combo: "alt+d" });
    expect(settingsOf(p.work).hotkeys).toEqual({ speak: "alt+d", dictate: "alt+z" });
    expect(p.engine.speech.settings.hotkeys.speak).toBe("alt+d");
    expect(p.panel.view().status).toMatchObject({
      tone: "success",
      text: "✓ Speak is Alt+D",
    });
    // the row shows the new key, with nothing waiting beside it
    expect(p.row("Speak…")).toEqual(expect.objectContaining({ value: "Alt+D" }));
    expect(p.row("Speak…")?.note).toBeUndefined();
    expect(p.panel.rebind).toBe(false);
    expect(p.close).not.toHaveBeenCalled();
    // leaving Hotkeys closes the panel and asks the host to reload Pi, which binds the new key
    await p.press("escape");
    expect(p.close).toHaveBeenCalledTimes(1);
    expect(p.panel.rebind).toBe(true);
  });

  it("leaving Hotkeys without a change goes back to the main view and asks for no reload", async () => {
    const p = open();
    await p.goTo("Speak…");
    await p.type("k");
    await p.press("escape");
    await p.press("escape");
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.rebind).toBe(false);
    expect(p.panel.view().menu).toBe("main");
  });

  it("k on Dictate takes a key with Ctrl and Shift too; setting it back to the bound key needs no reload", async () => {
    const p = open();
    await p.goTo("Dictate");
    await p.type("k");
    await p.press({ combo: "ctrl+alt+shift+x" });
    expect(settingsOf(p.work).hotkeys).toEqual({ speak: "alt+s", dictate: "ctrl+alt+shift+x" });
    expect(p.row("Dictate")).toMatchObject({ value: "Ctrl+Alt+Shift+X" });
    expect(p.row("Dictate")?.note).toBeUndefined();
    await p.type("k");
    await p.press({ key: "dictate", id: "alt+z" });
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.view().status?.text).toBe("✓ Dictate is Alt+Z again");
    expect(p.row("Dictate")).toMatchObject({ value: "Alt+Z" });
    expect(p.row("Dictate")?.note).toBeUndefined();
    expect(settingsOf(p.work).hotkeys).toBeUndefined();
    await p.press("escape");
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.rebind).toBe(false);
  });

  it("refuses a key without Alt, and the key of the other action; Esc cancels", async () => {
    const p = open();
    await p.goTo("Speak…");
    await p.type("k");
    await p.type("d");
    expect(p.panel.view().status).toMatchObject({
      tone: "error",
      text: "✗ d cannot be a hotkey: use Alt with a letter or a digit",
    });
    await p.type("k");
    await p.press({ combo: "ctrl+d" });
    expect(p.panel.view().status?.text).toBe("✗ Ctrl+D cannot be a hotkey: use Alt with a letter or a digit");
    await p.type("k");
    await p.press({ key: "dictate", id: "alt+z" });
    expect(p.panel.view().status?.text).toBe("✗ Alt+Z is already the key of Dictate");
    expect(p.close).not.toHaveBeenCalled();
    await p.type("k");
    await p.press("escape");
    expect(p.panel.view().menu).toBe("hotkeys");
    expect(p.row("Speak…")?.value).toBe("Alt+S");
    expect(p.engine.speech.settings.hotkeys).toEqual({ speak: "alt+s", dictate: "alt+z" });
    await p.press("down", "down");
    await p.type("k");
    expect(p.panel.view().status?.text).toBe("Only Speak and Dictate have keys of their own to change");
  });
});

describe("the panel view model: pickers", () => {
  it("Enter on Voice opens the voice picker in the provider's order, the current voice marked", async () => {
    const p = open();
    await p.goTo("Voice");
    await p.press("enter");
    const picker = p.panel.view().picker;
    expect(picker).toMatchObject({ title: "Voice", noun: "voices", total: 2, query: "" });
    expect(picker?.sort).toBeUndefined();
    expect(picker?.detail).toBeUndefined();
    expect(picker?.items.map((i) => i.id)).toEqual(["Kore", "Puck"]);
    expect(picker?.items.find((i) => i.current)?.id).toBe("Kore");
    expect(picker?.selected).toBe(0);
  });

  it("every printable character goes into the filter, l included; Backspace edits; Esc goes back", async () => {
    const p = open();
    await p.goTo("Voice");
    await p.press("enter");
    await p.type("pl");
    expect(p.panel.view().input).toBeUndefined();
    expect(p.panel.view().picker?.query).toBe("pl");
    expect(p.panel.view().picker?.items).toEqual([]);
    await p.press("backspace");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual(["Puck"]);
    await p.press("escape");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.close).not.toHaveBeenCalled();
  });

  it("Tab in the voice picker samples the highlighted voice without choosing it; Enter picks", async () => {
    const p = open();
    await p.goTo("Voice");
    await p.press("enter");
    await p.type("puck");
    p.panel.handle({ key: "tab" });
    expect(p.panel.view().status).toMatchObject({ tone: "busy", text: "♪ sampling Puck…" });
    await p.panel.idle();
    expect(p.requests.at(-1)?.body.voice).toBe("Puck");
    expect(p.panel.view().status?.text).toBe("✓ sampled Puck in English · multilingual voice");
    expect(p.engine.speech.settings.voice).toBe("Kore");
    expect(p.local.plays.at(-1)?.kind).toBe("sample");
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.row("Voice")?.value).toBe("Puck");
    expect(settingsOf(p.work).voice).toBe("Puck");
    expect(p.panel.view().status?.text).toBe("✓ Voice: Puck");
  });

  it("F2 in the voice picker sets the language of the highlighted voice and returns to the picker", async () => {
    const p = open();
    await p.goTo("Voice");
    await p.press("enter", "down", "language");
    expect(p.panel.view().input?.label).toMatch(/Puck/);
    expect(p.panel.view().input?.under).toBeUndefined();
    await p.type("pt-BR");
    await p.press("enter");
    expect(p.panel.view().picker?.items.find((i) => i.id === "Puck")?.cols?.[0]).toBe("pt-BR · set by you");
    expect(p.engine.speech.settings.voice).toBe("Kore");
  });

  it("the model pickers list the models by price, cheapest first, the subscription model last, and say so", async () => {
    const p = open({}, { xai: true });
    await p.goTo("Speech model");
    await p.press("enter");
    const picker = p.panel.view().picker;
    expect(picker).toMatchObject({ title: "Speech model", sort: "price", show: "all", noun: "models", total: 4 });
    expect(picker?.items.map((i) => i.id)).toEqual([
      "hexgrad/kokoro-82m",
      "x-ai/grok-voice-tts-1.0",
      "google/gemini-3.8-flash-tts",
      "xai",
    ]);
    expect(picker?.items[2]).toMatchObject({ price: "~$0.03/min", note: "tags · fast · 2 voices", current: true });
    expect(picker?.items[3]).toMatchObject({ label: "xAI Grok", price: "subscription", note: "xAI login" });
    expect(picker?.selected).toBe(0);
    await p.press("up");
    expect(p.picked()?.id).toBe("xai");
    await p.press("escape");
    await p.goTo("Transcription model");
    await p.press("enter");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual([
      "openai/whisper-large-v3-turbo",
      "openai/whisper-1",
      "xai",
    ]);
  });

  it("models with the same price are ordered by name", async () => {
    const p = open(
      {},
      {
        before: (e) => {
          e.speech.models = async () => ({
            tts: [
              { id: "b/two", label: "b", price: "$0.01/min" },
              { id: "a/one", label: "a", price: "~$0.01/min" },
              { id: "c/free", label: "c", price: "$0" },
              { id: "d/none", label: "d" },
            ],
            stt: [],
          });
        },
      },
    );
    await p.goTo("Speech model");
    await p.press("enter");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual(["c/free", "a/one", "b/two", "d/none"]);
    expect(p.panel.view().picker?.items[3].price).toBe("price unknown");
  });

  it("typing xai finds xAI Grok first; the count follows the filter", async () => {
    const p = open({}, { xai: true });
    await p.goTo("Speech model");
    await p.type("xai");
    const picker = p.panel.view().picker;
    expect(picker?.items.map((i) => i.id)).toEqual(["xai", "x-ai/grok-voice-tts-1.0"]);
    expect(picker).toMatchObject({ total: 4, selected: 0 });
    await p.press("enter");
    expect(p.engine.speech.settings.speechModel).toBe("xai");
  });

  it("picking a speech model loads its voices", async () => {
    const p = open({}, { xai: true });
    await p.goTo("Speech model");
    await p.press("enter", { text: "kokoro" }, "enter");
    expect(p.row("Speech model")?.value).toBe("hexgrad/kokoro-82m");
    await p.goTo("Voice");
    await p.press("enter");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual(["af_heart", "jf_alpha"]);
  });
});

describe("matching in the pickers", () => {
  const ids = (items: string[], q: string) => matchItems(items, q, (s) => s);

  it("ranks an exact word, then a word prefix, before other fuzzy matches, keeping the list order within each", () => {
    const list = ["x-ai/grok-voice-tts-1.0", "maxai/tts", "xAI Grok", "xaiden/voice"];
    expect(ids(list, "xai")).toEqual(["xAI Grok", "xaiden/voice", "x-ai/grok-voice-tts-1.0", "maxai/tts"]);
  });

  it("matches runs that start at word boundaries, not letters scattered inside a word", () => {
    const voices = ["Zephyr", "Leda", "Laomedeia", "Enceladus"];
    expect(ids(voices, "leda")).toEqual(["Leda"]);
    expect(ids(["google/gemini-3.8-flash-tts", "openai/whisper-1"], "gem tts")).toEqual([
      "google/gemini-3.8-flash-tts",
    ]);
    expect(ids(["elevenlabs/eleven-v3", "elevenlabs/eleven-flash-v2"], "elevenv3")).toEqual(["elevenlabs/eleven-v3"]);
    expect(ids(["Kore"], "ore")).toEqual(["Kore"]);
    expect(ids(["Kore"], "KORE")).toEqual(["Kore"]);
  });

  it("an empty query keeps everything in order", () => {
    expect(ids(["b", "a"], "  ")).toEqual(["b", "a"]);
  });
});

describe("the panel view model: browsing models", () => {
  const ids = (p: ReturnType<typeof open>) => p.panel.view().picker?.items.map((i) => i.id);

  it("Tab changes the order: price, provider, features, newest, name; the choice is saved", async () => {
    const p = open();
    await p.goTo("Speech model");
    await p.press("enter");
    expect(ids(p)).toEqual(["hexgrad/kokoro-82m", "x-ai/grok-voice-tts-1.0", "google/gemini-3.8-flash-tts"]);
    await p.press("tab");
    expect(p.panel.view().picker?.sort).toBe("provider");
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts", "hexgrad/kokoro-82m", "x-ai/grok-voice-tts-1.0"]);
    await p.press("tab");
    expect(p.panel.view().picker?.sort).toBe("features");
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts", "hexgrad/kokoro-82m", "x-ai/grok-voice-tts-1.0"]);
    await p.press("tab");
    expect(p.panel.view().picker?.sort).toBe("newest");
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts", "x-ai/grok-voice-tts-1.0", "hexgrad/kokoro-82m"]);
    expect(settingsOf(p.work).modelSort).toBe("newest");
    await p.press("tab");
    expect(p.panel.view().picker?.sort).toBe("name");
    await p.press("tab");
    expect(p.panel.view().picker?.sort).toBe("price");
    // the other model list follows the same order
    await p.press("tab", "escape");
    await p.goTo("Transcription model");
    await p.press("enter");
    expect(p.panel.view().picker?.sort).toBe("provider");
  });

  it("Shift+Tab shows only the models with one feature, then the next, then all again", async () => {
    const p = open();
    await p.goTo("Speech model");
    await p.press("enter");
    await p.press("backtab");
    expect(p.panel.view().picker).toMatchObject({ show: "tags", total: 3 });
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts"]);
    await p.press("backtab");
    expect(p.panel.view().picker?.show).toBe("multilingual");
    expect(ids(p)).toEqual(["hexgrad/kokoro-82m", "x-ai/grok-voice-tts-1.0"]);
    await p.press("backtab");
    expect(p.panel.view().picker?.show).toBe("fast");
    await p.press("backtab");
    expect(p.panel.view().picker?.show).toBe("all");
    expect(ids(p)).toHaveLength(3);
    expect(p.hint()).toBe("Enter pick · Tab sort · Shift+Tab show · type to filter · Esc back");
  });

  it("each model shows its features, and typing finds a model by one", async () => {
    const p = open();
    await p.goTo("Speech model");
    await p.press("enter");
    const items = p.panel.view().picker?.items ?? [];
    expect(items.map((i) => i.note)).toEqual(["8 langs · 2 voices", "20+ langs · 2 voices", "tags · fast · 2 voices"]);
    await p.type("tags");
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts"]);
  });

  it("says what the catalog says about the highlighted model", async () => {
    const p = open();
    await p.goTo("Speech model");
    await p.press("enter");
    expect(p.panel.view().picker?.detail).toMatch(/^Kokoro 82M is a lightweight/);
    await p.press("down");
    expect(p.panel.view().picker?.detail).toBe("");
    await p.press("down");
    expect(p.panel.view().picker?.detail).toMatch(/^Gemini 3.8 Flash TTS/);
  });
});

describe("the panel view model: history, files, and the dictation language", () => {
  it("History… lists the spoken messages, the newest first; Enter replays one and the list stays", async () => {
    const p = open();
    await p.engine.speech.speak("first words");
    await p.engine.speech.speak("second words");
    await p.type("h");
    const picker = p.panel.view().picker;
    expect(picker).toMatchObject({ title: "History", noun: "messages", total: 2 });
    expect(picker?.items.map((i) => i.label.replace(/^\S+ \S+ {2}/, ""))).toEqual(["second words", "first words"]);
    expect(p.hint()).toBe("Enter replay · type to filter · Esc back");
    const plays = p.local.plays.length;
    await p.press("down", "enter");
    expect(p.local.plays).toHaveLength(plays + 1);
    expect(p.local.plays.at(-1)?.file).toMatch(/first-words\.wav$/);
    expect(p.panel.view().picker?.title).toBe("History");
    expect(p.panel.view().status?.text).toBe("♪ speaking…");
    expect(p.requests.filter((r) => r.body?.input)).toHaveLength(2);
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
  });

  it("History… with nothing spoken says so", async () => {
    const p = open();
    await p.goTo("History…");
    await p.press("enter");
    expect(p.panel.view().picker).toMatchObject({ total: 0, empty: "Nothing spoken yet", items: [] });
    expect(p.hint()).toBe("Esc back");
  });

  it("t in the main view asks for an audio file under the list, puts the text into the editor and closes", async () => {
    const p = open();
    const audio = join(p.work, "note.wav");
    writeFileSync(audio, "RIFFfake");
    await p.type("t");
    expect(p.panel.view().input).toMatchObject({ label: "Audio file" });
    expect(p.panel.view().input?.under).toBeUndefined();
    expect(p.hint()).toBe("Enter transcribe · Esc back");
    await p.type(audio);
    await p.press("enter");
    expect(p.pasted).toEqual(["hello world"]);
    expect(p.close).toHaveBeenCalledTimes(1);
  });

  it("a file that cannot be transcribed is one ✗ line, and the path stays for another try", async () => {
    const p = open();
    await p.goTo("Transcribe file…");
    await p.press("enter");
    await p.type("/nowhere/missing.wav");
    await p.press("enter");
    expect(p.panel.view().status).toMatchObject({
      tone: "error",
      text: expect.stringMatching(/^✗ Cannot read audio file/),
    });
    expect(p.panel.view().input?.value).toBe("/nowhere/missing.wav");
    expect(p.pasted).toEqual([]);
    expect(p.close).not.toHaveBeenCalled();
  });

  it("Dictation language is saved, shown, sent with a transcribed file, and removed with auto", async () => {
    const p = open();
    await p.goTo("Dictation language");
    await p.press("enter");
    expect(p.panel.view().input).toMatchObject({ label: "Spoken language", under: "language" });
    await p.type("not a tag!");
    await p.press("enter");
    expect(p.panel.view().status).toMatchObject({
      tone: "error",
      text: expect.stringMatching(/^✗ Invalid language tag/),
    });
    await p.press("escape", "enter");
    await p.type("ja");
    await p.press("enter");
    expect(p.panel.view().input).toBeUndefined();
    expect(p.row("Dictation language")?.value).toBe("ja");
    expect(settingsOf(p.work).dictationLanguage).toBe("ja");
    const audio = join(p.work, "note.wav");
    writeFileSync(audio, "RIFFfake");
    await p.type("t");
    await p.type(audio);
    await p.press("enter");
    expect(p.requests.at(-1)?.body).toMatchObject({ language: "ja" });
    await p.engine.speech.set("stt-language", "auto");
    expect(p.row("Dictation language")?.value).toBe("auto");
    expect(settingsOf(p.work).dictationLanguage).toBeUndefined();
  });

  it("Dictation output is Pi, or User-defined with a command, set under its row", async () => {
    const p = open();
    await p.goTo("Dictation output");
    await p.press("enter");
    expect(p.panel.view().input).toMatchObject({ label: "Dictation output", under: "output" });
    await p.type("wl-copy %s");
    await p.press("enter");
    expect(p.row("Dictation output")?.value).toBe("User-defined");
    expect(p.row("Dictation output")?.note).toBeUndefined();
    expect(settingsOf(p.work).dictationOutput).toBe("wl-copy %s");
  });
});

describe.skipIf(!STAND_IN_BINARY)("the panel view model: Local sources", () => {
  const local = () => {
    const bin = fakeReceiver(mkdtempSync(join(tmpdir(), "pi-speech-receiver-")));
    const p = open({ PI_SPEECH_BINARY: bin.path });
    return { ...p, bin, calls: () => readFileSync(bin.log, "utf8").trim().split("\n") };
  };

  it("lists the on-device transcription models with size and state; a downloaded one is chosen at once", async () => {
    const p = local();
    await p.goTo("Transcription source");
    await p.press("right");
    await p.goTo("Transcription model");
    expect(p.row("Transcription model")).toMatchObject({ value: "none", note: "✗ choose a model", alert: true });
    await p.press("enter");
    const picker = p.panel.view().picker;
    expect(picker).toMatchObject({ title: "Transcription model", noun: "models", total: 2, loading: false });
    expect(picker?.sort).toBeUndefined();
    expect(picker?.items.map((i) => [i.label, i.price, i.cols?.[0]])).toEqual([
      ["parakeet-v3", "640 MB", "downloaded"],
      ["whisper-small", "639 MB", "not downloaded"],
    ]);
    expect(p.hint()).toBe("Enter pick · d download · x delete · Esc back");
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.row("Transcription model")).toEqual(expect.objectContaining({ value: "parakeet-v3" }));
    expect(p.row("Transcription model")?.note).toBeUndefined();
    expect(p.panel.view().status?.text).toBe("✓ Transcription model: parakeet-v3 (local)");
    expect(settingsOf(p.work)).toMatchObject({ transcriptionSource: "local", localTranscriptionModel: "parakeet-v3" });
    // The provider model is kept for when the source goes back to Provider.
    expect(settingsOf(p.work).transcriptionModel).toBe("openai/whisper-large-v3-turbo");
  });

  it("choosing a model not downloaded offers the download; Enter again downloads it with progress and chooses it", async () => {
    const p = local();
    p.engine.speech.setSource("transcription", "local");
    const lines: string[] = [];
    p.changed.mockImplementation(() => {
      const t = p.panel.view().status?.text;
      if (t && lines.at(-1) !== t) lines.push(t);
    });
    await p.goTo("Transcription model");
    await p.press("enter");
    await p.press("down", "enter");
    expect(p.panel.view().status).toEqual({
      tone: "warning",
      text: "! whisper-small is not downloaded (639 MB) · Enter downloads it",
    });
    expect(p.panel.view().picker).toBeDefined();
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(lines).toEqual(
      expect.arrayContaining([
        "… downloading whisper-small 50% (320 MB of 639 MB)",
        "… verifying whisper-small",
        "… unpacking whisper-small",
        "✓ whisper-small downloaded · Transcription model: whisper-small (local)",
      ]),
    );
    expect(p.row("Transcription model")?.value).toBe("whisper-small");
    expect(p.calls()).toContain("models download whisper-small");
  });

  it("in the list d downloads and x (twice) deletes the highlighted model", async () => {
    const p = local();
    p.engine.speech.setSource("transcription", "local");
    await p.goTo("Transcription model");
    await p.press("enter");
    await p.press("down");
    await p.type("d");
    expect(p.panel.view().status?.text).toBe("✓ whisper-small downloaded");
    expect(p.panel.view().picker?.items[1].cols?.[0]).toBe("downloaded");
    await p.type("x");
    expect(p.panel.view().status?.text).toBe("! x again deletes whisper-small (639 MB)");
    expect(p.calls()).not.toContain("models delete whisper-small");
    await p.type("x");
    expect(p.panel.view().status?.text).toBe("✓ whisper-small deleted · 1.2 KB freed");
    expect(p.panel.view().picker?.items[1].cols?.[0]).toBe("not downloaded");
    await p.type("x");
    expect(p.panel.view().status?.text).toBe("whisper-small is not downloaded");
    // Other letters still filter.
    await p.type("par");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual(["parakeet-v3"]);
  });

  it("Local speech lists the on-device speech models but says plainly that it cannot speak yet", async () => {
    const p = local();
    await p.goTo("Speech source");
    await p.press("right");
    await p.goTo("Speech model");
    await p.press("enter");
    expect(p.panel.view().picker?.items.map((i) => [i.id, i.cols?.[0]])).toEqual([["kokoro", "not downloaded"]]);
    await p.press("escape");
    await p.goTo("Hotkeys");
    await p.press("enter", "enter");
    await p.type("hello");
    await p.press("enter");
    expect(p.panel.view().status?.text).toBe(
      "✗ Local speech is not available yet: set Speech source to Provider in /speech to speak",
    );
    expect(p.requests.filter((r) => r.url.endsWith("/audio/speech"))).toEqual([]);
  });
});
