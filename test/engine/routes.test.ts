import { describe, expect, it } from "vitest";
import type { BridgeAudio, BridgeHealth } from "../../src/bridge/index";
import type { AudioInput, AudioOutput } from "../../src/engine/audio";
import { Routes } from "../../src/engine/routes";
import type { BridgeMode } from "../../src/engine/settings";

const output = (name: string): AudioOutput => ({
  name,
  play: async () => ({ ok: false, reason: "unused" }),
  stop: async () => {},
});
const input = (name: string): AudioInput => ({
  name,
  start: async () => {
    throw new Error("unused");
  },
});

function routes(mode: BridgeMode, env: Record<string, string>, health: BridgeHealth = { ok: true, version: "0.1.0" }) {
  const bridge: BridgeAudio = { output: output("bridge"), input: input("bridge"), health: async () => health };
  return new Routes({
    env: { PI_SPEECH_BRIDGE_URL: "http://127.0.0.1:47613", ...env },
    mode,
    bridge,
    localOutput: output("local"),
    localInput: input("local"),
  });
}

const SSH = { SSH_CONNECTION: "10.0.0.1 50000 10.0.0.2 22" };

describe("routes", () => {
  it("auto uses the bridge over SSH and the Pi host otherwise", () => {
    expect(routes("auto", SSH).route).toBe("bridge");
    expect(routes("auto", { SSH_TTY: "/dev/pts/3" }).route).toBe("bridge");
    expect(routes("auto", {}).route).toBe("local");
    expect(routes("auto", { SSH_CONNECTION: "", SSH_TTY: " " }).route).toBe("local");
  });

  it("on and off are explicit", () => {
    expect(routes("on", {}).output().name).toBe("bridge");
    expect(routes("off", SSH).output().name).toBe("local");
    expect(routes("off", SSH).input().name).toBe("local");
  });

  it("PI_SPEECH_LOCAL_MIC=1 keeps dictation on the Pi host in auto mode only", () => {
    expect(routes("auto", { ...SSH, PI_SPEECH_LOCAL_MIC: "1" }).input().name).toBe("local");
    expect(routes("auto", { ...SSH, PI_SPEECH_LOCAL_MIC: "1" }).output().name).toBe("bridge");
    expect(routes("on", { PI_SPEECH_LOCAL_MIC: "1" }).input().name).toBe("bridge");
    expect(routes("auto", SSH).input().name).toBe("bridge");
  });

  it("names the route in the Audio line", () => {
    expect(routes("auto", SSH).audioLine()).toBe("Audio: bridge (http://127.0.0.1:47613, auto: Pi runs over SSH)");
    expect(routes("auto", {}).audioLine()).toBe("Audio: local (auto)");
    expect(routes("on", {}).audioLine()).toBe("Audio: bridge (http://127.0.0.1:47613)");
    expect(routes("off", SSH).audioLine()).toBe("Audio: local");
  });

  it("refuses to turn the bridge on when the receiver does not answer, and keeps the mode", async () => {
    const r = routes("off", {}, { ok: false, reason: "the playback receiver answered 401: unauthorized" });
    await expect(r.choose("on")).rejects.toThrow(/401/);
    expect(r.mode).toBe("off");
  });

  it("announces the automatic bridge over SSH, with a warning when the receiver is down", async () => {
    expect(await routes("auto", {}).announcement()).toBeUndefined();
    expect(await routes("on", SSH).announcement()).toBeUndefined();
    const ok = await routes("auto", SSH).announcement();
    expect(ok?.level).toBe("info");
    expect(ok?.message).toMatch(/SSH/);
    const down = await routes("auto", SSH, { ok: false, reason: "not reachable" }).announcement();
    expect(down?.level).toBe("warning");
    expect(down?.message).toMatch(/not reachable/);
  });

  it("reports the mode, the reason, the URL, and the receiver", async () => {
    const r = await routes("auto", SSH).report();
    expect(r.message).toMatch(/auto/);
    expect(r.message).toMatch(/SSH/);
    expect(r.message).toContain("http://127.0.0.1:47613");
    expect(r.message).toContain("0.1.0");
  });
});
