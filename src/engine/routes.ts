/**
 * Where audio plays and where dictation records: the Pi host ("local") or the user's playback machine
 * through the playback bridge. The bridge mode decides; nothing ever falls back to the other machine.
 *   auto  the bridge when Pi runs over SSH, else local
 *   on    the bridge
 *   off   local
 */

import { bridgeConfig } from "../bridge/config";
import { type BridgeAudio, bridgeUrl, createBridgeAudioFrom, displayUrl } from "../bridge/index";
import type { AudioInput, AudioOutput } from "./audio";
import { type Env, overSsh } from "./env";
import { LocalInput } from "./local-input";
import { LocalOutput } from "./local-output";
import type { BridgeMode } from "./settings";

export type RouteName = "local" | "bridge";

export interface RoutesOptions {
  env: Env;
  mode: BridgeMode;
  /** Replaceable for tests. */
  bridge?: BridgeAudio;
  localOutput?: AudioOutput;
  localInput?: AudioInput;
}

export interface Notice {
  message: string;
  level: "info" | "warning";
}

export class Routes {
  mode: BridgeMode;
  /** Pi runs over SSH (SSH_CONNECTION or SSH_TTY set and not empty). */
  readonly ssh: boolean;
  readonly bridge: BridgeAudio;
  private readonly env: Env;
  private readonly localOutput: AudioOutput;
  private readonly localInput: AudioInput;

  constructor(opts: RoutesOptions) {
    this.env = opts.env;
    this.mode = opts.mode;
    this.ssh = overSsh(opts.env);
    // The configuration is read per request, so a token file written after Pi started is picked up.
    this.bridge = opts.bridge ?? createBridgeAudioFrom(() => bridgeConfig(this.env));
    this.localOutput = opts.localOutput ?? new LocalOutput(opts.env);
    this.localInput = opts.localInput ?? new LocalInput(opts.env);
  }

  /** The route a mode selects. */
  routeFor(mode: BridgeMode): RouteName {
    return mode === "on" || (mode === "auto" && this.ssh) ? "bridge" : "local";
  }

  get route(): RouteName {
    return this.routeFor(this.mode);
  }

  output(): AudioOutput {
    return this.route === "bridge" ? this.bridge.output : this.localOutput;
  }

  /**
   * Where dictation records. It follows the route, except that in auto mode PI_SPEECH_LOCAL_MIC=1 says the
   * Pi host's microphone is the user's, so it records there even over SSH.
   */
  get inputRoute(): RouteName {
    return this.mode === "auto" && this.env.PI_SPEECH_LOCAL_MIC === "1" ? "local" : this.route;
  }

  input(): AudioInput {
    return this.inputRoute === "bridge" ? this.bridge.input : this.localInput;
  }

  /** The receiver URL for display (never with credentials). */
  get url(): string {
    return displayUrl(bridgeUrl(this.env));
  }

  private get why(): string {
    return this.ssh ? "Pi runs over SSH" : "Pi does not run over SSH";
  }

  /** The `Audio:` status line. */
  audioLine(): string {
    if (this.route === "bridge") {
      return this.mode === "auto" ? `Audio: bridge (${this.url}, auto: ${this.why})` : `Audio: bridge (${this.url})`;
    }
    return this.mode === "auto" ? "Audio: local (auto)" : "Audio: local";
  }

  /**
   * Change the mode. `on` checks the receiver first and throws (leaving the mode unchanged) when it does not
   * answer. Returns what to tell the user; the caller saves the mode.
   */
  async choose(mode: BridgeMode): Promise<Notice> {
    if (mode === "on") {
      const h = await this.bridge.health();
      if (!h.ok) throw new Error(`The bridge was not selected (audio stays ${this.route}): ${h.reason}`);
      this.mode = mode;
      return { message: `Audio: bridge (${this.url}), receiver ${h.version}`, level: "info" };
    }
    this.mode = mode;
    if (this.route === "local") return { message: this.audioLine(), level: "info" };
    const h = await this.bridge.health();
    return h.ok
      ? { message: `${this.audioLine()}, receiver ${h.version}`, level: "info" }
      : {
          message: `${this.audioLine()}, but the receiver does not answer: ${h.reason}. Nothing will play or record on this host in its place.`,
          level: "warning",
        };
  }

  /** The bridge report for `--bridge status`: mode, route, why, URL, and the receiver. */
  async report(): Promise<Notice> {
    const h = await this.bridge.health();
    return {
      message: [
        `Bridge mode: ${this.mode}`,
        `Route: ${this.route}`,
        this.mode === "auto" ? `Why: auto, ${this.why}` : `Why: chosen with /speech --bridge ${this.mode}`,
        `Bridge URL: ${this.url}`,
        h.ok ? `Receiver: pi-speech-receiver ${h.version}` : `Receiver: ${h.reason}`,
      ].join("\n"),
      level: h.ok ? "info" : "warning",
    };
  }

  /** What to announce at session start: the automatic bridge over SSH, with a warning when the receiver is down. */
  async announcement(): Promise<Notice | undefined> {
    if (this.mode !== "auto" || !this.ssh) return undefined;
    const h = await this.bridge.health();
    const base = `Pi runs over SSH, so speech plays and dictation records on your machine through the playback bridge (${this.url})`;
    return h.ok
      ? { message: `${base}.`, level: "info" }
      : {
          message: `${base}, but the receiver does not answer: ${h.reason}. Nothing will play or record on this host in its place.`,
          level: "warning",
        };
  }

  /** Every output, for stopping at shutdown. */
  outputs(): AudioOutput[] {
    return [this.localOutput, this.bridge.output];
  }
}
