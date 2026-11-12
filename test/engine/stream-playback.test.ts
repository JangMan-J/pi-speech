/** Speech played as a Stream (GLOSSARY.md): xAI's audio reaches the player while the response still arrives. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Surface } from "../../src/engine/surface";
import { chunkedBody, makeEngine, pcmBytes, scriptedUi, until } from "./fixtures";

const TOKEN = "xai-login-token-abcdef";

afterEach(() => vi.unstubAllGlobals());

/** xAI behind a stubbed fetch: each speech request gets a body the test sends by hand. */
function fakeXai() {
  const bodies: Array<ReturnType<typeof chunkedBody> & { aborted: boolean; text: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.endsWith("/v1/tts/voices")) {
        return Response.json({ voices: [{ voice_id: "eve", name: "Eve", language: "multilingual" }] });
      }
      if (url.endsWith("/v1/tts")) {
        const b = Object.assign(chunkedBody(), { aborted: false, text: JSON.parse(String(init.body)).text });
        // As a real fetch does: aborting the request breaks off its body.
        init.signal?.addEventListener("abort", () => {
          b.aborted = true;
          b.fail(new DOMException("This operation was aborted", "AbortError"));
        });
        bodies.push(b);
        return new Response(b.body, { headers: { "content-type": "audio/pcm" } });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return { bodies };
}

async function setup() {
  const made = makeEngine({ OPENROUTER_API_KEY: "" });
  made.engine.speech.registry = { getApiKeyForProvider: async (p: string) => (p === "xai" ? TOKEN : undefined) };
  const surface = new Surface(made.engine);
  const run = async (args: string) => {
    const s = scriptedUi();
    let error: string | undefined;
    try {
      await surface.run(args, s.ui);
    } catch (err) {
      error = (err as Error).message;
    }
    return { error, text: s.notes.map((n) => n.message).join("\n") };
  };
  expect((await run("--set tts-model xai")).error).toBeUndefined();
  const history = () => {
    const dir = made.engine.speech.historyDir;
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".wav")) : [];
  };
  return { ...made, run, history };
}

describe("xai played as a Stream", () => {
  it("the first chunk reaches the player before the response has ended; the message is saved as one WAV", async () => {
    const x = fakeXai();
    const { run, local, history, engine } = await setup();
    const spoken = run("Hello from xai");
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(4800));
    await until(() => local.streams[0]?.chunks.length === 1);
    expect(local.streams[0].format).toEqual({ codec: "pcm", rate: 24000, channels: 1 });
    expect(history()).toHaveLength(0);
    x.bodies[0].send(pcmBytes(4800, 4800));
    x.bodies[0].end();
    expect((await spoken).error).toBeUndefined();
    await until(() => local.streams[0].ended);
    expect(local.plays.filter((p) => p.file)).toHaveLength(0);
    expect(history()).toHaveLength(1);
    const wav = readFileSync(join(engine.speech.historyDir, history()[0]));
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(Array.from(wav.subarray(44))).toEqual(Array.from(pcmBytes(9600)));
    expect(engine.player.playing).toBe(true);
    local.streams[0].finish({ state: "completed" });
    await until(() => !engine.player.playing);
  });

  it("stopped before the response has fully arrived: playback ends, the request is cancelled, nothing is saved", async () => {
    const x = fakeXai();
    const { run, local, history, engine } = await setup();
    const spoken = run("Hello from xai");
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(4800));
    await until(() => local.streams[0]?.chunks.length === 1);
    expect(await engine.player.stop()).toBe(true);
    const r = await spoken;
    expect(r.error).toBeUndefined();
    expect(r.text).toBe("Stopped.");
    expect(x.bodies[0].aborted).toBe(true);
    expect(local.streams[0].outcome).toEqual({ state: "cancelled" });
    expect(history()).toHaveLength(0);
    expect(engine.player.playing).toBe(false);
  });

  it("a newer playback replaces it: the old request is cancelled and its later chunks never play", async () => {
    const x = fakeXai();
    const { run, local, history } = await setup();
    const first = run("First message");
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(100));
    await until(() => local.streams[0]?.chunks.length === 1);
    const second = run("Second message");
    await until(() => x.bodies.length === 2);
    x.bodies[1].send(pcmBytes(200));
    await until(() => local.streams[1]?.chunks.length === 1);
    expect(local.streams[0].outcome).toEqual({ state: "cancelled" });
    expect(x.bodies[0].aborted).toBe(true);
    x.bodies[1].end();
    expect((await first).text).toBe("Stopped.");
    expect((await second).error).toBeUndefined();
    expect(local.streams[0].chunks).toHaveLength(1);
    expect(history()).toHaveLength(1);
  });

  it("a response that breaks off stops playback, shows xAI's message and saves nothing", async () => {
    const x = fakeXai();
    const { run, local, history, engine } = await setup();
    const spoken = run("Hello from xai");
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(100));
    await until(() => local.streams[0]?.chunks.length === 1);
    x.bodies[0].fail(new Error("socket hang up"));
    const r = await spoken;
    expect(r.error).toMatch(/xAI stopped sending audio: socket hang up/);
    expect(local.streams[0].outcome).toEqual({ state: "cancelled" });
    expect(history()).toHaveLength(0);
    expect(engine.player.playing).toBe(false);
  });

  it("a response with no audio at all is an error and saves nothing", async () => {
    const x = fakeXai();
    const { run, history } = await setup();
    const spoken = run("Hello from xai");
    await until(() => x.bodies.length === 1);
    x.bodies[0].end();
    expect((await spoken).error).toMatch(/no audio/);
    expect(history()).toHaveLength(0);
  });

  it("where a Stream cannot play (the bridge), the whole clip plays once it has arrived, with one notice", async () => {
    const x = fakeXai();
    const { run, local, bridgeOut, history, notes } = await setup();
    expect((await run("--bridge on")).error).toBeUndefined();
    const spoken = run("Hello from xai");
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(100));
    await new Promise((r) => setTimeout(r, 30));
    expect(bridgeOut.plays).toHaveLength(0);
    x.bodies[0].end();
    expect((await spoken).error).toBeUndefined();
    expect(bridgeOut.plays).toHaveLength(1);
    expect(bridgeOut.plays[0].file).toMatch(/\.wav$/);
    expect(local.streams).toHaveLength(0);
    expect(history()).toHaveLength(1);
    const again = run("Hello again");
    await until(() => x.bodies.length === 2);
    x.bodies[1].send(pcmBytes(100));
    x.bodies[1].end();
    await again;
    expect(bridgeOut.plays).toHaveLength(2);
    const warned = notes.filter((n) => /as it arrives/.test(n.message));
    expect(warned).toHaveLength(1);
    expect(warned[0].level).toBe("warning");
  });

  it("speaking without playing saves the message and plays nothing", async () => {
    const x = fakeXai();
    const { engine, local, history } = await setup();
    const spoken = engine.speech.speak("Saved only", { play: false });
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(100));
    x.bodies[0].end();
    const r = await spoken;
    expect(r.notPlayed).toBe("play was false");
    expect(local.plays).toHaveLength(0);
    expect(history()).toHaveLength(1);
  });

  it("a voice sample plays as a Stream and is never saved", async () => {
    const x = fakeXai();
    const { run, local, history } = await setup();
    const sampled = run("--sample eve");
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(100));
    await until(() => local.streams[0]?.chunks.length === 1);
    expect(local.streams[0].kind).toBe("sample");
    x.bodies[0].end();
    expect((await sampled).error).toBeUndefined();
    expect(history()).toHaveLength(0);
  });

  it("the caller's signal during the download stops it: the request is cancelled, nothing is saved", async () => {
    const x = fakeXai();
    const { engine, local, history } = await setup();
    const caller = new AbortController();
    const spoken = engine.speech.speak("Hello from xai", { signal: caller.signal });
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(100));
    await until(() => local.streams[0]?.chunks.length === 1);
    caller.abort();
    const r = await spoken;
    expect(r.stopped).toBe(true);
    expect(x.bodies[0].aborted).toBe(true);
    expect(local.streams[0].outcome).toEqual({ state: "cancelled" });
    expect(history()).toHaveLength(0);
  });

  it("the caller's signal aborted after the speech was saved does not stop its playback", async () => {
    const x = fakeXai();
    const { engine, local } = await setup();
    const caller = new AbortController();
    const spoken = engine.speech.speak("Hello from xai", { signal: caller.signal });
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(100));
    x.bodies[0].end();
    expect((await spoken).player).toBe("local");
    caller.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(local.streams[0].outcome).toBeUndefined();
    expect(engine.player.playing).toBe(true);
  });

  it("a caller's signal already aborted sends no request", async () => {
    const x = fakeXai();
    const { engine, history } = await setup();
    const r = await engine.speech.speak("Hello from xai", { signal: AbortSignal.abort() });
    expect(r.stopped).toBe(true);
    expect(x.bodies).toHaveLength(0);
    expect(history()).toHaveLength(0);
  });

  it("where a Stream cannot play, stop during the download cancels the request and saves nothing", async () => {
    const x = fakeXai();
    const { run, engine, bridgeOut, history } = await setup();
    expect((await run("--bridge on")).error).toBeUndefined();
    const spoken = run("Hello from xai");
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(100));
    await engine.player.stop();
    expect((await spoken).text).toBe("Stopped.");
    expect(x.bodies[0].aborted).toBe(true);
    expect(bridgeOut.plays).toHaveLength(0);
    expect(history()).toHaveLength(0);
  });

  it("where a Stream cannot play, what plays goes on until the next clip has arrived", async () => {
    const x = fakeXai();
    const { run, bridgeOut } = await setup();
    expect((await run("--bridge on")).error).toBeUndefined();
    const first = run("First");
    await until(() => x.bodies.length === 1);
    x.bodies[0].send(pcmBytes(100));
    x.bodies[0].end();
    await first;
    expect(bridgeOut.plays).toHaveLength(1);
    const second = run("Second");
    await until(() => x.bodies.length === 2);
    x.bodies[1].send(pcmBytes(100));
    await new Promise((r) => setTimeout(r, 20));
    expect(bridgeOut.cancelled).toBe(0);
    x.bodies[1].end();
    await second;
    expect(bridgeOut.plays).toHaveLength(2);
    expect(bridgeOut.cancelled).toBe(1);
  });
});

/** OpenRouter's /audio/speech behind a stubbed fetch: each request gets a body the test sends by hand. */
function fakeOpenRouterSpeech(type = "audio/pcm;rate=24000;channels=1", refusePcm = false) {
  const bodies: Array<ReturnType<typeof chunkedBody> & { aborted: boolean }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (!url.endsWith("/audio/speech")) return new Response("not found", { status: 404 });
      if (refusePcm && JSON.parse(String(init.body)).response_format === "pcm") {
        return new Response('{"error":{"message":"response_format pcm unsupported"}}', { status: 400 });
      }
      const b = Object.assign(chunkedBody(), { aborted: false });
      init.signal?.addEventListener("abort", () => {
        b.aborted = true;
        b.fail(new DOMException("This operation was aborted", "AbortError"));
      });
      bodies.push(b);
      return new Response(b.body, { headers: { "content-type": type } });
    }),
  );
  return { bodies };
}

describe("OpenRouter audio speech played as a Stream", () => {
  async function orSetup() {
    const made = makeEngine();
    const surface = new Surface(made.engine);
    const run = async (args: string) => {
      const s = scriptedUi();
      await surface.run(args, s.ui).catch((err) => s.notes.push({ message: (err as Error).message, level: "error" }));
      return s.notes.map((n) => n.message).join("\n");
    };
    await run("--set tts-model x-ai/grok-voice-tts-1.0");
    const history = () => {
      const dir = made.engine.speech.historyDir;
      return existsSync(dir) ? readdirSync(dir) : [];
    };
    return { ...made, run, history };
  }

  it("a maker that sends audio over time: the first chunk plays before the last has arrived", async () => {
    const or = fakeOpenRouterSpeech();
    const { run, local, history } = await orSetup();
    const spoken = run("Hello from OpenRouter");
    await until(() => or.bodies.length === 1);
    or.bodies[0].send(pcmBytes(4800));
    await until(() => local.streams[0]?.chunks.length === 1);
    expect(history()).toHaveLength(0);
    or.bodies[0].send(pcmBytes(4800, 4800));
    or.bodies[0].end();
    await spoken;
    expect(history().filter((f) => f.endsWith(".wav"))).toHaveLength(1);
  });

  it("a maker that sends one late burst plays through the same path", async () => {
    const or = fakeOpenRouterSpeech();
    const { run, local, history } = await orSetup();
    const spoken = run("Hello from OpenRouter");
    await until(() => or.bodies.length === 1);
    or.bodies[0].send(pcmBytes(9600));
    or.bodies[0].end();
    await spoken;
    expect(local.streams).toHaveLength(1);
    expect(Buffer.concat(local.streams[0].chunks).length).toBe(9600);
    expect(history().filter((f) => f.endsWith(".wav"))).toHaveLength(1);
  });

  it("a model that refuses PCM plays its MP3 as a Stream and saves it as MP3", async () => {
    const or = fakeOpenRouterSpeech("audio/mpeg", true);
    const { run, local, history } = await orSetup();
    const spoken = run("Hello in MP3");
    await until(() => or.bodies.length === 1);
    or.bodies[0].send(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]));
    await until(() => local.streams[0]?.chunks.length === 1);
    expect(local.streams[0].format).toEqual({ codec: "mp3" });
    or.bodies[0].end();
    await spoken;
    expect(history().filter((f) => f.endsWith(".mp3"))).toHaveLength(1);
  });

  it("stop during the download cancels OpenRouter's request and saves nothing", async () => {
    const or = fakeOpenRouterSpeech();
    const { run, local, engine, history } = await orSetup();
    const spoken = run("Hello from OpenRouter");
    await until(() => or.bodies.length === 1);
    or.bodies[0].send(pcmBytes(100));
    await until(() => local.streams[0]?.chunks.length === 1);
    await engine.player.stop();
    expect(await spoken).toBe("Stopped.");
    expect(or.bodies[0].aborted).toBe(true);
    expect(history()).toHaveLength(0);
  });
});
