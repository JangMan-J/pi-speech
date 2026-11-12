import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveXaiToken } from "../../src/engine/credentials";
import {
  listXaiVoices,
  XAI_MODEL,
  XAI_PRICE,
  XaiProvider,
  xaiSynthesize,
  xaiSynthesizeStream,
  xaiTranscribe,
} from "../../src/engine/xai";
import { chunkedBody, pcmBytes } from "./fixtures";

const BASE = "https://api.x.ai/v1";
const TOKEN = "xai-token-123456";

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}
const auth = (init?: RequestInit) => (init?.headers as Record<string, string>)?.Authorization;

afterEach(() => vi.unstubAllGlobals());

describe("the xAI choice", () => {
  it("is the model id xai with no invented price", () => {
    expect(XAI_MODEL).toBe("xai");
    expect(XAI_PRICE).toBe("included with your xAI plan (price unknown)");
    expect(XAI_PRICE).not.toMatch(/\$/);
  });
});

describe("resolveXaiToken", () => {
  it("asks Pi's registry for provider xai and nothing else", async () => {
    const reg = { getApiKeyForProvider: vi.fn(async (p: string) => (p === "xai" ? "tok" : "other")) };
    expect(await resolveXaiToken(reg)).toBe("tok");
    expect(reg.getApiKeyForProvider).toHaveBeenCalledWith("xai");
    expect(reg.getApiKeyForProvider).toHaveBeenCalledTimes(1);
  });

  it("is undefined without a registry, a login, or when the lookup throws", async () => {
    expect(await resolveXaiToken(undefined)).toBeUndefined();
    expect(await resolveXaiToken({ getApiKeyForProvider: async () => undefined })).toBeUndefined();
    expect(await resolveXaiToken({ getApiKeyForProvider: async () => "" })).toBeUndefined();
    expect(
      await resolveXaiToken({
        getApiKeyForProvider: async () => {
          throw new Error("refresh failed");
        },
      }),
    ).toBeUndefined();
  });
});

describe("listXaiVoices", () => {
  it("reads GET /v1/tts/voices with the token", async () => {
    const fn = stubFetch(() =>
      Response.json({
        voices: [
          { voice_id: "ara", name: "Ara", language: "multilingual", gender: "female" },
          { voice_id: "eve", name: "Eve", language: "multilingual", gender: "female" },
        ],
      }),
    );
    const voices = await listXaiVoices(TOKEN);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(`${BASE}/tts/voices`);
    expect(init?.method ?? "GET").toBe("GET");
    expect(auth(init)).toBe(`Bearer ${TOKEN}`);
    expect(voices).toEqual([
      { id: "ara", name: "Ara", language: "multilingual", gender: "female" },
      { id: "eve", name: "Eve", language: "multilingual", gender: "female" },
    ]);
  });

  it("returns an empty list as such", async () => {
    stubFetch(() => Response.json({ voices: [] }));
    expect(await listXaiVoices(TOKEN)).toEqual([]);
  });
});

describe("xaiSynthesizeStream", () => {
  it("posts text, voice_id, language and asks for 24 kHz PCM", async () => {
    const fn = stubFetch(() => new Response(new Uint8Array(4), { headers: { "content-type": "audio/pcm" } }));
    const s = await xaiSynthesizeStream(TOKEN, { text: "hello", voice: "leo", language: "auto" });
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(`${BASE}/tts`);
    expect(init?.method).toBe("POST");
    expect(auth(init)).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "hello",
      voice_id: "leo",
      language: "auto",
      output_format: { codec: "pcm", sample_rate: 24000 },
    });
    expect(s.format).toEqual({ codec: "pcm", rate: 24000, channels: 1 });
  });

  it("hands over each chunk as it arrives, before the response has ended", async () => {
    const b = chunkedBody();
    stubFetch(() => new Response(b.body, { headers: { "content-type": "audio/pcm" } }));
    const s = await xaiSynthesizeStream(TOKEN, { text: "hello", voice: "eve", language: "auto" });
    const it = s.chunks[Symbol.asyncIterator]();
    b.send(pcmBytes(10));
    expect(Array.from((await it.next()).value as Uint8Array)).toEqual(Array.from(pcmBytes(10)));
    b.send(pcmBytes(6, 10));
    expect(Array.from((await it.next()).value as Uint8Array)).toEqual(Array.from(pcmBytes(6, 10)));
    b.end();
    expect((await it.next()).done).toBe(true);
  });

  it("a response that breaks off midway is an error while reading, naming xAI", async () => {
    const b = chunkedBody();
    stubFetch(() => new Response(b.body, { headers: { "content-type": "audio/pcm" } }));
    const s = await xaiSynthesizeStream(TOKEN, { text: "hello", voice: "eve", language: "auto" });
    const it = s.chunks[Symbol.asyncIterator]();
    b.send(pcmBytes(4));
    await it.next();
    b.fail(new Error("socket hang up"));
    const err = await it.next().catch((e) => e);
    expect(err.message).toMatch(/xAI/);
    expect(err.message).toMatch(/socket hang up/);
  });

  it("an MP3 answer is taken as MP3; anything that is not audio is an error", async () => {
    const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
    stubFetch(() => new Response(mp3, { headers: { "content-type": "audio/mpeg" } }));
    expect((await xaiSynthesizeStream(TOKEN, { text: "hi", voice: "eve", language: "auto" })).format).toEqual({
      codec: "mp3",
    });
    stubFetch(() => new Response("<html>gateway</html>", { headers: { "content-type": "text/html" } }));
    const err = await xaiSynthesizeStream(TOKEN, { text: "hi", voice: "eve", language: "auto" }).catch((e) => e);
    expect(err.message).toMatch(/unexpected audio from xAI: text\/html/);
  });
});

describe("xaiSynthesize", () => {
  it("collects the PCM into one 24 kHz mono WAV", async () => {
    stubFetch(() => new Response(pcmBytes(50), { headers: { "content-type": "audio/pcm" } }));
    const r = await xaiSynthesize(TOKEN, { text: "hello", voice: "leo", language: "auto" });
    expect(r.format).toBe("wav");
    const wav = Buffer.from(r.audio);
    expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
    expect(wav.toString("latin1", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(Array.from(wav.subarray(44))).toEqual(Array.from(pcmBytes(50)));
  });

  it("no audio at all is an error", async () => {
    stubFetch(() => new Response(new Uint8Array(0), { headers: { "content-type": "audio/pcm" } }));
    const err = await xaiSynthesize(TOKEN, { text: "hi", voice: "eve", language: "auto" }).catch((e) => e);
    expect(err.message).toMatch(/no audio/);
  });

  it.each([401, 403])("a %i says the xAI login was rejected and to log in again, without the token", async (status) => {
    stubFetch(() => Response.json({ error: `bad token ${TOKEN}` }, { status }));
    const err = await xaiSynthesize(TOKEN, { text: "hi", voice: "eve", language: "auto" }).catch((e) => e);
    expect(err.message).toMatch(/xAI login was rejected/);
    expect(err.message).toMatch(/log in/);
    expect(err.message).not.toContain(TOKEN);
  });

  it("a 400 about the credentials is a rejected login", async () => {
    stubFetch(() => Response.json({ error: "Incorrect API key provided" }, { status: 400 }));
    const err = await xaiSynthesize(TOKEN, { text: "hi", voice: "eve", language: "auto" }).catch((e) => e);
    expect(err.message).toMatch(/xAI login was rejected/);
  });

  it("other errors show their status and message", async () => {
    stubFetch(() => Response.json({ error: "TTS synthesis failed: Voice 'x' not found" }, { status: 404 }));
    const err = await xaiSynthesize(TOKEN, { text: "hi", voice: "x", language: "auto" }).catch((e) => e);
    expect(err.message).toMatch(/404/);
    expect(err.message).toMatch(/Voice 'x' not found/);
    expect(err.message).not.toMatch(/login/);
  });
});

describe("xaiTranscribe", () => {
  it("posts the audio as multipart field file and returns text", async () => {
    const fn = stubFetch(() => Response.json({ text: "the quick brown fox", language: "en", duration: 1, words: [] }));
    const audio = new Uint8Array([1, 2, 3, 4]);
    const text = await xaiTranscribe(TOKEN, audio, "wav");
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(`${BASE}/stt`);
    expect(init?.method).toBe("POST");
    expect(auth(init)).toBe(`Bearer ${TOKEN}`);
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get("file") as File;
    expect(file).toBeInstanceOf(Blob);
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3, 4]);
    expect(text).toBe("the quick brown fox");
  });

  it("a rejected token is a rejected login", async () => {
    stubFetch(() => Response.json({ error: "Unauthorized" }, { status: 401 }));
    await expect(xaiTranscribe(TOKEN, new Uint8Array(4), "wav")).rejects.toThrow(/xAI login was rejected/);
  });
});

describe("XaiProvider", () => {
  const registry = (token?: string) => ({ getApiKeyForProvider: vi.fn(async () => token) });

  it("without a login says to log in and sends nothing", async () => {
    const fn = stubFetch(() => Response.json({ voices: [] }));
    const p = new XaiProvider(() => registry(undefined));
    expect(await p.available()).toBe(false);
    await expect(p.voices()).rejects.toThrow(/log in to xAI in Pi \(\/login\)/);
    await expect(p.synthesize({ text: "hi", model: "xai", voice: "eve", language: "auto" })).rejects.toThrow(/log in/);
    await expect(p.transcribe({ audio: new Uint8Array(4), format: "wav", model: "xai" })).rejects.toThrow(/log in/);
    expect(fn).not.toHaveBeenCalled();
  });

  it("caches a voice list until forgotten, but not a failure", async () => {
    let fail = true;
    const fn = stubFetch(() =>
      fail
        ? Response.json({ error: "down" }, { status: 503 })
        : Response.json({ voices: [{ voice_id: "eve", language: "multilingual" }] }),
    );
    const p = new XaiProvider(() => registry(TOKEN));
    await expect(p.voices()).rejects.toThrow(/503/);
    expect(p.cachedVoices()).toBeUndefined();
    fail = false;
    expect((await p.voices()).map((v) => v.id)).toEqual(["eve"]);
    await p.voices();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(p.cachedVoices()?.map((v) => v.id)).toEqual(["eve"]);
    p.forget();
    expect(p.cachedVoices()).toBeUndefined();
  });
});
