import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packageVersion } from "../../src/engine/binary";
import type { Engine } from "../../src/engine/engine";
import { matchItems, Panel, type PanelKey, type PanelView } from "../../src/engine/panel";
import type { Hotkeys } from "../../src/engine/settings";
import { Surface } from "../../src/engine/surface";
import { fakeOpenRouter, fakeReceiver, makeEngine, STAND_IN_BINARY, scriptedUi, trackTemp } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

/** The rows of the main view, in order. */
const ROWS = [
  "Read aloud options",
  "Speech source",
  "Speech model",
  "Voice",
  "Transcription source",
  "Transcription model",
  "Dictation options",
  "Hotkeys",
  "Receivers",
  "Spectrum OSD",
];

/** The rows of Hotkeys: every action. */
/** The rows of Hotkeys: the actions with keys of their own. */
const ACTIONS = ["Speak…", "Dictate", "Push-to-talk"];
/** The main view's own keys, on its hint line. */
const LETTER_HINTS = "Ctrl+O replay · Ctrl+L history · Ctrl+N stop · Ctrl+T transcribe";

/** The rows of Receivers over SSH. */
const BRIDGE_ROWS = ["Bridge", "Device", "Pairing", "Receiver", "Play audio on", "Record audio on", "Run models on"];

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
  opts: { xai?: boolean; before?: (e: Engine) => void; hotkeys?: Hotkeys; pairingMs?: number } = {},
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
    ...(opts.pairingMs ? { pairingMs: opts.pairingMs } : {}),
  });
  panel.open();
  const press = async (...keys: Array<PanelKey | string>) => {
    for (const k of keys) panel.handle(typeof k === "string" ? { key: k as never } : k);
    await panel.idle();
  };
  const type = async (text: string) => press({ text });
  const row = (label: string, v: PanelView = panel.view()) => v.rows.find((r) => r.label === label);
  const selectedLabel = () => panel.view().rows[panel.view().selected]?.label;
  /**
   * Select the row `label`: in the main view, or in Hotkeys for an action (entering it from the main view),
   * or in Bridge connection for Bridge.
   */
  const goTo = async (label: string) => {
    const menu = ACTIONS.includes(label) ? "hotkeys" : BRIDGE_ROWS.includes(label) ? "bridge" : "main";
    if (panel.view().menu !== menu && panel.view().menu !== "main") await press("escape");
    if (menu !== "main" && panel.view().menu === "main") {
      await goTo(menu === "hotkeys" ? "Hotkeys" : "Receivers");
      await press("enter");
    }
    // Down through the rows, and past the last one through the Speak line on to the first.
    for (let i = 0; i <= panel.view().rows.length + 1 && selectedLabel() !== label; i++) await press("down");
    expect(selectedLabel()).toBe(label);
  };
  const hint = () =>
    panel
      .view()
      .hints.filter((h) => h.action !== "tabs" && h.action !== "details")
      .map((h) => (h.action ? `${h.key} ${h.action}` : h.key))
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
  it("has the title, no state when nothing happens, and the ten main rows", async () => {
    const p = open();
    await p.panel.idle();
    const v = p.panel.view();
    expect(v.title).toBe("Speech");
    expect(v.menu).toBe("main");
    expect(v.crumb).toBeUndefined();
    expect(v.state).toBe("");
    expect(v.rows.map((r) => r.label)).toEqual(ROWS);
    expect(v.selected).toBe(0);
    expect(Object.fromEntries(v.rows.map((r) => [r.label, r.value]))).toEqual({
      "Read aloud options": "Off",
      "Speech source": "Provider",
      "Speech model": "google/gemini-3.8-flash-tts",
      Voice: "Kore",
      "Transcription source": "Provider",
      "Transcription model": "openai/whisper-large-v3-turbo",
      "Dictation options": "Filled",
      Hotkeys: "Alt+S · Alt+Z",
      Receivers: expect.stringMatching(/^Local/),
      "Spectrum OSD": "Lines",
    });
    expect(p.row("Dictation options")).toMatchObject({ value: "Filled", note: "auto", opens: true });
  });

  it("the key bar carries the keys Pi has bound", async () => {
    const p = open({}, { hotkeys: { speak: "ctrl+alt+s", dictate: "alt+d" } });
    expect(p.panel.view().keys).toEqual({ speak: "Ctrl+Alt+S", dictate: "Alt+D" });
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
      "Dictation options",
      "Hotkeys",
      "Receivers",
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
      expect(Object.keys(r ?? {}).sort(), label).toEqual(["id", "label", "opens", "value"]);
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
  it("↑↓ move row by row; past either end is the Speak line, the first entry", async () => {
    const p = open();
    await p.press("up");
    expect(p.panel.view().speak).toMatchObject({ focused: true });
    expect(p.panel.view().selected).toBe(-1);
    await p.press("up");
    expect(p.selectedLabel()).toBe("Spectrum OSD");
    await p.press("down");
    expect(p.panel.view().speak?.focused).toBe(true);
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
      ["Length", "Minimum ~15 s", false],
      ["Truncate at", "Off", false],
    ]);
    expect(v.status).toEqual({ tone: "info", text: "Off." });
    expect(p.hint()).toBe("← → Selects · Esc Main");
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
    expect(p.selectedLabel()).toBe("Read aloud options");
  });

  it("Read cycles Off, Summarized and Streaming in place with Enter and ←→; one line says what it does", async () => {
    const p = open();
    await p.press("enter");
    const lines: Array<[string | undefined, string | undefined]> = [];
    for (let i = 0; i < 3; i++) {
      await p.press(i === 2 ? "enter" : "right");
      lines.push([p.row("Read")?.value, p.panel.view().status?.text]);
    }
    expect(lines).toEqual([
      ["Summarized", "Speaks a summary when the reply ends."],
      ["Streaming", "Speaks summaries of reasoning steps mid-run."],
      ["Off", "Off."],
    ]);
    await p.press("left");
    expect(p.engine.readAloud.mode).toBe("streaming");
    await p.press("escape");
    expect(p.row("Read aloud options")?.value).toBe("Streaming");
    expect(p.notes).toEqual([]);
  });

  it("Streaming never keeps Same model: it takes the session's model, else the first; Summarized keeps that", async () => {
    const p = open(
      {},
      {
        before: (e) => {
          e.readAloud.attachHost({
            models: () => ["anthropic/claude-haiku", "openai/gpt-mini"],
            currentModel: () => "openai/gpt-mini",
          });
        },
      },
    );
    await p.press("enter");
    expect(p.row("Summarized by")?.value).toBe("Same model");
    await p.press("right", "right"); // Summarized, then Streaming
    expect(p.engine.readAloud.mode).toBe("streaming");
    expect(p.row("Summarized by")?.value).toBe("openai/gpt-mini");
    expect(p.engine.speech.settings.readAloud.summarizer).toBe("openai/gpt-mini");
    await p.press("left"); // back to Summarized: the chosen model stays
    expect(p.row("Summarized by")?.value).toBe("openai/gpt-mini");

    // Not the session's model when it is not one of the user's: the first of theirs.
    p.engine.setReadAloudOptions({ summarizer: undefined });
    p.engine.readAloud.attachHost({ currentModel: () => "local/unlisted" });
    p.engine.setReadMode("streaming");
    expect(p.engine.speech.settings.readAloud.summarizer).toBe("anthropic/claude-haiku");
  });

  it("Space steps a value that changes in place and opens submenus/pickers like Enter", async () => {
    const p = open();
    await p.type(" "); // Main: Read aloud options opens submenu
    expect(p.panel.view().crumb).toBe("Read aloud options");
    await p.type(" ");
    expect(p.engine.readAloud.mode).toBe("summary");
    await p.type(" ");
    expect(p.engine.readAloud.mode).toBe("streaming");
    await p.press("down"); // Summarized by: Space opens its picker
    await p.type(" ");
    expect(p.panel.view().picker?.title).toBe("Summarized by");
    await p.press("escape", "down"); // Length
    await p.type(" ");
    expect(p.engine.speech.settings.readAloud.length).toBe("abridged");
  });

  it("Streaming with no Pi model to take shows none, as a problem, never Same model", async () => {
    const p = open({}, { before: (e) => e.readAloud.attachHost({ models: () => [] }) });
    p.engine.setReadMode("streaming");
    await p.press("enter");
    expect(p.row("Summarized by")).toMatchObject({ value: "none", note: "✗ choose a model", alert: true });
  });

  it("Length and Truncate at cycle in place, are saved, and their lines say what they promise", async () => {
    const p = open();
    await p.press("enter", "down", "down");
    expect(p.panel.view().status?.text).toBe("~15 s target.");
    expect(p.hint()).toBe("← → Selects · Esc Main");
    await p.press("right");
    expect(p.row("Length")?.value).toBe("Abridged ~30 s");
    expect(p.panel.view().status?.text).toBe("~30 s target.");
    await p.press("enter");
    expect(p.row("Length")?.value).toBe("Full ~60 s");
    await p.press("down");
    expect(p.panel.view().status?.text).toBe("Off.");
    expect(p.hint()).toBe("← → Selects · Esc Main");
    await p.press("right", "right");
    expect(p.row("Truncate at")?.value).toBe("30 s");
    expect(p.panel.view().status?.text).toBe("Stops at 30 s.");
    await p.press("left", "left", "left");
    expect(p.row("Truncate at")?.value).toBe("120 s");
    const saved = JSON.parse(readFileSync(join(p.work, "agent", "pi-speech", "settings.json"), "utf8"));
    expect(saved.readAloud).toEqual({ length: "full", truncate: 120 });
  });

  it("Summarized by opens a picker of Same model and the user's Pi models", async () => {
    const p = open();
    p.engine.readAloud.attachHost({ models: () => ["anthropic/claude-haiku", "openai/gpt-mini"] });
    await p.press("enter", "down");
    expect(p.panel.view().status?.text).toBe("Summarization only: same model, same reply. No additional request.");
    expect(p.hint()).toBe("Enter choose summarization model · Esc Main");
    await p.press("right");
    expect(p.panel.view().picker).toBeUndefined();
    await p.press("enter");
    expect(p.hint()).toBe("Enter pick · type to filter · Esc back");
    expect(p.panel.view().status?.text).toBe("Summarization only: same model, same reply (no additional request).");
    const picker = p.panel.view().picker;
    expect(picker?.title).toBe("Summarized by");
    expect(picker?.items.map((i) => [i.label, i.current])).toEqual([
      ["Same model", true],
      ["anthropic/claude-haiku", false],
      ["openai/gpt-mini", false],
    ]);
    await p.press("down");
    expect(p.panel.view().status?.text).toBe(
      "Summarization only: one additional request to anthropic/claude-haiku per reply (your speech model speaks it).",
    );
    await p.type("haiku");
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.row("Summarized by")?.value).toBe("anthropic/claude-haiku");
    expect(p.panel.view().status?.text).toBe(
      "Summarization only: one additional request to anthropic/claude-haiku per reply.",
    );
    expect(p.engine.speech.settings.readAloud.summarizer).toBe("anthropic/claude-haiku");
    await p.press("up", "left"); // Streaming
    await p.press("down");
    expect(p.panel.view().status?.text).toBe(
      "Summarization only: additional requests to anthropic/claude-haiku made per step batch.",
    );
    await p.press("enter");
    expect(p.panel.view().status?.text).toBe(
      "Summarization only: additional requests to anthropic/claude-haiku made per step batch (your speech model speaks it).",
    );
    await p.press("escape");
    await p.press("up", "left"); // Summarized
    await p.press("down");
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
    expect(p.panel.view().status).toEqual({ tone: "success", text: "✓ Speech source: Local" });
    expect(p.row("Speech model")).toMatchObject({ value: "none", note: "✗ choose a model", alert: true });
    expect(p.row("Transcription model")).toMatchObject({ value: "none", note: "✗ choose a model", alert: true });
    // Without the binary a chosen local model's row says so.
    p.engine.speech.setLocalModel("transcription", "whisper-small");
    expect(p.row("Transcription model")).toMatchObject({ value: "whisper-small", note: "✗ local models unavailable" });
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

  it("Ctrl+P on the Voice row samples the current voice; on other rows it does nothing", async () => {
    const p = open();
    await p.press({ combo: "ctrl+p" });
    expect(p.requests.filter((r) => r.url.endsWith("/audio/speech"))).toHaveLength(0);
    await p.goTo("Voice");
    await p.press({ combo: "ctrl+p" });
    expect(p.requests.at(-1)?.body.voice).toBe("Kore");
  });

  it("the sample line names the sample language, and why it is English when it falls back", async () => {
    const p = open();
    await p.engine.speech.set("tts-model", "hexgrad/kokoro-82m");
    await p.engine.speech.set("voice", "jf_alpha");
    await p.goTo("Voice");
    await p.press({ combo: "ctrl+p" });
    expect(p.panel.view().status?.text).toBe("✓ sampled jf_alpha in ja");
    await p.engine.speech.set("tts-model", "x-ai/grok-voice-tts-1.0");
    await p.press({ combo: "ctrl+p" });
    expect(p.panel.view().status?.text).toMatch(/^✓ sampled \w+ in English · language unknown$/);
  });

  it("a failed sample is a ✗ line in the panel, not a notification", async () => {
    const p = open();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("quota", { status: 402 })),
    );
    await p.goTo("Voice");
    await p.press({ combo: "ctrl+p" });
    expect(p.panel.view().status).toMatchObject({ tone: "error", text: expect.stringMatching(/^✗ .*402/) });
    expect(p.notes).toEqual([]);
  });

  it("the hints follow the row; Esc is last", async () => {
    const p = open();
    const hints: Record<string, string> = {
      "Read aloud options": `Enter options · ${LETTER_HINTS} · Esc close`,
      "Speech source": `← → Selects · ${LETTER_HINTS} · Esc close`,
      "Speech model": `Enter browse · ${LETTER_HINTS} · Esc close`,
      Voice: `Enter choose · Ctrl+P sample · F2 language · ${LETTER_HINTS} · Esc close`,
      "Transcription source": `← → Selects · ${LETTER_HINTS} · Esc close`,
      "Transcription model": `Enter browse · ${LETTER_HINTS} · Esc close`,
      "Dictation options": `Enter options · ${LETTER_HINTS} · Esc close`,
      Hotkeys: `Enter keys · ${LETTER_HINTS} · Esc close`,
      Receivers: `Enter receivers · ${LETTER_HINTS} · Esc close`,
      "Spectrum OSD": `← → Selects · ${LETTER_HINTS} · Esc close`,
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
    expect(p.hint()).toBe("Enter pick · Ctrl+P sample · F2 language · type to filter · Esc back");
    expect(
      p.panel
        .view()
        .hints.filter((h) => h.optional)
        .map((h) => h.key),
    ).toEqual(["Ctrl+P", "F2"]);
    await p.type("zz");
    expect(p.hint()).toBe("Backspace · Esc back");
    await p.press("escape", "up");
    await p.press("enter");
    expect(p.hint()).toBe("Enter pick · Ctrl+S sort · Ctrl+T local · type to filter · Esc back");
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
    await p.press({ combo: "ctrl+n" });
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

describe("the panel view model: Receivers", () => {
  it("on this machine with Device Local it shows only Device and Receiver (hiding Bridge, Pairing, and DIRECTION)", async () => {
    const p = open();
    await p.panel.idle();
    await p.goTo("Receivers");
    await p.press("enter");
    const v = p.panel.view();
    expect(v).toMatchObject({ menu: "bridge", crumb: "Receivers", selected: 0 });
    expect(v.rows.map((r) => r.label)).toEqual(["Device", "Receiver"]);
    expect(p.row("Device")).toMatchObject({ value: "Local", note: "Enter connects to Remote", opens: true });
    expect(p.hint()).toBe("← → Selects · Enter connect · Esc Main");
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
    expect(p.selectedLabel()).toBe("Receivers");
  });

  it("over SSH it holds the bridge mode, which cycles auto, on, off in place and is saved", async () => {
    const p = open({ SSH_CONNECTION: "1 2 3 4" });
    await p.panel.idle();
    await p.goTo("Receivers");
    await p.press("enter");
    expect(p.panel.view().rows.map((r) => r.label)).toEqual(BRIDGE_ROWS);
    expect(p.row("Bridge")?.value).toBe("auto");
    expect(p.hint()).toBe("← → Selects · Esc Main");
    await p.press("right");
    expect(p.row("Bridge")?.value).toBe("on");
    await p.press("enter");
    expect(p.row("Bridge")?.value).toBe("off");
    expect(settingsOf(p.work).bridge).toBe("off");
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
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

describe("the panel view model: Device and Receiver, on this machine", () => {
  it("the main view's Receivers row summarizes Local or Remote connection state", async () => {
    const p = open();
    await p.panel.idle();
    expect(p.row("Receivers")).toMatchObject({ value: expect.stringMatching(/^Local/), opens: true });
    p.engine.speech.settings.remoteHost = "spider";
    p.engine.remoteState = "connecting";
    expect(p.row("Receivers")).toMatchObject({ value: "spider", note: "… connecting" });
    p.engine.remoteState = "connected";
    expect(p.row("Receivers")).toMatchObject({ value: "spider", note: expect.stringMatching(/^✓ CPU/) });
    p.engine.remoteState = "lost";
    p.engine.remoteError = "the connection to spider ended";
    expect(p.row("Receivers")).toMatchObject({
      value: "spider",
      note: "✗ the connection to spider ended",
      alert: true,
    });
    const ssh = open({ SSH_CONNECTION: "1 2 3 4" });
    await ssh.panel.idle();
    expect(ssh.row("Receivers")).toMatchObject({ value: "ssh forward", note: "✓" });
  });

  it("Enter on Device opens Connect; arrows step through the Hosts of ~/.ssh/config", async () => {
    const home = trackTemp(mkdtempSync(join(tmpdir(), "pi-speech-home-")));
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh", "config"), "Host spider\n  HostName 100.64.0.9\nHost *.lan\nHost build lab\n");
    const p = open({ HOME: home });
    await p.goTo("Receivers");
    await p.press("enter");
    await p.goTo("Device");
    await p.press("enter");
    expect(p.panel.view().input).toMatchObject({ label: "Connect to", value: "", under: "device" });
    expect(p.panel.view().status?.text).toBe("Your ssh Hosts: spider, build, lab");
    expect(p.hint()).toBe("Enter connect · ↑↓ your ssh Hosts · Esc back");
    await p.press("down");
    expect(p.panel.view().input?.value).toBe("spider");
    await p.press("down", "down", "down");
    expect(p.panel.view().input?.value).toBe("spider");
  });

  it("an SSH destination connects through the engine; its questions are asked here, a password as dots", async () => {
    const p = open(
      {},
      {
        before: (e) => {
          e.connectRemote = async (dest, prompts) => {
            prompts.progress(`… connecting to ${dest}`);
            if (!(await prompts.confirm("spider has no pi-speech-receiver. Install it?"))) throw new Error("declined");
            const pw = await prompts.password("me@spider");
            if (pw !== "hunter2") throw new Error("wrong password");
            e.speech.settings.remoteHost = dest;
            e.remoteState = "connected";
            e.onRemoteChange();
            return {
              dest,
              address: "127.0.0.1:40000",
              token: "t",
              version: "0.3.0",
              alive: () => true,
              close: async () => {},
            };
          };
        },
      },
    );
    await p.goTo("Receivers");
    await p.press("enter");
    await p.press("enter"); // Device: Connect
    await p.type("spider");
    p.panel.handle({ key: "enter" });
    await vi.waitFor(() => expect(p.panel.view().login?.prompt).toBe("spider has no pi-speech-receiver. Install it?"));
    expect(p.hint()).toBe("Enter yes · Esc no");
    // While a question waits the panel is not idle: keys go straight to it.
    p.panel.handle({ text: "n" }); // typing does not answer
    expect(p.panel.view().login?.prompt).toBe("spider has no pi-speech-receiver. Install it?");
    p.panel.handle({ key: "enter" });
    await vi.waitFor(() =>
      expect(p.panel.view().login).toMatchObject({ prompt: "Password for me@spider", secret: true }),
    );
    p.panel.handle({ text: "hunter2" });
    expect(p.panel.view().login?.value).toBe("hunter2"); // the renderer draws it as dots
    await p.press("enter");
    expect(p.panel.view().status?.text).toMatch(/^✓ Connected to spider over SSH, receiver 0.3.0/);
    expect(p.row("Device")).toMatchObject({ value: "Remote · spider", note: expect.stringMatching(/^✓ over SSH/) });
  });

  it("Receiver shows edition/version on connection, offers u only when outdated, and Device ←→ toggles Local ↔ Remote", async () => {
    const expected = "0.2.5";
    let installedVersion = "0.3.0";
    let updatedCalls = 0;
    const p = open(
      {},
      {
        before: (e) => {
          (e as unknown as { receiverVersion: string }).receiverVersion = expected;
          e.probeBridge = async () => ({
            ok: true,
            address: "127.0.0.1",
            port: 40000,
            ms: 12,
            version: installedVersion,
          });
          e.connectRemote = async (dest, _prompts, opts) => {
            if (opts?.update === "force") {
              updatedCalls++;
              installedVersion = expected;
            }
            e.speech.settings.remoteHost = dest;
            await e.setBridge("on");
            e.remoteState = "connected";
            e.onRemoteChange();
            return {
              dest,
              address: "127.0.0.1:40000",
              token: "t",
              version: installedVersion,
              edition: "cpu",
              outdated: installedVersion !== expected,
              alive: () => true,
              close: async () => {},
            };
          };
        },
      },
    );
    await p.goTo("Receivers");
    await p.press("enter");
    await p.press("enter");
    await p.type("spider");
    await p.press("enter");
    expect(p.panel.view().status?.text).toMatch(/receiver 0\.3\.0.*expected 0\.2\.5/);
    expect(p.row("Device")).toMatchObject({ value: "Remote · spider", note: expect.stringMatching(/^✓ over SSH/) });
    expect(p.row("Receiver")).toMatchObject({
      value: "CPU v0.3.0",
      note: "! u updates to v0.2.5",
      alert: true,
    });
    expect(p.hint()).toContain("u update to v0.2.5");
    await p.press("down"); // Receiver
    expect(p.hint()).toContain("u update to v0.2.5");
    await p.type("u");
    expect(updatedCalls).toBe(1);
    expect(p.panel.view().status?.text).toBe("✓ Updated pi-speech-receiver on spider to 0.2.5");
    expect(p.row("Receiver")).toMatchObject({ value: "CPU v0.2.5" });
    expect(p.row("Receiver")?.alert).toBeFalsy();
    expect(p.hint()).not.toContain("update to");
    await p.type("u");
    expect(updatedCalls).toBe(1);
    expect(p.panel.view().status?.text).toBe("pi-speech-receiver on spider is already current (0.2.5)");
    // Device ←→ toggles back to Local (turning off the bridge while remembering spider) and back to Remote
    await p.press("up"); // Device
    expect(p.engine.routes.route).toBe("bridge");
    await p.press("left");
    expect(p.engine.routes.route).toBe("local");
    expect(settingsOf(p.work).bridge).toBe("auto");
    expect(settingsOf(p.work).remoteHost).toBe("spider");
    expect(p.row("Device")).toMatchObject({ value: "Local", note: expect.stringContaining("spider") });
    await p.press("escape");
    expect(p.row("Receivers")).toMatchObject({ value: expect.stringMatching(/^Local/) });
    expect(p.row("Receivers")?.alert).toBeFalsy();
    await p.goTo("Receivers");
    await p.press("enter", "right");
    expect(p.engine.routes.route).toBe("bridge");
    expect(p.row("Device")).toMatchObject({ value: "Remote · spider" });
  });

  it.skipIf(!STAND_IN_BINARY)(
    "toggling Device from Remote to Local reloads local models/voices on this machine instead of failing on a closed bridge",
    async () => {
      const bin = fakeReceiver(mkdtempSync(join(tmpdir(), "pi-speech-toggle-dev-")));
      let linkOpen = false;
      const p = open(
        { PI_SPEECH_BINARY: bin.path },
        {
          before: (e) => {
            // Simulate a bridge whose models endpoint requires the live SSH link token (throws once link closes).
            (e.routes.bridge as { models?: unknown }).models = {
              list: async () => {
                if (!linkOpen) throw new Error("no bridge token");
                return [
                  {
                    id: "kokoro",
                    kind: "speech",
                    name: "Kokoro",
                    languages: ["en"],
                    size: 100000000,
                    downloaded: true,
                    partial: 0,
                    path: "/remote/kokoro",
                  },
                ];
              },
              voices: async () => {
                if (!linkOpen) throw new Error("no bridge token");
                return [{ name: "af_alloy", number: 0 }];
              },
              transcribe: async () => "ok",
              speak: async () => {
                throw new Error("unused");
              },
            };
            e.connectRemote = async (dest) => {
              linkOpen = true;
              e.speech.settings.remoteHost = dest;
              await e.setBridge("on");
              e.setDirection("modelsOn", "remote");
              e.remoteState = "connected";
              e.onRemoteChange();
              return {
                dest,
                address: "127.0.0.1:38275",
                token: "ephemeral",
                version: "0.2.5",
                edition: "gpu",
                alive: () => linkOpen,
                close: async () => {
                  linkOpen = false;
                },
              };
            };
          },
        },
      );
      p.engine.speech.setSource("speech", "local");
      p.engine.speech.settings.localSpeechModel = "kokoro";
      p.engine.speech.setSource("transcription", "local");
      p.engine.speech.settings.localTranscriptionModel = "parakeet-v3";

      await p.goTo("Receivers");
      await p.press("enter", "enter");
      await p.type("decent-spider");
      await p.press("enter");
      expect(p.engine.routes.route).toBe("bridge");

      // Toggle Device back to Local via left arrow: link closes, bridge switches off, local models reload cleanly.
      const origDisconnect = p.engine.disconnectRemote.bind(p.engine);
      p.engine.disconnectRemote = async (forget, opts) => {
        linkOpen = false;
        return origDisconnect(forget, opts);
      };
      await p.press("left");
      expect(p.engine.routes.route).toBe("local");
      await p.press("escape");
      expect(p.panel.view().status?.tone).not.toBe("error");
      // On this machine: parakeet-v3 is downloaded, kokoro is not downloaded (so Speech model says not downloaded, Voice says download model first — never local models/voices unavailable).
      expect(p.row("Transcription model")).toMatchObject({ value: "parakeet-v3" });
      expect(p.row("Transcription model")?.alert).toBeFalsy();
      expect(p.row("Speech model")).toMatchObject({ value: "kokoro", note: "✗ not downloaded", alert: true });
      expect(p.row("Voice")).toEqual({
        id: "voice",
        label: "Voice",
        value: "default",
        note: "download model first",
        disabled: true,
      });
    },
  );

  it("Local Receiver reports unavailable GPU hardware cleanly when switching CPU → GPU", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-speech-nogpu-"));
    const bin = join(dir, "fake-receiver");
    writeFileSync(
      bin,
      `#!${process.execPath}
const cmd = process.argv[2];
if (cmd === "--version") { console.log("pi-speech-receiver ${packageVersion()}"); process.exit(0); }
if (cmd === "gpu") { console.log(JSON.stringify({ driver: false, cuda: null, cudnn: false, hardware: false, edition: "cpu", target: null, usable: false, why: "no NVIDIA driver (libcuda.so.1 does not load)" })); process.exit(0); }
`,
      { mode: 0o755 },
    );
    const p = open({ PI_SPEECH_BINARY: bin });
    await p.goTo("Receivers");
    await p.press("enter");
    await p.press("down"); // Receiver
    expect(p.row("Receiver")).toMatchObject({ value: `CPU v${packageVersion()}`, note: "env" });
    await p.press("right");
    expect(p.panel.view().status?.text).toMatch(/GPU unavailable: no NVIDIA driver/);
    expect(p.engine.speech.settings.localDevice).toBe("cpu");
    rmSync(dir, { recursive: true, force: true });
  });

  it("Esc on a question or the password declines it, and the connection says why", async () => {
    const p = open(
      {},
      {
        before: (e) => {
          e.connectRemote = async (_dest, prompts) => {
            if (!(await prompts.confirm("Trust its key?")))
              throw new Error("not connected: the host key was not trusted");
            throw new Error("unreachable");
          };
        },
      },
    );
    await p.goTo("Receivers");
    await p.press("enter");
    await p.press("enter");
    await p.type("spider");
    p.panel.handle({ key: "enter" });
    await vi.waitFor(() => expect(p.panel.view().login?.prompt).toBe("Trust its key?"));
    await p.press("escape");
    expect(p.panel.view().status?.text).toBe("✗ not connected: the host key was not trusted");
  });

  it("address:port pairs with a receiver there without SSH; paired, the bridge goes on with the audio here", async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), "pi-speech-pair-")));
    const tokenFile = join(dir, "bridge.token");
    const token = "r".repeat(64);
    const p = open({ PI_SPEECH_BRIDGE_TOKEN_FILE: tokenFile });
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (!String(url).startsWith("http://100.64.0.2:47613/")) return inner(url, init);
        const path = new URL(url).pathname;
        const auth = (init.headers as Record<string, string>)?.Authorization;
        if (path === "/v1/health") {
          return auth === `Bearer ${token}`
            ? Response.json({ protocol: 1, name: "pi-speech-receiver", version: "0.4.0", capabilities: ["stream"] })
            : Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const { code } = JSON.parse(String(init.body)) as { code?: string };
        if (!code) return Response.json({ expires_in: 120, attempts: 5 }, { status: 202 });
        return code === "123456"
          ? Response.json({ token })
          : Response.json({ error: "wrong pairing code", attempts_left: 4 }, { status: 403 });
      }),
    );
    await p.goTo("Receivers");
    await p.press("enter");
    await p.press("enter");
    await p.type("100.64.0.2:47613");
    await p.press("enter");
    expect(p.panel.view().input).toMatchObject({ label: "Code from 100.64.0.2:47613" });
    await p.type("123456");
    await p.press("enter");
    await vi.waitFor(() => expect(p.panel.view().status?.text).toMatch(/Bridge on: models run there/));
    expect(settingsOf(p.work)).toMatchObject({ bridge: "on", playOn: "this", recordOn: "this" });
    expect(p.engine.speech.settings.modelsOn).toBe("remote");
  });
});

describe("the panel view model: Receivers' DIRECTION", () => {
  it("reveals DIRECTION rows only while a bridge is active, and clamps selection cleanly when the bridge turns off", async () => {
    const p = open({ SSH_CONNECTION: "1 2 3 4" });
    await p.goTo("Run models on");
    expect(p.panel.view().rows.map((r) => r.label)).toEqual(BRIDGE_ROWS);
    expect(p.selectedLabel()).toBe("Run models on");
    // Turn Bridge off: the three routing rows disappear and selection clamps when Bridge is turned off from row 0 or via engine.
    await p.engine.setBridge("off");
    expect(p.panel.view().rows.map((r) => r.label)).toEqual(["Bridge", "Device", "Pairing", "Receiver"]);
    expect(p.selectedLabel()).toBe("Receiver");
    expect(p.hint()).toMatch(/Esc Main$/);
    await p.engine.setBridge("auto");
    expect(p.panel.view().rows.map((r) => r.label)).toEqual(BRIDGE_ROWS);
  });

  it("over SSH each row cycles This machine | Remote machine and is saved; a choice that needs this host's microphone warns", async () => {
    const p = open({ SSH_CONNECTION: "1 2 3 4" });
    await p.goTo("Record audio on");
    expect(BRIDGE_ROWS.slice(4).map((l) => p.row(l)?.value)).toEqual([
      "Remote machine",
      "Remote machine",
      "Remote machine",
    ]);
    expect(p.hint()).toBe("← → Selects · Esc Main");
    await p.press("right");
    expect(p.row("Record audio on")?.value).toBe("This machine");
    expect(p.panel.view().status).toMatchObject({ tone: "warning", text: expect.stringMatching(/needs a microphone/) });
    expect(settingsOf(p.work).recordOn).toBe("this");
    expect(p.engine.routes.inputRoute).toBe("local");
    await p.goTo("Run models on");
    await p.press("left");
    expect(settingsOf(p.work).modelsOn).toBe("this");
    expect(p.engine.routes.modelsRoute).toBe("local");
    await p.press("enter");
    expect(settingsOf(p.work).modelsOn).toBeUndefined();
  });
});

describe("the panel view model: Receivers' Device and Pairing (Pi over SSH)", () => {
  // Over SSH the receiver is the user's own machine: the bridge mode and Pairing rows are there.
  const SSH = { SSH_CONNECTION: "1 2 3 4" };
  const connected = async () => ({ ok: true, address: "127.0.0.1", port: 47613, ms: 52, version: "0.3.0" }) as const;
  const refused = async () =>
    ({
      ok: false,
      address: "127.0.0.1",
      port: 47613,
      reason: "the playback receiver is not reachable at http://127.0.0.1:47613: fetch failed",
    }) as const;

  it("shows the bridge, the Device's address (the ssh forward by default), and a connected receiver", async () => {
    const p = open(SSH, { before: (e) => (e.probeBridge = connected) });
    await p.goTo("Receivers");
    await p.press("enter");
    expect(p.panel.view().rows.map((r) => r.label)).toEqual(BRIDGE_ROWS);
    expect(p.row("Device")).toMatchObject({ value: "Remote · 127.0.0.1:47613", note: "ssh forward" });
    expect(p.row("Pairing")).toMatchObject({ value: "✓ Connected to 127.0.0.1:47613 · 52 ms", opens: true });
    await p.goTo("Device");
    expect(p.hint()).toBe("← → Selects · Enter where it comes from · Esc Main");
    await p.press("enter");
    expect(p.panel.view().status).toMatchObject({ tone: "info", text: expect.stringMatching(/PI_SPEECH_BRIDGE_URL/) });
    await p.goTo("Pairing");
    expect(p.hint()).toBe("Enter address, pair · Esc Main");
  });

  it("names the address PI_SPEECH_BRIDGE_URL gives", async () => {
    const p = open(
      { ...SSH, PI_SPEECH_BRIDGE_URL: "http://localhost:5000" },
      { before: (e) => (e.probeBridge = connected) },
    );
    await p.goTo("Device");
    expect(p.row("Device")).toMatchObject({ value: "Remote · localhost:5000", note: "from PI_SPEECH_BRIDGE_URL" });
  });

  it("an unreachable receiver is ✗ Re-pair, whose Enter opens the address field", async () => {
    const p = open(SSH, { before: (e) => (e.probeBridge = refused) });
    await p.goTo("Pairing");
    expect(p.row("Pairing")).toMatchObject({ value: "✗ Re-pair", note: "receiver unreachable", opens: true });
    await p.press("enter");
    expect(p.panel.view().input).toMatchObject({ label: "Address", value: "", under: "pairing" });
    expect(p.panel.view().status?.text).toMatch(/--network/);
  });

  it("an address whose receiver refuses this machine's token pairs with the code its terminal shows", async () => {
    const dir = trackTemp(mkdtempSync(join(tmpdir(), "pi-speech-pair-")));
    const tokenFile = join(dir, "bridge.token");
    const token = "r".repeat(64);
    const p = open({ ...SSH, PI_SPEECH_BRIDGE_TOKEN_FILE: tokenFile }, { before: (e) => (e.probeBridge = refused) });
    // The receiver at a Tailscale address: it shows 123456 on its own terminal; 999999 has expired.
    const asked: string[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        if (!String(url).startsWith("http://100.64.0.2:47613/")) return inner(url, init);
        const path = new URL(url).pathname;
        asked.push(path);
        const auth = (init.headers as Record<string, string>)?.Authorization;
        if (path === "/v1/health") {
          return auth === `Bearer ${token}`
            ? Response.json({ protocol: 1, name: "pi-speech-receiver", version: "0.4.0", capabilities: ["stream"] })
            : Response.json({ error: "unauthorized" }, { status: 401 });
        }
        const { code } = JSON.parse(String(init.body)) as { code?: string };
        if (!code) return Response.json({ expires_in: 120, attempts: 5 }, { status: 202 });
        if (code === "123456") return Response.json({ token });
        if (code === "999999") return Response.json({ error: "no pairing code is active" }, { status: 410 });
        return Response.json({ error: "wrong pairing code", attempts_left: 4 }, { status: 403 });
      }),
    );
    await p.goTo("Pairing");
    await p.press("enter");
    await p.type("100.64.0.2");
    await p.press("enter");
    expect(asked).toEqual(["/v1/pair"]);
    expect(p.panel.view().input).toMatchObject({ label: "Code from 100.64.0.2:47613", value: "" });
    expect(p.panel.view().status?.text).toMatch(/shows on its terminal.*2 min/);

    await p.type("111111");
    await p.press("enter");
    expect(p.panel.view().status).toMatchObject({
      tone: "error",
      text: expect.stringMatching(/wrong.*4 attempts left/),
    });
    expect(p.panel.view().input).toMatchObject({ label: "Code from 100.64.0.2:47613", value: "" });

    await p.type("999999");
    await p.press("enter");
    expect(p.panel.view().input).toMatchObject({ label: "Address", value: "100.64.0.2:47613" });
    await p.press("enter");
    await p.type("123 456");
    await p.press("enter");
    expect(p.panel.view().input).toBeUndefined();
    expect(p.panel.view().status).toMatchObject({ tone: "success", text: expect.stringContaining(tokenFile) });
    expect(readFileSync(tokenFile, "utf8").trim()).toBe(token);
    expect(settingsOf(p.work).bridgeAddress).toBe("100.64.0.2:47613");
    expect(p.row("Device")).toMatchObject({ value: "Remote · 100.64.0.2:47613", note: "set in Pairing" });
    // Over SSH pairing leaves the bridge mode and the directions as they are.
    expect(settingsOf(p.work).bridge ?? "auto").toBe("auto");
  });

  it("Bridge on with no token of this machine goes to Pairing, saying to pair first", async () => {
    const p = open(SSH, {
      before: (e) => {
        e.probeBridge = refused;
        // As Routes.choose says it when no token file exists.
        e.setBridge = async () => {
          throw new Error(
            "The bridge was not selected (audio stays local): no bridge token: set PI_SPEECH_BRIDGE_TOKEN, or put it in /x/bridge.token (ENOENT)",
          );
        };
      },
    });
    await p.goTo("Bridge");
    await p.press("right");
    await vi.waitFor(() => expect(p.panel.view().input).toMatchObject({ label: "Address", under: "pairing" }));
    expect(p.panel.view().status).toMatchObject({ tone: "info", text: expect.stringMatching(/^Pair first/) });
    expect(p.row("Bridge")?.value).toBe("auto");
    await p.press("escape");
    expect(p.panel.view().menu).toBe("bridge");
  });

  it("probes when it opens and again while it is open, and stops when it is left", async () => {
    let n = 0;
    let ok = false;
    const p = open(SSH, {
      pairingMs: 20,
      before: (e) =>
        (e.probeBridge = async () => {
          n++;
          return ok ? connected() : refused();
        }),
    });
    await p.goTo("Receivers");
    await p.press("enter");
    expect(n).toBe(1);
    expect(p.row("Pairing")?.value).toBe("✗ Re-pair");
    ok = true;
    await vi.waitFor(() => expect(p.row("Pairing")?.value).toMatch(/^✓ Connected/));
    expect(n).toBeGreaterThan(1);
    await p.press("escape");
    await new Promise((r) => setTimeout(r, 60));
    const after = n;
    await new Promise((r) => setTimeout(r, 80));
    expect(n).toBe(after);
  });
});

describe("the panel view model: Hotkeys", () => {
  it("holds the actions with keys of their own; the submenu has its own title and hints", async () => {
    const p = open();
    await p.goTo("Hotkeys");
    await p.press("enter");
    const v = p.panel.view();
    expect(v).toMatchObject({ menu: "hotkeys", crumb: "Hotkeys", selected: 0 });
    expect(v.rows.map((r) => [r.label, r.value])).toEqual([
      ["Speak…", "Alt+S"],
      ["Dictate", "Alt+Z"],
      ["Push-to-talk", "off"],
    ]);
    expect(p.hint()).toBe("Enter run · k change key · Esc Main");
    await p.press("down");
    expect(p.hint()).toBe("Enter run · k change key · Esc Main");
    await p.press("down");
    expect(p.selectedLabel()).toBe("Push-to-talk");
    expect(p.hint()).toBe("k set key · Esc Main");
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
    expect(p.panel.view().tab).toBe("main");
  });
  it("Speak… puts the cursor on the main view's Speak line; Enter speaks and clears it; Esc closes", async () => {
    const p = open();
    await p.goTo("Speak…");
    await p.press("enter");
    expect(p.panel.view().menu).toBe("main");
    expect(p.panel.view().speak).toMatchObject({ focused: true, value: "" });
    expect(p.panel.view().selected).toBe(-1);
    expect(p.hint()).toBe("Enter speak · Ctrl+O replay · Ctrl+L history · Ctrl+N stop · Ctrl+T transcribe · Esc close");
    await p.type("panel hello");
    p.panel.handle({ key: "enter" });
    expect(p.panel.view().speak?.value).toBe("");
    expect(p.panel.view().status).toMatchObject({ tone: "busy", text: "♪ speaking…" });
    await p.type("second message");
    await p.press("enter");
    await p.panel.idle();
    expect(p.requests.filter((r) => r.body?.input).map((r) => r.body.input)).toEqual(["panel hello", "second message"]);
    expect(p.close).not.toHaveBeenCalled();
    p.local.end(1, { state: "completed" });
    await vi.waitFor(() => expect(p.panel.view().status).toMatchObject({ tone: "success", text: "✓ Spoken" }));
    // Down to the rows and back keeps a half-typed message.
    await p.type("draft");
    await p.press("down");
    expect(p.selectedLabel()).toBe("Read aloud options");
    expect(p.panel.view().speak).toMatchObject({ focused: false, value: "draft" });
    await p.press("up");
    expect(p.panel.view().speak).toMatchObject({ focused: true, value: "draft" });
    await p.press("escape");
    expect(p.close).toHaveBeenCalledTimes(1);
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

  it("the Speak line says when the speech model takes inline tags", async () => {
    const p = open();
    await p.panel.idle();
    await p.press("speak");
    expect(p.panel.view().speak?.placeholder).toMatch(/\[tags\] direct this model/);
    await p.engine.speech.set("tts-model", "hexgrad/kokoro-82m");
    expect(p.panel.view().speak?.placeholder).not.toMatch(/tags/);
  });
  it("the Speak key puts the cursor on the Speak line from the main view, a submenu and a picker", async () => {
    const p = open();
    await p.press("speak");
    expect(p.panel.view().speak?.focused).toBe(true);
    await p.press("down");
    await p.goTo("Voice");
    await p.press("enter", "speak");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.panel.view()).toMatchObject({ menu: "main", speak: { focused: true } });
    await p.press("down");
    await p.goTo("Receivers");
    await p.press("enter", "speak");
    expect(p.panel.view()).toMatchObject({ menu: "main", speak: { focused: true } });
  });
  it("Ctrl+O replays the last message from any row of the main view; the panel stays open", async () => {
    const p = open();
    await p.engine.speech.speak("earlier words");
    p.local.end(0, { state: "completed" });
    await p.press({ combo: "ctrl+o" });
    expect(p.close).not.toHaveBeenCalled();
    expect(p.local.plays).toHaveLength(2);
    expect(p.panel.view().status?.text).toBe("♪ speaking…");
    p.local.end(1, { state: "completed" });
    await vi.waitFor(() => expect(p.panel.view().status?.text).toBe("✓ Spoken"));
    await p.goTo("Receivers");
    await p.press({ combo: "ctrl+o" });
    expect(p.local.plays).toHaveLength(3);
    expect(p.close).not.toHaveBeenCalled();
    expect(p.notes).toEqual([]);
  });
  it("s on Hotkeys does not stop active speech", async () => {
    const p = open();
    await p.engine.speech.speak("still speaking");
    await p.goTo("Hotkeys");
    await p.press("enter");
    const stop = vi.spyOn(p.engine.player, "stop");
    await p.type("s");
    expect(stop).not.toHaveBeenCalled();
    await p.press("escape", { combo: "ctrl+n" });
    expect(stop).toHaveBeenCalled();
  });
  it("Ctrl+N stops and leaves the panel open; Ctrl+O with nothing to replay is refused", async () => {
    const p = open();
    await p.press({ combo: "ctrl+n" });
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.view().status?.text).toMatch(/nothing was playing/i);
    await p.press({ combo: "ctrl+o" });
    expect(p.close).not.toHaveBeenCalled();
    expect(p.panel.view().status).toMatchObject({ tone: "error", text: expect.stringMatching(/^✗ Nothing to replay/) });
  });
  it("Stop while speaking says Stopped, not Spoken", async () => {
    const p = open();
    await p.press("speak");
    await p.type("words");
    await p.press("enter");
    await p.press("down"); // to the rows, where Ctrl+N also stops
    await p.press({ combo: "ctrl+n" });
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

  it("Dictate inside the Speak composer keeps it open and inserts the transcript there", async () => {
    const p = open(
      {},
      {
        before: (e) => {
          vi.spyOn(e.routes, "input").mockReturnValue({
            name: "local",
            start: async () => ({
              stop: async () => ({ audio: Buffer.from("RIFF"), format: "wav" }),
              cancel: async () => {},
            }),
          });
        },
      },
    );
    p.panel.openSpeaker();
    await p.type("hello ");
    await p.press({ key: "dictate", id: "alt+z" });
    expect(p.close).not.toHaveBeenCalled();
    expect(p.engine.dictation.state).toBe("recording");
    await p.press({ key: "dictate", id: "alt+z" });
    await vi.waitFor(() => expect(p.engine.dictation.state).toBe("idle"));
    expect(p.close).not.toHaveBeenCalled();
    expect(p.pasted).toEqual([]);
    expect(p.panel.view().speak?.value).toBe("hello hello world");
  });

  it("Ctrl+L opens the history; Esc returns to the main view", async () => {
    const p = open();
    await p.engine.speech.speak("first words");
    await p.press({ combo: "ctrl+l" });
    expect(p.panel.view().picker).toMatchObject({ title: "History", total: 1 });
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
    expect(p.panel.view().picker).toBeUndefined();
  });
  it("Ctrl+T asks for the path of an audio file to transcribe; Esc returns to the main view", async () => {
    const p = open();
    await p.press({ combo: "ctrl+t" });
    expect(p.panel.view().input).toMatchObject({ label: "Audio file" });
    await p.press("escape");
    expect(p.panel.view().menu).toBe("main");
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
    await p.press({ combo: "ctrl+o" });
    expect(p.panel.view().status).toMatchObject({
      tone: "error",
      text: "✗ Ctrl+O cannot be a hotkey: use Alt with a letter or a digit",
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
  });

  it("Push-to-talk captures F8 or Alt+key, rejects collisions, and clears with Backspace", async () => {
    const p = open();
    await p.goTo("Push-to-talk");
    await p.type("k");
    await p.press({ combo: "f8" });
    expect(p.row("Push-to-talk")?.value).toBe("F8");
    expect(p.engine.speech.settings.hotkeys.ptt).toBe("f8");
    expect(p.hint()).toBe("k set key · Backspace clear · Esc Main");
    // Leaving Hotkeys after changing PTT alone does not require a Pi reload.
    await p.press("escape");
    expect(p.panel.rebind).toBe(false);
    expect(p.close).not.toHaveBeenCalled();

    // Backspace clears Push-to-talk back to off.
    await p.goTo("Push-to-talk");
    await p.press("backspace");
    expect(p.row("Push-to-talk")?.value).toBe("off");
    expect(p.engine.speech.settings.hotkeys.ptt).toBeUndefined();
  });

  it("Spectrum OSD defaults to Lines and cycles through Helix, Braille, Prism, Orb, Waves, and Off", async () => {
    const p = open();
    await p.goTo("Spectrum OSD");
    expect(p.row("Spectrum OSD")?.value).toBe("Lines");
    const expected: Array<[string, string]> = [
      ["Helix", "helix"],
      ["Braille", "braille"],
      ["Prism", "prism"],
      ["Orb", "orb"],
      ["Waves", "wave"],
      ["Off", "off"],
      ["Lines", "line"],
    ];
    for (const [label, id] of expected) {
      await p.press("right");
      expect(p.row("Spectrum OSD")?.value).toBe(label);
      expect(p.engine.speech.settings.osdStyle).toBe(id);
    }
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

  it("Ctrl+P in the voice picker samples the highlighted voice without choosing it; Enter picks", async () => {
    const p = open();
    await p.goTo("Voice");
    await p.press("enter");
    await p.type("puck");
    p.panel.handle({ combo: "ctrl+p" });
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

  it("the model pickers list the models alphabetically by default, and Ctrl+S price puts cheapest first, subscription last", async () => {
    const p = open({}, { xai: true });
    await p.goTo("Speech model");
    await p.press("enter");
    const picker = p.panel.view().picker;
    expect(picker).toMatchObject({ title: "Speech model", sort: "name", noun: "models", total: 4 });
    expect(picker?.items.map((i) => i.id)).toEqual([
      "google/gemini-3.8-flash-tts",
      "hexgrad/kokoro-82m",
      "x-ai/grok-voice-tts-1.0",
      "xai",
    ]);
    await p.press({ combo: "ctrl+s" }, { combo: "ctrl+s" }); // name -> name-desc -> price
    const byPrice = p.panel.view().picker;
    expect(byPrice?.sort).toBe("price");
    expect(byPrice?.items.map((i) => i.id)).toEqual([
      "hexgrad/kokoro-82m",
      "x-ai/grok-voice-tts-1.0",
      "google/gemini-3.8-flash-tts",
      "xai",
    ]);
    expect(byPrice?.items[2]).toMatchObject({ price: "~$0.03/min", note: "tags · fast · 2 voices", current: true });
    expect(byPrice?.items[3]).toMatchObject({ label: "xAI Grok", price: "subscription", note: "xAI login" });
    expect(byPrice?.selected).toBe(0);
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
    await p.press({ combo: "ctrl+s" }, { combo: "ctrl+s" }); // name -> name-desc -> price
    // Unpriced models (d/none) are hidden by default while free (c/free) and priced models stay visible.
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual(["c/free", "a/one", "b/two"]);
    expect(p.panel.view().picker?.detail).toContain("1 model without price hidden · F4 shows them");
    expect(p.hint()).toContain("F4 show 1 unpriced");
    // F4 reveals unpriced models with price "unknown" and persists showUnpricedModels.
    await p.press({ combo: "f4" });
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual(["c/free", "a/one", "b/two", "d/none"]);
    expect(p.panel.view().picker?.items[3].price).toBe("unknown");
    expect(settingsOf(p.work).showUnpricedModels).toBe(true);
    await p.press({ combo: "f4" });
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual(["c/free", "a/one", "b/two"]);
    expect(settingsOf(p.work).showUnpricedModels).toBeUndefined();
  });

  it("never filters out xAI subscription or free models when hiding unpriced models", async () => {
    const p = open(
      {},
      {
        xai: true,
        before: (e) => {
          e.speech.models = async () => ({
            tts: [
              { id: "xai", label: "xAI Grok", voices: ["ara"] },
              { id: "local/free", label: "free", price: "$0" },
              { id: "ep:unpriced", label: "unpriced" },
            ],
            stt: [],
          });
        },
      },
    );
    await p.goTo("Speech model");
    await p.press("enter");
    expect(p.panel.view().picker?.items.map((i) => [i.id, i.price])).toEqual([
      ["local/free", "free"],
      ["xai", "subscription"],
    ]);
    expect(p.panel.view().picker?.detail).toContain("1 model without price hidden");
  });

  it("typing xai finds xAI Grok first; the count follows the filter", async () => {
    const p = open({}, { xai: true });
    await p.goTo("Speech model");
    await p.press("enter");
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

  it("Ctrl+S changes the order: name/desc, price/desc, provider/desc, newest; the choice is saved", async () => {
    const p = open();
    await p.goTo("Speech model");
    await p.press("enter");
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts", "hexgrad/kokoro-82m", "x-ai/grok-voice-tts-1.0"]);
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("name-desc");
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("price");
    expect(ids(p)).toEqual(["hexgrad/kokoro-82m", "x-ai/grok-voice-tts-1.0", "google/gemini-3.8-flash-tts"]);
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("price-desc");
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts", "x-ai/grok-voice-tts-1.0", "hexgrad/kokoro-82m"]);
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("provider");
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts", "hexgrad/kokoro-82m", "x-ai/grok-voice-tts-1.0"]);
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("provider-desc");
    expect(ids(p)).toEqual(["x-ai/grok-voice-tts-1.0", "hexgrad/kokoro-82m", "google/gemini-3.8-flash-tts"]);
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("newest");
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts", "x-ai/grok-voice-tts-1.0", "hexgrad/kokoro-82m"]);
    expect(settingsOf(p.work).modelSort).toBe("newest");
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("name");
    // the other model list follows the same order
    await p.press({ combo: "ctrl+s" }, "escape");
    await p.goTo("Transcription model");
    await p.press("enter");
    expect(p.panel.view().picker?.sort).toBe("name-desc");
  });

  it("refreshes provider models asynchronously whenever /speech opens", async () => {
    let calls = 0;
    const p = open(
      {},
      {
        before: (e) => {
          e.speech.models = async (opts) => {
            calls++;
            return {
              tts: opts?.refresh
                ? [
                    { id: "google/gemini-3.8-flash-tts", label: "Gemini", price: "~$0.03/min" },
                    { id: "openai:tts-1", label: "tts-1", price: "~$0.012/min" },
                  ]
                : [{ id: "google/gemini-3.8-flash-tts", label: "Gemini", price: "~$0.03/min" }],
              stt: [],
            };
          };
        },
      },
    );
    await p.panel.idle();
    expect(calls).toBeGreaterThanOrEqual(2);
    await p.goTo("Speech model");
    await p.press("enter");
    expect(ids(p)).toContain("openai:tts-1");
  });

  it("each model shows its features, and typing finds a model by one", async () => {
    const p = open();
    await p.goTo("Speech model");
    await p.press("enter");
    const items = p.panel.view().picker?.items ?? [];
    expect(items.map((i) => i.note)).toEqual(["tags · fast · 2 voices", "8 langs · 2 voices", "20+ langs · 2 voices"]);
    await p.type("tags");
    expect(ids(p)).toEqual(["google/gemini-3.8-flash-tts"]);
  });

  it("says what the catalog says about the highlighted model", async () => {
    const p = open();
    await p.goTo("Speech model");
    await p.press("enter");
    expect(p.panel.view().picker?.detail).toMatch(/^Gemini 3.8 Flash TTS/);
    await p.press("down");
    expect(p.panel.view().picker?.detail).toMatch(/^Kokoro 82M is a lightweight/);
    await p.press("down");
    expect(p.panel.view().picker?.detail).toBe("");
  });
});

describe("the panel view model: history, files, and the dictation language", () => {
  it("History… lists the spoken messages, the newest first; Enter replays one and the list stays", async () => {
    const p = open();
    await p.engine.speech.speak("first words");
    await p.engine.speech.speak("second words");
    await p.press({ combo: "ctrl+l" });
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

  it("h with nothing spoken says so", async () => {
    const p = open();
    await p.press({ combo: "ctrl+l" });
    expect(p.panel.view().picker).toMatchObject({ total: 0, empty: "Nothing spoken yet", items: [] });
    expect(p.hint()).toBe("Esc back");
  });

  it("t in the main view asks for an audio file under the list, puts the text into the editor and closes", async () => {
    const p = open();
    const audio = join(p.work, "note.wav");
    writeFileSync(audio, "RIFFfake");
    await p.press({ combo: "ctrl+t" });
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
    await p.press({ combo: "ctrl+t" });
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

  it("Dictation language inside Dictation options is saved, shown on Main, sent with a transcribed file, and removed with auto", async () => {
    const p = open();
    await p.goTo("Dictation options");
    await p.press("enter", "down");
    expect(p.selectedLabel()).toBe("Language");
    expect(p.hint()).toBe("Enter set · Esc Main");
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
    expect(p.row("Language")?.value).toBe("ja");
    expect(settingsOf(p.work).dictationLanguage).toBe("ja");
    await p.press("escape");
    expect(p.row("Dictation options")).toMatchObject({ value: "Filled", note: "ja" });
    const audio = join(p.work, "note.wav");
    writeFileSync(audio, "RIFFfake");
    await p.press({ combo: "ctrl+t" });
    await p.type(audio);
    await p.press("enter");
    expect(p.requests.at(-1)?.body).toMatchObject({ language: "ja" });
    await p.engine.speech.set("stt-language", "auto");
    expect(p.row("Dictation options")).toMatchObject({ value: "Filled", note: "auto" });
    expect(settingsOf(p.work).dictationLanguage).toBeUndefined();
  });

  it("Dictation options configures Typed/Filled output, Language, Submit word presets/User-defined, Vocabulary, and Voice commands via Pi editor", async () => {
    let lastEditor: { title: string; prefill?: string } | undefined;
    const editorReply = { value: undefined as string | undefined };
    const p = open();
    const ui = {
      ...p.ui,
      editor: async (title: string, prefill?: string) => {
        lastEditor = { title, prefill };
        return editorReply.value;
      },
    };
    const panel2 = new Panel(p.engine, new Surface(p.engine), { ui, close: p.close, changed: p.changed });
    panel2.open();
    const press2 = async (k: Parameters<Panel["handle"]>[0]) => {
      panel2.handle(k);
      await panel2.idle();
    };
    while (panel2.view().rows[panel2.view().selected]?.label !== "Dictation options") {
      await press2({ key: "down" });
    }
    await press2({ key: "enter" });
    expect(panel2.view().crumb).toBe("Dictation options");
    // While Transcription source is Provider, Output is locked on Filled with explanatory note.
    expect(panel2.view().rows[0]).toMatchObject({
      label: "Output",
      value: "Filled",
      note: "Typed requires Local transcription",
      disabled: true,
    });
    await press2({ key: "right" });
    expect(panel2.view().rows[0].value).toBe("Filled");
    expect(panel2.view().status?.text).toBe("Typed output requires Transcription source: Local");

    // Switch Transcription source to Local so Output unlocks and cycles Filled <-> Typed.
    p.engine.speech.setSource("transcription", "local");
    expect(panel2.view().rows.map((r) => [r.label, r.value])).toEqual([
      ["Output", "Filled"],
      ["Language", "auto"],
      ["Submit word", "Off"],
      ["Vocabulary", "Off"],
      ["Commands", "Off"],
    ]);
    await press2({ key: "right" });
    expect(panel2.view().rows[0]).toMatchObject({ label: "Output", value: "Typed" });
    expect(settingsOf(p.work).dictationLive).toBe(true);
    // Down past Language to Submit word: cycles Off -> Send it -> Submit -> User-defined -> Off.
    await press2({ key: "down" });
    expect(panel2.view().rows[panel2.view().selected]?.label).toBe("Language");
    await press2({ key: "down" });
    await press2({ text: " " });
    expect(panel2.view().rows[2]).toMatchObject({ label: "Submit word", value: "Send it" });
    expect(panel2.view().input).toBeUndefined();
    await press2({ text: " " });
    expect(panel2.view().rows[2]).toMatchObject({ label: "Submit word", value: "Submit" });
    expect(panel2.view().input).toBeUndefined();
    await press2({ text: " " });
    expect(panel2.view().rows[2]).toMatchObject({ label: "Submit word", value: "User-defined" });
    expect(panel2.view().input).toBeUndefined();
    await press2({ text: " " });
    expect(panel2.view().rows[2]).toMatchObject({ label: "Submit word", value: "Off" });
    await press2({ key: "left" });
    expect(panel2.view().rows[2]).toMatchObject({ label: "Submit word", value: "User-defined" });
    await press2({ key: "enter" });
    expect(panel2.view().input).toMatchObject({ label: "Submit word", value: "" });
    for (const c of "over") await press2({ text: c });
    await press2({ key: "enter" });
    expect(panel2.view().rows[2]).toMatchObject({ label: "Submit word", value: "User-defined", note: "over" });
    expect(settingsOf(p.work).dictationSubmitWord).toBe("over");
    editorReply.value = "# comment\nPi\nzelij, Zellij\n";
    await press2({ key: "down" });
    await press2({ key: "enter" });
    expect(lastEditor?.title).toBe("Dictation vocabulary");
    expect(lastEditor?.prefill).toContain("# Fix spelling and capitalization");
    expect(panel2.view().rows[3]).toMatchObject({ label: "Vocabulary", value: "2 terms" });
    expect(settingsOf(p.work).dictationVocabulary).toEqual(["Pi", "zelij, Zellij"]);
    editorReply.value = "# comment\n/compact\n";
    await press2({ key: "down" });
    await press2({ key: "enter" });
    expect(lastEditor?.title).toBe("Voice slash commands");
    expect(panel2.view().rows[4]).toMatchObject({ label: "Commands", value: "1 command" });
    expect(settingsOf(p.work).dictationCommands).toEqual(["/compact"]);
    await press2({ key: "escape" });
    expect(panel2.view().rows.find((r) => r.label === "Dictation options")).toMatchObject({
      value: "Typed",
      note: "auto",
    });
    // Switching back to Provider shows Filled on Main without erasing saved dictationLive.
    p.engine.speech.setSource("transcription", "provider");
    expect(panel2.view().rows.find((r) => r.label === "Dictation options")).toMatchObject({
      value: "Filled",
      note: "auto",
    });
    expect(settingsOf(p.work).dictationLive).toBe(true);
  });

  it("Space cycles every non-submenu setting across Main, Read aloud, Dictation, and Receivers", async () => {
    const p = open();
    // Main: Speech source, Transcription source, Spectrum OSD
    await p.goTo("Speech source");
    await p.press({ text: " " });
    expect(p.row("Speech source")?.value).toBe("Local");
    await p.press({ text: " " });
    expect(p.row("Speech source")?.value).toBe("Provider");

    await p.goTo("Transcription source");
    await p.press({ text: " " });
    expect(p.row("Transcription source")?.value).toBe("Local");

    await p.goTo("Spectrum OSD");
    await p.press({ text: " " });
    expect(p.row("Spectrum OSD")?.value).toBe("Helix");

    // Read aloud: rows 1..3 start muted while Read is Off, remain editable, and unmute once Read is Summarized
    await p.goTo("Read aloud options");
    await p.press({ text: " " });
    expect(p.panel.view().crumb).toBe("Read aloud options");
    expect(p.panel.view().rows.map((r) => Boolean(r.muted))).toEqual([false, true, true, true]);
    await p.press({ text: " " });
    expect(p.panel.view().rows[0].value).toBe("Summarized");
    expect(p.panel.view().rows.map((r) => Boolean(r.muted))).toEqual([false, false, false, false]);
    await p.press("down"); // Summarized by: Space opens picker
    await p.press({ text: " " });
    expect(p.panel.view().picker?.title).toBe("Summarized by");
    await p.press("escape", "down"); // Length
    await p.press({ text: " " });
    expect(p.panel.view().rows[2].value).toBe("Abridged ~30 s");
    await p.press("down"); // Truncate at
    await p.press({ text: " " });
    expect(p.panel.view().rows[3].value).toBe("15 s");
    await p.press("escape");

    // Dictation options (Transcription source is Local from above): Space enters submenu, cycles Output and Submit word
    await p.goTo("Dictation options");
    await p.press({ text: " " });
    expect(p.panel.view().crumb).toBe("Dictation options");
    await p.press({ text: " " });
    expect(p.panel.view().rows[0].value).toBe("Typed");
    await p.press("down", "down"); // past Language to Submit word
    await p.press({ text: " " });
    expect(p.panel.view().rows[2].value).toBe("Send it");
    await p.press({ text: " " });
    expect(p.panel.view().rows[2].value).toBe("Submit");
    await p.press("escape");

    // Receivers: Space enters submenu, Device (Local -> Connect)
    await p.goTo("Receivers");
    await p.press({ text: " " });
    expect(p.panel.view().crumb).toBe("Receivers");
    await p.press({ text: " " });
    expect(p.panel.view().input?.label).toBe("Connect to");
  });

  it("locks Voice on single-voice or unchosen-local models and locks Dictation language when local STT fixes or auto-detects it", async () => {
    const p = open();
    await p.panel.idle();
    // Local speech with no model chosen yet: Voice is locked without chevron or Enter choose hint.
    p.engine.speech.setSource("speech", "local");
    await p.goTo("Voice");
    expect(p.row("Voice")).toEqual({
      id: "voice",
      label: "Voice",
      value: "none",
      note: "choose a speech model",
      disabled: true,
    });
    expect(p.hint()).toBe(`${LETTER_HINTS} · Esc close`);
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.panel.view().status?.text).toBe("Choose a local speech model first: Speech model");

    // Provider model whose only voice is "default": Voice is locked as single voice, keeping Ctrl+P sample.
    p.engine.speech.setSource("speech", "provider");
    p.engine.speech.voicesFor = async () => ["default"];
    await p.engine.speech.set("tts-model", "hexgrad/kokoro-82m");
    p.panel.open();
    await p.panel.idle();
    await p.goTo("Voice");
    expect(p.row("Voice")).toEqual({
      id: "voice",
      label: "Voice",
      value: "default",
      note: "single voice",
      disabled: true,
    });
    expect(p.hint()).toBe(`Ctrl+P sample · F2 language · ${LETTER_HINTS} · Esc close`);
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.panel.view().status?.text).toBe("hexgrad/kokoro-82m has a single voice (Ctrl+P samples it)");

    // Local STT language modes: auto-detected (whisper-small), fixed (moonshine-base-ja-v2), selectable (canary-1b-v2).
    p.engine.speech.setSource("transcription", "local");
    p.engine.speech.settings.localTranscriptionModel = "whisper-small";
    await p.goTo("Dictation options");
    await p.press("enter", "down");
    expect(p.row("Language")).toEqual({
      id: "language",
      label: "Language",
      value: "auto",
      note: "detected by model",
      disabled: true,
    });
    expect(p.hint()).toBe("Esc Main");
    await p.press("enter");
    expect(p.panel.view().input).toBeUndefined();
    expect(p.panel.view().status?.text).toBe("whisper-small detects the spoken language automatically");

    p.engine.speech.settings.localTranscriptionModel = "moonshine-base-ja-v2";
    expect(p.row("Language")).toEqual({
      id: "language",
      label: "Language",
      value: "ja",
      note: "fixed by model",
      disabled: true,
    });

    p.engine.speech.settings.localTranscriptionModel = "canary-1b-v2";
    expect(p.row("Language")).toEqual({
      id: "language",
      label: "Language",
      value: "auto",
    });
    expect(p.hint()).toBe("Enter set · Esc Main");
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
    expect(picker?.sort).toBe("name");
    expect(picker?.items.map((i) => [i.label, i.price, i.cols?.[0]])).toEqual([
      ["parakeet-v3", "640 MB", "downloaded"],
      ["whisper-small", "639 MB", "not downloaded"],
    ]);
    expect(p.hint()).toBe("Enter pick · Ctrl+O download · Alt+O uninstall · Ctrl+S sort · Ctrl+T provider · Esc back");
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

  it("a download outlives the panel that started it: a panel opened meanwhile follows it and sees the end", async () => {
    const p = local();
    const gate = join(dirname(p.bin.path), "unpack.gate");
    writeFileSync(gate, "");
    p.engine.speech.setSource("transcription", "local");
    await p.goTo("Transcription model");
    await p.press("enter");
    p.panel.handle({ key: "down" });
    p.panel.handle({ key: "enter" });
    p.panel.handle({ key: "enter" });
    await vi.waitFor(() => expect(p.engine.downloads.get("whisper-small")?.progress?.phase).toBe("unpacking"));
    p.panel.dispose(); // closed while it unpacks

    const changed = vi.fn();
    const again = new Panel(p.engine, new Surface(p.engine), { ui: p.ui, close: vi.fn(), changed });
    again.open();
    expect(again.view().status?.text).toBe("… unpacking whisper-small");
    const label = () => again.view().rows[again.view().selected].label;
    for (let i = 0; i < 20 && label() !== "Transcription model"; i++) again.handle({ key: "down" });
    again.handle({ key: "enter" });
    await again.idle();
    const item = () => again.view().picker?.items.find((i) => i.id === "whisper-small");
    expect(item()?.cols?.[0]).toBe("unpacking");
    again.handle({ key: "down" });
    again.handle({ key: "enter" });
    expect(again.view().status?.text).toBe("whisper-small is still downloading; it can be chosen once it is done");
    expect(p.calls().filter((c) => c === "models download whisper-small")).toHaveLength(1);

    rmSync(gate);
    await vi.waitFor(() => expect(item()?.cols?.[0]).toBe("downloaded"));
    expect(again.view().status?.text).toBe("✓ whisper-small downloaded · Transcription model: whisper-small (local)");
    expect(settingsOf(p.work).localTranscriptionModel).toBe("whisper-small");
    expect(changed).toHaveBeenCalled();
  });

  it("in an open picker a model goes not downloaded → unpacking → downloaded and Enter selects it there", async () => {
    const p = local();
    const gate = join(dirname(p.bin.path), "unpack.gate");
    writeFileSync(gate, "");
    p.engine.speech.setSource("transcription", "local");
    await p.goTo("Transcription model");
    await p.press("enter");
    const item = () => p.panel.view().picker?.items.find((i) => i.id === "whisper-small");
    expect(item()?.cols?.[0]).toBe("not downloaded");
    p.panel.handle({ key: "down" });
    p.panel.handle({ combo: "ctrl+o" });
    await vi.waitFor(() => expect(item()?.cols?.[0]).toBe("unpacking"));
    expect(p.panel.view().picker).toBeDefined();
    // A second model's download starts and reaches unpacking while the first is still there.
    const other = p.engine.downloads.start({ id: "kokoro", size: 100 });
    await vi.waitFor(() => expect(p.engine.downloads.get("kokoro")?.progress?.phase).toBe("unpacking"));
    expect(p.engine.downloads.active.size).toBe(2);
    rmSync(gate);
    await vi.waitFor(() => expect(item()?.cols?.[0]).toBe("downloaded"));
    await expect(other).resolves.toMatchObject({ status: "done", id: "kokoro" });
    // Still in the same picker: Enter selects the now-downloaded model.
    expect(p.panel.view().picker).toBeDefined();
    await p.press("enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.row("Transcription model")?.value).toBe("whisper-small");
    expect(settingsOf(p.work).localTranscriptionModel).toBe("whisper-small");
  });

  it("in the list Ctrl+O downloads and Alt+O (twice) uninstalls the highlighted model; Ctrl+T toggles local and provider lists", async () => {
    const p = local();
    p.engine.speech.setSource("transcription", "local");
    await p.goTo("Transcription model");
    await p.press("enter");
    await p.press("down");
    await p.press({ combo: "ctrl+o" });
    expect(p.panel.view().status?.text).toBe("✓ whisper-small downloaded");
    expect(p.panel.view().picker?.items.find((i) => i.id === "whisper-small")?.cols?.[0]).toBe("downloaded");
    await p.press({ combo: "alt+o" });
    expect(p.panel.view().status?.text).toBe("! Alt+O again uninstalls whisper-small (639 MB)");
    expect(p.calls()).not.toContain("models delete whisper-small");
    await p.press({ combo: "alt+o" });
    expect(p.panel.view().status?.text).toBe("✓ whisper-small deleted · 1.2 KB freed");
    expect(p.panel.view().picker?.items.find((i) => i.id === "whisper-small")?.cols?.[0]).toBe("not downloaded");
    await p.press({ combo: "alt+o" });
    expect(p.panel.view().status?.text).toBe("whisper-small is not downloaded");
    // Ctrl+T toggles between local and provider lists in place.
    await p.press({ combo: "ctrl+t" });
    expect(p.panel.view().status?.text).toBe("✓ Transcription source: Provider");
    expect(p.hint()).toBe("Enter pick · Ctrl+S sort · Ctrl+T local · type to filter · Esc back");
    expect(p.panel.view().picker?.items.some((i) => i.id === "openai/whisper-large-v3-turbo")).toBe(true);
    await p.press({ combo: "ctrl+t" });
    expect(p.panel.view().status?.text).toBe("✓ Transcription source: Local");
    expect(p.hint()).toBe("Enter pick · Ctrl+O download · Alt+O uninstall · Ctrl+S sort · Ctrl+T provider · Esc back");
    // Also works in the Speech model tab.
    await p.press("escape");
    await p.press("tab", "tab");
    expect(p.panel.view().tab).toBe("speechModel");
    expect(p.hint()).toBe("Enter pick · Ctrl+S sort · Ctrl+T local · type to filter · Esc back");
    await p.press({ combo: "ctrl+t" });
    expect(p.panel.view().status?.text).toBe("✓ Speech source: Local");
    expect(p.hint()).toBe("Enter pick · Ctrl+O download · Alt+O uninstall · Ctrl+S sort · Ctrl+T provider · Esc back");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual(["kokoro"]);
    await p.press({ combo: "ctrl+t" });
    expect(p.panel.view().status?.text).toBe("✓ Speech source: Provider");
    // Return to local transcription for the filter check below.
    await p.press("tab", "tab");
    expect(p.panel.view().tab).toBe("transcription");
    // Other letters still filter.
    await p.type("par");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual(["parakeet-v3"]);
  });

  it("Local speech lists the on-device speech models; with none chosen, speaking says to choose one", async () => {
    const p = local();
    await p.goTo("Speech source");
    await p.press("right");
    await p.goTo("Speech model");
    expect(p.row("Speech model")).toMatchObject({ value: "none", note: "✗ choose a model", alert: true });
    await p.press("enter");
    expect(p.panel.view().picker?.items.map((i) => [i.id, i.cols?.[0]])).toEqual([["kokoro", "not downloaded"]]);
    await p.press("escape");
    await p.goTo("Hotkeys");
    await p.press("enter", "enter");
    await p.type("hello");
    await p.press("enter");
    expect(p.panel.view().status?.text).toBe("✗ Choose a local speech model first: /speech, Speech model");
    expect(p.requests.filter((r) => r.url.endsWith("/audio/speech"))).toEqual([]);
  });

  it("with Speech source Local the Voice row picks a voice the binary lists for the local model", async () => {
    const p = local();
    await p.engine.speech.local.download("kokoro").result;
    p.engine.speech.setSource("speech", "local");
    await p.goTo("Speech model");
    await p.press("enter");
    await p.press("enter");
    expect(p.panel.view().status?.text).toBe("✓ Speech model: kokoro (local)");
    expect(p.row("Speech model")?.note).toBeUndefined();
    await p.goTo("Voice");
    expect(p.row("Voice")).toMatchObject({ value: "default" });
    expect(p.row("Voice")?.note).toBeUndefined();
    await p.press("enter");
    const picker = p.panel.view().picker;
    expect(picker).toMatchObject({ title: "Voice", noun: "voices", total: 3, loading: false });
    expect(picker?.items.map((i) => [i.id, i.cols?.[0], i.current])).toEqual([
      ["af_alloy", "default", true],
      ["af_sol", "", false],
      ["bm_lewis", "", false],
    ]);
    expect(p.calls()).toContain("speak kokoro --list-voices");
    // A local voice has no language to set.
    expect(p.hint()).not.toMatch(/F2/);
    await p.press("down", "enter");
    expect(p.panel.view().picker).toBeUndefined();
    expect(p.row("Voice")?.value).toBe("af_sol");
    expect(p.panel.view().status?.text).toBe("✓ Voice: af_sol (local)");
    expect(settingsOf(p.work)).toMatchObject({ localSpeechVoice: "af_sol" });
    // The provider voice is kept for Provider.
    expect(settingsOf(p.work).voice).toBe("Kore");
  });

  it("groups single-voice Piper English models under piper-en and picks/downloads voices in Voice", async () => {
    const p = local();
    // Stand-in binary with two single-voice Piper entries + one multi-speaker Piper entry.
    const binPath = p.bin.path;
    writeFileSync(
      binPath,
      readFileSync(binPath, "utf8").replace(
        '{ id: "kokoro", kind: "speech", name: "Kokoro", languages: ["en"], size: 100000000 }',
        `{ id: "kokoro", kind: "speech", name: "Kokoro", languages: ["en"], size: 100000000 },
  { id: "piper-en_US-lessac-high", kind: "speech", name: "Piper lessac high", languages: ["en"], size: 115000000 },
  { id: "piper-en_GB-alba-medium", kind: "speech", name: "Piper alba", languages: ["en"], size: 67000000 },
  { id: "piper-en_GB-vctk-medium", kind: "speech", name: "Piper VCTK (109 British)", languages: ["en"], size: 80000000 }`,
      ),
    );
    p.engine.speech.setSource("speech", "local");
    await p.goTo("Speech model");
    await p.press("enter");
    const modelIds = p.panel.view().picker?.items.map((i) => i.id);
    expect(modelIds).toContain("piper-en");
    expect(modelIds).not.toContain("piper-en_GB-vctk-medium");
    expect(modelIds).not.toContain("piper-en_US-lessac-high");
    expect(modelIds).not.toContain("piper-en_GB-alba-medium");

    // Alphabetically: kokoro -> piper-en; moving down onto piper-en opens the Voice picker for piper-en without persisting synthetic "piper-en".
    await p.press("down", "enter");
    expect(p.panel.view().tab).toBe("voice");
    expect(settingsOf(p.work).localSpeechModel).toBeUndefined();
    expect(p.panel.view().picker?.items.map((i) => [i.id, i.label, i.cols?.[0]])).toEqual([
      ["piper-en_GB-alba-medium", "alba-medium (UK)", "not downloaded"],
      ["piper-en_US-lessac-high", "lessac-high (US)", "not downloaded"],
      ["piper-en_GB-vctk-medium", "vctk-medium (UK, 109 voices)", "not downloaded"],
    ]);
    // Enter twice downloads and selects alba-medium (UK) (now first alphabetically).
    await p.press("enter");
    expect(p.panel.view().status?.text).toMatch(/alba-medium \(UK\) is not downloaded.*Enter downloads it/);
    await p.press("enter");
    expect(p.row("Speech model")?.value).toBe("piper-en");
    expect(p.row("Voice")?.value).toBe("alba-medium (UK)");
    expect(settingsOf(p.work).localSpeechModel).toBe("piper-en_GB-alba-medium");
  });

  it("sorts local speech models alphabetically by default and cycles name/desc, recommended, size/desc, state/desc via Ctrl+S", async () => {
    const p = local();
    const binPath = p.bin.path;
    writeFileSync(
      binPath,
      readFileSync(binPath, "utf8").replace(
        '{ id: "kokoro", kind: "speech", name: "Kokoro", languages: ["en"], size: 100000000 }',
        `{ id: "orpheus-3b-q4", kind: "speech", name: "Orpheus 3B", languages: ["en"], size: 2140000000 },
  { id: "kokoro-multi-lang-v1.1", kind: "speech", name: "Kokoro 1.1", languages: ["en"], size: 365000000 },
  { id: "phonon-31m-en", kind: "speech", name: "Phonon 31M", languages: ["en"], size: 68000000 }`,
      ),
    );
    p.engine.speech.setSource("speech", "local");
    await p.goTo("Speech model");
    await p.press("enter");
    // Default is alphabetical (name).
    expect(p.panel.view().picker?.sort).toBe("name");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual([
      "kokoro-multi-lang-v1.1",
      "orpheus-3b-q4",
      "phonon-31m-en",
    ]);
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("name-desc");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual([
      "phonon-31m-en",
      "orpheus-3b-q4",
      "kokoro-multi-lang-v1.1",
    ]);
    // Download phonon-31m-en (highlighted at index 0) so it stays pinned at top in recommended even on GPU.
    await p.press({ combo: "ctrl+o" });
    expect(p.panel.view().picker?.items[0].cols?.[0]).toBe("downloaded");
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("recommended");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual([
      "phonon-31m-en",
      "kokoro-multi-lang-v1.1",
      "orpheus-3b-q4",
    ]);
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("size");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual([
      "phonon-31m-en",
      "kokoro-multi-lang-v1.1",
      "orpheus-3b-q4",
    ]);
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("size-desc");
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual([
      "orpheus-3b-q4",
      "kokoro-multi-lang-v1.1",
      "phonon-31m-en",
    ]);
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("state");
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("state-desc");
    expect(settingsOf(p.work).localModelSort).toBe("state-desc");
    await p.press({ combo: "ctrl+s" });
    expect(p.panel.view().picker?.sort).toBe("name");

    // On GPU device, recommended promotes orpheus-3b-q4 above kokoro (behind downloaded phonon-31m-en).
    await p.press({ combo: "ctrl+s" }, { combo: "ctrl+s" }); // recommended
    p.engine.speech.settings.localDevice = "gpu";
    expect(p.panel.view().picker?.items.map((i) => i.id)).toEqual([
      "phonon-31m-en",
      "orpheus-3b-q4",
      "kokoro-multi-lang-v1.1",
    ]);
  });
});

describe("tab navigation", () => {
  it("visits seven tabs in both directions, wraps, and Esc returns home then closes", async () => {
    const p = open();
    const tabs = ["main", "readAloud", "speechModel", "voice", "transcription", "hotkeys", "bridge"];
    expect(p.panel.view().tabs.map((t) => t.label)).toEqual([
      "Main",
      "Read aloud",
      "Speech model",
      "Voice",
      "Transcription model",
      "Hotkeys",
      "Receivers",
    ]);
    expect(p.panel.view().rows).toHaveLength(10);
    expect(p.panel.view().rows.some((r) => r.id === "hotkeys")).toBe(true);
    for (const tab of [...tabs.slice(1), "main"]) {
      await p.press("tab");
      expect(p.panel.view().tab).toBe(tab);
    }
    for (const tab of [...tabs.slice(1).reverse(), "main"]) {
      await p.press("backtab");
      expect(p.panel.view().tab).toBe(tab);
    }
    await p.press("tab", "escape");
    expect(p.panel.view().tab).toBe("main");
    await p.press("escape");
    expect(p.close).toHaveBeenCalledOnce();
  });
  it("typing on any Main row, including paste, goes to Speak", async () => {
    const p = open();
    await p.goTo("Voice");
    await p.press({ text: "rhst", paste: true });
    expect(p.panel.view().speak).toMatchObject({ focused: true, value: "rhst" });
    expect(p.panel.view().picker).toBeUndefined();
  });
  it("uses Ctrl+O on Main for replay", async () => {
    const p = open();
    await p.press({ combo: "ctrl+o" });
    expect(p.panel.view().status?.text).toMatch(/nothing|no message/i);
  });
});
