/**
 * The Pi-independent engine: routes, player, speech operations, dictation, read-aloud, and the status
 * indicator, wired together. The Pi adapter (src/pi/) maps Pi's events, UI, and tools onto it.
 */

import { join } from "node:path";
import type { BridgeAudio } from "../bridge/index";
import type { AudioInput, AudioOutput } from "./audio";
import { Dictation } from "./dictation";
import { runDictationOutput } from "./dictation-output";
import type { Env } from "./env";
import { Indicator } from "./indicator";
import type { SpeechCatalog } from "./openrouter";
import { Player } from "./player";
import { type Notify, ReadAloud, type ReadAloudOptions } from "./read-aloud";
import { type Notice, Routes } from "./routes";
import { type BridgeMode, SettingsFile } from "./settings";
import { Speech } from "./speech";

export interface EngineOptions {
  /** Pi's agent directory; settings live in its `pi-speech/` directory. */
  agentDir: string;
  env: Env;
  home?: string;
  fetchCatalog?: () => Promise<SpeechCatalog>;
  bridge?: BridgeAudio;
  localOutput?: AudioOutput;
  localInput?: AudioInput;
}

export class Engine {
  readonly routes: Routes;
  readonly player: Player;
  readonly speech: Speech;
  readonly dictation: Dictation;
  readonly readAloud: ReadAloud;
  readonly indicator: Indicator;
  /** Where notifications go; the adapter points it at the current session's UI. */
  notify: Notify = () => {};
  /** Called after the tools setting changed. */
  onToolsChanged: () => void = () => {};
  private announced = false;

  constructor(opts: EngineOptions) {
    const settingsFile = new SettingsFile(join(opts.agentDir, "pi-speech"));
    const mode = settingsFile.load().bridge;
    this.routes = new Routes({
      env: opts.env,
      mode,
      bridge: opts.bridge,
      localOutput: opts.localOutput,
      localInput: opts.localInput,
    });
    this.indicator = new Indicator(() => ({
      dictation: this.dictation.indicator(),
      playing: this.player.playing,
      route: this.routes.route,
    }));
    this.player = new Player(() => this.routes.output(), {
      onChange: () => this.indicator.update(),
      onFailed: (error, kind) =>
        this.notify(
          `${kind === "sample" ? "The voice sample" : "Playback"} failed (${this.routes.route}): ${error}`,
          "error",
        ),
    });
    this.speech = new Speech({
      agentDir: opts.agentDir,
      settingsFile,
      player: this.player,
      env: opts.env,
      home: opts.home,
      fetchCatalog: opts.fetchCatalog,
    });
    this.speech.onWarning = (message) => this.notify(message, "warning");
    this.dictation = new Dictation({
      input: () => this.routes.input(),
      transcribe: (audio, format, signal, language) => this.speech.transcribeAudio(audio, format, { signal, language }),
      defaultLanguage: () => this.speech.settings.dictationLanguage,
      outputConfigured: () => !!this.speech.settings.dictationOutput,
      output: (text) => runDictationOutput(this.speech.settings.dictationOutput ?? "", text, opts.env),
      onChange: () => this.indicator.update(),
    });
    this.readAloud = new ReadAloud(
      this.speech,
      (m, l) => this.notify(m, l),
      () => this.speech.settings.readAloud,
    );
  }

  /** A session starts: reload the settings, load the catalog, and turn read-aloud off. */
  start(): void {
    this.speech.start();
    this.routes.mode = this.speech.settings.bridge;
    this.readAloud.mode = "off";
    this.announced = false;
    this.indicator.update();
  }

  /** The automatic bridge over SSH, announced once per session. */
  async announce(): Promise<Notice | undefined> {
    if (this.announced) return undefined;
    this.announced = true;
    return this.routes.announcement();
  }

  async setBridge(mode: BridgeMode): Promise<Notice> {
    const notice = await this.routes.choose(mode);
    this.speech.settings.bridge = mode;
    this.speech.save();
    this.indicator.update();
    return notice;
  }

  /** Change read-aloud's options and save them. */
  setReadAloudOptions(change: Partial<ReadAloudOptions>): void {
    const next = { ...this.speech.settings.readAloud, ...change };
    if ("summarizer" in change && !change.summarizer) delete next.summarizer;
    this.speech.settings.readAloud = next;
    this.speech.save();
  }

  async setTools(on: boolean): Promise<string> {
    const summary = await this.speech.set("tools", on ? "on" : "off");
    this.onToolsChanged();
    return summary;
  }

  /** The full status, one line per item. */
  async status(): Promise<string> {
    const d = this.dictation.state;
    return [
      ...(await this.speech.statusLines()),
      this.routes.audioLine(),
      `Read-aloud: ${this.readAloud.enabled ? `on (${this.readAloud.mode})` : "off"}`,
      `Dictation: ${d} (Alt+Z; records on ${this.routes.inputRoute === "bridge" ? "your machine through the bridge" : "this host"})`,
    ].join("\n");
  }

  /** The session ends: stop playback everywhere and drop a recording in progress. */
  async shutdown(): Promise<void> {
    await this.dictation.cancel();
    await this.player.stop();
  }
}
