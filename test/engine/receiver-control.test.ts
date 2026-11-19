import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBinaryFor, hasBinaryFor, inspectLocalBinary, releaseAssetSize } from "../../src/engine/binary";
import { ReceiverControl, type ReceiverHost } from "../../src/engine/receiver-control";
import { manageRemoteReceiver } from "../../src/engine/remote";

vi.mock("../../src/engine/binary", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/binary")>("../../src/engine/binary");
  return {
    ...actual,
    ensureBinaryFor: vi.fn(),
    hasBinaryFor: vi.fn(),
    inspectLocalBinary: vi.fn(),
    releaseAssetSize: vi.fn(),
  };
});

vi.mock("../../src/engine/remote", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/remote")>("../../src/engine/remote");
  return {
    ...actual,
    manageRemoteReceiver: vi.fn(),
  };
});

function control(env: Record<string, string> = {}) {
  const closeWorkers = vi.fn();
  const host = {
    env,
    speech: {
      settings: { localDevice: "cpu" as const },
      local: { gpu: vi.fn(async () => undefined) },
      closeWorkers,
    },
    receiverVersion: "0.2.7",
  };
  return { ctl: new ReceiverControl(host as unknown as ReceiverHost), closeWorkers, host };
}

const gpu = {
  driver: true,
  cuda: 13,
  cudnn: true,
  hardware: true,
  usable: true,
  why: null,
  target: "linux-x64-cuda13",
};
const noGpu = { driver: false, cuda: null, cudnn: false, hardware: false, why: "no NVIDIA driver" };

function remoteControl(ssh: boolean) {
  const bridge = {
    health: vi.fn(async (): Promise<any> => ({ ok: true, edition: "cpu" })),
    gpu: vi.fn(async (): Promise<any> => gpu),
  };
  const host = {
    env: {},
    routes: { ssh, route: "bridge", bridge },
    remoteState: ssh ? "off" : "connected",
    remoteHost: ssh ? undefined : "server",
    remotePlatform: "linux-x64",
    remoteEdition: "cpu",
    updateRemoteReceiver: vi.fn(async () => ({ dest: "server", version: "1.0" })),
    probeBridge: vi.fn(async () => ({ ok: false, reason: "offline" })),
  };
  const prompts = { progress: vi.fn(), confirm: vi.fn(async () => true), password: vi.fn(async () => "") };
  return { ctl: new ReceiverControl(host as unknown as ReceiverHost), host, bridge, prompts };
}

describe("remote GPU", () => {
  beforeEach(() => vi.mocked(hasBinaryFor).mockReset());

  it("refreshes GPU information on every healthy probe and clears it on failure or leaving bridge", async () => {
    const { ctl, bridge, host } = remoteControl(true);
    const onGpu = vi.fn();
    await ctl.probeHealth(onGpu);
    await vi.waitFor(() => expect(ctl.remoteGpu).toEqual(gpu));
    bridge.gpu.mockResolvedValueOnce({ ...gpu, edition: "gpu" });
    bridge.health.mockResolvedValueOnce({ ok: true, edition: "gpu" });
    await ctl.probeHealth(onGpu);
    await vi.waitFor(() => expect(ctl.remoteGpu?.edition).toBe("gpu"));
    expect(onGpu).toHaveBeenCalledTimes(2);
    bridge.health.mockResolvedValueOnce({ ok: false, reason: "offline" });
    await ctl.probeHealth();
    expect(ctl.remoteGpu).toBeUndefined();
    ctl.remoteGpu = gpu;
    bridge.health.mockRejectedValueOnce(new Error("offline"));
    await ctl.probeHealth();
    expect(ctl.remoteGpu).toBeUndefined();
    ctl.remoteGpu = gpu;
    host.routes.route = "local";
    await ctl.probeHealth();
    expect(ctl.remoteGpu).toBeUndefined();
  });

  it("offers manual switching on an SSH tunnel with GPU hardware, probing if needed", async () => {
    const { ctl, bridge, prompts, host } = remoteControl(true);
    expect(ctl.canSwitchRemoteEdition()).toBe(false);
    expect(await ctl.switchRemoteEdition(prompts)).toEqual({
      tone: "info",
      text: "Desk has CUDA 13 (linux-x64-cuda13): start the GPU edition of pi-speech-receiver on your desk machine",
    });
    expect(bridge.gpu).toHaveBeenCalledOnce();
    expect(ctl.canSwitchRemoteEdition()).toBe(true);
    expect(host.updateRemoteReceiver).not.toHaveBeenCalled();
  });

  it("explains how to switch an SSH-tunnel GPU receiver back to CPU", async () => {
    const { ctl, prompts } = remoteControl(true);
    ctl.health = { ok: true, edition: "gpu" } as any;
    expect(ctl.canSwitchRemoteEdition()).toBe(true);
    expect(await ctl.switchRemoteEdition(prompts)).toEqual({
      tone: "info",
      text: expect.stringMatching(/GPU edition.*restart.*CPU edition/),
    });
  });

  it("reports missing GPU hardware on an SSH tunnel", async () => {
    const { ctl, bridge, prompts } = remoteControl(true);
    bridge.gpu.mockResolvedValueOnce(noGpu);
    expect(await ctl.switchRemoteEdition(prompts)).toEqual({
      tone: "warning",
      text: expect.stringContaining("no NVIDIA driver"),
    });
    expect(ctl.canSwitchRemoteEdition()).toBe(false);
  });

  it("installs GPU and CPU editions over outbound SSH", async () => {
    const { ctl, host, prompts } = remoteControl(false);
    ctl.remoteGpu = gpu;
    vi.mocked(hasBinaryFor).mockReturnValue(true);
    expect(ctl.canSwitchRemoteEdition()).toBe(true);
    expect(await ctl.switchRemoteEdition(prompts)).toEqual({ tone: "success", text: "✓ server: GPU receiver v1.0" });
    expect(host.updateRemoteReceiver).toHaveBeenCalledWith(prompts, { targetOverride: gpu.target });
    ctl.health = { ok: true, edition: "gpu" } as any;
    expect(await ctl.switchRemoteEdition(prompts)).toEqual({ tone: "success", text: "✓ server: CPU receiver v1.0" });
    expect(host.updateRemoteReceiver).toHaveBeenLastCalledWith(prompts, { targetOverride: "linux-x64" });
  });

  it("requires an available archive for outbound CPU to GPU, but not for a paired receiver", () => {
    const outbound = remoteControl(false);
    outbound.ctl.remoteGpu = gpu;
    expect(outbound.ctl.canSwitchRemoteEdition()).toBe(false);
    outbound.host.remoteState = "off";
    expect(outbound.ctl.canSwitchRemoteEdition()).toBe(true);
  });
});

describe("updateLocal", () => {
  beforeEach(() => {
    vi.mocked(ensureBinaryFor).mockReset();
    vi.mocked(hasBinaryFor).mockReset();
    vi.mocked(inspectLocalBinary).mockReset();
    vi.mocked(releaseAssetSize).mockReset().mockReturnValue(1234);
  });

  it("warns when PI_SPEECH_BINARY pins an old receiver instead of pretending to update", async () => {
    const pinned = "/home/x/.local/bin/pi-speech-receiver";
    const { ctl, closeWorkers } = control({ PI_SPEECH_BINARY: pinned });
    ctl.localStatus = { version: "0.2.5", edition: "cpu", from: "env", path: pinned };
    await expect(ctl.updateLocal()).resolves.toEqual({
      tone: "info",
      text: "Update the receiver set by PI_SPEECH_BINARY on This machine",
    });
    expect(ensureBinaryFor).not.toHaveBeenCalled();
    expect(closeWorkers).not.toHaveBeenCalled();
  });

  it("installs the expected binary and reports success only after the probed version is current", async () => {
    const { ctl, closeWorkers, host } = control();
    const target = `${process.platform}-${process.arch}`;
    const installed = `/cache/0.2.7/${target}/pi-speech-receiver`;
    ctl.localStatus = { version: "0.2.5", edition: "cpu", from: "checkout", path: "/old/pi-speech-receiver" };
    vi.mocked(hasBinaryFor).mockReturnValue(true);
    vi.mocked(ensureBinaryFor).mockResolvedValue(installed);
    vi.mocked(inspectLocalBinary).mockResolvedValue({
      version: "0.2.7",
      edition: "cpu",
      from: "cache",
      path: installed,
    });
    await expect(ctl.updateLocal()).resolves.toEqual({
      tone: "success",
      text: "✓ Updated local receiver to v0.2.7",
    });
    expect(ensureBinaryFor).toHaveBeenCalledWith(target, host.env, { releaseOnly: true });
    expect(closeWorkers).toHaveBeenCalledOnce();
    expect(inspectLocalBinary).toHaveBeenCalledWith(host.env, expect.objectContaining({ probeVersion: true }));
  });

  it("warns when the binary still in use is outdated after the install", async () => {
    const { ctl, closeWorkers } = control();
    const stale = "/checkout/receiver/target/release/pi-speech-receiver";
    ctl.localStatus = { version: "0.2.5", edition: "cpu", from: "checkout", path: stale };
    vi.mocked(hasBinaryFor).mockReturnValue(true);
    vi.mocked(ensureBinaryFor).mockResolvedValue("/cache/0.2.7/pi-speech-receiver");
    vi.mocked(inspectLocalBinary).mockResolvedValue({
      version: "0.2.5",
      edition: "cpu",
      from: "checkout",
      path: stale,
    });
    await expect(ctl.updateLocal()).resolves.toEqual({
      tone: "warning",
      text: `! Receiver 0.2.5 is still in use at ${stale} (checkout) (expected 0.2.7)`,
    });
    expect(closeWorkers).toHaveBeenCalledOnce();
  });

  it("switches a forwarded SSH bridge receiver between CPU and GPU via Manage over SSH when receiverSshHost is set", async () => {
    vi.mocked(manageRemoteReceiver).mockReset();
    vi.mocked(hasBinaryFor).mockReturnValue(true);
    let edition: "cpu" | "gpu" = "cpu";
    const host = {
      env: {},
      speech: {
        settings: { localDevice: "cpu" as const, receiverSshHost: "desk" },
        local: { gpu: vi.fn(async () => undefined) },
        closeWorkers: vi.fn(),
        save: vi.fn(),
      },
      routes: {
        ssh: true,
        route: "bridge" as const,
        bridge: {
          health: vi.fn(async () => ({ ok: true as const, version: "0.3.1", edition })),
          gpu: vi.fn(async () => ({
            driver: true,
            cuda: 13,
            cudnn: true,
            hardware: true,
            target: "linux-x64-cuda",
            usable: true,
            why: null,
          })),
        },
      },
      remoteState: "disconnected" as const,
      receiverVersion: "0.3.1",
      probeBridge: vi.fn(async () => ({
        ok: true as const,
        address: "127.0.0.1",
        port: 47613,
        ms: 4,
        version: "0.3.1",
      })),
    };
    const ctl = new ReceiverControl(host as unknown as ReceiverHost);
    ctl.pairing = { ok: true, address: "127.0.0.1", port: 47613, ms: 4, version: "0.3.1" };
    const prompts = { confirm: vi.fn(async () => true), progress: vi.fn(), password: vi.fn(async () => undefined) };

    vi.mocked(manageRemoteReceiver).mockImplementation(async () => {
      edition = "gpu";
      return { action: "updated", version: "0.3.1" };
    });
    await expect(ctl.switchRemoteEdition(prompts)).resolves.toEqual({
      tone: "success",
      text: "✓ Updated receiver v0.3.1 on desk · bridge connected",
    });
    expect(manageRemoteReceiver).toHaveBeenCalledWith(
      "desk",
      "update",
      prompts,
      expect.objectContaining({ targetOverride: "linux-x64-cuda" }),
    );

    vi.mocked(manageRemoteReceiver).mockImplementation(async () => {
      edition = "cpu";
      return { action: "updated", version: "0.3.1" };
    });
    await expect(ctl.switchRemoteEdition(prompts)).resolves.toEqual({
      tone: "success",
      text: "✓ Updated receiver v0.3.1 on desk · bridge connected",
    });
    expect(manageRemoteReceiver).toHaveBeenLastCalledWith(
      "desk",
      "update",
      prompts,
      expect.objectContaining({ targetOverride: "cpu" }),
    );
  });
});
