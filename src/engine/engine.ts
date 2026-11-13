/**
 * The Pi-independent engine: routes, player, speech operations, dictation, read-aloud, and the status
 * indicator, wired together. The Pi adapter (src/pi/) maps Pi's events, UI, and tools onto it.
 */

import { join } from "node:path";
import {
  addressOf,
  type BridgeAudio,
  type BridgeProbe,
  bridgeConfig,
  bridgeTarget,
  bridgeToken,
  DEFAULT_URL,
  probeBridge,
  requestPairingCode,
  saveBridgeToken,
  sendPairingCode,
} from "../bridge/index";
import type { AudioInput, AudioOutput } from "./audio";
import { Dictation } from "./dictation";
import { runDictationOutput } from "./dictation-output";
import type { Env } from "./env";
import { Indicator } from "./indicator";
import type { LocalModels } from "./local-models";
import type { SpeechCatalog } from "./openrouter";
import { Player } from "./player";
import { type Notify, ReadAloud, type ReadAloudOptions } from "./read-aloud";
import { DIRECTION_LABELS, type Notice, Routes } from "./routes";
import { type BridgeMode, type DirectionSetting, type Machine, SettingsFile } from "./settings";
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
  /** The on-device models (default: through the bundled binary). */
  local?: LocalModels;
}

/** What Enter on an address in Pairing led to: the receiver takes the token, or it shows a pairing code. */
export type PairStart =
  | { state: "connected"; probe: BridgeProbe & { ok: true } }
  | { state: "code"; address: string; expiresIn: number };

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
  /** Probe the receiver once, as the configuration stands now (the Pairing row of Bridge connection). */
  probeBridge: () => Promise<BridgeProbe>;
  readonly env: Env;

  constructor(opts: EngineOptions) {
    this.env = opts.env;
    this.probeBridge = () => probeBridge(() => bridgeConfig(opts.env, this.speech.settings.bridgeAddress));
    const settingsFile = new SettingsFile(join(opts.agentDir, "pi-speech"));
    const mode = settingsFile.load().bridge;
    this.routes = new Routes({
      env: opts.env,
      mode,
      bridge: opts.bridge,
      localOutput: opts.localOutput,
      localInput: opts.localInput,
      directions: () => this.speech.settings,
      address: () => this.speech.settings.bridgeAddress,
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
          `${kind === "sample" ? "The voice sample" : "Playback"} failed (${this.routes.outputRoute}): ${error}`,
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
      local: opts.local,
    });
    this.speech.onWarning = (message) => this.notify(message, "warning");
    // Run models on: Local sources run on the Remote machine while the bridge is in use and it says so.
    this.speech.local.remote = () => {
      if (this.routes.modelsRoute !== "bridge") return undefined;
      const models = this.routes.bridge.models;
      if (models) return models;
      const no = () => Promise.reject(new Error("this bridge cannot run models on the Remote machine"));
      return { list: no, voices: no, transcribe: no, speak: no };
    };
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

  /**
   * Set Play audio on, Record audio on or Run models on, and save it. Without the bridge in use everything runs on
   * This machine, so it throws why instead. Returns what to tell the user, with a warning for a choice that needs
   * this host's own speakers or microphone while Pi runs over SSH.
   */
  setDirection(direction: DirectionSetting, machine: Machine): Notice {
    if (this.routes.route !== "bridge") {
      throw new Error(
        `Without the bridge in use (Bridge ${this.routes.mode}${this.routes.mode === "auto" ? ", Pi does not run over SSH" : ""}), audio plays and records and models run on This machine`,
      );
    }
    this.speech.settings[direction] = machine;
    this.speech.save();
    const said = `${DIRECTION_LABELS[direction]}: ${machine === "this" ? "This machine" : "Remote machine"}`;
    if (machine === "this" && this.routes.ssh && direction !== "modelsOn") {
      const needs = direction === "playOn" ? "speakers" : "a microphone";
      return { message: `${said} (Pi runs over SSH: this needs ${needs} on This machine)`, level: "warning" };
    }
    return { message: said, level: "info" };
  }

  /** Save the address typed in Pairing; empty, or the ssh forward's own, goes back to the default. */
  private saveAddress(address: string): void {
    const url = address.trim() ? bridgeTarget(this.env, address).url : "";
    if (!url || url === DEFAULT_URL) delete this.speech.settings.bridgeAddress;
    else this.speech.settings.bridgeAddress = addressOf(url);
    this.speech.save();
  }

  /**
   * Enter on an address in Pairing (empty: the default, PI_SPEECH_BRIDGE_URL or the ssh forwards): probe it with
   * the token of This machine; when it answers, keep the address. When no token works there, ask the receiver for
   * a pairing code, which it shows on its own terminal. Throws when it cannot be reached.
   */
  async pairAt(address: string): Promise<PairStart> {
    const target = bridgeTarget(this.env, address);
    let token: string | undefined;
    try {
      token = bridgeToken(this.env);
    } catch {
      token = undefined;
    }
    let at = target.url;
    if (token) {
      const probe = await probeBridge({ ...target, token });
      if (probe.ok) {
        this.saveAddress(address);
        return { state: "connected", probe };
      }
      if (probe.status !== 401) throw new Error(probe.reason);
      // Where it asked (a spare forward, once found).
      if (probe.address && probe.port) {
        const host = probe.address.includes(":") ? `[${probe.address}]` : probe.address;
        at = `http://${host}:${probe.port}`;
      }
    }
    const { expiresIn } = await requestPairingCode(at, { network: target.network });
    return { state: "code", address: addressOf(at), expiresIn };
  }

  /**
   * The code the receiver at `address` showed: the token it earns is saved as the token file, the address is
   * kept, and the receiver probed with it. Throws a PairingError for a wrong or expired code.
   */
  async pairWithCode(
    address: string,
    code: string,
  ): Promise<{ probe: BridgeProbe; file: string; overridden: boolean }> {
    const target = bridgeTarget(this.env, address);
    const token = await sendPairingCode(target.url, code, { network: target.network });
    const file = saveBridgeToken(this.env, token);
    this.saveAddress(address);
    const overridden = !!this.env.PI_SPEECH_BRIDGE_TOKEN?.trim();
    const probe = await probeBridge({ ...target, token });
    return { probe, file, overridden };
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
