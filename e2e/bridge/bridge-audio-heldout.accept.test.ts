import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBridgeAudio } from "../../src/bridge/index";
// @ts-expect-error plain JS helper copied next to this test
import { startReceiver } from "../lib/receiver.mjs";

function wav(seconds = 0.3, rate = 16000): Buffer {
  const pcm = Buffer.alloc(Math.floor(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const file = join(tmpdir(), `bridge-heldout-${process.pid}.wav`);
let rcv: any;
beforeAll(async () => {
  writeFileSync(file, wav());
  rcv = await startReceiver();
});
afterAll(async () => {
  await rcv?.stop();
  rcv?.cleanup();
});
const audio = () => createBridgeAudio({ url: rcv.url, token: rcv.token });
/** A saved WAV as a Stream: every playback is one. */
const streamOf = (path: string) => ({
  format: { codec: "wav" as const },
  chunks: (async function* () {
    yield readFileSync(path);
  })(),
});

describe("bridge audio, held out", () => {
  it("cancels a playback through its stop()", async () => {
    rcv.mode("player", "long");
    const p = await audio().output.playStream(streamOf(file), "message");
    if (!p.ok) throw new Error(p.reason);
    await new Promise((r) => setTimeout(r, 300));
    await p.stop();
    expect(await p.done).toEqual({ state: "cancelled" });
    rcv.mode("player", "ok");
  });

  it("output.stop() stops what plays", async () => {
    rcv.mode("player", "long");
    const p = await audio().output.playStream(streamOf(file), "sample");
    if (!p.ok) throw new Error(p.reason);
    await new Promise((r) => setTimeout(r, 300));
    await audio().output.stop();
    expect(await p.done).toEqual({ state: "cancelled" });
    rcv.mode("player", "ok");
  });

  it("reports a player failure as failed", async () => {
    rcv.mode("player", "fail");
    const p = await audio().output.playStream(streamOf(file), "message");
    if (p.ok) expect(await p.done).toMatchObject({ state: "failed" });
    else expect(p.reason).toMatch(/\S/);
    rcv.mode("player", "ok");
  });

  it("refuses a Stream format it does not take, with the receiver's message", async () => {
    const p = await audio().output.playStream(
      { format: { codec: "pcm", rate: 1, channels: 1 }, chunks: streamOf(file).chunks },
      "message",
    );
    expect(p).toMatchObject({ ok: false, reason: expect.stringMatching(/400/) });
  });

  it("maps recording errors to readable errors", async () => {
    const a = audio();
    const r1 = await a.input.start();
    await expect(a.input.start()).rejects.toThrow(/already|409|active/i);
    await r1.cancel();
    rcv.mode("recorder", "empty");
    const r2 = await a.input.start();
    await new Promise((r) => setTimeout(r, 200));
    await expect(r2.stop()).rejects.toThrow(/0\.1|empty|short|less/i);
    rcv.mode("recorder", "die");
    const r3 = await a.input.start();
    await new Promise((r) => setTimeout(r, 1300));
    await expect(r3.stop()).rejects.toThrow(/stream error/);
    rcv.mode("recorder", "busy");
    await expect(a.input.start()).rejects.toThrow(/busy/);
    rcv.mode("recorder", "ok");
  });

  it("rejects a wrong token readably", async () => {
    const a = createBridgeAudio({ url: rcv.url, token: "wrong-token-0000000000000000000000000" });
    await expect(a.input.start()).rejects.toThrow(/unauthori[sz]ed|401|token/i);
    const h = await a.health();
    expect(h.ok).toBe(false);
    const p = await a.output.playStream(streamOf(file), "message");
    expect(p.ok).toBe(false);
  });

  it("an unreachable receiver is an error, not a hang", async () => {
    const a = createBridgeAudio({ url: "http://127.0.0.1:9", token: rcv.token });
    const t0 = Date.now();
    await expect(a.input.start()).rejects.toThrow(/reach|connect|refused/i);
    const p = await a.output.playStream(streamOf(file), "message");
    expect(p.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10000);
  });

  it("losing the receiver during playback ends it without claiming completion", async () => {
    const r2 = await startReceiver();
    r2.mode("player", "long");
    const a = createBridgeAudio({ url: r2.url, token: r2.token });
    const p = await a.output.playStream(streamOf(file), "message");
    if (!p.ok) throw new Error(p.reason);
    await new Promise((r) => setTimeout(r, 300));
    await r2.stop();
    const outcome = await Promise.race([p.done, new Promise((r) => setTimeout(() => r("hang"), 15000))]);
    // A receiver that shuts down cleanly reports the playback cancelled; one that vanishes leaves it failed.
    expect(["failed", "cancelled"]).toContain((outcome as { state?: string }).state);
    r2.cleanup();
  }, 30000);
});
