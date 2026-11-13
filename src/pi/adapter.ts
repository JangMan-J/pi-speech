/**
 * The thin Pi adapter: maps Pi's session events, UI, shortcut, command, and tools onto the engine.
 * All behavior lives in src/engine/; this file only translates.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Engine } from "../engine/engine";
import { errorMessage } from "../engine/env";
import { STATUS_KEY } from "../engine/indicator";
import type { Panel } from "../engine/panel";
import { type Hotkeys, keyLabel } from "../engine/settings";
import type { SpeechResult } from "../engine/speech";
import { parse, Surface, type SurfaceUi } from "../engine/surface";
import { openPanel } from "./panel";
import { pick } from "./picker";

export const SYNTHESIZE_TOOL = "speech_synthesize";
/**
 * The hidden argument of /speech that reloads Pi: sent from agent_settled when a changed hotkey asked for a
 * reload while the agent was running (Pi cannot reload then).
 */
export const RELOAD_ARG = "--reload-hotkeys";
export const TRANSCRIBE_TOOL = "speech_transcribe";
const TOOLS = [SYNTHESIZE_TOOL, TRANSCRIBE_TOOL];

const ACTIONS = [
  "stop",
  "replay",
  "dictate",
  "type",
  "transcribe",
  "sample",
  "status",
  "models",
  "voices",
  "languages",
  "read-aloud",
  "bridge",
  "language",
  "set",
  "endpoints",
  "endpoint",
  "help",
];
const ACTION_VALUES: Record<string, string[]> = {
  "read-aloud": ["on", "off", "summary", "thinking", "all"],
  bridge: ["auto", "on", "off", "status"],
  set: ["tts-model", "voice", "stt-model", "stt-language", "tools", "dictation-output", "tts-source", "stt-source"],
};

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

/** The engine's view of one Pi context's UI. */
function surfaceUi(ctx: ExtensionContext): SurfaceUi {
  return {
    cwd: ctx.cwd,
    notify: (message, level) => ctx.ui.notify(message, level),
    paste: (text) => ctx.ui.pasteToEditor(text),
    select: (title, options) => ctx.ui.select(title, options),
    input: (title, placeholder) => ctx.ui.input(title, placeholder),
    pick: (title, options, current) =>
      hasTerminal(ctx) ? pick(ctx, title, options, current) : ctx.ui.select(title, options),
  };
}

/** The recording dot in the theme's error colour (red); every other status text stays plain. */
export function tintRecordingDot(
  text: string | undefined,
  theme: { fg(color: "error", text: string): string },
): string | undefined {
  return text?.startsWith("●") ? theme.fg("error", "●") + text.slice(1) : text;
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

  /** Follow the latest context: its UI hears notifications and shows the status; its registry has the key. */
  const attach = (ctx: ExtensionContext) => {
    latest = ctx;
    engine.speech.registry = ctx.modelRegistry;
    if (ctx.ui === ui) return;
    ui = ctx.ui;
    const current = ctx.ui;
    const tinted = hasTerminal(ctx) && !env.NO_COLOR;
    engine.indicator.attach((text) =>
      current.setStatus(STATUS_KEY, tinted ? tintRecordingDot(text, current.theme) : text),
    );
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

  pi.on("session_start", async (_event, ctx) => {
    attach(ctx);
    engine.start();
    applyTools();
    watchOptionKey(ctx);
    void engine.announce().then((n) => {
      if (n) engine.notify(n.message, n.level);
    });
  });

  pi.on("session_shutdown", async () => {
    await engine.shutdown();
  });

  // Read-aloud: the user's Pi models summarize when chosen (one extra request per reply).
  engine.readAloud.models = () => (latest ? piModels(latest) : []);
  engine.readAloud.summarize = (ref, prompt, signal) => {
    if (!latest) return Promise.reject(new Error("Pi's models are not available yet"));
    return summarizeWith(latest, ref, prompt, signal);
  };

  // Summary and Thinking with the same model: a guideline asks for a marked summary at the end of each reply.
  pi.on("before_agent_start", async (event, ctx) => {
    attach(ctx);
    engine.readAloud.onRunStart(event.systemPromptOptions.promptGuidelines);
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
  const open = (ctx: ExtensionContext, speak: boolean) =>
    openPanel(
      ctx,
      engine,
      surface,
      surfaceUi(ctx),
      env,
      (p) => {
        panel = p;
      },
      speak,
      hotkeys,
    );

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
    const chars = new Map<string, keyof Hotkeys>();
    for (const name of ["speak", "dictate"] as const) {
      const char = macOptionCharacter(hotkeys[name]);
      if (char) chars.set(char, name);
    }
    if (!chars.size) return;
    const current = ctx.ui;
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

  pi.registerShortcut(hotkeys.dictate as KeyId, {
    description: "Dictate: record, then press again to insert the transcript at the cursor (never sends)",
    handler: async (ctx) => {
      attach(ctx);
      await engine.dictation.toggle(surfaceUi(ctx));
    },
  });

  pi.registerShortcut(hotkeys.speak as KeyId, {
    description: "Speak messages: Enter speaks and clears the composer, ready for the next; Esc closes",
    handler: async (ctx) => {
      attach(ctx);
      await open(ctx, true);
    },
  });

  pi.registerCommand("speech", {
    description:
      "Speak text; dictate or transcribe into the editor with --dictate, --type, --transcribe; no arguments opens settings",
    getArgumentCompletions(prefix) {
      const words = prefix.split(/\s+/);
      if (words.length === 1 && words[0].startsWith("-")) {
        return ACTIONS.map((a) => `--${a}`)
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
          const rebind = await open(ctx, false);
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
        await surface.run(args, surfaceUi(ctx));
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
