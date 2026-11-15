import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  type Hint,
  type PanelRow,
  type PanelView,
  type PickerItem,
  type PickerView,
  TABS,
  type TabId,
} from "../../src/engine/panel";
import { MIN_WIDTH, type PanelStyle, PLAIN, renderPanel } from "../../src/pi/panel-render";

/** Zero-width ANSI SGR markers so visibleWidth measures only the plain text, just as in a terminal. */
const TAGGED: PanelStyle = {
  accent: (t) => `\x1b[36m${t}\x1b[39m`,
  bold: (t) => `\x1b[1m${t}\x1b[22m`,
  dim: (t) => `\x1b[2m${t}\x1b[22m`,
  success: (t) => `\x1b[32m${t}\x1b[39m`,
  error: (t) => `\x1b[31m${t}\x1b[39m`,
  warning: (t) => `\x1b[33m${t}\x1b[39m`,
  cursor: (t) => `\x1b[7m${t}\x1b[27m`,
  selected: (t) => `\x1b[44m${t}\x1b[49m`,
};

const MAIN_ROWS: PanelRow[] = [
  { id: "readAloud", label: "Read aloud options", value: "Off", opens: true },
  { id: "speechSource", label: "Speech source", value: "Provider" },
  { id: "speechModel", label: "Speech model", value: "x-ai/grok-voice-tts-1.0", opens: true },
  { id: "voice", label: "Voice", value: "eve", opens: true },
  { id: "transcriptionSource", label: "Transcription source", value: "Provider" },
  { id: "transcription", label: "Transcription model", value: "openai/whisper-large-v3-turbo", opens: true },
  { id: "language", label: "Dictation language", value: "auto" },
  { id: "output", label: "Dictation output", value: "Pi", opens: true },
  { id: "osdStyle", label: "Spectrum OSD", value: "Braille" },
];

const HOTKEY_ROWS: PanelRow[] = [
  { id: "speak", label: "Speak…", value: "Alt+S" },
  { id: "dictate", label: "Dictate", value: "Alt+Z" },
  {
    id: "ptt",
    label: "Push-to-talk",
    value: "off",
    note: "hold to dictate (Kitty key-release)",
    short: "hold to dictate",
  },
  { id: "replay", label: "Replay last" },
  { id: "history", label: "History…", opens: true },
  { id: "stop", label: "Stop" },
];

function fixture(over: Partial<PanelView> & { tab?: TabId } = {}): PanelView {
  const raw = {
    title: "Speech",
    state: "",
    menu: "main" as const,
    tab: "main" as TabId,
    tabs: TABS,
    keys: { speak: "Alt+S", dictate: "Alt+Z" },
    rows: MAIN_ROWS,
    selected: 0,
    hints: [
      { key: "Enter", action: "change" },
      { key: "Tab", action: "next tab", optional: true },
      { key: "Esc", action: "close" },
    ],
    ...over,
  };
  return raw as unknown as PanelView;
}

function modelPicker(over: Partial<PickerView> = {}): PickerView {
  const items: PickerItem[] = Array.from({ length: 25 }, (_, i) => ({
    id: `vendor-${i}/model-${i}`,
    label: `model-${i}`,
    price: `~$0.0${10 + i}/min`,
    cols: [i % 2 === 0 ? "OpenRouter" : "xAI", `${2 + i} voices`],
    current: i === 2,
  }));
  return {
    title: "Speech model",
    sort: "price",
    detail: "Gemini 3.8 Flash TTS is a low-latency text-to-speech model with inline audio tags and 20+ languages.",
    noun: "models",
    query: "",
    cursor: 0,
    items,
    selected: 0,
    total: items.length,
    loading: false,
    empty: "No matches",
    ...over,
  };
}

describe("renderPanel in the shared 19-line frame", () => {
  it("renders Main, a model picker, a form menu, and an input as exactly 19 lines", () => {
    const main = renderPanel(
      fixture({
        tab: "main",
        selected: -1,
        speak: { value: "", cursor: 0, placeholder: "type a message · Enter speaks it", focused: true },
      }),
      100,
      PLAIN,
    );
    const picker = renderPanel(fixture({ tab: "speechModel", rows: [], picker: modelPicker() }), 100);
    const menu = renderPanel(fixture({ tab: "hotkeys", rows: HOTKEY_ROWS, selected: 0 }), 100);
    const input = renderPanel(
      fixture({
        tab: "bridge",
        rows: [{ id: "remoteMachine", label: "Remote machine", value: "not connected" }],
        input: { label: "Connect to", value: "alice@box", cursor: 9, placeholder: "user@host" },
      }),
      100,
    );

    for (const lines of [main, picker, menu, input]) {
      expect(lines).toHaveLength(19);
      expect(lines[0]).toMatch(/^─ Speech ─+/);
    }
    expect(main[3]).toMatch(/^ {2}Speak: > +type a message/);
    expect(main[4]).toMatch(/^ {2}Setting +Value$/);
    expect(main.join("\n")).not.toMatch(/SPEAK \(|LISTEN \(|SETTINGS/);
    expect(picker[3]).toBe("  Search: >  ");
    expect(menu[3]).toBe("");
    expect(menu[5]).toMatch(/^▶ Speak… +Alt\+S$/);
    expect(input[3]).toMatch(/^ {2}Connect to: > alice@box $/);
  });

  it("highlights the active tab and windows tabs with << and >> so the active tab stays visible", () => {
    const wide = renderPanel(fixture({ tab: "voice" }), 120, TAGGED);
    expect(wide[1]).toContain("\x1b[44m\x1b[36m\x1b[1m Voice \x1b[22m\x1b[39m\x1b[49m");
    expect(wide[1]).not.toContain("<<");
    expect(wide[1]).not.toContain(">>");

    const firstNarrow = renderPanel(fixture({ tab: "main" }), 60);
    expect(firstNarrow[1]).toContain("Main");
    expect(firstNarrow[1]).not.toContain("<< ");
    expect(firstNarrow[1]).toContain(" >>");

    const lastNarrow = renderPanel(fixture({ tab: "bridge" }), 60);
    expect(lastNarrow[1]).toContain("<< ");
    expect(lastNarrow[1]).toContain("Bridge");
    expect(lastNarrow[1]).not.toContain(" >>");
  });

  it("draws the state badge in the title rule and masks secret inputs as dots", () => {
    const rec = renderPanel(fixture({ state: "● REC 0:07" }), 84, TAGGED);
    expect(rec[0]).toContain("\x1b[31m●\x1b[39m REC 0:07");

    const secret = renderPanel(
      fixture({
        input: { label: "Password", value: "hunter2", cursor: 7, placeholder: "", secret: true },
      }),
      84,
    );
    expect(secret[3]).toContain("Password: > •••••••");
    expect(secret.join("\n")).not.toContain("hunter2");
  });

  it("draws picker sort arrows on columns, Sort: newest on the header right, current dots, and 10 scrolled rows", () => {
    const byPrice = renderPanel(
      fixture({ tab: "speechModel", picker: modelPicker({ sort: "price", selected: 12 }) }),
      100,
    );
    expect(byPrice[4]).toMatch(/Model +Provider +Price ▲ +Voices$/);
    // 10 rows centred around item 12 (indices 7..16)
    expect(byPrice.slice(5, 15).filter((l) => /model-\d+/.test(l))).toHaveLength(10);
    expect(byPrice.slice(5, 15).find((l) => l.includes("model-12"))).toMatch(/^▶ model-12/);

    const byNewest = renderPanel(
      fixture({ tab: "speechModel", picker: modelPicker({ sort: "newest", selected: 2 }) }),
      100,
    );
    expect(byNewest[4]).toMatch(/Model +Provider +Sort: newest +Price +Voices$/);
    expect(byNewest.slice(5, 15).find((l) => l.includes("model-2"))).toMatch(/^▶ model-2 ●/);

    const empty = renderPanel(
      fixture({ tab: "voice", picker: modelPicker({ items: [], total: 0, empty: "xAI lists no voices" }) }),
      80,
    );
    expect(empty).toHaveLength(19);
    expect(empty[5]).toBe("  xAI lists no voices");
  });

  it("shows (n/m) <id> · <detail> on a picker's status line, (n/m) <label> on a form, or toned status when set", () => {
    const picker = renderPanel(fixture({ tab: "speechModel", picker: modelPicker({ selected: 0 }) }), 90);
    expect(picker[15]).toMatch(/^ {2}\(1\/25\) vendor-0\/model-0 · Gemini 3\.8 Flash TTS is a low-latency.*…$/);
    expect(visibleWidth(picker[15])).toBeLessThanOrEqual(90);

    const form = renderPanel(fixture({ tab: "main", selected: 3 }), 90);
    expect(form[15]).toBe("  (4/9) Voice");

    const toned = renderPanel(fixture({ status: { tone: "error", text: "✗ Playback failed: boom" } }), 90, TAGGED);
    expect(toned[15]).toBe("  \x1b[31m✗ Playback failed: boom\x1b[39m");
  });

  it("places Alt+S speak · Alt+Z dictate on the right of a wide key bar and drops it and optional hints when narrow", () => {
    const hints: Hint[] = [
      { key: "Enter", action: "pick" },
      { key: "Ctrl+P", action: "sample", optional: true },
      { key: "F2", action: "language", optional: true },
      { key: "type", action: "to filter" },
      { key: "Esc", action: "back" },
    ];
    const wide = renderPanel(fixture({ hints }), 110);
    expect(wide[17]).toMatch(
      /^ {2}Enter pick · Ctrl\+P sample · F2 language · type to filter · Esc back {2,}Alt\+S speak · Alt\+Z dictate$/,
    );
    expect(visibleWidth(wide[17])).toBe(108); // ends NOTE_GAP (2) cols before the edge

    const medium = renderPanel(fixture({ hints }), 80);
    expect(medium[17]).not.toContain("Alt+S speak");
    expect(medium[17]).toBe("  Enter pick · Ctrl+P sample · F2 language · type to filter · Esc back");

    expect(renderPanel(fixture({ hints }), 60)[17]).toBe("  Enter pick · Ctrl+P sample · type to filter · Esc back");
    expect(renderPanel(fixture({ hints }), 45)[17]).toBe("  Enter pick · type to filter · Esc back");
  });

  it("returns one narrow-terminal line below MIN_WIDTH and never exceeds termWidth", () => {
    expect(renderPanel(fixture(), MIN_WIDTH - 1)).toEqual(["Speech: terminal too narrow · Esc"]);
    expect(renderPanel(fixture(), 20)).toEqual(["Speech: terminal to…"]);

    for (const w of [1, 15, 39, 40, 48, 60, 80, 128, 160]) {
      for (const v of [
        fixture({ state: "▶ speaking" }),
        fixture({ tab: "speechModel", picker: modelPicker({ query: "gemini", cursor: 6 }) }),
        fixture({
          tab: "bridge",
          rows: [{ id: "bridgeMode", label: "Bridge", value: "auto", note: "✗ receiver unreachable", alert: true }],
        }),
      ]) {
        const lines = renderPanel(v, w);
        expect(Math.max(...lines.map((l) => visibleWidth(l))), `width ${w}`).toBeLessThanOrEqual(w);
      }
    }
  });
});
