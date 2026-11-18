import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureBinaryFor, hasBinaryFor, inspectLocalBinary } from "../../src/engine/binary";
import { ReceiverControl, type ReceiverHost } from "../../src/engine/receiver-control";

vi.mock("../../src/engine/binary", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/binary")>("../../src/engine/binary");
  return {
    ...actual,
    ensureBinaryFor: vi.fn(),
    hasBinaryFor: vi.fn(),
    inspectLocalBinary: vi.fn(),
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

describe("updateLocal", () => {
  beforeEach(() => {
    vi.mocked(ensureBinaryFor).mockReset();
    vi.mocked(hasBinaryFor).mockReset();
    vi.mocked(inspectLocalBinary).mockReset();
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
});
