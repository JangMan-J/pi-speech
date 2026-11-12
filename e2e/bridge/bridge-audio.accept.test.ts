import { writeFileSync } from "node:fs";
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

let rcv: any;
beforeAll(async () => {
  rcv = await startReceiver();
});
afterAll(async () => {
  await rcv?.stop();
  rcv?.cleanup();
});

describe("createBridgeAudio", () => {
  it("reports the receiver's health", async () => {
    const b = createBridgeAudio({ url: rcv.url, token: rcv.token });
    const h = await b.health();
    expect(h.ok).toBe(true);
    if (h.ok) expect(h.version).toMatch(/\d+\.\d+/);
    expect(b.output.name).toBe("bridge");
    expect(b.input.name).toBe("bridge");
  });

  it("plays a file on the receiver and follows it to completion", async () => {
    const file = join(tmpdir(), `bridge-accept-${process.pid}.wav`);
    writeFileSync(file, wav());
    const b = createBridgeAudio({ url: rcv.url, token: rcv.token });
    const p = await b.output.play(file, "message");
    expect(p.ok).toBe(true);
    if (p.ok) expect(await p.done).toEqual({ state: "completed" });
  });

  it("records on the receiver and returns the WAV", async () => {
    const b = createBridgeAudio({ url: rcv.url, token: rcv.token });
    const r = await b.input.start();
    await new Promise((res) => setTimeout(res, 300));
    const { audio, format } = await r.stop();
    expect(format).toBe("wav");
    expect(audio.subarray(0, 4).toString()).toBe("RIFF");
    expect(audio.length).toBeGreaterThan(16000);
  });

  it("turns a missing microphone into a readable error", async () => {
    rcv.mode("recorder", "fail");
    try {
      const b = createBridgeAudio({ url: rcv.url, token: rcv.token });
      await expect(b.input.start()).rejects.toThrow(/no such audio device/);
    } finally {
      rcv.mode("recorder", "ok");
    }
  });

  it("refuses a non-loopback URL without connecting", async () => {
    const started = Date.now();
    let refused = false;
    try {
      const b = createBridgeAudio({ url: "http://192.0.2.1:47613", token: rcv.token });
      const h = await b.health();
      refused = !h.ok && /loopback/i.test(h.reason);
    } catch (err) {
      refused = /loopback/i.test(String(err));
    }
    expect(refused).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
