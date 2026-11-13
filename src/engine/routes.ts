/**
 * Where audio plays, where dictation records and where Local sources run their models: This machine ("local") or
 * the Remote machine through the playback bridge. The bridge mode decides whether the bridge is in use; while it
 * is, Play audio on, Record audio on and Run models on choose each. Nothing ever falls back to the other machine.
 *   auto  the bridge when Pi runs over SSH, else local
 *   on    the bridge
 *   off   local
 */

import { type BridgeAudio, bridgeConfig, bridgeTarget, createBridgeAudioFrom, displayUrl } from "../bridge/index";
import type { AudioInput, AudioOutput } from "./audio";
import { type Env, overSsh } from "./env";
import { LocalInput } from "./local-input";
import { LocalOutput } from "./local-output";
import { type BridgeMode, DEFAULT_SETTINGS, type DirectionSetting, type Machine } from "./settings";

export type RouteName = "local" | "bridge";

export interface RoutesOptions {
  env: Env;
  mode: BridgeMode;
  /** Replaceable for tests. */
  bridge?: BridgeAudio;
  localOutput?: AudioOutput;
  localInput?: AudioInput;
  /** Play audio on, Record audio on, Run models on, as saved (default: all Remote machine). */
  directions?: () => Record<DirectionSetting, Machine>;
  /** The receiver's address saved in Bridge connection's Pairing, if any. */
  address?: () => string | undefined;
}

/** The rows of DIRECTION, as the panel and messages name them. */
export const DIRECTION_LABELS: Record<DirectionSetting, string> = {
  playOn: "Play audio on",
  recordOn: "Record audio on",
  modelsOn: "Run models on",
};

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
  private readonly directions: () => Record<DirectionSetting, Machine>;
  /** The saved address, if any. */
  readonly address: () => string | undefined;

  constructor(opts: RoutesOptions) {
    this.directions = opts.directions ?? (() => DEFAULT_SETTINGS);
    this.address = opts.address ?? (() => undefined);
    this.env = opts.env;
    this.mode = opts.mode;
    this.ssh = overSsh(opts.env);
    // The configuration is read per request, so a token file written after Pi started is picked up.
    this.bridge = opts.bridge ?? createBridgeAudioFrom(() => bridgeConfig(this.env, this.address()));
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

  /** Where one direction runs: the Remote machine only while the bridge is in use and the direction says so. */
  on(direction: DirectionSetting): RouteName {
    return this.route === "bridge" && this.directions()[direction] === "remote" ? "bridge" : "local";
  }

  /** Where audio plays. */
  get outputRoute(): RouteName {
    return this.on("playOn");
  }

  /** Where Local sources run their models. */
  get modelsRoute(): RouteName {
    return this.on("modelsOn");
  }

  output(): AudioOutput {
    if (this.outputRoute === "bridge") return this.bridge.output;
    return this.route === "bridge" ? this.plainOutput() : this.localOutput;
  }

  /**
   * Where dictation records: Record audio on, except that in auto mode PI_SPEECH_LOCAL_MIC=1 says This machine's
   * microphone is the user's, so it records there even over SSH.
   */
  get inputRoute(): RouteName {
    return this.mode === "auto" && this.env.PI_SPEECH_LOCAL_MIC === "1" ? "local" : this.on("recordOn");
  }

  input(): AudioInput {
    if (this.inputRoute === "bridge") return this.bridge.input;
    return this.route === "bridge" ? this.plainInput() : this.localInput;
  }

  /** Why a direction chosen as This machine failed while the bridge is in use, said plainly with the way out. */
  private plainly(direction: DirectionSetting, what: string, reason: string): string {
    const label = DIRECTION_LABELS[direction];
    const ssh = this.ssh ? ", and Pi runs over SSH" : "";
    return `${label} is This machine${ssh}: ${what} on This machine failed: ${reason}. To use the Remote machine, set ${label} to Remote machine (/speech, SETTINGS, Bridge connection)`;
  }

  /** This machine's output, its failures saying that Play audio on chose it. */
  private plainOutput(): AudioOutput {
    const local = this.localOutput;
    const say = (reason: string) => this.plainly("playOn", "playing", reason);
    return {
      name: local.name,
      stop: (kind) => local.stop(kind),
      async playStream(stream, kind) {
        const started = await local.playStream(stream, kind);
        if (!started.ok) return { ok: false, reason: say(started.reason) };
        const done = started.done.then((o) =>
          o.state === "failed" ? { state: "failed" as const, error: say(o.error) } : o,
        );
        return { ...started, done };
      },
    };
  }

  /** This machine's input, its failure to record saying that Record audio on chose it. */
  private plainInput(): AudioInput {
    const local = this.localInput;
    const say = (reason: string) => this.plainly("recordOn", "recording", reason);
    return {
      name: local.name,
      async start() {
        try {
          return await local.start();
        } catch (err) {
          throw new Error(say(err instanceof Error ? err.message : String(err)));
        }
      },
    };
  }

  /** The receiver URL for display (never with credentials): the spare forward in use once one was found. */
  get url(): string {
    try {
      const target = bridgeTarget(this.env, this.address());
      return displayUrl((target.ports && this.bridge.at?.()) || target.url);
    } catch {
      return "(invalid address)";
    }
  }

  private get why(): string {
    return this.ssh ? "Pi runs over SSH" : "Pi does not run over SSH";
  }

  /** The `Audio:` status line; with the bridge in use, what runs on This machine instead. */
  audioLine(): string {
    if (this.route === "bridge") {
      const here = (Object.keys(DIRECTION_LABELS) as DirectionSetting[])
        .filter((d) => this.directions()[d] === "this")
        .map((d) => DIRECTION_LABELS[d]);
      const also = here.length ? `; This machine: ${here.join(", ")}` : "";
      return this.mode === "auto"
        ? `Audio: bridge (${this.url}, auto: ${this.why}${also})`
        : `Audio: bridge (${this.url}${also})`;
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
