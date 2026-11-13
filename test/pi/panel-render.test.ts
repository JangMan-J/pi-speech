import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Hint, PanelRow, PanelView, PickerItem, PickerView } from "../../src/engine/panel";
import { type PanelStyle, PLAIN, renderPanel } from "../../src/pi/panel-render";

/** The main view as in the agreed mockup. */
const rows: PanelRow[] = [
  { id: "readAloud", section: "speak", label: "Read aloud options", value: "Off" },
  { id: "speechSource", section: "speak", label: "Speech source", value: "Provider" },
  { id: "speechModel", section: "speak", label: "Speech model", value: "x-ai/grok-voice-tts-1.0", opens: true },
  { id: "voice", section: "speak", label: "Voice", value: "eve", opens: true },
  { id: "transcriptionSource", section: "listen", label: "Transcription source", value: "Provider" },
  {
    id: "transcription",
    section: "listen",
    label: "Transcription model",
    value: "openai/whisper-large-v3-turbo",
    opens: true,
  },
  { id: "language", section: "listen", label: "Dictation language", value: "auto" },
  { id: "output", section: "listen", label: "Dictation output", value: "Pi", opens: true },
  { id: "hotkeys", section: "settings", label: "Hotkeys", opens: true },
  { id: "bridge", section: "settings", label: "Bridge connection", opens: true },
];
const LABELS = rows.map((r) => r.label);
/** Where rows are in `rows`, for `selected`. */
const at = (id: PanelRow["id"]) => rows.findIndex((r) => r.id === id);

const HEADINGS = { speak: "SPEAK (Alt+S)", listen: "LISTEN (Alt+Z)", settings: "SETTINGS" };

function view(over: Partial<PanelView> = {}): PanelView {
  return {
    title: "Speech",
    state: "",
    menu: "main",
    headings: HEADINGS,
    rows,
    selected: 0,
    hints: [
      { key: "←→", action: "Off · All" },
      { key: "Esc", action: "close" },
    ],
    ...over,
  };
}

const hotkeyRows: PanelRow[] = [
  { id: "speak", label: "Speak…", value: "Alt+S" },
  { id: "dictate", label: "Dictate", value: "Alt+Z" },
  { id: "replay", label: "Replay last", value: "r" },
  { id: "history", label: "History…", value: "h" },
  { id: "stop", label: "Stop", value: "s" },
  { id: "transcribe", label: "Transcribe file…", value: "t" },
];

function hotkeys(over: Partial<PanelView> = {}): PanelView {
  return {
    title: "Speech",
    state: "",
    menu: "hotkeys",
    crumb: "Hotkeys",
    rows: hotkeyRows,
    selected: 0,
    hints: [
      { key: "Enter", action: "run" },
      { key: "k", action: "change key" },
      { key: "Esc", action: "back" },
    ],
    ...over,
  };
}

const bridge = (note: string, alert = false): PanelView => ({
  title: "Speech",
  state: "",
  menu: "bridge",
  crumb: "Bridge connection",
  rows: [{ id: "bridgeMode", label: "Bridge", value: "auto", note, short: "✗ receiver unreachable", alert }],
  selected: 0,
  hints: [
    { key: "←→", action: "auto · on · off" },
    { key: "Esc", action: "back" },
  ],
});

const VOICE_HINTS: Hint[] = [
  { key: "Enter", action: "pick" },
  { key: "Tab", action: "sample", optional: true },
  { key: "F2", action: "language", optional: true },
  { key: "type", action: "to filter" },
  { key: "Esc", action: "back" },
];

/** The row starting with `label` (after the marker). */
const row = (lines: string[], label: string) => lines.find((l) => l.replace(/^[\s▸>]+/, "").startsWith(label));
const widest = (lines: string[]) => Math.max(...lines.map((l) => visibleWidth(l)));
const hintLine = (lines: string[]) => [...lines].reverse().find((l) => /Esc/.test(l)) ?? "";

/** Styles as escape codes (zero width, like real ones) that `tags` turns into visible tags. */
const CODES: Record<string, [number, number]> = {
  a: [90, 91],
  b: [92, 93],
  d: [94, 95],
  s: [96, 97],
  e: [100, 101],
  w: [102, 103],
  c: [104, 105],
};
const wrap = (tag: string) => (t: string) => `\x1b[${CODES[tag][0]}m${t}\x1b[${CODES[tag][1]}m`;
const TAGS: PanelStyle = {
  accent: wrap("a"),
  bold: wrap("b"),
  dim: wrap("d"),
  success: wrap("s"),
  error: wrap("e"),
  warning: wrap("w"),
  cursor: wrap("c"),
  selected: wrap("c"),
};
/** Escape codes of TAGS as <a>…</a>. */
const tags = (l: string) =>
  Object.entries(CODES).reduce(
    (out, [tag, [open, close]]) =>
      out.split(`\x1b[${open}m`).join(`<${tag}>`).split(`\x1b[${close}m`).join(`</${tag}>`),
    l,
  );
const untag = (l: string) => l.replace(/<\/?[a-z]>/g, "");
const styled = (v: PanelView, w: number) => renderPanel(v, w, TAGS).map(tags);

/** The agreed main view, the first row selected. */
const MOCKUP = [
  "SPEAK (Alt+S)",
  "  ▸ Read aloud options   Off",
  "    Speech source        Provider",
  "    Speech model         x-ai/grok-voice-tts-1.0 ›",
  "    Voice                eve ›",
  "LISTEN (Alt+Z)",
  "    Transcription source Provider",
  "    Transcription model  openai/whisper-large-v3-turbo ›",
  "    Dictation language   auto",
  "    Dictation output     Pi ›",
  "SETTINGS",
  "    Hotkeys ›",
  "    Bridge connection ›",
];

const HOTKEYS_MOCKUP = [
  "  ▸ Speak…             Alt+S",
  "    Dictate            Alt+Z",
  "    Replay last        r",
  "    History…           h",
  "    Stop               s",
  "    Transcribe file…   t",
];

describe("drawing the main view", () => {
  it("draws the agreed mockup: headings with their keys, one label column, only current values, › where a row opens", () => {
    for (const w of [96, 80, 60]) {
      const lines = renderPanel(view(), w);
      expect(lines[0]).toMatch(new RegExp(`^Speech ─{${w - 7}}$`));
      expect(lines.slice(1, 1 + MOCKUP.length)).toEqual(MOCKUP);
      expect(lines.slice(1 + MOCKUP.length)).toEqual(["", "", "  ←→ Off · All · Esc close", "─".repeat(w)]);
    }
  });

  it("never wider than 96 columns, whatever the terminal", () => {
    const lines = renderPanel(view(), 160);
    expect(widest(lines)).toBe(96);
    expect(lines.slice(1, 1 + MOCKUP.length)).toEqual(MOCKUP);
  });

  it("narrower, a long value is cut with … and keeps its ›; the labels stay", () => {
    const lines = renderPanel(view({ selected: at("transcription") }), 45);
    expect(widest(lines)).toBeLessThanOrEqual(45);
    for (const l of LABELS) expect(row(lines, l), l).toBeDefined();
    expect(row(lines, "Transcription model")).toMatch(/openai\/whisper.*… ›$/);
    expect(row(lines, "Voice")).toMatch(/Voice\s+eve ›$/);
  });

  it("a note says what is wrong; when it does not fit, its short form, then only the ✗", () => {
    const alerting = rows.map((r) =>
      r.id === "speechModel" ? { ...r, note: "✗ xAI: no login", short: "✗ no login", alert: true } : r,
    );
    expect(row(renderPanel(view({ rows: alerting }), 80), "Speech model")).toMatch(
      /x-ai\/grok-voice-tts-1\.0 · ✗ xAI: no login ›$/,
    );
    expect(row(renderPanel(view({ rows: alerting }), 64), "Speech model")).toMatch(/1\.0 · ✗ no login ›$/);
    expect(row(renderPanel(view({ rows: alerting }), 52), "Speech model")).toMatch(/1\.0 ✗ ›$/);
  });

  it("below 40 columns shows one line instead of a broken layout", () => {
    const lines = renderPanel(view(), 39);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/narrow|widen/);
    expect(widest(renderPanel(view(), 12))).toBeLessThanOrEqual(12);
  });

  it("never draws a line wider than the terminal, at any width, in any state", () => {
    const longRows = rows.map((r) =>
      r.id === "speechModel" ? { ...r, value: "some-provider/a-very-long-speech-model-name-that-goes-on-and-on" } : r,
    );
    const items: PickerItem[] = Array.from({ length: 30 }, (_, i) => ({
      id: `vendor/model-with-a-long-name-${i}`,
      label: `vendor/model-with-a-long-name-${i}`,
      price: `~$0.0${i}/min`,
      note: "OpenRouter",
      current: i === 2,
    }));
    const picker = pickerView({ items, total: 30, selected: 14, title: "Speech model", sort: "price", show: "all" });
    for (let w = 1; w <= 170; w++) {
      for (const v of [
        view(),
        view({ rows: longRows, state: "● REC 12:34" }),
        view({ picker, hints: VOICE_HINTS }),
        view({
          input: { label: "Spoken language", value: "x".repeat(200), cursor: 100, placeholder: "", under: "language" },
        }),
        view({ status: { tone: "error", text: `✗ ${"very long reason ".repeat(10)}` } }),
        hotkeys(),
        hotkeys({
          rows: hotkeyRows.map((r) => (r.id === "speak" ? { ...r, value: "Ctrl+Alt+Shift+D" } : r)),
        }),
        bridge("on over SSH · plays on the Remote machine · ✗ receiver unreachable", true),
      ]) {
        expect(widest(renderPanel(v, w)), `width ${w}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it("on a short terminal gives up the blank lines, the rule and the headings, then shows one line", () => {
    const full = renderPanel(view(), 84);
    expect(renderPanel(view(), 84, PLAIN, 40)).toEqual(full);
    for (const h of [16, 14, 13]) {
      const lines = renderPanel(view({ status: { tone: "success", text: "✓ Read aloud: All" } }), 84, PLAIN, h);
      expect(lines.length, `height ${h}`).toBeLessThanOrEqual(h);
      expect(lines[0]).toMatch(/^Speech/);
      expect(hintLine(lines)).toMatch(/Esc close$/);
      for (const l of LABELS) expect(row(lines, l), `${l} at ${h}`).toBeDefined();
      expect(lines.some((l) => l.includes("✓ Read aloud: All"))).toBe(true);
    }
    expect(renderPanel(view(), 84, PLAIN, 13)).not.toContain("SETTINGS");
    const tiny = renderPanel(view(), 84, PLAIN, 9);
    expect(tiny).toHaveLength(1);
    expect(tiny[0]).toMatch(/too small/);
  });

  it("the header shows what is happening on the right, the recording dot in the error colour", () => {
    expect(renderPanel(view({ state: "▶ speaking" }), 84)[0]).toMatch(/^Speech ─{60,} ▶ speaking$/);
    expect(renderPanel(view({ state: "▶ speaking" }), 84)[0]).toHaveLength(84);
    expect(renderPanel(view({ state: "● REC 0:07" }), 50)[0]).toMatch(/● REC 0:07$/);
    expect(renderPanel(view({ state: "… transcribing" }), 60)[0]).toMatch(/… transcribing$/);
    const rec = styled(view({ state: "● REC 0:07" }), 84)[0];
    expect(rec).toContain("<e>●</e> REC 0:07");
  });

  it("the status line shows errors and successes with their symbol, under the rows, after a blank line", () => {
    const lines = renderPanel(
      view({ status: { tone: "error", text: "✗ xAI: no login. Log in to xAI in Pi (/login)" } }),
      84,
    );
    const si = lines.findIndex((l) => l.includes("✗ xAI: no login"));
    expect(si).toBeGreaterThan(lines.indexOf(row(lines, "Bridge connection") ?? ""));
    expect(lines[si - 1]).toBe("");
    const ok = styled(view({ status: { tone: "success", text: "✓ Spoken" } }), 84);
    expect(ok.some((l) => l.includes("<s>✓ Spoken</s>"))).toBe(true);
  });
});

describe("drawing a submenu", () => {
  it("Hotkeys as agreed: the title in the header, each action with its key, the hints", () => {
    for (const w of [96, 80]) {
      const lines = renderPanel(hotkeys(), w);
      expect(lines[0]).toMatch(/^Speech › Hotkeys ─+$/);
      expect(lines.slice(1, 7)).toEqual(HOTKEYS_MOCKUP);
      expect(lines.slice(7)).toEqual(["", "", "  Enter run · k change key · Esc back", "─".repeat(w)]);
    }
  });

  it("a changed key shows as the row's value, with nothing beside it", () => {
    const changed = hotkeyRows.map((r) => (r.id === "speak" ? { ...r, value: "Alt+D" } : r));
    expect(row(renderPanel(hotkeys({ rows: changed }), 80), "Speak…")).toBe("  ▸ Speak…             Alt+D");
  });

  it("the input of Transcribe file… is drawn under its row", () => {
    const input = { label: "Audio file", value: "", cursor: 0, placeholder: "wav, mp3", under: "transcribe" as const };
    const lines = renderPanel(hotkeys({ input, selected: 5 }), 80);
    const i = lines.indexOf(row(lines, "Transcribe file…") ?? "");
    expect(lines[i + 1]).toMatch(/^ {6}Audio file\s+wav, mp3$/);
  });

  it("Bridge connection: the mode and where audio plays; the note gives way to its short form", () => {
    const note = "on over SSH · plays on the Remote machine · ✗ receiver unreachable";
    let lines = renderPanel(bridge(note, true), 96);
    expect(lines[0]).toMatch(/^Speech › Bridge connection ─+$/);
    expect(lines[1]).toBe(`  ▸ Bridge             auto · ${note}`);
    lines = renderPanel(bridge(note, true), 60);
    expect(lines[1]).toBe("  ▸ Bridge             auto · ✗ receiver unreachable");
  });
});

describe("emphasis", () => {
  it("the title is accent and bold; headings and labels dim, values normal; the selected line bold and marked ▸", () => {
    const lines = styled(view({ selected: at("voice") }), 96);
    expect(lines[0]).toMatch(/^<a><b>Speech<\/b><\/a> <d>─+<\/d>$/);
    expect(lines).toContain("<d>SPEAK (Alt+S)</d>");
    const voice = lines.find((l) => untag(l).includes("Voice")) ?? "";
    expect(voice).toContain("<c>");
    expect(voice).toContain("<a>▸ </a>");
    expect(voice).toContain("<b>Voice");
    expect(voice).toContain("<b>eve");
    expect(voice).toContain("<d> ›</d>");
    const model = lines.find((l) => untag(l).includes("Speech model")) ?? "";
    expect(model).toContain("<d>Speech model");
    expect(model).not.toMatch(/<[bd]>x-ai/);
    const hk = lines.find((l) => untag(l).includes("Hotkeys")) ?? "";
    expect(hk).toBe("    <d>Hotkeys</d><d> ›</d>");
  });

  it("an alert note is in the error colour", () => {
    const alerting = rows.map((r) => (r.id === "voice" ? { ...r, note: "✗ voices unavailable", alert: true } : r));
    const voice = styled(view({ rows: alerting }), 96).find((l) => untag(l).includes("Voice")) ?? "";
    expect(voice).toContain("<e> · ✗ voices unavailable</e>");
  });

  it("plain: no escape codes, the selection still marked ▸", () => {
    const plain = renderPanel(view({ selected: at("voice") }), 84).join("\n");
    expect(plain.includes("\x1b")).toBe(false);
    expect(row(plain.split("\n"), "Voice")).toMatch(/^ {2}▸ Voice/);
  });
});

describe("drawing an input", () => {
  it("draws the language input under its row; the rest of the rows stay", () => {
    const input = {
      label: "Spoken language",
      value: "",
      cursor: 0,
      placeholder: "a tag such as ja or pt-BR, or auto",
      under: "language" as const,
    };
    const lines = renderPanel(view({ input, selected: at("language") }), 84);
    const i = lines.indexOf(row(lines, "Dictation language") ?? "");
    expect(lines[i + 1]).toMatch(/Spoken language\s+a tag such as ja/);
    expect(row(lines, "Bridge connection")).toBeDefined();
  });

  it("an input that belongs to no row is drawn under the rows", () => {
    const input = { label: "Audio file", value: "", cursor: 0, placeholder: "wav, mp3" };
    const lines = renderPanel(view({ input }), 84);
    expect(lines.findIndex((l) => /Audio file/.test(l))).toBeGreaterThan(
      lines.indexOf(row(lines, "Bridge connection") ?? ""),
    );
  });

  it("scrolls long text to keep the cursor in view", () => {
    const value = `${"x".repeat(100)}END`;
    const lines = renderPanel(view({ input: { label: "", value, cursor: 103, placeholder: "" } }), 50);
    expect(lines.some((l) => l.includes("END"))).toBe(true);
    expect(widest(lines)).toBeLessThanOrEqual(50);
  });

  it("the speak composer hides the rows", () => {
    const input = { label: "", value: "", cursor: 0, placeholder: "type a message" };
    const lines = renderPanel(view({ title: "Speak", composer: true, input }), 80);
    expect(lines[0]).toMatch(/^Speak ─+$/);
    expect(row(lines, "Voice")).toBeUndefined();
    expect(lines.some((l) => /type a message/.test(l))).toBe(true);
  });
});

function pickerView(over: Partial<PickerView> = {}): PickerView {
  return {
    title: "Voice",
    noun: "voices",
    query: "",
    cursor: 0,
    items: [
      { id: "Kore", label: "Kore", note: "multilingual · documented", current: true },
      { id: "Puck", label: "Puck", note: "multilingual · documented", current: false },
    ],
    selected: 1,
    total: 2,
    loading: false,
    empty: "No matches",
    ...over,
  };
}

/** 39 models by price, as the catalog of the checks has them, xAI Grok last. */
const MODELS: PickerItem[] = [
  ...Array.from({ length: 38 }, (_, i) => ({
    id: `vendor-${i}/speech-model-${i}`,
    label: `vendor-${i}/speech-model-${i}`,
    price: `${i % 2 ? "~" : ""}$0.0${10 + i}/min`,
    note: i % 3 ? "20+ langs · 5 voices" : "tags · fast · 21 voices",
    current: i === 12,
  })),
  { id: "xai", label: "xAI Grok", price: "price unknown", note: "xAI login", current: false },
];

describe("drawing the picker", () => {
  it("replaces the list: the title, Find: and the count, the current choice ✓, the selection ▸", () => {
    const lines = renderPanel(view({ picker: pickerView(), hints: VOICE_HINTS }), 84);
    expect(lines[0]).toMatch(/^Speech › Voice ─+$/);
    const find = lines.find((l) => /Find:/.test(l)) ?? "";
    expect(find).toMatch(/^\s*Find: .*\s2 voices$/);
    expect(lines.find((l) => l.includes("Kore"))).toMatch(/✓ Kore {2}multilingual · documented/);
    expect(lines.find((l) => l.includes("Puck"))).toMatch(/^▸ {3}Puck {2}multilingual · documented/);
    expect(lines.some((l) => l.includes("Speech model"))).toBe(false);
    expect(hintLine(lines).trim()).toBe("Enter pick · Tab sample · F2 language · type to filter · Esc back");
  });

  it("a model list says how it is ordered and what it shows, and counts the matches while filtering", () => {
    const p = pickerView({
      title: "Speech model",
      sort: "price",
      show: "all",
      noun: "models",
      items: MODELS,
      total: 39,
      selected: 0,
    });
    const find = (v: PickerView, w = 110) => renderPanel(view({ picker: v }), w).find((l) => /Find:/.test(l)) ?? "";
    expect(renderPanel(view({ picker: p }), 110)[0]).toMatch(/^Speech › Speech model ─+$/);
    expect(find(p)).toMatch(/^Find: \s+sort price · show all {3}39 models$/);
    expect(find(p)).toHaveLength(96);
    expect(find({ ...p, query: "vendor-1", cursor: 8, items: MODELS.slice(10, 16) })).toMatch(
      /^Find: vendor-1\s+sort price · show all {3}6 of 39 models$/,
    );
    // a feature filter narrows the list like a query does
    expect(find({ ...p, sort: "provider", show: "tags", items: MODELS.slice(0, 13) })).toMatch(
      /sort provider · show tags {3}13 of 39 models$/,
    );
    // on a narrow panel the order gives way; the count stays
    expect(find(p, 44)).toMatch(/^Find: \s+39 models$/);
    // the values are plain, their names dim
    const styledFind = styled(view({ picker: p }), 110).find((l) => /Find:/.test(untag(l))) ?? "";
    expect(styledFind).toContain("<d>sort</d> price <d>· show</d> all");
  });

  it("under a model list: what the catalog says about the highlighted model, cut to the width", () => {
    const detail =
      "Eleven v4 Turbo is a low-latency text-to-speech model from ElevenLabs. It keeps Eleven v4's audio tags.";
    const p = pickerView({
      title: "Speech model",
      sort: "price",
      show: "all",
      noun: "models",
      items: MODELS,
      total: 39,
    });
    const lines = renderPanel(view({ picker: { ...p, detail, selected: 0 } }), 110);
    const foot = lines.find((l) => l.startsWith("Eleven v4 Turbo")) ?? "";
    expect(foot).toMatch(/^Eleven v4 Turbo is a low-latency .*… {2,}1–8 of 39 ↓$/);
    expect(foot).toHaveLength(96);
    // a model the catalog says nothing about keeps the line, so the dock does not jump
    const three = MODELS.slice(0, 3);
    const short = pickerView({
      title: "Speech model",
      sort: "price",
      show: "all",
      noun: "models",
      items: three,
      total: 3,
    });
    expect(renderPanel(view({ picker: { ...short, detail: "" } }), 110)).toHaveLength(
      renderPanel(view({ picker: { ...short, detail } }), 110).length,
    );
    // a voice list has no such line
    expect(renderPanel(view({ picker: pickerView() }), 110)).toHaveLength(8);
  });

  it("a long model name sets the name column; prices and features line up beneath it", () => {
    const items: PickerItem[] = [
      {
        id: "a",
        label: "qwen/qwen3-asr-0.6b",
        price: "$0.0002/min",
        note: "autodetect · 30 langs · fast",
        current: false,
      },
      {
        id: "b",
        label: "nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b",
        price: "$0.0002/min",
        note: "40 langs · fast",
        current: false,
      },
      {
        id: "c",
        label: "elevenlabs/scribe-v2",
        price: "$0.0037/min",
        note: "timestamps · speakers · 90+ langs",
        current: false,
      },
    ];
    const p = pickerView({ title: "Transcription", sort: "features", show: "all", noun: "models", items, total: 3 });
    const at96 = renderPanel(view({ picker: p }), 96);
    const qwen = at96.find((l) => l.includes("qwen3")) ?? "";
    const nemo = at96.find((l) => l.includes("nemotron")) ?? "";
    const scribe = at96.find((l) => l.includes("scribe")) ?? "";
    // the longest name sets the name column; the prices line up in one column under it
    expect(nemo).toMatch(
      /nvidia\/nemotron-3\.5-asr-streaming-multilingual-0\.6b {2}\$0\.0002\/min {2}40 langs · fast$/,
    );
    expect(qwen.indexOf("$0.0002/min")).toBe(nemo.indexOf("$0.0002/min"));
    expect(scribe.indexOf("$0.0037/min")).toBe(nemo.indexOf("$0.0002/min"));
    // the features start in one column too
    expect(qwen.indexOf("autodetect")).toBe(nemo.indexOf("40 langs"));
    const at76 = renderPanel(view({ picker: p }), 76);
    expect(widest(at76)).toBeLessThanOrEqual(76);
    // the long name still shows its price; the features give way with …
    expect(at76.find((l) => l.includes("nemotron"))).toMatch(/\$0\.0002\/min {2}40 la…$/);
  });

  it("the list keeps its height while a filter shortens it", () => {
    const p = pickerView({
      title: "Speech model",
      sort: "price",
      show: "all",
      noun: "models",
      items: MODELS,
      total: 39,
    });
    const all = renderPanel(view({ picker: { ...p, detail: "" } }), 110);
    const few = renderPanel(view({ picker: { ...p, detail: "", show: "tags", items: MODELS.slice(0, 2) } }), 110);
    expect(few).toHaveLength(all.length);
    expect(all).toHaveLength(15);
  });

  it("models show the value, the price right-aligned in its column, then what they offer", () => {
    const p = pickerView({
      title: "Speech model",
      sort: "price",
      show: "all",
      noun: "models",
      items: MODELS,
      total: 39,
      selected: 0,
    });
    const lines = renderPanel(view({ picker: p }), 110);
    const first = lines.find((l) => l.includes("vendor-0/")) ?? "";
    const second = lines.find((l) => l.includes("vendor-1/")) ?? "";
    expect(first).toMatch(/^▸ {3}vendor-0\/speech-model-0 +\$0\.010\/min {2}tags · fast · 21 voices$/);
    expect(second).toMatch(/^ {4}vendor-1\/speech-model-1 +~\$0\.011\/min {2}20\+ langs · 5 voices$/);
    // the prices and the features line up in their own columns
    expect(first.indexOf("/min")).toBe(second.indexOf("/min"));
    expect(first.indexOf("tags")).toBe(second.indexOf("20+ langs"));
  });

  it("drops a column every row fills the same way, and cuts a capability cell on whole tokens", () => {
    const items: PickerItem[] = [
      {
        id: "a/one",
        label: "a/one",
        price: "free",
        cols: ["multilingual", "timestamps · speakers · autodetect"],
        current: false,
      },
      {
        id: "b/two",
        label: "b/two",
        price: "~$0.03/min",
        cols: ["multilingual", "timestamps · speakers"],
        current: true,
      },
    ];
    const p = pickerView({ title: "Transcription", sort: "price", show: "all", noun: "models", items, total: 2 });
    const lines = renderPanel(view({ picker: p }), 60);
    // every row is "multilingual", so that column is gone
    expect(lines.join("\n")).not.toMatch(/multilingual/);
    // the capability cell is cut on a whole token, never mid-word
    const one = lines.find((l) => l.includes("a/one")) ?? "";
    expect(one).toMatch(/timestamps · speakers$/);
    expect(one).not.toMatch(/autode|speak…/);
    // the free price shows as "free"
    expect(one).toMatch(/free/);
    expect(widest(lines)).toBeLessThanOrEqual(60);
  });

  it("a list of on-device models keeps its state column even when every row shares it", () => {
    const items: PickerItem[] = [
      { id: "kokoro", label: "kokoro", price: "147 MB", cols: ["not downloaded", "en zh"], current: false },
      { id: "piper", label: "piper", price: "67 MB", cols: ["not downloaded", "en"], current: false },
    ];
    const p = pickerView({ title: "Speech model", noun: "models", items, total: 2, keepColumns: true });
    const lines = renderPanel(view({ picker: p }), 80);
    const one = lines.find((l) => l.includes("kokoro")) ?? "";
    const two = lines.find((l) => l.includes("piper")) ?? "";
    expect(one).toMatch(/kokoro +147 MB {2}not downloaded {2}en zh$/);
    expect(two).toMatch(/piper +67 MB {2}not downloaded {2}en$/);
    expect(one.indexOf("MB")).toBe(two.indexOf("MB"));
  });

  it("structured columns: name, price, then the language and voices line up in their own columns", () => {
    const items: PickerItem[] = [
      { id: "a/one", label: "a/one", price: "~$0.03/min", note: "", cols: ["", "30 voices"], current: false },
      { id: "b/two", label: "b/two", price: "~$0.032/min", note: "", cols: ["English", "21 voices"], current: true },
      {
        id: "c/three",
        label: "c/three",
        price: "~$0.036/min",
        note: "",
        cols: ["90+ langs", "36 voices"],
        current: false,
      },
    ];
    const p = pickerView({ title: "Speech model", sort: "price", show: "all", noun: "models", items, total: 3 });
    const lines = renderPanel(view({ picker: p }), 96);
    const one = lines.find((l) => l.includes("a/one")) ?? "";
    const two = lines.find((l) => l.includes("b/two")) ?? "";
    const three = lines.find((l) => l.includes("c/three")) ?? "";
    // the prices right-align in one column, and the language and voices each start in one column
    expect(one.indexOf("/min")).toBe(two.indexOf("/min"));
    expect(two.indexOf("English")).toBe(three.indexOf("90+ langs"));
    expect(one.indexOf("30 voices")).toBe(two.indexOf("21 voices"));
    expect(two.indexOf("21 voices")).toBe(three.indexOf("36 voices"));
    // a row with no stated language leaves that column blank rather than shifting the voices column
    expect(one).toMatch(/a\/one\s+~\$0\.03\/min\s+30 voices$/);
    expect(widest(lines)).toBeLessThanOrEqual(96);
  });

  it("a long list scrolls with the selection and shows where it is: ↑ 12–19 of 39 ↓", () => {
    const p = pickerView({
      title: "Speech model",
      sort: "price",
      show: "all",
      noun: "models",
      items: MODELS,
      total: 39,
    });
    const top = renderPanel(view({ picker: { ...p, selected: 0 } }), 110);
    expect(top.some((l) => /\s1–8 of 39 ↓$/.test(l))).toBe(true);
    const mid = renderPanel(view({ picker: { ...p, selected: 15 } }), 110);
    expect(mid.some((l) => /↑ 12–19 of 39 ↓$/.test(l))).toBe(true);
    expect(mid.find((l) => l.includes("model-15"))).toMatch(/^▸/);
    expect(mid.filter((l) => /vendor-/.test(l))).toHaveLength(8);
    const end = renderPanel(view({ picker: { ...p, selected: 38 } }), 110);
    expect(end.some((l) => /↑ 32–39 of 39\s*$/.test(l))).toBe(true);
    expect(end.find((l) => l.includes("xAI Grok"))).toMatch(/^▸ {3}xAI Grok +price unknown {2}xAI login$/);
  });

  it("at 60 columns keeps the prices and gives up the provider; ✓ and ▸ at every width", () => {
    const items = [
      {
        id: "google/gemini-3.1-flash-tts-preview",
        label: "google/gemini-3.1-flash-tts-preview",
        price: "~$0.03/min",
        note: "OpenRouter",
        current: false,
      },
      {
        id: "google/gemini-3.8-flash-tts",
        label: "google/gemini-3.8-flash-tts",
        price: "~$0.014/min",
        note: "OpenRouter",
        current: true,
      },
      { id: "xai", label: "xAI Grok", price: "price unknown", note: "xAI", current: false },
    ];
    const p = pickerView({
      title: "Speech model",
      sort: "price",
      show: "all",
      noun: "models",
      items,
      total: 3,
      selected: 0,
    });
    const lines = renderPanel(view({ picker: p }), 60);
    expect(widest(lines)).toBeLessThanOrEqual(60);
    expect(lines.find((l) => l.includes("3.8-flash-tts"))).toMatch(
      /✓ google\/gemini-3\.8-flash-tts +~\$0\.014\/min {2}OpenR…$/,
    );
    // ✓ and ▸ stay at every width, and no line overflows
    for (const w of [45, 50, 60, 84]) {
      const ls = renderPanel(view({ picker: p }), w);
      expect(widest(ls), `${w}`).toBeLessThanOrEqual(w);
      expect(
        ls.find((l) => l.includes("gemini-3.8")),
        `${w}`,
      ).toMatch(/✓ google/);
      expect(
        ls.find((l) => l.includes("gemini-3.1")),
        `${w}`,
      ).toMatch(/^▸ {3}google/);
    }
    // narrower, the note column gives way with …; the price stays in its column
    const narrow = renderPanel(view({ picker: p }), 45);
    expect(narrow.join("\n")).not.toMatch(/OpenRouter/);
    expect(narrow.find((l) => l.includes("gemini-3.8"))).toMatch(/\$0\.014/);
  });

  it("the count reads in the singular when there is one of a thing: 1 voice, not 1 voices", () => {
    const one = pickerView({ items: [{ id: "Solo", label: "Solo", cols: ["English"], current: true }], total: 1 });
    const find = renderPanel(view({ picker: one }), 84).find((l) => /Find:/.test(l)) ?? "";
    expect(find).toMatch(/\s1 voice$/);
    expect(find).not.toMatch(/1 voices/);
    const many = pickerView({ total: 2 });
    expect(renderPanel(view({ picker: many }), 84).find((l) => /Find:/.test(l)) ?? "").toMatch(/\s2 voices$/);
  });

  it("no match: No matches, the count 0 of n, and a steady height", () => {
    const all = renderPanel(view({ picker: pickerView() }), 84);
    const none = renderPanel(
      view({
        picker: pickerView({ items: [], query: "zz", cursor: 2 }),
        hints: [
          { key: "Backspace", action: "" },
          { key: "Esc", action: "back" },
        ],
      }),
      84,
    );
    expect(none.join("\n")).toMatch(/No matches/);
    expect(none.find((l) => /Find:/.test(l))).toMatch(/\s0 of 2 voices$/);
    expect(hintLine(none).trim()).toBe("Backspace · Esc back");
    expect(none).toHaveLength(all.length);
  });

  it("loading and empty states", () => {
    const loading = renderPanel(
      view({ picker: pickerView({ items: [], loading: true, total: 0 }), hints: [{ key: "Esc", action: "back" }] }),
      84,
    );
    expect(loading.join("\n")).toMatch(/loading…/);
    expect(loading.find((l) => /Find:/.test(l))).not.toMatch(/voices/);
    const empty = renderPanel(view({ picker: pickerView({ items: [], total: 0, empty: "xAI lists no voices" }) }), 84);
    expect(empty.join("\n")).toMatch(/xAI lists no voices/);
  });

  it("at narrow widths the hints give up Tab and F2 first and keep type to filter and Esc", () => {
    const at = (w: number) => hintLine(renderPanel(view({ picker: pickerView(), hints: VOICE_HINTS }), w)).trim();
    expect(at(84)).toBe("Enter pick · Tab sample · F2 language · type to filter · Esc back");
    expect(at(60)).toBe("Enter pick · Tab sample · type to filter · Esc back");
    expect(at(45)).toBe("Enter pick · type to filter · Esc back");
  });

  it("measures wide characters: CJK names and queries never overflow", () => {
    const items = [
      {
        id: "日本語の声-とても長い名前のボイス",
        label: "日本語の声-とても長い名前のボイス",
        note: "ja · provider",
        current: true,
      },
      { id: "Kore", label: "Kore", note: "multilingual · documented", current: false },
    ];
    const cursor: PanelStyle = { ...PLAIN, cursor: (t) => `\x1b[7m${t}\x1b[27m` };
    for (let w = 40; w <= 90; w++) {
      const v = view({ picker: pickerView({ items, query: "日本語の声を探しています長いクエリ", cursor: 17 }) });
      expect(widest(renderPanel(v, w)), `width ${w}`).toBeLessThanOrEqual(w);
      const input = {
        label: "Language of 日本語の声",
        value: "日本語".repeat(20),
        cursor: 30,
        placeholder: "",
        under: "voice" as const,
      };
      expect(widest(renderPanel(view({ input }), w)), `input at ${w}`).toBeLessThanOrEqual(w);
    }
    const lines = renderPanel(view({ picker: pickerView({ query: "pu", cursor: 2 }) }), 84, cursor);
    expect(lines.find((l) => l.includes("Find"))).toContain("Find: pu\x1b[7m \x1b[27m");
  });

  it("shows fewer picker rows on a short terminal", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ id: `voice-${i}`, label: `voice-${i}`, current: i === 0 }));
    const lines = renderPanel(
      view({ picker: pickerView({ items, total: 30, selected: 12 }), hints: VOICE_HINTS }),
      84,
      PLAIN,
      12,
    );
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines.filter((l) => /voice-\d+/.test(l)).length).toBeGreaterThanOrEqual(3);
    expect(lines.find((l) => l.includes("voice-12"))).toMatch(/▸/);
    expect(hintLine(lines)).toMatch(/Esc back$/);
  });
});

describe("the picker as an aligned table", () => {
  it("narrow: long names and notes give way with …, prices stay in one right-aligned column", () => {
    const ids = [
      "fish-audio/s2.1-pro-free:free",
      "hexgrad/kokoro-82m",
      "canopylabs/orpheus-3b-0.1-ft",
      "sesame/csm-1b",
      "google/gemini-3.8-flash-lite-tts",
    ];
    const prices = ["$0", "~$0.0005/min", "~$0.0056/min", "~$0.0056/min", "~$0.0091/min"];
    const items = ids.map(
      (id, i): PickerItem => ({ id, label: id, price: prices[i], note: "OpenRouter", current: false }),
    );
    const p = pickerView({
      title: "Speech model",
      sort: "price",
      show: "all",
      noun: "models",
      items,
      total: 5,
      selected: 0,
    });
    const lines = renderPanel(view({ picker: p }), 45).filter((l) => l.includes("/") && !l.includes("Find"));
    expect(lines).toHaveLength(5);
    expect(widest(lines)).toBeLessThanOrEqual(45);
    // the notes start in one column on every row
    expect(new Set(lines.map((l) => l.indexOf("OpenR"))).size).toBe(1);
    // a long name is cut with … rather than pushing the price and note columns out of line
    expect(lines.find((l) => l.includes("gemini-3.8"))).toMatch(/google\/gemini-3\.8-… +~\$0\.0091\/min {2}OpenR…$/);
    expect(lines.find((l) => l.includes("kokoro"))).toMatch(/hexgrad\/kokoro-82m +~\$0\.0005\/min {2}OpenR…$/);
  });
});
