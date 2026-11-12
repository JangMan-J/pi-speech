/** xAI as a speech provider, through the engine and the /speech surface, with a stubbed fetch. */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioInput } from "../../src/engine/audio";
import { Surface } from "../../src/engine/surface";
import { makeEngine, scriptedUi } from "./fixtures";

const TOKEN = "xai-login-token-abcdef";
const OR_KEY = "sk-test";

afterEach(() => vi.unstubAllGlobals());

interface Logged {
  url: string;
  method: string;
  auth?: string;
  body?: any;
  form?: FormData;
}

/** Stub fetch for both services: xAI answers PCM / voices / a transcript; OpenRouter as in fixtures. */
function fakeServices(opts: { voices?: unknown[]; transcript?: string } = {}) {
  const log: Logged[] = [];
  const failures: Array<{ status: number; body: unknown }> = [];
  const voices = opts.voices ?? [
    { voice_id: "ara", name: "Ara", language: "multilingual", gender: "female" },
    { voice_id: "eve", name: "Eve", language: "multilingual", gender: "female" },
    { voice_id: "leo", name: "Leo", language: "multilingual", gender: "male" },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const auth = (init.headers as Record<string, string> | undefined)?.Authorization;
      const entry: Logged = { url, method: init.method ?? "GET", auth };
      if (init.body instanceof FormData) entry.form = init.body;
      else if (init.body) entry.body = JSON.parse(String(init.body));
      log.push(entry);
      if (url.startsWith("https://api.x.ai/")) {
        if (auth !== `Bearer ${TOKEN}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
        if (entry.method === "POST" && failures.length) {
          const f = failures.shift()!;
          return Response.json(f.body, { status: f.status });
        }
        if (url.endsWith("/v1/tts/voices")) return Response.json({ voices });
        if (url.endsWith("/v1/tts")) {
          return new Response(new Uint8Array(100), { headers: { "content-type": "audio/pcm" } });
        }
        if (url.endsWith("/v1/stt")) return Response.json({ text: opts.transcript ?? "hello from xai" });
        return Response.json({ error: "not found" }, { status: 404 });
      }
      if (url.endsWith("/audio/speech")) {
        return new Response(new Uint8Array(4800), { headers: { "content-type": "audio/pcm;rate=24000;channels=1" } });
      }
      if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "from openrouter" });
      return new Response("not found", { status: 404 });
    }),
  );
  const xai = () => log.filter((r) => r.url.startsWith("https://api.x.ai/"));
  const openrouter = () => log.filter((r) => r.url.startsWith("https://openrouter.ai/"));
  return { log, xai, openrouter, failNext: (status: number, body: unknown) => failures.push({ status, body }) };
}

function setup(opts: { login?: boolean; env?: Record<string, string>; localInput?: AudioInput } = {}) {
  const made = makeEngine(opts.env ?? {}, opts.localInput);
  let token: string | undefined = opts.login === false ? undefined : TOKEN;
  made.engine.speech.registry = {
    getApiKeyForProvider: async (p: string) => (p === "xai" ? token : undefined),
  };
  const surface = new Surface(made.engine);
  const run = async (args: string) => {
    const s = scriptedUi();
    let error: string | undefined;
    try {
      await surface.run(args, s.ui);
    } catch (err) {
      error = (err as Error).message;
    }
    return { error, text: s.notes.map((n) => n.message).join("\n"), notes: s.notes };
  };
  return { ...made, surface, run, logout: () => (token = undefined) };
}

const lines = (t: string) => t.split("\n");
const saved = (dir: string) => (existsSync(dir) ? readdirSync(dir) : []);

describe("xai without an xAI login", () => {
  it("is not offered, cannot be selected, and nothing is sent to xAI", async () => {
    const svc = fakeServices();
    const { run, engine } = setup({ login: false });
    const models = (await run("--models")).text;
    expect(lines(models).some((l) => /^xai\b/.test(l))).toBe(false);
    const tts = await run("--set tts-model xai");
    expect(tts.error).toMatch(/log in to xAI in Pi \(\/login\)/);
    const stt = await run("--set stt-model xai");
    expect(stt.error).toMatch(/log in to xAI/);
    expect(engine.speech.settings.speechModel).not.toBe("xai");
    expect(engine.speech.settings.transcriptionModel).not.toBe("xai");
    expect(svc.xai()).toHaveLength(0);
  });

  it("a saved xai choice whose login has gone is an error when used, never OpenRouter", async () => {
    const svc = fakeServices();
    const { run, engine, logout, local } = setup();
    expect((await run("--set tts-model xai")).error).toBeUndefined();
    expect((await run("--set stt-model xai")).error).toBeUndefined();
    logout();
    const spoken = await run("hello");
    expect(spoken.error).toMatch(/log in to xAI/);
    await expect(engine.speech.transcribeAudio(Buffer.alloc(8), "wav")).rejects.toThrow(/log in to xAI/);
    expect(svc.openrouter().filter((r) => r.method === "POST")).toHaveLength(0);
    expect(local.plays).toHaveLength(0);
    expect(engine.speech.settings.speechModel).toBe("xai");
  });
});

describe("xai with an xAI login", () => {
  it("is listed once per section with its price label", async () => {
    fakeServices();
    const { run } = setup();
    await run("--set tts-model xai");
    const models = (await run("--models")).text;
    const xaiLines = lines(models).filter((l) => /^xai\b/.test(l));
    expect(xaiLines).toEqual([
      "xai  included with your xAI plan (price unknown)  (selected)",
      "xai  included with your xAI plan (price unknown)",
    ]);
    const speechHeader = lines(models).findIndex((l) => l.startsWith("Speech models"));
    const sttHeader = lines(models).findIndex((l) => l.startsWith("Transcription models"));
    const idx = lines(models)
      .map((l, i) => (/^xai\b/.test(l) ? i : -1))
      .filter((i) => i >= 0);
    expect(idx[0]).toBeGreaterThan(speechHeader);
    expect(idx[0]).toBeLessThan(sttHeader);
    expect(idx[1]).toBeGreaterThan(sttHeader);
  });

  it("selecting xai keeps an xAI voice, else eve, else the first voice", async () => {
    fakeServices();
    const { run, engine } = setup();
    expect((await run("--set tts-model xai")).text).toMatch(/voice: eve/);
    expect(engine.speech.settings.voice).toBe("eve");
    await run("--set voice leo");
    await run("--set tts-model hexgrad/kokoro-82m");
    engine.speech.settings.voice = "leo";
    await run("--set tts-model xai");
    expect(engine.speech.settings.voice).toBe("leo");
  });

  it("falls back to the first voice when eve is not listed", async () => {
    fakeServices({ voices: [{ voice_id: "rex", language: "multilingual" }, { voice_id: "sal" }] });
    const { run, engine } = setup();
    await run("--set tts-model xai");
    expect(engine.speech.settings.voice).toBe("rex");
  });

  it("lists, validates and errors on xAI voices", async () => {
    const svc = fakeServices();
    const { run } = setup();
    await run("--set tts-model xai");
    const voices = (await run("--voices")).text;
    expect(voices).toMatch(/ara/);
    expect(voices).toMatch(/leo/);
    const bad = await run("--set voice Kore");
    expect(bad.error).toMatch(/Kore is not a voice of xai; choose one of: ara, eve, leo/);
    expect(svc.xai().find((r) => r.url.endsWith("/tts/voices"))?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("an empty voice list is shown as such and a failed one is an error", async () => {
    fakeServices({ voices: [] });
    const { run } = setup();
    await run("--set tts-model xai");
    expect((await run("--voices")).text).toMatch(/no voices/i);
    expect((await run("hello")).error).toMatch(/no voices/i);
  });

  it("speaks: text, voice_id, language auto, WAV and MP3 in the history, played as a Stream, no OpenRouter", async () => {
    const svc = fakeServices();
    const { run, engine, local } = setup({ env: { OPENROUTER_API_KEY: "" } });
    await run("--set tts-model xai");
    await run("--set voice leo");
    const r = await run("Hello from xai");
    expect(r.error).toBeUndefined();
    const req = svc
      .xai()
      .filter((x) => x.url.endsWith("/v1/tts"))
      .at(-1);
    expect(req?.body).toMatchObject({ text: "Hello from xai", voice_id: "leo", language: "auto" });
    expect(req?.auth).toBe(`Bearer ${TOKEN}`);
    expect(local.streams).toHaveLength(1);
    expect(local.plays.filter((p) => p.file)).toHaveLength(0);
    expect(saved(engine.speech.historyDir).filter((f) => f.endsWith(".wav"))).toHaveLength(1);
    expect(svc.openrouter().filter((x) => x.method === "POST")).toHaveLength(0);
  });

  it("samples a multilingual voice in English, with the override in Japanese and language ja", async () => {
    const svc = fakeServices();
    const { run, engine } = setup();
    await run("--set tts-model xai");
    const langs = (await run("--languages")).text;
    expect(lines(langs).find((l) => l.startsWith("ara"))).toMatch(/multilingual/);
    expect(lines(langs).find((l) => l.startsWith("ara"))).toMatch(/provider metadata/);
    const en = await run("--sample ara");
    expect(en.text).toMatch(/English/);
    const tts = () => svc.xai().filter((x) => x.url.endsWith("/v1/tts"));
    expect(tts().at(-1)?.body).toMatchObject({ voice_id: "ara", language: "en" });
    expect((await run("--language ara ja")).error).toBeUndefined();
    await run("--sample ara");
    expect(tts().at(-1)?.body.language).toBe("ja");
    expect(tts().at(-1)?.body.text).toMatch(/[\u3040-\u30ff]/);
    expect(saved(engine.speech.historyDir)).toHaveLength(0);
  });

  it("transcribes files and dictation through xAI only, as multipart file", async () => {
    const svc = fakeServices({ transcript: "the quick brown fox" });
    const audio = Buffer.from("RIFF0000WAVEfmt fake");
    const input: AudioInput = {
      name: "local",
      start: async () => ({ stop: async () => ({ audio, format: "wav" }), cancel: async () => {} }),
    };
    const { run, engine, work } = setup({ localInput: input, env: { OPENROUTER_API_KEY: "" } });
    await run("--set stt-model xai");
    const clip = join(work, "clip.wav");
    writeFileSync(clip, audio);
    expect(await engine.speech.transcribeFile(clip, { cwd: work })).toBe("the quick brown fox");
    const ui = scriptedUi();
    await engine.dictation.toggle(ui.ui);
    await engine.dictation.toggle(ui.ui);
    expect(ui.pasted).toEqual(["the quick brown fox"]);
    const stt = svc.xai().filter((x) => x.url.endsWith("/v1/stt"));
    expect(stt).toHaveLength(2);
    const file = stt[0].form?.get("file") as Blob;
    expect(Buffer.from(await file.arrayBuffer())).toEqual(audio);
    expect(svc.openrouter().filter((x) => x.method === "POST")).toHaveLength(0);
  });

  it("failures are visible and final: rejected login, server error, no fallback", async () => {
    const svc = fakeServices();
    const { run, engine, local } = setup();
    await run("--set tts-model xai");
    svc.failNext(401, { error: "Unauthorized" });
    const rejected = await run("this will fail");
    expect(rejected.error).toMatch(/xAI login was rejected/);
    expect(rejected.error).toMatch(/log in/);
    expect(rejected.error).not.toContain(TOKEN);
    svc.failNext(500, { error: "upstream broke" });
    expect((await run("this too")).error).toMatch(/500: upstream broke/);
    expect(local.plays).toHaveLength(0);
    expect(saved(engine.speech.historyDir)).toHaveLength(0);
    expect(svc.openrouter().filter((x) => x.method === "POST")).toHaveLength(0);
  });

  it("credentials stay with their provider", async () => {
    const svc = fakeServices();
    const { run, engine, work } = setup();
    await run("--set tts-model xai");
    await run("hello");
    await run("--set stt-model xai");
    writeFileSync(join(work, "a.wav"), Buffer.alloc(16));
    await engine.speech.transcribeFile("a.wav", { cwd: work });
    await run("--set tts-model hexgrad/kokoro-82m");
    await run("back to openrouter");
    expect(svc.xai().every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(svc.openrouter().every((r) => !r.auth || r.auth === `Bearer ${OR_KEY}`)).toBe(true);
    expect(svc.openrouter().filter((r) => r.url.endsWith("/audio/speech"))).toHaveLength(1);
    expect(JSON.stringify(svc.xai())).not.toContain(OR_KEY);
  });

  it("status and pickers name xai; the choice persists", async () => {
    fakeServices();
    const { run, engine, surface } = setup();
    await run("--set tts-model xai");
    await run("--set stt-model xai");
    const st = (await run("--status")).text;
    expect(st).toMatch(/Speech model: xai/);
    expect(st).toMatch(/Transcription model: xai/);
    const ui = scriptedUi([
      (_t, options) => options?.find((o) => o.startsWith("Speech model")),
      (_t, options) => {
        expect(options?.some((o) => o.startsWith("xai"))).toBe(true);
        return undefined;
      },
    ]);
    await surface.menu(ui.ui);
    engine.start();
    expect(engine.speech.settings.speechModel).toBe("xai");
    expect(engine.speech.settings.transcriptionModel).toBe("xai");
    expect(engine.speech.settings.voice).toBe("eve");
  });
});
