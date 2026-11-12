import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READING_MIN_CHARS } from "../../src/engine/pieces";
import { Surface } from "../../src/engine/surface";
import { fakeOpenRouter, makeEngine as makeFixtureEngine, scriptedUi } from "./fixtures";

const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const LONG = Array.from({ length: 10 }, (_, i) => `This is sentence ${i + 1} of a long spoken reply.`).join(" ");
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const pieceFiles = () => readdirSync(tmpdir()).filter((f) => f.startsWith(`pi-speech-reading-${process.pid}-`));

const engines: Array<ReturnType<typeof makeFixtureEngine>["engine"]> = [];
const makeEngine = () => {
  const made = makeFixtureEngine();
  engines.push(made.engine);
  return made;
};

afterEach(async () => {
  for (const e of engines.splice(0)) await e.shutdown();
  await tick();
  vi.unstubAllGlobals();
  expect(pieceFiles()).toEqual([]);
});

describe("playback-only speech of a long text", () => {
  it("is spoken in pieces, played in order as one Stream, and saved as one message", async () => {
    const requests = fakeOpenRouter();
    const { engine, work, local } = makeEngine();
    expect(LONG.length).toBeGreaterThan(READING_MIN_CHARS);
    const r = await engine.speech.say(LONG);
    const inputs = requests.filter((q) => q.url.endsWith("/audio/speech")).map((q) => q.body.input);
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(norm(inputs.join(" "))).toBe(norm(LONG));
    expect(r.player).toBe("local");
    expect(r.files.length).toBe(1);
    expect(readdirSync(join(work, "history")).filter((f) => f.endsWith(".wav")).length).toBe(1);
    // One player for the whole Reading, every piece's audio on it in order.
    expect(local.plays).toHaveLength(1);
    await tick();
    expect(local.streams[0].ended).toBe(true);
    expect(Buffer.concat(local.streams[0].chunks).length).toBe(4800 * inputs.length);
    expect(engine.player.playing).toBe(true);
    local.end(0, { state: "completed" });
    await tick();
    expect(engine.player.playing).toBe(false);
    expect(engine.speech.lastMessage()).toBe(r.files[0]);
  });

  it("speaks a text of at most 280 characters in one request", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    await engine.speech.say("A short reply.");
    expect(requests.filter((q) => q.url.endsWith("/audio/speech")).map((q) => q.body.input)).toEqual([
      "A short reply.",
    ]);
  });

  it("leaves speech_synthesize (speak) as one request", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    await engine.speech.speak(LONG);
    expect(requests.filter((q) => q.url.endsWith("/audio/speech")).length).toBe(1);
  });

  it("/speech <text> and read-aloud read a long text in pieces", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    const ui = scriptedUi();
    await new Surface(engine).run(LONG, ui.ui);
    expect(requests.filter((q) => q.url.endsWith("/audio/speech")).length).toBeGreaterThan(1);
    expect(ui.notes[0]).toMatchObject({ level: "info", message: expect.stringMatching(/^Speaking with/) });
    const before = requests.length;
    engine.readAloud.enabled = true;
    await engine.readAloud.onRunEnd([{ role: "assistant", content: [{ type: "text", text: LONG }] }]);
    expect(requests.length - before).toBeGreaterThan(1);
  });

  it("an MP3-only model reads a long text in pieces as one MP3 Stream and saves one MP3", async () => {
    const inputs: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        inputs.push(JSON.parse(String(init.body)).input);
        return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { headers: { "content-type": "audio/mpeg" } });
      }),
    );
    const { engine, work, local } = makeEngine();
    const r = await engine.speech.say(LONG);
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(r.files[0].endsWith(".mp3")).toBe(true);
    expect(readdirSync(join(work, "history"))).toEqual([r.files[0].split("/").at(-1)]);
    expect(local.plays.map((p) => p.stream?.format)).toEqual([{ codec: "mp3" }]);
  });

  it("where a Stream cannot play, speaks the text in one request when the pieces cannot be WAV (MP3 without a converter)", async () => {
    const inputs: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        inputs.push(JSON.parse(String(init.body)).input);
        return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), { headers: { "content-type": "audio/mpeg" } });
      }),
    );
    const { engine, work, bridgeOut } = makeEngine();
    await engine.setBridge("on");
    const r = await engine.speech.say(LONG);
    expect(inputs.at(-1)).toBe(LONG);
    expect(r.files.length).toBe(1);
    expect(r.files[0].endsWith(".mp3")).toBe(true);
    expect(readdirSync(join(work, "history"))).toEqual([r.files[0].split("/").at(-1)]);
    expect(bridgeOut.plays.map((p) => p.file)).toEqual([r.files[0]]);
    // The next long text goes straight to one request.
    inputs.length = 0;
    await engine.speech.say(LONG);
    expect(inputs).toEqual([LONG]);
  });

  it("a failed request is one error that says what failed and that nothing was saved", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 2) return new Response('{"error":{"message":"rate limited"}}', { status: 429 });
        return new Response(new Uint8Array(4800), { headers: { "content-type": "audio/pcm;rate=24000;channels=1" } });
      }),
    );
    const { engine, work, notes } = makeEngine();
    engine.readAloud.enabled = true;
    await engine.readAloud.onRunEnd([{ role: "assistant", content: [{ type: "text", text: LONG }] }]);
    const errors = notes.filter((x) => x.level === "error");
    expect(errors.length).toBe(1);
    expect(errors[0].message).toMatch(/^Read-aloud stopped: HTTP 429.*rate limited.*The reply was not saved/);
    expect(errors[0].message.match(/fail/gi) ?? []).toEqual([]);
    expect(errors[0].message).not.toMatch(/sk-test/);
    let files: string[] = [];
    try {
      files = readdirSync(join(work, "history"));
    } catch {
      /* no history directory: nothing saved */
    }
    expect(files).toEqual([]);
    await engine.player.stop();
    await tick();
    expect(pieceFiles()).toEqual([]);
  });

  it("a stopped /speech <text> says only that it stopped", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            asked.push(JSON.parse(String(init.body)).input);
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const { engine, work } = makeEngine();
    const ui = scriptedUi();
    const run = new Surface(engine).run(LONG, ui.ui);
    for (let i = 0; i < 50 && asked.length < 2; i++) await tick();
    expect(asked.length).toBe(2);
    await engine.player.stop();
    await run;
    expect(asked.length).toBe(2);
    expect(() => readdirSync(join(work, "history"))).toThrow();
    expect(ui.notes.at(-1)).toEqual({ message: "Stopped.", level: "info" });
  });

  it("a stopped read-aloud is silent", async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            asked.push(JSON.parse(String(init.body)).input);
            init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const { engine, notes } = makeEngine();
    engine.readAloud.enabled = true;
    const run = engine.readAloud.onRunEnd([{ role: "assistant", content: [{ type: "text", text: LONG }] }]);
    for (let i = 0; i < 50 && asked.length < 2; i++) await tick();
    await engine.player.stop();
    await run;
    expect(notes).toEqual([]);
  });

  it("a failed /speech <text> is one error that says the text was not saved", async () => {
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        n++;
        if (n === 1) return new Response("upstream down", { status: 503 });
        return new Response(new Uint8Array(4800), { headers: { "content-type": "audio/pcm;rate=24000;channels=1" } });
      }),
    );
    const { engine } = makeEngine();
    const ui = scriptedUi();
    await expect(new Surface(engine).run(LONG, ui.ui)).rejects.toThrow(
      /^Speech stopped: HTTP 503: upstream down\. The text was not saved; try \/speech --replay/,
    );
    expect(ui.notes).toEqual([]);
  });
});
