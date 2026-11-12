import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Engine } from "../../src/engine/engine";
import { matchItems, Panel, type PanelKey, type PanelView, rowLines } from "../../src/engine/panel";
import { Surface } from "../../src/engine/surface";
import { fakeOpenRouter, makeEngine, scriptedUi } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

/** The rows in order: each section's actions (one toolbar line), then its settings. */
const ROWS = [
  "Speak…",
  "Replay last",
  "History…",
  "Stop",
  "Speech model",
  "Voice",
  "Read replies aloud",
  "Dictate",
  "Transcribe file…",
  "Transcription",
  "Dictation language",
  "Dictation output",
  "Play audio on",
  "Agent tools",
];

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

function open(env: Record<string, string> = {}, opts: { xai?: boolean; before?: (e: Engine) => void } = {}) {
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
  const panel = new Panel(made.engine, new Surface(made.engine), { ui, close, changed });
  panel.open();
  const press = async (...keys: Array<PanelKey | string>) => {
    for (const k of keys) panel.handle(typeof k === "string" ? { key: k as never } : k);
    await panel.idle();
  };
  const type = async (text: string) => press({ text });
  const row = (label: string, v: PanelView = panel.view()) => v.rows.find((r) => r.label === label);
  const selectedLabel = () => panel.view().rows[panel.view().selected].label;
  /** ↓ to the line of the row, then → along its toolbar. */
  const goTo = async (label: string) => {
    const rows = panel.view().rows;
    const lines = rowLines(rows);
    const target = rows.findIndex((r) => r.label === label);
    const line = lines.find((l) => l.includes(target)) ?? [];
    for (let i = 0; i < lines.length && !line.includes(panel.view().selected); i++) await press("down");
    for (let i = 0; i < line.length && panel.view().selected !== target; i++) await press("right");
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

describe("the panel view model: rows", () => {
  it("has the title, no state when nothing happens, and three sections of actions and settings", async () => {
    const p = open();
    await p.panel.idle();
    const v = p.panel.view();
    expect(v.title).toBe("Speech");
    expect(v.state).toBe("");
    expect(v.rows.map((r) => r.label)).toEqual(ROWS);
    expect(v.rows.filter((r) => r.group === "action").map((r) => r.key)).toEqual([
      "Alt+S",
      "r",
      "h",
      "s",
      "Alt+Z",
      "t",
    ]);
    expect(v.rows.filter((r) => r.section === "listen").map((r) => r.label)).toEqual(ROWS.slice(7, 12));
    expect(v.rows.filter((r) => r.section === "system").map((r) => r.label)).toEqual(["Play audio on", "Agent tools"]);
    // the actions of a section share a line; every setting has its own
    expect(rowLines(v.rows).map((l) => l.length)).toEqual([4, 1, 1, 1, 2, 1, 1, 1, 1, 1]);
    expect(v.selected).toBe(0);
    expect(p.row("Dictation language")).toMatchObject({ value: "auto", note: "the model detects it" });
    expect(p.row("Speech model")?.value).toBe("google/gemini-3.8-flash-tts");
    expect(p.row("Voice")?.value).toBe("Kore");
    expect(p.row("Transcription")?.value).toBe("openai/whisper-large-v3-turbo");
    expect(p.row("Play audio on")?.value).toBe("auto");
    expect(p.row("Read replies aloud")?.value).toBe("off");
    expect(p.row("Agent tools")?.value).toBe("on");
  });

  it("marks the rows whose Enter opens a list, and only those", async () => {
    const p = open();
    const opens = p.panel
      .view()
      .rows.filter((r) => r.opens)
      .map((r) => r.label);
    expect(opens).toEqual(["Speech model", "Voice", "Transcription", "Dictation language", "Dictation output"]);
  });

  it("model rows show loading… until the catalog is there, then the price and the provider", async () => {
    const p = open();
    expect(p.row("Speech model")?.note).toBe("loading…");
    expect(p.row("Speech model")?.value).toBe("google/gemini-3.8-flash-tts");
    await p.panel.idle();
    expect(p.row("Speech model")).toMatchObject({ price: "~$0.03/min", note: "tags · fast" });
    expect(p.row("Transcription")).toMatchObject({ price: "$0.0007/min", note: "99+ langs · fast" });
    await p.engine.speech.set("stt-model", "openai/whisper-1");
    expect(p.row("Transcription")?.note).toBe("translate");
  });

  it("the voice note names the language and where it comes from; an override is set by you", async () => {
    const p = open();
    await p.panel.idle();
    expect(p.row("Voice")?.note).toBe("multilingual");
    await p.engine.speech.set("tts-model", "hexgrad/kokoro-82m");
    await p.engine.speech.set("voice", "jf_alpha");
    expect(p.row("Voice")?.note).toBe("ja");
    await p.engine.speech.setLanguage("jf_alpha", "fr");
    expect(p.row("Voice")?.note).toBe("fr · set by you");
  });

  it("Play audio on shows the resolved route, and an unreachable receiver", async () => {
    const p = open();
    await p.panel.idle();
    expect(p.row("Play audio on")?.note).toBe("→ this machine");
    p.engine.routes.bridge.health = async () => ({ ok: false, reason: "connection refused" });
    await p.goTo("Play audio on");
    await p.press("right");
    expect(p.row("Play audio on")?.value).toBe("auto");
    expect(p.panel.view().status).toMatchObject({
      tone: "error",
      text: expect.stringMatching(/^✗ .*connection refused/),
    });
    p.engine.routes.bridge.health = async () => ({ ok: true, version: "0.1.0" });
    await p.press("right");
    expect(p.row("Play audio on")).toMatchObject({ value: "bridge", note: "✓ 127.0.0.1:47613" });
    await p.press("right");
    expect(p.row("Play audio on")).toMatchObject({ value: "local", note: "this machine" });
    expect(settingsOf(p.work).bridge).toBe("off");
    await p.press("left");
    expect(p.row("Play audio on")?.value).toBe("bridge");
  });

  it("over SSH auto goes to the bridge; an unreachable receiver is a ✗ note and the panel still opens", async () => {
    fakeOpenRouter();
    const made = makeEngine({ SSH_CONNECTION: "1 2 3 4" });
    made.engine.routes.bridge.health = async () => ({ ok: false, reason: "connection refused" });
    const panel = new Panel(made.engine, new Surface(made.engine), {
      ui: scriptedUi().ui,
      close: vi.fn(),
      changed: vi.fn(),
    });
    panel.open();
    await panel.idle();
    const audio = panel.view().rows.find((r) => r.label === "Play audio on");
    expect(audio).toMatchObject({ value: "auto", note: "→ bridge ✗ receiver unreachable", alert: true });
  });

  it("shows the xai model as xAI Grok; the saved id stays xai", async () => {
    const p = open({}, { xai: true });
    await p.goTo("Speech model");
    await p.press("enter", { text: "xai" }, "enter");
    expect(p.engine.speech.settings.speechModel).toBe("xai");
    expect(settingsOf(p.work).speechModel).toBe("xai");
    expect(p.row("Speech model")).toMatchObject({ value: "xAI Grok", price: "subscription", note: "xAI" });
    expect(p.row("Voice")).toMatchObject({ value: "eve", note: "multilingual" });
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
});

describe("the panel view model: keys", () => {
  it("↑↓ move line by line and wrap; ←→ move along a toolbar, and ↑↓ return to its column", async () => {
    const p = open();
    await p.press("up");
    expect(p.selectedLabel()).toBe("Agent tools");
    await p.press("down");
    expect(p.selectedLabel()).toBe("Speak…");
    await p.press("down");
    expect(p.selectedLabel()).toBe("Speech model");
    await p.press("up", "right");
    expect(p.selectedLabel()).toBe("Replay last");
    await p.press("left", "left");
    expect(p.selectedLabel()).toBe("Stop");
    await p.press("right", "right");
    expect(p.selectedLabel()).toBe("Replay last");
    await p.press("down", "down", "down", "down");
    expect(p.selectedLabel()).toBe("Transcribe file…");
    await p.press("down");
    expect(p.selectedLabel()).toBe("Transcription");
  });

  it("←→ and Enter toggle Agent tools and Read replies aloud in place and save at once", async () => {
    const p = open();
    const toolsChanged = vi.fn();
    p.engine.onToolsChanged = toolsChanged;
    await p.goTo("Agent tools");
    p.panel.handle({ key: "right" });
    expect(p.row("Agent tools")?.value).toBe("off");
    await p.panel.idle();
    expect(settingsOf(p.work).tools).toBe(false);
    expect(toolsChanged).toHaveBeenCalled();
    await p.press("left");
    expect(settingsOf(p.work).tools).toBe(true);
    await p.press("enter");
    expect(settingsOf(p.work).tools).toBe(false);
    await p.goTo("Read replies aloud");
    await p.press("right");
    expect(p.row("Read replies aloud")?.value).toBe("on");
    expect(p.engine.readAloud.enabled).toBe(true);
    await p.press("enter");
    expect(p.engine.readAloud.enabled).toBe(false);
    expect(p.notes).toEqual([]);
  });

  it("Enter on Play audio on does the same as →", async () => {
    const p = open();
    await p.goTo("Play audio on");
    await p.press("enter");
    expect(p.row("Play audio on")?.value).toBe("bridge");
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
    await p.goTo("Transcription");
    await p.type("1");
    const picker = p.panel.view().picker;
    expect(picker).toMatchObject({ title: "Transcription", query: "1" });
    expect(picker?.items.map((i) => i.id)).toEqual(["openai/whisper-1"]);
    await p.press("enter");
    expect(p.row("Transcription")?.value).toBe("openai/whisper-1");
    await p.goTo("Voice");
    await p.type("l");
    expect(p.panel.view().picker).toMatchObject({ title: "Voice", query: "l" });
    expect(p.panel.view().input).toBeUndefined();
  });

  it("typing on a toggle row does nothing", async () => {
    const p = open();
    await p.goTo("Agent tools");
    await p.type("x");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.panel.view().input).toBeUndefined();
    expect(p.row("Agent tools")?.value).toBe("on");
  });

  it("F2 on the Voice row asks for the voice language (a tag or auto); the note follows", async () => {
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
    expect(p.row("Voice")?.note).toBe("ja · set by you");
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
    await p.goTo("Transcription");
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

describe("the panel view model: hints", () => {
  it("follow the row: actions show their own key, toggles ←→, picker rows Enter choose; Esc is last", async () => {
    const p = open();
    const hints: Record<string, string> = {
      "Speak…": "Enter type messages to speak · ←→ more · Esc close",
      "Replay last": "Enter play the last message again · ←→ more · Esc close",
      "History…": "Enter replay an earlier message · ←→ more · Esc close",
      Stop: "Enter stop what is playing · ←→ more · Esc close",
      "Speech model": "Enter browse, sort and filter · Esc close",
      Voice: "Enter choose · Tab sample · F2 language · Esc close",
      "Read replies aloud": "←→ on/off · Esc close",
      Dictate: "Enter record, then insert the text · ←→ more · Esc close",
      "Transcribe file…": "Enter insert the text of an audio file · ←→ more · Esc close",
      Transcription: "Enter browse, sort and filter · Esc close",
      "Dictation language": "Enter set · Esc close",
      "Dictation output": "Enter set · Esc close",
      "Play audio on": "←→ auto · bridge · local · Esc close",
      "Agent tools": "←→ on/off · Esc close",
    };
    for (const label of ROWS) {
      await p.goTo(label);
      expect(p.hint(), label).toBe(hints[label]);
    }
  });

  it("follow the picker's state: loaded, no match, loading", async () => {
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
});

describe("the panel view model: Speak…, Replay, Stop, Dictate", () => {
  it("Speak… opens a dedicated composer; ↑↓ do nothing; Esc returns", async () => {
    const p = open();
    await p.press("enter");
    expect(p.panel.view()).toMatchObject({ title: "Speak", composer: true });
    expect(p.panel.view().input).toMatchObject({ value: "" });
    expect(p.panel.view().input?.under).toBeUndefined();
    expect(p.hint()).toBe("Enter speak · Esc back");
    await p.type("hi");
    await p.press("up", "down");
    expect(p.panel.view().input?.value).toBe("hi");
    expect(p.selectedLabel()).toBe("Speak…");
    await p.press("escape");
    expect(p.panel.view().input).toBeUndefined();
    expect(p.close).not.toHaveBeenCalled();
  });

  it("Enter speaks and clears the composer, ready for the next message without reselecting Speak", async () => {
    const p = open();
    await p.press("enter");
    await p.type("panel hello");
    p.panel.handle({ key: "enter" });
    expect(p.panel.view()).toMatchObject({ title: "Speak", composer: true });
    expect(p.panel.view().input?.value).toBe("");
    expect(p.panel.view().status).toMatchObject({ tone: "busy", text: "♪ speaking…" });
    await p.type("second message");
    await p.press("enter");
    await p.panel.idle();
    expect(p.requests.filter((r) => r.body?.input).map((r) => r.body.input)).toEqual(["panel hello", "second message"]);
    expect(p.panel.view().input?.value).toBe("");
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.view().status?.text).toBe("♪ speaking…");
    p.local.end(1, { state: "completed" });
    await vi.waitFor(() => expect(p.panel.view().status).toMatchObject({ tone: "success", text: "✓ Spoken" }));
    expect(p.notes).toEqual([]);
  });

  it("a failed Speak is one ✗ line in the panel", async () => {
    const p = open();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("quota", { status: 402 })),
    );
    await p.press("enter");
    await p.type("hello");
    await p.press("enter");
    expect(p.panel.view().status).toMatchObject({ tone: "error", text: expect.stringMatching(/^✗ .*402/) });
    expect(p.close).not.toHaveBeenCalled();
    expect(p.notes).toEqual([]);
  });

  it("Replay last and r play the last message and the panel stays open", async () => {
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
    expect(p.close).not.toHaveBeenCalled();
    expect(p.notes).toEqual([]);
  });

  it("Stop leaves the panel open; Replay with nothing to replay is refused in the panel", async () => {
    const p = open();
    await p.type("s");
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.view().status?.text).toMatch(/nothing was playing/i);
    await p.type("r");
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.view().status).toMatchObject({ tone: "error", text: expect.stringMatching(/^✗ Nothing to replay/) });
  });

  it("Stop while speaking says Stopped, not Spoken", async () => {
    const p = open();
    await p.press("enter");
    await p.type("words");
    await p.press("enter");
    await p.press("escape");
    await p.type("s");
    expect(p.panel.view().status?.text).toBe("✓ Stopped");
    await new Promise((r) => setTimeout(r, 10));
    expect(p.panel.view().status?.text).toBe("✓ Stopped");
  });

  it("Dictate closes the panel and starts dictation", async () => {
    const q = open();
    q.panel.handle({ key: "dictate" });
    expect(q.close).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(q.notes.at(-1)?.message).toMatch(/no microphone here/));
  });

  it("Esc closes the panel; the header follows the live state", async () => {
    const p = open();
    await p.engine.speech.speak("words");
    expect(p.panel.view().state).toBe("▶ speaking");
    expect(p.changed).toHaveBeenCalled();
    await p.goTo("Stop");
    await p.press("enter");
    expect(p.panel.view().state).toBe("");
    expect(p.panel.view().status?.text).toMatch(/stopped/i);
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
    await p.goTo("Transcription");
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

  it("the composer says when the speech model takes inline tags", async () => {
    const p = open();
    await p.panel.idle();
    await p.press("enter");
    expect(p.panel.view().input?.placeholder).toMatch(/\[tags\] direct this model/);
    await p.press("escape");
    await p.engine.speech.set("tts-model", "hexgrad/kokoro-82m");
    await p.press("enter");
    expect(p.panel.view().input?.placeholder).not.toMatch(/tags/);
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
  });

  it("History… with nothing spoken says so", async () => {
    const p = open();
    await p.goTo("History…");
    await p.press("enter");
    expect(p.panel.view().picker).toMatchObject({ total: 0, empty: "Nothing spoken yet", items: [] });
    expect(p.hint()).toBe("Esc back");
  });

  it("Transcribe file… asks for a path under its row, puts the text into the editor and closes", async () => {
    const p = open();
    const audio = join(p.work, "note.wav");
    writeFileSync(audio, "RIFFfake");
    await p.type("t");
    expect(p.panel.view().input).toMatchObject({ label: "Audio file", under: "transcribe" });
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
    expect(p.row("Dictation language")).toMatchObject({
      value: "ja",
      note: "sent with dictation and transcribed files",
    });
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

  it("Alt+S opens the composer from the list and from a picker", async () => {
    const p = open();
    await p.press("speak");
    expect(p.panel.view()).toMatchObject({ title: "Speak", composer: true });
    await p.press("escape");
    await p.goTo("Voice");
    await p.press("enter", "speak");
    expect(p.panel.view().composer).toBe(true);
    expect(p.panel.view().picker).toBeUndefined();
  });
});
