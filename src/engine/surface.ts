/**
 * The /speech command, Pi-free: `/speech` opens the menu (the Pi adapter opens the settings panel instead
 * when Pi has a terminal UI), `/speech <text>` speaks the text, and
 * `/speech --<action> [args]` runs an action. Direct editor actions (`--dictate`, `--type`, `--transcribe`)
 * insert text without submitting it. Anything that is not an explicit action is spoken, never interpreted;
 * `/speech -- <text>` speaks text that starts with dashes.
 */

import { basename } from "node:path";
import type { DictationUi } from "./dictation";
import type { Engine } from "./engine";
import { REPLACED } from "./player";
import { READ_MODES, type ReadMode } from "./read-aloud";
import { ReadingFailed, readingFailedMessage } from "./reading";
import type { BridgeMode } from "./settings";
import { languageLabel, type SampleResult, SETTING_NAMES, type SpeechResult } from "./speech";

export interface SurfaceUi extends DictationUi {
  /** Base for a relative audio path passed to --transcribe. */
  cwd: string;
  select(title: string, options: string[]): Promise<string | undefined>;
  /** A searchable picker for long lists; `current` is preselected when the UI can. */
  pick(title: string, options: string[], current?: string): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

interface ActionSpec {
  args: string;
  help: string;
  /** Allowed number of words after the action. */
  min: number;
  max: number;
}

const ACTIONS: Record<string, ActionSpec> = {
  stop: { args: "", help: "stop what is playing", min: 0, max: 0 },
  replay: { args: "", help: "play the last message again", min: 0, max: 0 },
  dictate: {
    args: "[language|auto]",
    help: "start dictation, or stop it and insert the transcript; optional language for this recording",
    min: 0,
    max: 1,
  },
  type: { args: "<text>", help: "insert literal text into the editor without submitting it", min: 1, max: 1 },
  transcribe: {
    args: "<audio-file> [language|auto]",
    help: "insert an audio file's transcript into the editor without submitting it",
    min: 1,
    max: 2,
  },
  sample: { args: "[voice]", help: "play a sample of a voice in its language", min: 0, max: 1 },
  status: { args: "", help: "show the settings and what speech is doing", min: 0, max: 0 },
  models: { args: "", help: "list speech and transcription models with prices", min: 0, max: 0 },
  voices: { args: "", help: "list the voices of the speech model", min: 0, max: 0 },
  languages: { args: "", help: "list the voice languages of the speech model", min: 0, max: 0 },
  "read-aloud": {
    args: "on|off|summary|thinking|all",
    help: "speak the final reply of each run, or a spoken summary of it",
    min: 1,
    max: 1,
  },
  bridge: { args: "auto|on|off|status", help: "play and record on your machine through the bridge", min: 1, max: 1 },
  language: { args: "<voice> <tag|auto>", help: "set or remove the language of a voice", min: 2, max: 2 },
  set: { args: `${SETTING_NAMES.join("|")} <value>`, help: "change a setting", min: 2, max: Infinity },
  endpoints: { args: "", help: "list the OpenAI-compatible speech endpoints and what they offer", min: 0, max: 0 },
  endpoint: {
    args: "<name> <base-url|off> [key|KEY_ENV]",
    help: "add (or remove) a speech endpoint that follows the OpenAI audio API",
    min: 2,
    max: 3,
  },
  help: { args: "", help: "show this help", min: 0, max: 0 },
};

export function usage(): string {
  const rows: Array<[string, string]> = [
    ["/speech", "open the settings panel (a menu without a terminal UI)"],
    ["/speech <text>", "speak the text"],
    ["/speech -- <text>", "speak text that starts with dashes"],
    ...Object.entries(ACTIONS).map(([name, a]): [string, string] => [
      `/speech --${name}${a.args ? ` ${a.args}` : ""}`,
      a.help,
    ]),
  ];
  const width = Math.max(...rows.map(([c]) => c.length));
  return ["Usage:", ...rows.map(([c, h]) => `  ${c.padEnd(width)}  ${h}`), "Alt+Z toggles dictation."].join("\n");
}

export type Parsed =
  | { kind: "menu" }
  | { kind: "speak"; text: string }
  | { kind: "action"; name: string; args: string[] }
  | { kind: "error"; message: string };

export function parse(input: string): Parsed {
  const text = input.trim();
  if (!text) return { kind: "menu" };
  if (text === "--" || /^--\s/.test(text)) {
    const rest = text.slice(2).trim();
    return rest ? { kind: "speak", text: rest } : { kind: "error", message: `Nothing to say after --\n${usage()}` };
  }
  if (!text.startsWith("--")) return { kind: "speak", text };
  // Literal editor text keeps its internal whitespace and may itself start with dashes.
  if (text === "--type" || text.startsWith("--type ")) {
    const value = text.slice("--type".length).trim();
    return value
      ? { kind: "action", name: "type", args: [value] }
      : { kind: "error", message: `Nothing to insert after --type\n${usage()}` };
  }
  const [word, ...args] = text.split(/\s+/);
  const name = word.slice(2);
  const spec = ACTIONS[name];
  if (!spec) {
    return { kind: "error", message: `Unknown action ${word}. To speak it, use /speech -- ${text}\n${usage()}` };
  }
  if (args.length < spec.min || args.length > spec.max) {
    const form = `/speech --${name}${spec.args ? ` ${spec.args}` : ""}`;
    return {
      kind: "error",
      message: `${spec.max === 0 ? `--${name} takes no arguments` : `Usage: ${form}`}\n${usage()}`,
    };
  }
  return { kind: "action", name, args };
}

/** What happened to a message, briefly. */
export function describeSpoken(r: SpeechResult): { message: string; level: "info" | "warning" } {
  if (r.stopped) return { message: "Stopped.", level: "info" };
  if (r.player) return { message: `Speaking with ${r.voice} (${r.model})`, level: "info" };
  return { message: `Saved, but not played: ${r.notPlayed ?? "unknown reason"}`, level: "warning" };
}

export function describeSample(r: SampleResult): { message: string; level: "info" | "warning" } {
  const vl = r.voiceLanguage;
  const lines = [`Sample of ${r.voice} (${r.model}) in ${r.language}`];
  if (vl.status === "unknown" || vl.status === "multilingual") lines.push(`Voice language: ${vl.status}`);
  else lines.push(`Voice language: ${languageLabel(vl)} (${vl.status === "override" ? "override" : vl.evidence})`);
  if (r.notice) lines.push(r.notice);
  if (!r.player) lines.push(`Not played: ${r.notPlayed ?? "unknown reason"}`);
  return { message: lines.join("\n"), level: r.player || r.notPlayed === REPLACED ? "info" : "warning" };
}

const BRIDGE_ARGS = ["auto", "on", "off", "status"];

/** Runs /speech for one UI. Errors are thrown as readable Errors for the caller to show. */
export class Surface {
  constructor(private readonly engine: Engine) {}

  async run(args: string, ui: SurfaceUi): Promise<void> {
    const p = parse(args);
    switch (p.kind) {
      case "menu":
        return this.menu(ui);
      case "speak":
        return this.speak(p.text, ui);
      case "error":
        throw new Error(p.message);
      case "action":
        return this.action(p.name, p.args, ui);
    }
  }

  private get speech() {
    return this.engine.speech;
  }

  async speak(text: string, ui: SurfaceUi): Promise<void> {
    let r: SpeechResult;
    try {
      r = await this.speech.say(text);
    } catch (err) {
      if (err instanceof ReadingFailed) throw new Error(readingFailedMessage("Speech", "text", err.reason));
      throw err;
    }
    const d = describeSpoken(r);
    ui.notify(d.message, d.level);
  }

  async sample(voice: string | undefined, ui: SurfaceUi): Promise<void> {
    const d = describeSample(await this.speech.sample(voice));
    ui.notify(d.message, d.level);
  }

  async stop(ui: SurfaceUi): Promise<void> {
    const was = await this.engine.player.stop();
    ui.notify(was ? "Stopped" : "Nothing was playing", "info");
  }

  async replay(ui: SurfaceUi): Promise<void> {
    const file = this.speech.lastMessage();
    if (!file) throw new Error("Nothing to replay: no spoken message in the history yet");
    const started = await this.engine.player.play(file, "message");
    if (!started.ok) throw new Error(`Replay did not start: ${started.reason}`);
    ui.notify(`Replaying ${basename(file)}`, "info");
  }

  async setBridge(arg: string, ui: SurfaceUi): Promise<void> {
    if (arg === "status") {
      const r = await this.engine.routes.report();
      ui.notify(r.message, r.level);
      return;
    }
    if (!BRIDGE_ARGS.includes(arg)) throw new Error(`Usage: /speech --bridge ${BRIDGE_ARGS.join("|")}`);
    const n = await this.engine.setBridge(arg as BridgeMode);
    ui.notify(n.message, n.level);
  }

  /** on: the whole reply, unless a summary mode is already chosen; or a mode by name. */
  setReadAloud(on: boolean | ReadMode, ui: SurfaceUi): void {
    const r = this.engine.readAloud;
    if (typeof on === "boolean") r.enabled = on;
    else r.mode = on;
    const what: Record<ReadMode, string> = {
      off: "off",
      all: "on (the final reply of each run is spoken)",
      summary: "summary (a spoken summary of each reply is read)",
      thinking: "thinking (a spoken summary of the reasoning, then of the reply, is read)",
    };
    ui.notify(`Read-aloud: ${what[r.mode]}`, "info");
  }

  async set(name: string, value: string, ui: SurfaceUi): Promise<void> {
    if (name === "tools") {
      if (value !== "on" && value !== "off") throw new Error(`tools must be on or off, not ${value || "empty"}`);
      ui.notify(await this.engine.setTools(value === "on"), "info");
      return;
    }
    ui.notify(await this.speech.set(name, value), "info");
  }

  private async action(name: string, args: string[], ui: SurfaceUi): Promise<void> {
    switch (name) {
      case "stop":
        return this.stop(ui);
      case "replay":
        return this.replay(ui);
      case "dictate":
        return this.engine.dictation.toggle(ui, args[0]);
      case "type":
        ui.paste(args[0]);
        return;
      case "transcribe": {
        const language = args[1] === "auto" ? undefined : (args[1] ?? this.speech.settings.dictationLanguage);
        const text = (await this.speech.transcribeFile(args[0], { cwd: ui.cwd, language })).trim();
        if (!text) throw new Error("Transcription failed: no speech was recognized in the audio file");
        ui.paste(text);
        return;
      }
      case "sample":
        return this.sample(args[0], ui);
      case "status":
        ui.notify(await this.engine.status(), "info");
        return;
      case "models":
        ui.notify(await this.speech.modelsReport(), "info");
        return;
      case "voices":
        ui.notify(await this.speech.voicesReport(), "info");
        return;
      case "languages":
        ui.notify(await this.speech.languagesReport(), "info");
        return;
      case "help":
        ui.notify(usage(), "info");
        return;
      case "read-aloud":
        if (args[0] === "on" || args[0] === "off") return this.setReadAloud(args[0] === "on", ui);
        if (!READ_MODES.includes(args[0] as ReadMode)) {
          throw new Error(`Usage: /speech --read-aloud on|off|summary|thinking|all`);
        }
        return this.setReadAloud(args[0] as ReadMode, ui);
      case "bridge":
        return this.setBridge(args[0], ui);
      case "language":
        ui.notify(await this.speech.setLanguage(args[0], args[1]), "info");
        return;
      case "set":
        return this.set(args[0], args.slice(1).join(" "), ui);
      case "endpoints":
        ui.notify(await this.speech.endpointsReport(), "info");
        return;
      case "endpoint":
        ui.notify(
          args[1] === "off"
            ? await this.speech.removeEndpoint(args[0])
            : await this.speech.setEndpoint(args[0], args[1], args[2]),
          "info",
        );
        return;
    }
  }

  // ── The menu ──────────────────────────────────────────────────────────────

  /** The menu: choosing an entry acts or opens the next step; Escape goes back. */
  async menu(ui: SurfaceUi): Promise<void> {
    await this.speech.ready();
    // Loads the xAI voice list (and with it the voice languages) for the labels; a failure shows later.
    await this.speech.voicesFor(this.speech.settings.speechModel).catch(() => undefined);
    for (;;) {
      const entries = this.entries();
      const choice = await ui.select(
        "Speech",
        entries.map((e) => e.label),
      );
      const entry = entries.find((e) => e.label === choice);
      if (!entry) return;
      if ((await entry.run(ui)) === "done") return;
    }
  }

  private entries(): Array<{ label: string; run: (ui: SurfaceUi) => Promise<"done" | "back"> }> {
    const e = this.engine;
    const s = this.speech.settings;
    const routes = e.routes;
    const recording = e.dictation.state === "recording" || e.dictation.state === "starting";
    const done = async (p: Promise<void> | void) => {
      await p;
      return "done" as const;
    };
    const vl = this.speech.languageOf(s.speechModel, s.voice);
    return [
      {
        label: "Speak text…",
        run: async (ui) => {
          const text = (await ui.input("Text to speak"))?.trim();
          return text ? done(this.speak(text, ui)) : "back";
        },
      },
      { label: "Stop", run: (ui) => done(this.stop(ui)) },
      { label: "Replay last", run: (ui) => done(this.replay(ui)) },
      {
        label: recording ? "Dictate: stop and insert (Alt+Z)" : "Dictate (Alt+Z)",
        run: (ui) => done(e.dictation.toggle(ui)),
      },
      {
        label: "Sample a voice…",
        run: async (ui) => {
          const voice = await this.pickVoice(ui, "Sample a voice");
          return voice ? done(this.sample(voice, ui)) : "back";
        },
      },
      {
        label: `Read-aloud: ${e.readAloud.enabled ? "on (select to turn off)" : "off (select to turn on)"}`,
        run: (ui) => done(this.setReadAloud(!e.readAloud.enabled, ui)),
      },
      {
        label: `Audio: ${routes.mode} (${routes.route})…`,
        run: async (ui) => {
          const options = [
            "auto: the bridge when Pi runs over SSH, else this host",
            "on: always the bridge",
            "off: always this host",
            "status: check the receiver",
          ];
          const choice = await ui.select(`Audio (now ${routes.mode})`, options);
          return choice ? done(this.setBridge(choice.split(":")[0], ui)) : "back";
        },
      },
      {
        label: `Speech model: ${s.speechModel}…`,
        run: async (ui) => {
          const id = await this.pickModel(ui, "Speech model", (await this.speech.models()).tts, s.speechModel);
          return id ? done(this.set("tts-model", id, ui)) : "back";
        },
      },
      {
        label: `Voice: ${s.voice}…`,
        run: async (ui) => {
          const voice = await this.pickVoice(ui, "Voice");
          return voice ? done(this.set("voice", voice, ui)) : "back";
        },
      },
      {
        label: `Voice language: ${s.voice} is ${languageLabel(vl)}…`,
        run: async (ui) => {
          const voice = await this.pickVoice(ui, "Voice language of", true);
          if (!voice) return "back";
          const tag = (await ui.input(`Language of ${voice}: a tag such as ja or pt-BR, or auto`, "auto"))?.trim();
          return tag ? done(ui.notify(await this.speech.setLanguage(voice, tag), "info")) : "back";
        },
      },
      {
        label: `Transcription model: ${s.transcriptionModel}…`,
        run: async (ui) => {
          const id = await this.pickModel(
            ui,
            "Transcription model",
            (await this.speech.models()).stt,
            s.transcriptionModel,
          );
          return id ? done(this.set("stt-model", id, ui)) : "back";
        },
      },
      {
        label: `Tools: ${s.tools ? "on (select to turn off)" : "off (select to turn on)"}`,
        run: (ui) => done(this.set("tools", s.tools ? "off" : "on", ui)),
      },
      { label: "Status", run: async (ui) => done(ui.notify(await e.status(), "info")) },
    ];
  }

  private async pickModel(
    ui: SurfaceUi,
    title: string,
    models: Array<{ id: string; price?: string }>,
    current: string,
  ): Promise<string | undefined> {
    const label = (m: { id: string; price?: string }) => (m.price ? `${m.id}  ${m.price}` : m.id);
    const labels = models.map(label);
    const chosen = await ui.pick(
      `${title} (price per minute; ~ is an estimate)`,
      labels,
      labels[models.findIndex((m) => m.id === current)],
    );
    return chosen === undefined ? undefined : models[labels.indexOf(chosen)]?.id;
  }

  private async pickVoice(ui: SurfaceUi, title: string, withLanguage = false): Promise<string | undefined> {
    const model = this.speech.settings.speechModel;
    const voices = await this.speech.voicesFor(model);
    const labels = voices.map((v) => (withLanguage ? `${v}  ${languageLabel(this.speech.languageOf(model, v))}` : v));
    const current = labels[voices.indexOf(this.speech.settings.voice)];
    const chosen = await ui.pick(`${title} (${model})`, labels, current);
    return chosen === undefined ? undefined : voices[labels.indexOf(chosen)];
  }
}
