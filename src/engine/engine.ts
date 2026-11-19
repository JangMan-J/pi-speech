/**
 * The Pi-independent engine: routes, player, speech operations, dictation, read-aloud, and the status
 * indicator, wired together. The Pi adapter (src/pi/) maps Pi's events, UI, and tools onto it.
 */

import { statSync } from "node:fs";
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
} from "../bridge/client";
import type { AudioInput, AudioOutput } from "./audio";
import {
  binaryFor,
  ensureBinaryFor,
  expectedReceiverVersion,
  hasBinaryFor,
  isReceiverOutdated,
  releaseAssetSize,
} from "./binary";
import { Dictation } from "./dictation";
import { DictationRuleCache } from "./dictation-rules";
import { Downloads } from "./downloads";
import { type Env, errorMessage } from "./env";
import { Indicator } from "./indicator";
import { jingConfigPath } from "./jing-config";
import { canLiveDictate, type LocalModels } from "./local-models";
import { Player } from "./player";
import type { SpeechCatalog } from "./provider";
import { type Notify, ReadAloud, type ReadAloudHost, type ReadAloudOptions, type ReadMode } from "./read-aloud";
import { ReceiverControl } from "./receiver-control";
import { createRedirect } from "./redirect";
import { connectRemote, libraries, type RemoteLink, type RemotePrompts } from "./remote";
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
  /** Host callbacks for ReadAloud (Pi models, current model, summarizer). */
  readAloudHost?: Partial<ReadAloudHost>;
  /** The expected receiver version (default: this package's version). */
  receiverVersion?: string;
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
  /** The on-device model download in progress; it outlives the settings panel that started it. */
  readonly downloads: Downloads;
  readonly indicator: Indicator;
  readonly receivers: ReceiverControl;
  /** Where notifications go; the adapter points it at the current session's UI. */
  notify: Notify = () => {};
  /** Called after the tools setting changed. */
  onToolsChanged: () => void = () => {};
  private announced = false;
  /** Probe the receiver once, as the configuration stands now (the Pairing row of Bridge connection). */
  probeBridge: () => Promise<BridgeProbe>;
  readonly env: Env;
  /** The receiver version this extension expects. */
  readonly receiverVersion: string | undefined;

  constructor(opts: EngineOptions) {
    this.env = opts.env;
    this.receiverVersion = opts.receiverVersion ?? expectedReceiverVersion();
    this.probeBridge = () => probeBridge(() => bridgeConfig(opts.env, this.bridgeAddress(), this.linkToken()));
    const settingsFile = new SettingsFile(join(opts.agentDir, "pi-speech"), jingConfigPath(opts.env));
    const mode = settingsFile.load().bridge;
    this.routes = new Routes({
      env: opts.env,
      mode,
      bridge: opts.bridge,
      localOutput: opts.localOutput,
      localInput: opts.localInput,
      directions: () => this.speech.settings,
      address: () => this.bridgeAddress(),
      token: () => this.linkToken(),
    });
    this.indicator = new Indicator(() => ({
      dictation: this.dictation.indicator(),
      dictationPhase: this.dictation.phase(),
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
      remoteModels: () => this.routes.remoteModels(),
    });
    this.speech.onWarning = (message) => this.notify(message, "warning");
    const rules = new DictationRuleCache();
    this.dictation = new Dictation({
      input: () => this.routes.input(),
      transcribe: (audio, format, signal, language) => this.speech.transcribeAudio(audio, format, { signal, language }),
      defaultLanguage: () => this.speech.settings.dictationLanguage,
      prepare: (language) => this.speech.prepareTranscription(language),
      liveEnabled: () => Boolean(this.speech.settings.dictationLive),
      redirectEnabled: () => Boolean(this.speech.settings.dictationRedirect),
      redirect: createRedirect({ env: opts.env }),
      liveCapable: () => canLiveDictate(this.speech.settings),
      previewTransform: (text) => rules.preview(text, this.speech.settings.dictationVocabulary),
      finalize: (rawText) => {
        const s = this.speech.settings;
        return rules.finalize(rawText, s.dictationVocabulary, s.dictationCommands, s.dictationSubmitWord);
      },
      onChange: () => this.indicator.update(),
    });
    this.downloads = new Downloads(
      () => this.speech.local,
      (direction, id) => this.speech.setLocalModel(direction, id),
    );
    this.readAloud = new ReadAloud(
      this.speech,
      (m, l) => this.notify(m, l),
      () => this.speech.settings.readAloud,
      { speaking: () => this.player.playing },
      opts.readAloudHost,
    );
    this.receivers = new ReceiverControl(this);
  }

  // ── The Remote machine over SSH (Connect) ──────────────────────────────

  /** The SSH connection to the Remote machine, while there is one. */
  private link?: RemoteLink;
  /** What Connect is doing; `lost` and `failed` say why in `remoteError`. */
  remoteState: "off" | "connecting" | "connected" | "lost" | "failed" = "off";
  remoteError?: string;
  /** Called on every change of the connection (the panel follows it). */
  onRemoteChange: () => void = () => {};

  /** Where the bridge reaches the receiver: the SSH forward while connected, else the address saved in Pairing. */
  bridgeAddress(): string | undefined {
    return this.link?.alive() ? this.link.address : this.speech.settings.bridgeAddress;
  }

  /** The token of the Remote machine's receiver while connected over SSH. */
  private linkToken(): string | undefined {
    return this.link?.alive() ? this.link.token : undefined;
  }

  /** The destination connected to (or to be reconnected to), if any. */
  get remoteHost(): string | undefined {
    return this.link?.dest ?? this.speech.settings.remoteHost;
  }

  /** The connected Remote machine's running receiver version, when connected over SSH. */
  get remoteVersion(): string | undefined {
    return this.link?.version;
  }

  /** The connected Remote machine's running receiver edition (`cpu` or `gpu`), when known. */
  get remoteEdition(): "cpu" | "gpu" | undefined {
    return this.link?.edition;
  }

  /** The connected Remote machine's OS/arch (`linux-x64`), when known. */
  get remotePlatform(): string | undefined {
    return this.link?.platform;
  }

  /** Whether the connected Remote machine's running receiver is older than this extension's. */
  get remoteOutdated(): boolean {
    return (
      this.remoteState === "connected" &&
      (this.link?.outdated === true || isReceiverOutdated(this.link?.version, this.receiverVersion))
    );
  }

  private setRemote(state: Engine["remoteState"], error?: string): void {
    this.remoteState = state;
    this.remoteError = error;
    this.onRemoteChange();
  }

  /**
   * Connect to `dest` over SSH (see remote.ts) and use its receiver: the bridge goes on, with the audio here and
   * the models there unless Pi runs over SSH. Remembered, and reconnected to at the next session start. Throws
   * what failed.
   */
  async connectRemote(
    dest: string,
    prompts: RemotePrompts,
    opts: { update?: boolean | "force"; targetOverride?: string } = {},
  ): Promise<RemoteLink> {
    await this.disconnectRemote(false, { keepBridge: true });
    this.setRemote("connecting");
    let link: RemoteLink;
    try {
      link = await connectRemote(dest, prompts, {
        env: this.env as NodeJS.ProcessEnv,
        binaryFor: (platform) => ensureBinaryFor(platform, this.env),
        hasBinaryFor: (platform) => hasBinaryFor(platform, this.env),
        binarySizeFor: (platform) => {
          const onDisk = binaryFor(platform, this.env);
          if (onDisk) return [onDisk, ...libraries(onDisk)].reduce((n, f) => n + statSync(f).size, 0);
          return releaseAssetSize(platform);
        },
        version: this.receiverVersion,
        ...(opts.update !== undefined ? { update: opts.update } : {}),
        ...(opts.targetOverride !== undefined ? { targetOverride: opts.targetOverride } : {}),
      });
    } catch (err) {
      this.setRemote("failed", errorMessage(err));
      throw err;
    }
    // The receiver's token stays in the link, in memory: never written down here.
    this.link = link;
    link.onLost = () => {
      if (this.link !== link) return;
      this.link = undefined;
      this.setRemote("lost", `the connection to ${link.dest} ended`);
      this.notify(
        `Remote machine: the connection to ${link.dest} ended (Enter on Remote machine reconnects)`,
        "warning",
      );
    };
    this.speech.settings.remoteHost = link.dest;
    this.speech.save();
    try {
      await this.setBridge("on");
      if (!this.routes.ssh) {
        this.setDirection("playOn", "this");
        this.setDirection("recordOn", "this");
        this.setDirection("modelsOn", "remote");
      }
    } catch (err) {
      await this.disconnectRemote(false);
      this.setRemote("failed", errorMessage(err));
      throw err;
    }
    this.setRemote("connected");
    return link;
  }

  /**
   * Close the SSH connection and stop routing through its bridge (unless `keepBridge` is set for session teardown
   * or reconnect replacement). With `forget`, also remove `remoteHost` from settings.
   */
  async disconnectRemote(forget = true, opts: { keepBridge?: boolean } = {}): Promise<void> {
    const link = this.link;
    this.link = undefined;
    if (link) await link.close();
    if (forget) {
      delete this.speech.settings.remoteHost;
      this.speech.save();
    }
    if (!opts.keepBridge && this.routes.mode === "on" && !this.routes.ssh) {
      await this.setBridge("auto").catch(() => {});
    }
    this.setRemote("off");
  }

  /** Re-install the bundled receiver binary on the connected Remote machine over SSH and reconnect. */
  async updateRemoteReceiver(prompts: RemotePrompts, opts: { targetOverride?: string } = {}): Promise<RemoteLink> {
    const host = this.remoteHost;
    if (!host) throw new Error("not connected to a Remote machine");
    return this.connectRemote(host, prompts, { update: "force", ...opts });
  }

  /** At a session start: reconnect to the machine remembered when Device was left Remote, without prompting. */
  private reconnect(): void {
    const dest = this.speech.settings.remoteHost;
    if (
      !dest ||
      this.speech.settings.bridge !== "on" ||
      this.link ||
      this.remoteState === "connecting" ||
      this.routes.ssh
    )
      return;
    const quiet: RemotePrompts = { password: async () => undefined, confirm: async () => false, progress: () => {} };
    this.connectRemote(dest, quiet)
      .then((link) => {
        if (link.outdated || isReceiverOutdated(link.version, this.receiverVersion)) {
          const ver = link.version || "an older version";
          const exp = this.receiverVersion ? ` (this extension expects ${this.receiverVersion})` : "";
          this.notify(
            `pi-speech-receiver on ${link.dest} is ${ver}${exp}: open /speech > Receivers and press u on Receiver to update`,
            "warning",
          );
        }
      })
      .catch(() => {
        // Without a live SSH link or manual bridge URL, do not strand this session on a tokenless localhost bridge.
        if (
          this.routes.mode === "on" &&
          !this.speech.settings.bridgeAddress &&
          !this.env.PI_SPEECH_BRIDGE_URL?.trim() &&
          !this.routes.ssh
        ) {
          this.routes.mode = "auto";
          this.indicator.update();
        }
      });
  }

  /** A session starts: reload the settings, load the catalog, and turn read-aloud off. */
  start(): void {
    this.speech.start();
    this.routes.mode = this.speech.settings.bridge;
    this.readAloud.mode = "off";
    this.announced = false;
    this.indicator.update();
    this.reconnect();
  }

  /** The automatic bridge over SSH, announced once per session (warning if the receiver is outdated). */
  async announce(): Promise<Notice | undefined> {
    if (this.announced) return undefined;
    this.announced = true;
    const notice = await this.routes.announcement();
    if (notice?.level === "info" && this.receiverVersion) {
      const h = await this.routes.bridge.health().catch(() => undefined);
      if (h?.ok && isReceiverOutdated(h.version, this.receiverVersion)) {
        return {
          message: `${notice.message} Receiver is ${h.version} (this extension expects ${this.receiverVersion}): update pi-speech-receiver on your machine.`,
          level: "warning",
        };
      }
    }
    return notice;
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

  /**
   * Set what read-aloud reads. Streaming cannot use Same model (the reply's own model is busy until the run
   * ends), so choosing it without a separate model chooses one: the session's model, else the first of the
   * user's. Saved like any Summarized by choice, so it stays when Summarized is chosen again.
   */
  setReadMode(mode: ReadMode): void {
    this.readAloud.mode = mode;
    if (mode !== "streaming" || this.speech.settings.readAloud.summarizer) return;
    const model = this.readAloud.defaultSummarizer();
    if (model) this.setReadAloudOptions({ summarizer: model });
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

  /** Replay the last spoken message from history; returns its file path or throws why it could not start. */
  async replay(): Promise<string> {
    const file = this.speech.lastMessage();
    if (!file) throw new Error("Nothing to replay: no spoken message in the history yet");
    const started = await this.player.play(file, "message");
    if (!started.ok) throw new Error(`Replay did not start: ${started.reason}`);
    return file;
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

  /** The session ends: stop playback everywhere, drop a recording in progress, and give up the Remote machine's lease. */
  async shutdown(): Promise<void> {
    await this.dictation.cancel();
    await this.player.stop();
    await this.disconnectRemote(false, { keepBridge: true });
    this.speech.closeWorkers();
  }
}
