/** OpenAI-compatible endpoints, against a real local HTTP server that speaks the OpenAI audio API. */

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { kindOfModel } from "../../src/engine/endpoints";
import { Panel } from "../../src/engine/panel";
import { SettingsFile } from "../../src/engine/settings";
import { Surface, usage } from "../../src/engine/surface";
import { wavSeconds } from "../../src/engine/wav";
import { makeEngine, scriptedUi } from "./fixtures";

interface Seen {
  method: string;
  path: string;
  auth?: string;
  json?: any;
  form?: Record<string, string>;
  file?: { name: string; type: string; size: number };
}

/** A WAV as a streaming server sends it: 24 kHz mono 16-bit, the sizes left open (0xFFFFFFFF). */
function streamedWav(seconds: number): Buffer {
  const data = Buffer.alloc(48000 * seconds);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(0xffffffff, 4);
  head.write("WAVEfmt ", 8, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(24000, 24);
  head.writeUInt32LE(48000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(0xffffffff, 40);
  return Buffer.concat([head, data]);
}

interface ServerOptions {
  models?: unknown;
  /** undefined: no voice list (404). */
  voices?: unknown;
  key?: string;
  /** Reject WAV by name, as a server that only has MP3 does. */
  mp3Only?: boolean;
}

const servers: Server[] = [];

async function serve(opts: ServerOptions = {}) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const type = req.headers["content-type"] ?? "";
    const entry: Seen = { method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization };
    if (type.startsWith("application/json")) entry.json = JSON.parse(body.toString());
    if (type.startsWith("multipart/form-data")) {
      const form = await new Response(body, { headers: { "content-type": type } }).formData();
      entry.form = {};
      for (const [k, v] of form) {
        if (typeof v === "string") entry.form[k] = v;
        else entry.file = { name: v.name, type: v.type, size: v.size };
      }
    }
    seen.push(entry);
    const send = (status: number, payload: unknown, contentType = "application/json") => {
      res.writeHead(status, { "content-type": contentType });
      res.end(Buffer.isBuffer(payload) ? payload : JSON.stringify(payload));
    };
    if (opts.key && req.headers.authorization !== `Bearer ${opts.key}`) {
      return send(401, { error: { message: `Incorrect API key provided: ${req.headers.authorization}` } });
    }
    if (entry.path === "/v1/models") {
      return send(
        200,
        opts.models ?? {
          object: "list",
          data: [
            { id: "llama-3.3-70b", object: "model" },
            { id: "kokoro", object: "model" },
            { id: "whisper-large-v3-turbo", object: "model" },
            { id: "whisper-old", object: "model", active: false },
          ],
        },
      );
    }
    if (entry.path === "/v1/audio/voices") {
      return opts.voices === undefined ? send(404, { detail: "Not Found" }) : send(200, opts.voices);
    }
    if (entry.path === "/v1/audio/speech") {
      if (opts.mp3Only && entry.json.response_format !== "mp3") {
        return send(400, { error: { message: "response_format must be one of: mp3" } });
      }
      return opts.mp3Only
        ? send(200, Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), "application/octet-stream")
        : send(200, streamedWav(1), "application/octet-stream");
    }
    if (entry.path === "/v1/audio/transcriptions") return send(200, { text: " heard through the endpoint " });
    if (entry.path === "/v1/chat/completions" && entry.json.stream) {
      // A chat model that speaks: it reads the text between the markers, as base64 PCM cut off the 4-character grid.
      const text = /<<<\n([\s\S]*)\n>>>/.exec(entry.json.messages[1].content)?.[1] ?? "";
      const pcm = Buffer.alloc(4800, 5).toString("base64");
      const event = (audio: object) => `data: ${JSON.stringify({ choices: [{ delta: { audio } }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(event({ data: pcm.slice(0, 1001) }));
      res.write(event({ data: pcm.slice(1001) }));
      res.write(event({ transcript: text }));
      return res.end("data: [DONE]\n\n");
    }
    if (entry.path === "/v1/chat/completions") {
      return send(200, { choices: [{ message: { role: "assistant", content: "heard by a chat model" } }] });
    }
    send(404, { detail: "Not Found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

const KOKORO_VOICES = {
  voices: [{ id: "af_heart", name: "af_heart" }, { id: "bm_george" }],
  default_voice: "af_heart",
};

describe("telling the models of an OpenAI-style list apart", () => {
  it.each([
    ["tts-1", "tts"],
    ["gpt-4o-mini-tts", "tts"],
    ["canopylabs/orpheus-v1-english", "tts"],
    ["hexgrad/Kokoro-82M", "tts"],
    ["ResembleAI/chatterbox-turbo", "tts"],
    ["Qwen/Qwen3-TTS", "tts"],
    ["sesame/csm-1b", "tts"],
    ["whisper-1", "stt"],
    ["whisper-large-v3-turbo", "stt"],
    ["gpt-4o-mini-transcribe", "stt"],
    ["voxtral-mini-latest", "stt"],
    ["Qwen/Qwen3-ASR-0.6B", "stt"],
    ["nvidia/parakeet-tdt-0.6b-v3", "stt"],
    ["gpt-4o-transcribe-diarize", undefined],
    ["gpt-4o-realtime-preview", undefined],
    ["llama-3.3-70b-versatile", undefined],
    ["nvidia/llama-nemotron-embed-vl-1b-v2", undefined],
    ["text-embedding-3-small", undefined],
  ])("%s → %s", (id, kind) => {
    expect(kindOfModel({ id })).toBe(kind);
  });

  it("believes what the server states over the name", () => {
    expect(kindOfModel({ id: "speaches-ai/piper-en", task: "text-to-speech" })).toBe("tts");
    expect(kindOfModel({ id: "Systran/faster-distil-small.en", task: "automatic-speech-recognition" })).toBe("stt");
    expect(kindOfModel({ id: "mystery", type: "transcribe" })).toBe("stt");
  });
});

describe("a user-defined endpoint", () => {
  it("offers the speech and transcription models of its list, named <endpoint>:<model>, with its voices", async () => {
    const { url } = await serve({ voices: KOKORO_VOICES });
    const { engine } = makeEngine();
    const said = await engine.speech.setEndpoint("local", `${url}/`);
    expect(said).toBe("Endpoint local: 1 speech and 1 transcription model, named local:<model>");
    const { tts, stt } = await engine.speech.models();
    const speech = tts.find((m) => m.id === "local:kokoro");
    expect(speech).toMatchObject({ label: "kokoro", vendor: "local", voices: ["af_heart", "bm_george"], price: "$0" });
    expect(stt.find((m) => m.id === "local:whisper-large-v3-turbo")?.features).toEqual([
      "multilingual",
      "fast",
      "free",
    ]);
    // The chat model and the inactive one are not offered; OpenRouter's models still are.
    expect([...tts, ...stt].filter((m) => m.id.startsWith("local:")).map((m) => m.id)).toEqual([
      "local:kokoro",
      "local:whisper-large-v3-turbo",
    ]);
    expect(tts.some((m) => m.id === "hexgrad/kokoro-82m")).toBe(true);
    expect(engine.speech.settings.endpoints.local).toEqual({ baseUrl: url });
  });

  it("speaks through POST /audio/speech and saves a WAV whose open sizes are written", async () => {
    const { url, seen } = await serve({ voices: KOKORO_VOICES });
    const { engine, local } = makeEngine();
    await engine.speech.setEndpoint("local", url);
    expect(await engine.speech.set("tts-model", "local:kokoro")).toBe("Speech model: local:kokoro, voice: af_heart");
    const r = await engine.speech.speak("Hello there.");
    const call = seen.find((s) => s.path === "/v1/audio/speech");
    expect(call?.json).toEqual({ model: "kokoro", input: "Hello there.", voice: "af_heart", response_format: "wav" });
    expect(call?.auth).toBeUndefined(); // no key configured: none sent
    expect(r.model).toBe("local:kokoro");
    expect(local.plays).toHaveLength(1);
    const wav = readFileSync(r.files[0]);
    expect(wav.readUInt32LE(40)).toBe(48000);
    expect(wavSeconds(wav)).toBe(1);
    expect(engine.speech.providerName("local:kokoro")).toBe("local");
  });

  it("transcribes through POST /audio/transcriptions as multipart file + model + language", async () => {
    const { url, seen } = await serve();
    const { engine } = makeEngine();
    await engine.speech.setEndpoint("local", url);
    await engine.speech.set("stt-model", "local:whisper-large-v3-turbo");
    const text = await engine.speech.transcribeAudio(Buffer.from("RIFFfake"), "wav", { language: "ja" });
    expect(text).toBe(" heard through the endpoint ");
    const call = seen.find((s) => s.path === "/v1/audio/transcriptions");
    expect(call?.form).toEqual({ model: "whisper-large-v3-turbo", language: "ja", response_format: "json" });
    expect(call?.file).toEqual({ name: "audio.wav", type: "audio/wav", size: 8 });
  });

  it("sends its key (named by an environment variable) only as the Authorization header", async () => {
    const { url, seen } = await serve({ key: "sk-local-secret" });
    const { engine } = makeEngine({ LOCAL_KEY: "sk-local-secret" });
    await engine.speech.setEndpoint("local", url, "LOCAL_KEY");
    expect(engine.speech.settings.endpoints.local).toEqual({ baseUrl: url, apiKeyEnv: "LOCAL_KEY" });
    expect((await engine.speech.models()).stt.some((m) => m.id === "local:whisper-large-v3-turbo")).toBe(true);
    expect(seen.every((s) => s.auth === "Bearer sk-local-secret")).toBe(true);
  });

  it("a rejected key is a readable error that never shows the key", async () => {
    const { url } = await serve({ key: "the-right-one" });
    const { engine } = makeEngine();
    const said = await engine.speech.setEndpoint("local", url, "sk-wrong-key-12345");
    expect(said).toMatch(/^Endpoint local saved, but it did not answer: local rejected the API key \(HTTP 401\)/);
    expect(said).not.toContain("sk-wrong-key-12345");
    expect(said).toContain("[key]");
    expect(await engine.speech.endpointsReport()).not.toContain("sk-wrong-key-12345");
  });

  it("asks again for MP3 when the server rejects WAV by name", async () => {
    const { url, seen } = await serve({ mp3Only: true });
    const { engine } = makeEngine();
    await engine.speech.setEndpoint("local", url);
    await engine.speech.set("tts-model", "local:kokoro");
    const r = await engine.speech.speak("Hi.", { play: false });
    expect(seen.filter((s) => s.path === "/v1/audio/speech").map((s) => s.json.response_format)).toEqual([
      "wav",
      "mp3",
    ]);
    expect(r.files[0]).toMatch(/\.mp3$/);
  });

  it("passes any voice on when nobody lists the voices of a model", async () => {
    const { url, seen } = await serve(); // no /audio/voices
    const { engine } = makeEngine();
    await engine.speech.setEndpoint("local", url);
    expect(await engine.speech.set("tts-model", "local:kokoro")).toBe("Speech model: local:kokoro, voice: default");
    await engine.speech.speak("One.", { play: false });
    expect(seen.at(-1)?.json).toEqual({ model: "kokoro", input: "One.", response_format: "wav" });
    expect(await engine.speech.set("voice", "tara")).toBe("Voice: tara");
    await engine.speech.speak("Two.", { play: false });
    expect(seen.at(-1)?.json.voice).toBe("tara");
  });

  it("takes its models and voices from the settings when the server has no model list", async () => {
    const { url, seen } = await serve({ models: { data: [] } });
    const { engine } = makeEngine();
    engine.speech.settings.endpoints.fw = { baseUrl: url, stt: ["whisper-v3"], tts: ["speaker"], voices: ["a", "b"] };
    engine.speech.save();
    engine.start();
    const { tts, stt } = await engine.speech.models();
    expect(stt.map((m) => m.id)).toContain("fw:whisper-v3");
    expect(tts.find((m) => m.id === "fw:speaker")?.voices).toEqual(["a", "b"]);
    expect(seen).toEqual([]); // nothing had to be asked
  });

  it("keeps a selected endpoint model across a restart, and when the endpoint is down says so only when used", async () => {
    const { url } = await serve({ voices: KOKORO_VOICES });
    const { engine, notes } = makeEngine();
    await engine.speech.setEndpoint("local", url);
    await engine.speech.set("tts-model", "local:kokoro");
    await engine.speech.set("stt-model", "local:whisper-large-v3-turbo");
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    engine.start();
    await engine.speech.ready();
    expect(engine.speech.settings.speechModel).toBe("local:kokoro");
    expect(engine.speech.settings.transcriptionModel).toBe("local:whisper-large-v3-turbo");
    expect(notes).toEqual([]); // not "replaced" by an OpenRouter model
    expect((await engine.status()).split("\n").find((l) => l.startsWith("Endpoint local"))).toMatch(/✗/);
    await expect(engine.speech.speak("Hi.", { play: false })).rejects.toThrow(/^Speech synthesis failed: /);
    // Dictation and the OpenRouter models are untouched by the dead endpoint.
    expect((await engine.speech.models()).tts.some((m) => m.id === "google/gemini-3.8-flash-tts")).toBe(true);
  });

  it("offers OpenAI's audio chat models for both uses, and reaches them through /chat/completions", async () => {
    const { url, seen } = await serve({
      models: { data: [{ id: "gpt-4o" }, { id: "gpt-audio-mini" }, { id: "whisper-1" }] },
    });
    const { engine, local } = makeEngine();
    await engine.speech.setEndpoint("local", url);
    const { tts, stt } = await engine.speech.models();
    expect(tts.find((m) => m.id === "local:gpt-audio-mini")).toMatchObject({
      via: "chat",
      features: ["chat", "multilingual", "free"],
    });
    expect(stt.filter((m) => m.id.startsWith("local:")).map((m) => [m.id, m.via])).toEqual([
      ["local:whisper-1", undefined],
      ["local:gpt-audio-mini", "chat"],
    ]);
    await engine.speech.set("tts-model", "local:gpt-audio-mini");
    await engine.speech.set("voice", "nova"); // nobody lists the voices of a chat model on an endpoint you added
    const r = await engine.speech.speak("Read me, do not answer me.");
    const spoke = seen.find((s) => s.path === "/v1/chat/completions");
    expect(spoke?.json).toMatchObject({
      model: "gpt-audio-mini",
      stream: true,
      audio: { voice: "nova", format: "pcm16" },
    });
    const wav = readFileSync(r.files[0]);
    expect(wav.subarray(44).equals(Buffer.alloc(4800, 5))).toBe(true);
    expect(local.plays).toHaveLength(1);
    await engine.speech.set("stt-model", "local:gpt-audio-mini");
    expect(await engine.speech.transcribeAudio(Buffer.from("RIFFfake"), "wav")).toBe("heard by a chat model");
    expect(seen.at(-1)?.json.messages[1].content[1].input_audio).toEqual({
      data: Buffer.from("RIFFfake").toString("base64"),
      format: "wav",
    });
    expect(seen.some((s) => s.path.startsWith("/v1/audio/"))).toBe(false);
  });

  it("takes other chat models that take audio from the settings (chatStt)", async () => {
    const { url, seen } = await serve();
    const { engine } = makeEngine();
    engine.speech.settings.endpoints.vllm = { baseUrl: url, chatStt: ["mistralai/Voxtral-Mini-3B-2507"] };
    engine.speech.save();
    engine.start();
    await engine.speech.set("stt-model", "vllm:mistralai/Voxtral-Mini-3B-2507");
    expect(await engine.speech.transcribeAudio(Buffer.from("RIFFfake"), "wav")).toBe("heard by a chat model");
    expect(seen.map((s) => s.path)).toEqual(["/v1/chat/completions"]);
    expect(seen[0].json.model).toBe("mistralai/Voxtral-Mini-3B-2507");
  });

  it("is removed with off; names that would shadow a provider are refused", async () => {
    const { url } = await serve();
    const { engine } = makeEngine();
    await engine.speech.setEndpoint("local", url);
    expect(await engine.speech.removeEndpoint("local")).toBe("Endpoint local removed");
    expect((await engine.speech.models()).tts.some((m) => m.id.startsWith("local:"))).toBe(false);
    await expect(engine.speech.setEndpoint("xai", url)).rejects.toThrow(/xai is taken/);
    await expect(engine.speech.setEndpoint("My Server", url)).rejects.toThrow(/lowercase letters/);
    await expect(engine.speech.setEndpoint("local", "localhost:8880")).rejects.toThrow(/is not a base URL/);
    await expect(engine.speech.removeEndpoint("groq")).rejects.toThrow(/built in/);
  });
});

describe("endpoints on the /speech surface and in the panel", () => {
  it("--endpoint adds and removes, --endpoints lists, and the settings file keeps them", async () => {
    const { url } = await serve({ voices: KOKORO_VOICES });
    const { engine, work } = makeEngine();
    const { ui, notes } = scriptedUi();
    const s = new Surface(engine);
    await s.run(`--endpoint local ${url}`, ui);
    expect(notes.at(-1)?.message).toBe("Endpoint local: 1 speech and 1 transcription model, named local:<model>");
    await s.run("--endpoints", ui);
    expect(notes.at(-1)?.message).toContain(`  local      ${url}`);
    expect(notes.at(-1)?.message).toContain("1 speech model, 1 transcription model");
    await s.run("--set stt-model local:whisper-large-v3-turbo", ui);
    await s.run("--models", ui);
    expect(notes.at(-1)?.message).toContain("local:whisper-large-v3-turbo  $0  multilingual · fast · free  (selected)");
    const saved = new SettingsFile(join(work, "agent", "pi-speech")).load();
    expect(saved.endpoints).toEqual({ local: { baseUrl: url } });
    expect(saved.transcriptionModel).toBe("local:whisper-large-v3-turbo");
    await s.run("--endpoint local off", ui);
    expect(new SettingsFile(join(work, "agent", "pi-speech")).load().endpoints).toEqual({});
    expect(usage()).toContain("/speech --endpoint <name> <base-url|off> [key|KEY_ENV]");
  });

  it("the panel shows an endpoint model as offered even while OpenRouter's catalog is offline", async () => {
    const { url } = await serve({ voices: KOKORO_VOICES });
    const { engine } = makeEngine();
    await engine.speech.setEndpoint("local", url);
    await engine.speech.set("tts-model", "local:kokoro");
    expect(engine.speech.catalogOffline("local:kokoro")).toBe(false);
    expect(engine.speech.catalogOffline("google/gemini-3.8-flash-tts")).toBe(false);
    const panel = new Panel(engine, new Surface(engine), { ui: scriptedUi().ui, close: vi.fn(), changed: vi.fn() });
    panel.open();
    await panel.idle();
    const row = panel.view().rows.find((r) => r.label === "Speech model");
    expect(row).toMatchObject({ value: "local:kokoro", price: "free" });
    expect(row?.alert).toBeUndefined();
  });
});

describe("the built-in endpoints", () => {
  it("are not asked anything, and offer nothing, without a key", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const { engine } = makeEngine();
    const report = await engine.speech.endpointsReport();
    expect(fetched).not.toHaveBeenCalled();
    for (const name of ["openai", "groq", "together", "mistral", "deepinfra"]) expect(report).toContain(`  ${name} `);
    expect(report).toContain("no key (set GROQ_API_KEY, or log in to groq in Pi)");
    expect((await engine.speech.models()).tts.every((m) => !m.id.includes(":"))).toBe(true);
    await expect(engine.speech.set("stt-model", "groq:whisper-large-v3")).rejects.toThrow(/No Groq API key/);
  });

  it("ask their own base URL with the key Pi holds, and know the voices the vendor documents", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(`${(init.headers as Record<string, string>).Authorization} ${url}`);
        if (url === "https://api.groq.com/openai/v1/models") {
          return Response.json({
            data: [
              { id: "canopylabs/orpheus-v1-english" },
              { id: "whisper-large-v3" },
              { id: "llama-3.3-70b-versatile" },
            ],
          });
        }
        return new Response("no", { status: 404 });
      }),
    );
    const { engine } = makeEngine();
    engine.speech.registry = { getApiKeyForProvider: async (p) => (p === "groq" ? "gsk-from-pi" : undefined) };
    engine.start();
    const { tts, stt } = await engine.speech.models();
    expect(urls).toEqual(["Bearer gsk-from-pi https://api.groq.com/openai/v1/models"]);
    expect(tts.find((m) => m.id === "groq:canopylabs/orpheus-v1-english")).toMatchObject({
      vendor: "Groq",
      voices: ["autumn", "diana", "hannah", "austin", "daniel", "troy"],
    });
    expect(stt.map((m) => m.id)).toContain("groq:whisper-large-v3");
    expect(await engine.speech.endpointsReport()).toContain("1 speech model, 1 transcription model");
  });
});
