/**
 * Receiver lifecycle, binary management, GPU edition switching, SSH connection, and bridge pairing
 * behind Engine: keeps OS/binary/SSH/bridge details out of the settings panel view model.
 */

import { type BridgeHealth, type BridgeProbe, bridgeTarget, displayUrl, PairingError } from "../bridge/client";
import {
  ensureBinary,
  ensureBinaryFor,
  findBinary,
  hasBinaryFor,
  inspectLocalBinary,
  isReceiverOutdated,
  type LocalBinaryStatus,
  releaseAssetSize,
} from "./binary";
import type { Env } from "./env";
import { errorMessage } from "./env";
import { formatSize, type GpuInfo } from "./local-models";
import type { RemoteLink, RemotePrompts } from "./remote";
import { manageRemoteReceiver, sshConfigHosts } from "./remote";
import type { Routes } from "./routes";
import type { BridgeMode } from "./settings";
import type { Speech } from "./speech";

export interface ReceiverHost {
  readonly env: Env;
  readonly routes: Routes;
  readonly speech: Speech;
  readonly receiverVersion: string | undefined;
  readonly remoteState: "off" | "connecting" | "connected" | "lost" | "failed";
  readonly remoteError?: string;
  readonly remoteHost: string | undefined;
  readonly remoteVersion: string | undefined;
  readonly remoteEdition: "cpu" | "gpu" | undefined;
  readonly remotePlatform: string | undefined;
  readonly remoteOutdated: boolean;
  probeBridge(): Promise<BridgeProbe>;
  setBridge(mode: BridgeMode): Promise<{ message: string; level: "info" | "warning" }>;
  setDirection(direction: "playOn" | "recordOn" | "modelsOn", machine: "this" | "remote"): unknown;
  connectRemote(
    dest: string,
    prompts: RemotePrompts,
    opts?: { update?: boolean | "force"; targetOverride?: string },
  ): Promise<RemoteLink>;
  disconnectRemote(forget?: boolean): Promise<void>;
  updateRemoteReceiver(prompts: RemotePrompts, opts?: { targetOverride?: string }): Promise<RemoteLink>;
  pairAt(
    address: string,
  ): Promise<
    { state: "connected"; probe: BridgeProbe & { ok: true } } | { state: "code"; address: string; expiresIn: number }
  >;
  pairWithCode(address: string, code: string): Promise<{ probe: BridgeProbe; file: string; overridden: boolean }>;
}

export type ReceiverNotice = { tone: "success" | "warning" | "info" | "error"; text: string };
export type ReceiverSshAction = "update" | "restart";

export type PairCodeOutcome =
  | { ok: true; tone: "success" | "warning"; text: string }
  | { ok: false; kind: "wrong" | "expired" | "other"; message: string; attemptsLeft?: number };

/** The host:port of a bridge URL, or undefined when it is not one. */
export function hostPort(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.hostname ? `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}` : undefined;
  } catch {
    return undefined;
  }
}

/** Why a pairing probe failed, in a word or two. */
export function pairingFault(reason: string): string {
  if (/^no bridge token/.test(reason)) return "no token on This machine";
  if (/\b401\b|check the bridge token/.test(reason)) return "token rejected";
  if (/not reachable/.test(reason)) return "receiver unreachable";
  if (/too old/.test(reason)) return "receiver too old";
  if (/loopback|valid URL|plain http|user name/.test(reason)) return "bridge URL not usable";
  return "receiver not usable";
}

export class ReceiverControl {
  localStatus?: LocalBinaryStatus;
  localGpu?: GpuInfo;
  remoteGpu?: GpuInfo;
  health?: BridgeHealth | "checking";
  pairing?: BridgeProbe | "checking";
  private probeSeq = 0;
  private pairSeq = 0;

  constructor(private readonly host: ReceiverHost) {}

  sshHosts(): string[] {
    return sshConfigHosts(this.host.env.HOME || undefined);
  }

  isRemoteDevice(): boolean {
    const h = this.host;
    if (h.routes.ssh) return h.routes.route === "bridge";
    return (
      h.remoteState === "connecting" ||
      h.remoteState === "connected" ||
      h.remoteState === "lost" ||
      h.remoteState === "failed" ||
      h.routes.route === "bridge"
    );
  }

  canManageRemote(): boolean {
    return !this.host.routes.ssh && this.host.remoteState === "connected" && Boolean(this.host.remoteHost);
  }

  canMaintainRemote(): boolean {
    return this.host.routes.route === "bridge" && !this.canManageRemote();
  }

  get maintenanceHost(): string | undefined {
    return this.host.speech.settings.receiverSshHost;
  }

  setMaintenanceHost(dest: string): void {
    const host = "(?:[a-z0-9_][a-z0-9_.-]*|\\[[a-f0-9:.]+\\])";
    const authority = `(?:[a-z0-9_][a-z0-9_.-]*@)?${host}`;
    if (dest && !new RegExp(`^(?:${authority}|ssh://${authority}(?::[0-9]{1,5})?)$`, "i").test(dest)) {
      throw new Error("Use an SSH host, user@host, or ssh://user@host:port (no password in the address)");
    }
    if (dest) this.host.speech.settings.receiverSshHost = dest;
    else delete this.host.speech.settings.receiverSshHost;
    this.host.speech.save();
  }

  async maintainRemote(action: ReceiverSshAction, prompts: RemotePrompts): Promise<ReceiverNotice> {
    const dest = this.maintenanceHost;
    if (!dest || !this.canMaintainRemote()) {
      return { tone: "info", text: "Choose an SSH host for the receiver reached through this bridge" };
    }
    const r = await manageRemoteReceiver(dest, action, prompts, {
      env: this.host.env as NodeJS.ProcessEnv,
      binaryFor: (target) => ensureBinaryFor(target, this.host.env, { releaseOnly: true }),
      hasBinaryFor: (target) => releaseAssetSize(target) !== undefined,
      binarySizeFor: (target) => releaseAssetSize(target),
      version: this.host.receiverVersion,
    });
    if (r.action === "cancelled") return { tone: "info", text: `No changes on ${dest}` };

    const version = r.version ? ` v${r.version}` : "";
    const text =
      r.action === "current"
        ? `Receiver${version} is current on ${dest}`
        : `${r.action[0].toUpperCase()}${r.action.slice(1)} receiver${version} on ${dest}`;
    await this.probeHealth();
    await this.probePairing();
    const p = this.pairing;
    if (!p || p === "checking" || !p.ok) {
      const fault = p && p !== "checking" && !p.ok ? ` (${pairingFault(p.reason)})` : "";
      return { tone: "warning", text: `${text} · existing bridge not connected${fault}` };
    }
    if (r.version && p.version !== r.version) {
      return { tone: "warning", text: `${text} · existing bridge still reports v${p.version}` };
    }
    return { tone: "success", text: `✓ ${text} · bridge connected` };
  }

  connectedVersion(): string | undefined {
    const p = this.pairing;
    if (p && p !== "checking" && p.ok) return p.version;
    const r = this.health;
    if (r && r !== "checking" && r.ok) return r.version;
    return this.host.remoteVersion;
  }

  connectedEdition(): "cpu" | "gpu" | undefined {
    const r = this.health;
    if (r && r !== "checking" && r.ok && r.edition) return r.edition;
    return this.host.remoteEdition;
  }

  addressFrom(): "pairing" | "env" | "default" {
    if (this.host.speech.settings.bridgeAddress) return "pairing";
    return bridgeTarget(this.host.env).from;
  }

  isVersionOutdated(actual: string | undefined): boolean {
    return isReceiverOutdated(actual, this.host.receiverVersion);
  }

  isRemoteOutdated(): boolean {
    return this.host.remoteOutdated || this.isVersionOutdated(this.connectedVersion());
  }

  isLocalOutdated(): boolean {
    return this.isVersionOutdated(this.localStatus?.version);
  }

  private localReleaseTarget(): string | undefined {
    return this.localStatus?.edition === "gpu"
      ? (this.localGpu?.target ?? undefined)
      : `${process.platform}-${process.arch}`;
  }

  /** If the current local binary can't be updated in place, tell the user what to update instead. */
  localUpdateHint(): string | undefined {
    if (this.localStatus?.from === "env") return "Update the receiver set by PI_SPEECH_BINARY on This machine";
    const target = this.localReleaseTarget();
    if (!target || releaseAssetSize(target) === undefined)
      return "No release archive; rebuild receiver on This machine";
    return undefined;
  }

  canSwitchLocalGpu(): boolean {
    return (
      !this.isRemoteDevice() &&
      this.host.speech.settings.localDevice === "cpu" &&
      Boolean(this.localGpu?.hardware && this.localGpu.target && hasBinaryFor(this.localGpu.target, this.host.env))
    );
  }

  canSwitchRemoteEdition(): boolean {
    return (
      this.canManageRemote() &&
      (this.connectedEdition() === "gpu" ||
        Boolean(
          this.remoteGpu?.hardware && this.remoteGpu.target && hasBinaryFor(this.remoteGpu.target, this.host.env),
        ))
    );
  }

  localAssetSize(target = `${process.platform}-${process.arch}`): number | undefined {
    return releaseAssetSize(target);
  }

  hasBinaryForTarget(target: string): boolean {
    return hasBinaryFor(target, this.host.env);
  }

  async refreshLocal(probeGpuHardware: boolean): Promise<void> {
    const device = this.host.speech.settings.localDevice;
    this.localStatus = await inspectLocalBinary(this.host.env, {
      device,
      ...(this.localGpu?.target ? { gpuTarget: this.localGpu.target } : {}),
      probeVersion: probeGpuHardware,
    });
    if (this.localStatus.from && probeGpuHardware && !this.localGpu) {
      this.localGpu = await this.host.speech.local.gpu().catch(() => undefined);
    }
  }

  async probeHealth(onGpu?: () => void): Promise<void> {
    const seq = ++this.probeSeq;
    if (this.host.routes.route !== "bridge") {
      this.health = undefined;
      this.remoteGpu = undefined;
      return;
    }
    this.health = "checking";
    try {
      const h = await this.host.routes.bridge.health();
      if (seq !== this.probeSeq) return;
      this.health = h;
      if (h.ok && this.host.routes.bridge.gpu && !this.remoteGpu) {
        void this.host.routes.bridge
          .gpu()
          .then((g) => {
            if (g && seq === this.probeSeq) {
              this.remoteGpu = g as unknown as GpuInfo;
              onGpu?.();
            }
          })
          .catch(() => {});
      }
    } catch (err) {
      if (seq === this.probeSeq) this.health = { ok: false, reason: errorMessage(err) };
    }
  }

  async probePairing(): Promise<void> {
    if (!this.host.routes.ssh && this.host.routes.route !== "bridge") {
      this.pairing = undefined;
      return;
    }
    const seq = ++this.pairSeq;
    let r: BridgeProbe;
    try {
      r = await this.host.probeBridge();
    } catch (err) {
      r = { ok: false, reason: errorMessage(err) };
    }
    if (seq === this.pairSeq) this.pairing = r;
  }

  async fetchLocal(): Promise<ReceiverNotice> {
    const target = `${process.platform}-${process.arch}`;
    if (!hasBinaryFor(target, this.host.env)) {
      return { tone: "info", text: "No receiver archive available in receivers.json; build receiver/ locally" };
    }
    const choice = await ensureBinary(this.host.env);
    if (!choice.ok) throw new Error(choice.reason);
    await this.refreshLocal(true);
    return { tone: "success", text: `✓ Fetched pi-speech-receiver (${target})` };
  }

  async updateLocal(): Promise<ReceiverNotice> {
    const expected = this.host.receiverVersion;
    const ver = this.localStatus?.version;
    if (!isReceiverOutdated(ver, expected)) {
      return { tone: "info", text: `Local receiver is already current (${ver ?? expected ?? "unknown"})` };
    }
    const manual = this.localUpdateHint();
    if (manual) return { tone: "info", text: manual };
    const target = this.localReleaseTarget();
    if (!target || !(await ensureBinaryFor(target, this.host.env, { releaseOnly: true }))) {
      throw new Error(`no release archive for ${target ?? "the selected receiver"}`);
    }
    this.host.speech.local.close();
    await this.refreshLocal(true);
    return { tone: "success", text: `✓ Updated local receiver to v${expected}` };
  }

  async switchLocalEdition(prompts: RemotePrompts): Promise<ReceiverNotice> {
    if (this.host.speech.settings.localDevice === "gpu") {
      this.host.speech.setDevice("cpu");
      await this.refreshLocal(true);
      return { tone: "success", text: "✓ Receiver: CPU" };
    }
    prompts.progress("… checking GPU hardware");
    const info = await this.host.speech.local.gpu();
    this.localGpu = info;
    if (!info.hardware) {
      return { tone: "warning", text: `! GPU unavailable: ${info.why ?? "no compatible GPU"}` };
    }
    const target = info.target;
    if (!target) {
      return { tone: "warning", text: `! ${info.why ?? "no GPU receiver build for this platform"}` };
    }
    const onDisk = findBinary(this.host.env, { device: "gpu", gpuTarget: target });
    if (onDisk.ok && onDisk.edition === "gpu") {
      this.host.speech.setDevice("gpu");
      await this.refreshLocal(true);
      return { tone: "success", text: `✓ Receiver: GPU (CUDA ${info.cuda})` };
    }
    if (!hasBinaryFor(target, this.host.env)) {
      return { tone: "warning", text: `! No GPU receiver archive for ${target} in receivers.json` };
    }
    const sz = releaseAssetSize(target);
    const sizeNote = sz ? ` (${formatSize(sz)})` : "";
    const ok = await prompts.confirm(`Download GPU receiver (${target}${sizeNote})?`);
    if (!ok) return { tone: "info", text: "Kept CPU receiver" };
    prompts.progress(`… downloading GPU receiver (${target}${sizeNote})`);
    const bin = await ensureBinaryFor(target, this.host.env);
    if (!bin) throw new Error(`cannot download ${target}`);
    this.host.speech.setDevice("gpu");
    await this.refreshLocal(true);
    return { tone: "success", text: `✓ Receiver: GPU (CUDA ${info.cuda})` };
  }

  async switchRemoteEdition(prompts: RemotePrompts): Promise<ReceiverNotice> {
    if (this.host.routes.ssh || this.host.remoteState !== "connected" || !this.host.remoteHost) {
      return { tone: "info", text: "Switching remote receiver edition requires an SSH connection" };
    }
    const ed = this.connectedEdition() ?? "cpu";
    if (ed === "gpu") {
      const target = this.host.remotePlatform;
      if (!target || !hasBinaryFor(target, this.host.env)) {
        return { tone: "info", text: "No CPU receiver archive available for remote platform" };
      }
      prompts.progress(`… switching ${this.host.remoteHost} to CPU receiver`);
      const link = await this.host.updateRemoteReceiver(prompts, { targetOverride: target });
      await this.probeHealth().then(() => this.probePairing());
      return { tone: "success", text: `✓ ${link.dest}: CPU receiver v${link.version}` };
    }
    const info = this.remoteGpu;
    if (!info?.hardware || !info.target) {
      return { tone: "warning", text: `! Remote GPU unavailable: ${info?.why ?? "no compatible GPU detected"}` };
    }
    if (!hasBinaryFor(info.target, this.host.env)) {
      return { tone: "warning", text: `! No GPU receiver archive for ${info.target} in receivers.json` };
    }
    const sz = releaseAssetSize(info.target);
    const sizeNote = sz ? ` (${formatSize(sz)})` : "";
    const ok = await prompts.confirm(`Install GPU receiver (${info.target}${sizeNote}) on ${this.host.remoteHost}?`);
    if (!ok) return { tone: "info", text: "Kept CPU receiver" };
    const link = await this.host.updateRemoteReceiver(prompts, { targetOverride: info.target });
    await this.probeHealth().then(() => this.probePairing());
    return { tone: "success", text: `✓ ${link.dest}: GPU receiver v${link.version}` };
  }

  async updateRemote(prompts: RemotePrompts): Promise<ReceiverNotice> {
    const host = this.host.remoteHost;
    if (!host || !this.canManageRemote()) {
      return {
        tone: "info",
        text:
          this.host.routes.route === "bridge"
            ? "Update pi-speech-receiver on the Remote machine; this bridge can't install updates"
            : "Not connected to a Remote machine",
      };
    }
    const ver = this.connectedVersion();
    const expected = this.host.receiverVersion;
    if (this.host.remoteState === "connected" && !this.host.remoteOutdated && !isReceiverOutdated(ver, expected)) {
      return { tone: "info", text: `pi-speech-receiver on ${host} is already current (${ver ?? expected})` };
    }
    const targetOverride =
      this.connectedEdition() === "gpu" && this.remoteGpu?.target ? this.remoteGpu.target : undefined;
    prompts.progress(`… updating pi-speech-receiver on ${host}`);
    const link = await this.host.updateRemoteReceiver(prompts, { ...(targetOverride ? { targetOverride } : {}) });
    await this.probeHealth().then(() => this.probePairing());
    if (link.outdated && expected) {
      return {
        tone: "warning",
        text: `! Binary updated on ${link.dest}, but receiver ${link.version || "old"} is still running (another session holds it; expected ${expected})`,
      };
    }
    return { tone: "success", text: `✓ Updated pi-speech-receiver on ${link.dest} to ${link.version}` };
  }

  async connectHost(dest: string, prompts: RemotePrompts): Promise<ReceiverNotice> {
    const link = await this.host.connectRemote(dest, prompts);
    await this.probeHealth().then(() => this.probePairing());
    const here = this.host.routes.ssh ? "" : " · models run there, audio plays and records here";
    if (link.outdated && this.host.receiverVersion) {
      return {
        tone: "warning",
        text: `! Connected to ${link.dest} over SSH, receiver ${link.version || "old"} (expected ${this.host.receiverVersion} · press u to update)`,
      };
    }
    return { tone: "success", text: `✓ Connected to ${link.dest} over SSH, receiver ${link.version}${here}` };
  }

  async disconnect(forget = true): Promise<ReceiverNotice> {
    const host = this.host.remoteHost;
    if (!host && this.host.routes.route !== "bridge") {
      return { tone: "info", text: "Not connected to a Remote machine" };
    }
    await this.host.disconnectRemote(forget);
    await this.refreshLocal(true);
    await this.probeHealth();
    return {
      tone: "success",
      text:
        forget && host
          ? `✓ Disconnected from ${host}; audio and models are on This machine`
          : "✓ Device: Local (audio and models on This machine)",
    };
  }

  async switchToLocalDevice(): Promise<ReceiverNotice> {
    const notice = await this.host.setBridge("off");
    await this.probeHealth();
    await this.refreshLocal(true);
    return notice.level === "info"
      ? { tone: "success", text: "✓ Device: Local" }
      : { tone: "error", text: `✗ ${notice.message}` };
  }

  private async useAfterPairing(): Promise<string> {
    const routes = this.host.routes;
    if (routes.ssh || routes.route === "bridge") return "";
    let notice: { message: string; level: "info" | "warning" };
    try {
      notice = await this.host.setBridge("on");
    } catch (err) {
      return ` · ✗ ${errorMessage(err)}`;
    }
    if (notice.level !== "info") return ` · ✗ ${notice.message}`;
    this.host.setDirection("playOn", "this");
    this.host.setDirection("recordOn", "this");
    this.host.setDirection("modelsOn", "remote");
    return " · Bridge on: models run there, audio plays and records here (DIRECTION changes that)";
  }

  async pairAddress(
    address: string,
  ): Promise<
    | { state: "connected"; tone: "success" | "warning"; text: string; usedBridge: boolean }
    | { state: "code"; address: string; expiresIn: number }
  > {
    const r = await this.host.pairAt(address);
    if (r.state === "connected") {
      this.pairing = r.probe;
      const connected = `✓ Connected to ${r.probe.address}:${r.probe.port}, receiver ${r.probe.version}`;
      const used = await this.useAfterPairing();
      await this.probeHealth();
      return {
        state: "connected",
        tone: used.includes("✗") ? "warning" : "success",
        text: connected + used,
        usedBridge: Boolean(used),
      };
    }
    return r;
  }

  async pairCode(address: string, code: string): Promise<PairCodeOutcome> {
    try {
      const r = await this.host.pairWithCode(address, code);
      this.pairing = r.probe;
      const where = displayUrl(`http://${address}`).replace(/^http:\/\//, "");
      const tail = r.overridden ? " (PI_SPEECH_BRIDGE_TOKEN is set and still wins: unset it)" : "";
      const tone = r.probe.ok && !r.overridden ? "success" : "warning";
      const paired = `${tone === "success" ? "✓" : "!"} Paired with ${where}: the token is in ${r.file}${tail}`;
      if (!r.probe.ok || r.overridden) {
        await this.probeHealth();
        return { ok: true, tone, text: paired };
      }
      const used = await this.useAfterPairing();
      await this.probeHealth();
      return { ok: true, tone: used.includes("✗") ? "warning" : "success", text: paired + used };
    } catch (err) {
      if (err instanceof PairingError) {
        return {
          ok: false,
          kind: err.kind,
          message: errorMessage(err),
          ...(err.attemptsLeft !== undefined ? { attemptsLeft: err.attemptsLeft } : {}),
        };
      }
      return { ok: false, kind: "other", message: errorMessage(err) };
    }
  }
}
