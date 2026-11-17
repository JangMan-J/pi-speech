/**
 * The thin Pi adapter: maps Pi's session events, UI, shortcut, command, and tools onto the engine.
 * All behavior lives in src/engine/; this file only translates.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  colorToRgb,
  Editor,
  isKeyRelease,
  isKeyRepeat,
  isKittyProtocolActive,
  type KeyId,
  matchesKey,
  parseKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { splitEditorPrefill } from "../engine/dictation-rules";
import type { Engine } from "../engine/engine";
import { errorMessage } from "../engine/env";
import { STATUS_KEY, statusLine } from "../engine/indicator";
import {
  ansiRgbTint,
  centre,
  holdingPresence,
  OSD_COLUMNS,
  type OsdThemeColors,
  previewBands,
  type Rgb,
  renderOsd,
  vividRgb,
} from "../engine/osd";
import type { Panel } from "../engine/panel";
import { type Hotkeys, keyLabel } from "../engine/settings";
import type { SpeechResult } from "../engine/speech";
import { ACTION_NAMES, ACTION_VALUES, parse, Surface, type SurfaceUi } from "../engine/surface";

export const SYNTHESIZE_TOOL = "speech_synthesize";
/**
 * The hidden argument of /speech that reloads Pi: sent from agent_settled when a changed hotkey asked for a
 * reload while the agent was running (Pi cannot reload then).
 */
export const RELOAD_ARG = "--reload-hotkeys";
export const TRANSCRIBE_TOOL = "speech_transcribe";
const OSD_KEY = "pi-speech-osd";
const OSD_POLL_MS = 48;
/** Ticks of overall level kept for the Orb's rings: as long as a ring takes to leave the graph. */
const OSD_TRAIL = 40;
const TOOLS = [SYNTHESIZE_TOOL, TRANSCRIBE_TOOL];

const KITTY_FN_CODES: Record<string, string> = {
  "11": "f1",
  "12": "f2",
  "13": "f3",
  "14": "f4",
  "15": "f5",
  "17": "f6",
  "18": "f7",
  "19": "f8",
  "20": "f9",
  "21": "f10",
  "23": "f11",
  "24": "f12",
};

/** Match `key`, including Kitty `F1`–`F12` press/repeat/release sequences on pi-tui 1.4.x. */
function matchesPttKey(data: string, key: string): boolean {
  if (matchesKey(data, key as KeyId)) return true;
  if (!data.startsWith("\x1b[")) return false;
  const rest = data.slice(1);
  const tilde = /^\[(\d+)(?:;(\d+))?(?::\d+)?~$/.exec(rest);
  const pqs = /^\[(?:1;(\d+)(?::\d+)?)?([PQS])$/.exec(rest);
  const fn = tilde ? KITTY_FN_CODES[tilde[1]] : pqs ? ({ P: "f1", Q: "f2", S: "f4" }[pqs[2]] ?? "") : "";
  if (!fn) return false;
  const mod = Math.max(0, Number.parseInt(tilde?.[2] ?? pqs?.[1] ?? "1", 10) - 1);
  const mods: string[] = [];
  if (mod & 4) mods.push("ctrl");
  if (mod & 2) mods.push("alt");
  if (mod & 1) mods.push("shift");
  return [...mods, fn].join("+") === key;
}

/** The tool result for a synthesis: files, model and voice, and whether it plays. Never contains the key. */
export function describeForTool(r: SpeechResult): string {
  if (r.stopped) return "Stopped before the speech had fully arrived; nothing was saved.";
  return [
    `Saved: ${r.files.join(", ")}`,
    `Model: ${r.model}, voice: ${r.voice}`,
    r.player ? `Playing with ${r.player}` : `Not played: ${r.notPlayed ?? "unknown reason"}`,
  ].join("\n");
}

function errorResult(err: unknown) {
  const text = errorMessage(err);
  return { content: [{ type: "text" as const, text }], details: { error: text }, isError: true };
}

/** Multi-line editor overlay where Enter inserts a newline and Shift+Enter saves & closes. */
function multiLineEditor(ctx: ExtensionContext, title: string, prefill?: string): Promise<string | undefined> {
  if (!hasTerminal(ctx) || typeof ctx.ui.custom !== "function") {
    return ctx.ui.editor(title, prefill);
  }
  return ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
    const editorTheme = {
      borderColor: (s: string) => theme.fg("border", s),
      selectList: {
        selectedPrefix: (s: string) => theme.fg("accent", s),
        selectedText: (s: string) => theme.fg("accent", theme.bold(s)),
        description: (s: string) => theme.fg("dim", s),
        scrollInfo: (s: string) => theme.fg("dim", s),
        noMatch: (s: string) => theme.fg("dim", s),
      },
    };
    const { guide, body } = splitEditorPrefill(prefill);
    const ed = new Editor(tui, editorTheme, { paddingX: 1 });
    ed.disableSubmit = true;
    if (body) ed.setText(body);
    let focused = true;
    ed.focused = true;
    const hint = `${theme.fg("dim", "Enter")} ${theme.fg("muted", "newline")}  ${theme.fg("dim", "Shift+Enter")} ${theme.fg("muted", "save")}  ${theme.fg("dim", "Esc")} ${theme.fg("muted", "cancel")}`;
    return {
      get focused() {
        return focused;
      },
      set focused(v: boolean) {
        focused = v;
        ed.focused = v;
      },
      invalidate() {
        ed.invalidate();
      },
      render(width: number): string[] {
        const w = Math.max(1, width);
        const rule = theme.fg("accent", "─".repeat(w));
        const header = truncateToWidth(` ${theme.fg("accent", theme.bold(title))}`, w, "…");
        const guideLines = guide.map((line, i) =>
          truncateToWidth(` ${theme.fg(i === 0 ? "muted" : "dim", line)}`, w, "…"),
        );
        return [
          rule,
          header,
          ...(guideLines.length ? [...guideLines, ""] : [""]),
          ...ed.render(w),
          truncateToWidth(` ${hint}`, w, "…"),
          rule,
        ];
      },
      handleInput(data: string): void {
        if (isKeyRelease(data)) return;
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
          done(undefined);
          return;
        }
        if (matchesKey(data, "shift+enter")) {
          done(ed.getText());
          return;
        }
        if (matchesKey(data, "enter")) {
          ed.insertTextAtCursor("\n");
          tui.requestRender();
          return;
        }
        ed.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/** The engine's view of one Pi context's UI. */
function surfaceUi(
  ctx: ExtensionContext,
  sendMessage?: (text: string, opts?: { expandPromptTemplates?: boolean }) => void,
): SurfaceUi {
  return {
    cwd: ctx.cwd,
    notify: (message, level) => ctx.ui.notify(message, level),
    paste: (text) => ctx.ui.pasteToEditor(text),
    setEditor: (text) => ctx.ui.setEditorText(text),
    getEditor: () => ctx.ui.getEditorText(),
    editor: (title, prefill) => multiLineEditor(ctx, title, prefill),
    ...(sendMessage
      ? {
          submit: (text: string) => sendMessage(text),
          runCommand: (cmd: string) => sendMessage(cmd, { expandPromptTemplates: true }),
        }
      : {}),
    select: (title, options) => ctx.ui.select(title, options),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    pick: (title, options) => ctx.ui.select(title, options),
  };
}

/** The user's Pi models as `provider/id`: the scoped ones when the session has them, else every available one. */
export function piModels(ctx: Pick<ExtensionContext, "scopedModels" | "modelRegistry">): string[] {
  const scoped = ctx.scopedModels ?? [];
  const models = scoped.length ? scoped.map((s) => s.model) : ctx.modelRegistry.getAvailable();
  return [...new Set(models.map((m) => `${m.provider}/${m.id}`))];
}

/** One request to the Pi model `ref` (`provider/id`) with `prompt`: resolves to its answer's text. */
export async function summarizeWith(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  ref: string,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const slash = ref.indexOf("/");
  const model = slash > 0 ? ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
  if (!model) throw new Error(`${ref} is not one of your Pi models`);
  const reply = await ctx.modelRegistry.complete(
    model,
    { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { signal },
  );
  if (reply.stopReason === "error" || reply.stopReason === "aborted") {
    throw new Error(reply.errorMessage || `the request was ${reply.stopReason === "error" ? "refused" : "stopped"}`);
  }
  return reply.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * What Option with a letter or a digit types on a US Mac layout when the terminal does not send Option as Alt
 * (macOS Terminal.app unless "Use Option as Meta key" is on). Dead keys (e, i, n, u) type nothing at once.
 */
const MAC_OPTION: Record<string, string> = {
  a: "å",
  b: "∫",
  c: "ç",
  d: "∂",
  f: "ƒ",
  g: "©",
  h: "˙",
  j: "∆",
  k: "˚",
  l: "¬",
  m: "µ",
  o: "ø",
  p: "π",
  q: "œ",
  r: "®",
  s: "ß",
  t: "†",
  v: "√",
  w: "∑",
  x: "≈",
  y: "¥",
  z: "Ω",
  "1": "¡",
  "2": "™",
  "3": "£",
  "4": "¢",
  "5": "∞",
  "6": "§",
  "7": "¶",
  "8": "•",
  "9": "ª",
  "0": "º",
};

/** The character the hotkey `key` (`alt+z`) types on a US Mac layout without Option as Alt; none for other keys. */
export function macOptionCharacter(key: string): string | undefined {
  const m = /^alt\+([a-z0-9])$/.exec(key);
  return m ? MAC_OPTION[m[1]] : undefined;
}

/** The one-time notice: the Speak or Dictate key reached Pi as a character, and what to do about it. */
export function optionKeyNotice(name: keyof Hotkeys, key: string, char: string): string {
  const action = name === "speak" ? "Speak" : "Dictate";
  const instead = name === "speak" ? "/speech <text>" : "/speech --dictate";
  return (
    `${keyLabel(key)} (${action}) reached Pi as the character ${char}: macOS sends characters for Option+letter. ` +
    `Turn on "Use Option as Meta key" in Terminal > Settings > Profiles > Keyboard (iTerm2 and Ghostty: Option as Alt), ` +
    `which gives up Option for accented letters; or choose another key in /speech > Hotkeys; or use ${instead}.`
  );
}

/** Pi has a terminal UI here (not RPC or print mode). */
const hasTerminal = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI;

export function registerPi(
  pi: ExtensionAPI,
  engine: Engine,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  const surface = new Surface(engine);
  let ui: ExtensionContext["ui"] | undefined;
  /** The settings panel while it is open: engine notifications go to its status line instead of toasts. */
  let panel: Panel | undefined;
  /** The latest context: its model registry has the user's Pi models. */
  let latest: ExtensionContext | undefined;

  /** The OSD widget while it is up, and the TUI that draws it (to ask for a frame when the bands change). */
  let osdTui: { requestRender(): void } | undefined;
  let osdUp = false;
  let lastBands: number[] = [];
  let osdTick = 0;
  let silenceTicks = 0;
  /** The overall level (`0..1`) of the latest ticks, the newest first: the Orb draws its rings from it. */
  let levelTrail: number[] = [];
  const trailLevel = () => {
    const level = lastBands.length ? lastBands.reduce((a, b) => a + b, 0) / lastBands.length / 100 : 0;
    levelTrail = [level, ...levelTrail.slice(0, OSD_TRAIL - 1)];
  };
  let previewUntil = 0;
  let seenOsdStyle = engine.speech.settings.osdStyle;
  let levelsTimer: ReturnType<typeof setInterval> | undefined;
  let levelsInflight = false;
  let pttActive = false;
  let pttTarget: "editor" | "composer" | undefined;
  let stopPtt: (() => void) | undefined;

  const stopLevels = () => {
    if (levelsTimer) {
      clearInterval(levelsTimer);
      levelsTimer = undefined;
    }
    levelsInflight = false;
  };

  /** The footer always shows what speech does; the OSD is the graph only, and the panel's header stays quiet. */
  engine.indicator.shownElsewhere = () => !!latest && hasTerminal(latest);

  const hideOsd = () => {
    stopLevels();
    lastBands = [];
    levelTrail = [];
    osdTick = 0;
    silenceTicks = 0;
    if (osdUp) ui?.setWidget?.(OSD_KEY, undefined);
    osdUp = false;
    osdTui = undefined;
  };

  const supportsTruecolor = () => {
    const ct = (env.COLORTERM ?? "").toLowerCase();
    if (ct === "truecolor" || ct === "24bit") return true;
    return Boolean(
      env.KITTY_WINDOW_ID ||
        env.GHOSTTY_RESOURCES_DIR ||
        env.WEZTERM_PANE ||
        env.ALACRITTY_WINDOW_ID ||
        env.KONSOLE_VERSION ||
        env.WT_SESSION,
    );
  };

  /** Extract high-contrast semantic RGB stops from Pi's active theme (including terminal-derived `system` theme). */
  const osdPaletteFromTheme = (theme: ExtensionContext["ui"]["theme"] | undefined): OsdThemeColors | undefined => {
    if (!theme?.colors) return undefined;
    const acc = theme.colors.accent;
    // When `system` theme has no OSC terminal palette response yet, its tokens are uncalibrated 0..15 ANSI indices.
    if (!acc || (acc.kind === "indexed" && acc.index < 16)) return undefined;
    const appearance = theme.appearance === "light" ? "light" : "dark";
    const pickRgb = (token: keyof typeof theme.colors, fallback: Rgb, boost = 1.24): Rgb => {
      const c = theme.colors[token];
      if (!c) return fallback;
      const rgb = colorToRgb(c);
      return vividRgb([rgb.r, rgb.g, rgb.b], boost);
    };
    const panelBg = theme.colors.toolPendingBg ? colorToRgb(theme.colors.toolPendingBg) : undefined;
    const bg: Rgb = panelBg
      ? appearance === "light"
        ? [Math.round((panelBg.r + 255) / 2), Math.round((panelBg.g + 255) / 2), Math.round((panelBg.b + 255) / 2)]
        : [Math.round(panelBg.r * 0.45), Math.round(panelBg.g * 0.45), Math.round(panelBg.b * 0.45)]
      : appearance === "light"
        ? [245, 247, 250]
        : [14, 16, 24];
    const inkRaw = theme.colors.text ? colorToRgb(theme.colors.text) : undefined;
    const ink: Rgb = inkRaw ? [inkRaw.r, inkRaw.g, inkRaw.b] : appearance === "light" ? [38, 42, 48] : [238, 245, 250];
    return {
      appearance,
      bg,
      ink,
      accent: pickRgb("accent", [180, 105, 255]),
      error: pickRgb("error", [255, 52, 88]),
      warning: pickRgb("warning", [255, 208, 62]),
      success: pickRgb("success", [62, 238, 152]),
      keyword: pickRgb("syntaxKeyword", [58, 122, 255]),
      variable: pickRgb("syntaxVariable", [0, 222, 245]),
      string: pickRgb("syntaxString", [255, 142, 38]),
      magenta: pickRgb("thinkingXhigh", [255, 86, 205], 1.18),
    };
  };

  /** The OSD's lines now, centred in `width` with theme-derived truecolor / 256-colour shading (or plain under NO_COLOR). */
  const osdLines = (width: number): string[] => {
    const style = engine.speech.settings.osdStyle;
    if (style === "off") return [];
    const d = engine.dictation.state;
    const mode = d === "starting" || d === "recording" ? "recording" : "playing";
    const tinted = latest ? hasTerminal(latest) && !env.NO_COLOR && env.TERM !== "dumb" : false;
    const theme = ui?.theme;
    const colorMode = typeof theme?.getColorMode === "function" ? theme.getColorMode() : undefined;
    const truecolor = colorMode === "truecolor" || (colorMode === undefined && supportsTruecolor());
    const tint = tinted
      ? {
          ...(theme ? { dot: (t: string) => theme.fg("error", t), accent: (t: string) => theme.fg("accent", t) } : {}),
          rgb: ansiRgbTint(truecolor),
        }
      : undefined;
    const palette = tinted ? osdPaletteFromTheme(theme) : undefined;
    const cols = OSD_COLUMNS[style];
    const presence = holdingPresence(silenceTicks);
    const lines = centre(
      renderOsd({ style, mode, bands: lastBands, tick: osdTick, presence, trail: levelTrail, palette, tint }),
      cols,
      width,
    );
    return width < cols ? lines.map((l) => truncateToWidth(l, Math.max(1, width), "")) : lines;
  };

  /** Show the OSD while recording, playing, or previewing a newly selected style, else remove it. */
  const updateOsd = () => {
    if (!ui || typeof ui.setWidget !== "function") return;
    const d = engine.dictation.state;
    const activeAudio = d === "starting" || d === "recording" || engine.player.playing;
    const previewing = !activeAudio && Date.now() < previewUntil;
    if (engine.speech.settings.osdStyle === "off" || (!activeAudio && !previewing)) {
      previewUntil = 0;
      hideOsd();
      return;
    }
    if (previewing && lastBands.length === 0) lastBands = previewBands(osdTick);
    if (!osdUp) {
      osdUp = true;
      ui.setWidget(
        OSD_KEY,
        (tui) => {
          osdTui = tui;
          return { render: (width: number) => osdLines(width), invalidate: () => {} };
        },
        { placement: "aboveEditor" },
      );
    } else osdTui?.requestRender();
    if (!levelsTimer) {
      levelsTimer = setInterval(() => {
        if (levelsInflight) return;
        levelsInflight = true;
        osdTick++;
        const nowActive =
          engine.dictation.state === "starting" || engine.dictation.state === "recording" || engine.player.playing;
        if (!nowActive) {
          if (Date.now() >= previewUntil) {
            levelsInflight = false;
            updateOsd();
            return;
          }
          lastBands = previewBands(osdTick);
          trailLevel();
          levelsInflight = false;
          updateOsd();
          return;
        }
        void engine.routes
          .levels()
          .then((r) => {
            const next =
              engine.dictation.state === "recording" ? r?.recording : engine.player.playing ? r?.playing : undefined;
            lastBands = next ?? lastBands.map((v) => (v * 0.5 < 0.5 ? 0 : v * 0.5));
            if (lastBands.some((v) => v >= 1)) silenceTicks = 0;
            else silenceTicks++;
            trailLevel();
            updateOsd();
          })
          .finally(() => {
            levelsInflight = false;
          });
      }, OSD_POLL_MS);
      levelsTimer.unref?.();
    }
  };

  engine.indicator.listen(() => {
    if (engine.dictation.state === "idle" && pttActive) {
      pttActive = false;
      pttTarget = undefined;
    }
    updateOsd();
  });

  /** Follow the latest context: its UI hears notifications and shows the status; its registry has the key. */
  const attach = (ctx: ExtensionContext) => {
    latest = ctx;
    engine.speech.registry = ctx.modelRegistry;
    if (ctx.ui === ui) return;
    ui = ctx.ui;
    const current = ctx.ui;
    const tinted = hasTerminal(ctx) && !env.NO_COLOR;
    // Always there, in its own colours: footer extensions place it by its key (zentui: colorModes "original").
    engine.indicator.attach((state) => current.setStatus(STATUS_KEY, statusLine(state, tinted)));
    updateOsd();
  };
  engine.notify = (message, level) => {
    try {
      if (panel) panel.report(message, level);
      else ui?.notify(message, level);
    } catch {
      /* the session is gone */
    }
  };

  const applyTools = () => {
    const active = pi.getActiveTools();
    const others = active.filter((t) => !TOOLS.includes(t));
    const next = engine.speech.settings.tools ? [...others, ...TOOLS] : others;
    if (next.length !== active.length || next.some((t) => !active.includes(t))) pi.setActiveTools(next);
  };
  engine.onToolsChanged = applyTools;

  let panelModule: Promise<typeof import("./panel")> | undefined;
  let warmPanelTimer: ReturnType<typeof setTimeout> | undefined;
  const loadPanel = () => {
    panelModule ??= import("./panel");
    return panelModule;
  };

  pi.on("session_start", async (_event, ctx) => {
    attach(ctx);
    engine.start();
    applyTools();
    watchOptionKey(ctx);
    watchPtt(ctx);
    void engine.announce().then((n) => {
      if (n) engine.notify(n.message, n.level);
    });
    if (!panelModule && !warmPanelTimer && hasTerminal(ctx)) {
      warmPanelTimer = setTimeout(() => {
        warmPanelTimer = undefined;
        void loadPanel().catch(() => {});
      }, 250);
      warmPanelTimer.unref();
    }
  });

  pi.on("session_shutdown", async () => {
    if (warmPanelTimer) {
      clearTimeout(warmPanelTimer);
      warmPanelTimer = undefined;
    }
    stopPtt?.();
    stopPtt = undefined;
    hideOsd();
    await engine.shutdown();
  });

  // Read-aloud: the user's Pi models summarize when chosen (one extra request per reply).
  engine.readAloud.attachHost({
    models: () => (latest ? piModels(latest) : []),
    currentModel: () => (latest?.model ? `${latest.model.provider}/${latest.model.id}` : undefined),
    summarize: (ref, prompt, signal) => {
      if (!latest) return Promise.reject(new Error("Pi's models are not available yet"));
      return summarizeWith(latest, ref, prompt, signal);
    },
  });

  // Summarized with the same model: a guideline asks for a marked summary at the end of each reply.
  pi.on("before_agent_start", async (event, ctx) => {
    attach(ctx);
    engine.readAloud.onRunStart(event.systemPromptOptions.promptGuidelines);
  });

  // Streaming: each reasoning block is summarized and read as it finishes streaming.
  pi.on("message_update", (event, ctx) => {
    const e = event.assistantMessageEvent;
    if (e.type !== "thinking_end") return;
    attach(ctx);
    engine.readAloud.onThinkingBlock(e.content, ctx.signal);
  });

  // The marked summary is taken out of the finished message, so it is neither shown nor kept in the session.
  pi.on("message_end", async (event) => {
    const message = engine.readAloud.onMessageEnd(event.message);
    return message ? { message } : undefined;
  });

  pi.on("agent_end", async (event, ctx) => {
    attach(ctx);
    void engine.readAloud.onRunEnd(event.messages ?? []);
  });

  /** A changed hotkey asked for a reload while the agent was running: it runs once the agent has settled. */
  let reloadRequested = false;
  pi.on("agent_settled", async () => {
    if (!reloadRequested) return;
    reloadRequested = false;
    // Sent from agent_settled, the command runs after every settled handler finishes, while Pi is idle.
    void pi.sendUserMessage(`/speech ${RELOAD_ARG}`, { expandPromptTemplates: true });
  });

  // Pi binds an extension's shortcuts when it loads the extension: leaving Hotkeys with a changed key closes
  // the panel and reloads Pi, which loads the extension again with the new keys.
  const hotkeys = { ...engine.speech.settings.hotkeys };
  const sendUser = (text: string, opts?: { expandPromptTemplates?: boolean }) => pi.sendUserMessage(text, opts);
  const open = async (ctx: ExtensionContext) => {
    const { openPanel } = await loadPanel();
    seenOsdStyle = engine.speech.settings.osdStyle;
    return openPanel(
      ctx,
      engine,
      surface,
      surfaceUi(ctx, sendUser),
      env,
      (p) => {
        panel = p;
        if (!p) {
          previewUntil = 0;
          if (latest) watchPtt(latest);
        }
        // Who shows the live state depends on whether the panel is open, and on the OSD it may have changed.
        engine.indicator.refresh();
        updateOsd();
      },
      hotkeys,
      () => {
        const nextStyle = engine.speech.settings.osdStyle;
        if (nextStyle !== seenOsdStyle) {
          seenOsdStyle = nextStyle;
          lastBands = [];
          levelTrail = [];
          silenceTicks = 0;
          previewUntil = nextStyle === "off" ? 0 : Date.now() + 1800;
          updateOsd();
        }
      },
    );
  };

  /**
   * macOS: a terminal that does not send Option as Alt types Ω for Option+Z, so the hotkey never reaches Pi.
   * When the character the Speak or Dictate key types there arrives in an empty editor, say once per install
   * what happened. The character is only looked at: it always goes on to the editor unchanged.
   */
  let stopWatching: (() => void) | undefined;
  const watchOptionKey = (ctx: ExtensionContext) => {
    stopWatching?.();
    stopWatching = undefined;
    if (platform !== "darwin" || !hasTerminal(ctx) || engine.speech.settings.optionKeyHintShown) return;
    const chars = new Map<string, "speak" | "dictate">();
    for (const name of ["speak", "dictate"] as const) {
      const char = macOptionCharacter(hotkeys[name]);
      if (char) chars.set(char, name);
    }
    if (!chars.size) return;
    const current = ctx.ui;
    // Pi before onTerminalInput existed (and test doubles without it): no hint.
    if (typeof current.onTerminalInput !== "function") return;
    stopWatching = current.onTerminalInput((data) => {
      try {
        const name = chars.get(data);
        if (!name || panel || engine.speech.settings.optionKeyHintShown) return undefined;
        if (current.getEditorText() !== "") return undefined;
        engine.speech.settings.optionKeyHintShown = true;
        try {
          engine.speech.save();
        } catch {
          // Unwritable settings: shown once in this session all the same.
        }
        const stop = stopWatching;
        stopWatching = undefined;
        // After this input has gone on to the editor.
        setTimeout(() => {
          stop?.();
          current.notify(optionKeyNotice(name, hotkeys[name], data), "info");
        }, 0);
      } catch {
        // Never in the way of typing.
      }
      return undefined;
    });
  };

  /** Push-to-talk: hold the configured key to record, release to transcribe (requires Kitty key-release). */
  const watchPtt = (ctx: ExtensionContext) => {
    stopPtt?.();
    stopPtt = undefined;
    if (!engine.speech.settings.hotkeys.ptt) {
      pttActive = false;
      pttTarget = undefined;
      return;
    }
    if (!hasTerminal(ctx) || typeof ctx.ui.onTerminalInput !== "function") return;
    stopPtt = ctx.ui.onTerminalInput((data) => {
      try {
        const pttKey = engine.speech.settings.hotkeys.ptt;
        if (!pttKey) {
          pttActive = false;
          pttTarget = undefined;
          return undefined;
        }
        if (panel?.isCapturingHotkey()) return undefined;
        const release = isKeyRelease(data);
        const repeat = !release && isKeyRepeat(data);
        const base = pttKey.split("+").pop() ?? "";
        const hasMod = pttKey.includes("+");
        if (!release) {
          if (!matchesPttKey(data, pttKey)) return undefined;
          if (repeat) return pttActive ? { consume: true } : undefined;
          if (!isKittyProtocolActive()) {
            ctx.ui.notify(
              "Push-to-talk requires a terminal with key-release support (Kitty keyboard protocol); use Alt+Z to toggle",
              "warning",
            );
            return { consume: true };
          }
          if (!pttActive && engine.dictation.state === "idle") {
            pttActive = true;
            if (panel?.inSpeakComposer()) {
              pttTarget = "composer";
              panel.dictateNow();
            } else {
              pttTarget = "editor";
              panel?.close();
              void engine.dictation
                .toggle(surfaceUi(ctx, sendUser))
                .catch((err) => engine.notify(errorMessage(err), "error"));
            }
          }
          return { consume: true };
        }
        if (pttActive && (matchesPttKey(data, pttKey) || (hasMod && parseKey(data) === base))) {
          const target = pttTarget;
          pttActive = false;
          pttTarget = undefined;
          if (engine.dictation.state === "starting" || engine.dictation.state === "recording") {
            if (target === "composer" && panel?.inSpeakComposer()) panel.dictateNow();
            else
              void engine.dictation
                .toggle(surfaceUi(ctx, sendUser))
                .catch((err) => engine.notify(errorMessage(err), "error"));
          }
          return { consume: true };
        }
      } catch {
        // Never block terminal input.
      }
      return undefined;
    });
  };

  pi.registerShortcut(hotkeys.dictate as KeyId, {
    description: "Dictate: record, then press again to insert the transcript at the cursor",
    handler: async (ctx) => {
      attach(ctx);
      await engine.dictation.toggle(surfaceUi(ctx, sendUser));
    },
  });

  pi.registerShortcut(hotkeys.speak as KeyId, {
    description: "Open /speech with the cursor on its Speak line: type a message, Enter speaks it",
    handler: async (ctx) => {
      attach(ctx);
      await open(ctx);
    },
  });

  pi.registerCommand("speech", {
    description:
      "Speak text; dictate or transcribe into the editor with --dictate, --type, --transcribe; no arguments opens settings",
    getArgumentCompletions(prefix) {
      const words = prefix.split(/\s+/);
      if (words.length === 1 && words[0].startsWith("-")) {
        return ACTION_NAMES.map((a) => `--${a}`)
          .filter((a) => a.startsWith(words[0]))
          .map((a) => ({ value: a, label: a }));
      }
      const values = words.length === 2 ? ACTION_VALUES[words[0].slice(2)] : undefined;
      if (values) {
        return values.filter((v) => v.startsWith(words[1])).map((v) => ({ value: `${words[0]} ${v}`, label: v }));
      }
      return null;
    },
    async handler(args, ctx) {
      attach(ctx);
      try {
        if (args.trim() === RELOAD_ARG) {
          await ctx.reload();
          return;
        }
        // With a terminal UI, /speech alone opens the settings panel; elsewhere (RPC) the menu of dialogs.
        if (parse(args).kind === "menu" && hasTerminal(ctx)) {
          const rebind = await open(ctx);
          // A changed hotkey: reload Pi silently so it is bound at once (later, if the agent is running).
          if (rebind) {
            if (!ctx.isIdle()) {
              reloadRequested = true;
              return;
            }
            await ctx.reload();
            return;
          }
          return;
        }
        await surface.run(args, surfaceUi(ctx, sendUser));
      } catch (err) {
        ctx.ui.notify(errorMessage(err), "error");
      }
    },
  });

  pi.registerTool({
    name: SYNTHESIZE_TOOL,
    label: "Speech Synthesize",
    description:
      "Speak text aloud with the selected speech provider (OpenRouter, an OpenAI-compatible endpoint, or xai through the xAI login in Pi). Uses the saved speech model and voice unless given. " +
      "Saves the message in the speech history (newest 10 kept) and plays it unless play is false.",
    promptGuidelines: ["Use speech_synthesize when the user asks to say, read aloud, or speak text."],
    parameters: Type.Object({
      text: Type.String({ description: "Text to speak" }),
      model: Type.Optional(Type.String({ description: "Speech model for this call only (see /speech --models)" })),
      voice: Type.Optional(Type.String({ description: "Voice for this call only (see /speech --voices)" })),
      play: Type.Optional(Type.Boolean({ description: "Play the audio (default true)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      attach(ctx);
      try {
        const r = await engine.speech.speak(params.text, {
          model: params.model,
          voice: params.voice,
          play: params.play ?? true,
          signal,
        });
        return {
          content: [{ type: "text", text: describeForTool(r) }],
          details: { files: r.files, model: r.model, voice: r.voice, player: r.player ?? null, notPlayed: r.notPlayed },
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  });

  pi.registerTool({
    name: TRANSCRIBE_TOOL,
    label: "Speech Transcribe",
    description:
      "Transcribe an audio file (wav, mp3, flac, m4a, ogg, webm, aac) to text with the selected provider (OpenRouter, an OpenAI-compatible endpoint, or xai through the xAI login in Pi). " +
      "Uses the saved transcription model unless given.",
    promptGuidelines: ["Use speech_transcribe when the user wants the text of an audio file."],
    parameters: Type.Object({
      path: Type.String({ description: "Path of the audio file" }),
      model: Type.Optional(Type.String({ description: "Transcription model for this call only" })),
      language: Type.Optional(Type.String({ description: "ISO-639-1 language code, e.g. en" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      attach(ctx);
      try {
        const text = await engine.speech.transcribeFile(params.path, {
          cwd: ctx.cwd,
          model: params.model,
          language: params.language,
          signal,
        });
        return { content: [{ type: "text", text: text || "(empty transcription)" }], details: { path: params.path } };
      } catch (err) {
        return errorResult(err);
      }
    },
  });
}
