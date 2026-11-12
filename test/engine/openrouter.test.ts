import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSpeechCatalog, synthesize, transcribe, wrapPcmAsWav } from "../../src/engine/openrouter";

const BASE = "https://openrouter.ai/api/v1";

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("wrapPcmAsWav", () => {
  it("prepends a 44-byte PCM WAV header", () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const wav = Buffer.from(wrapPcmAsWav(pcm, 24000, 1));
    expect(wav.length).toBe(50);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + 6);
    expect(wav.subarray(8, 16).toString()).toBe("WAVEfmt ");
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(28)).toBe(48000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(36, 40).toString()).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(6);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("uses the channel count for byte rate and block align", () => {
    const wav = Buffer.from(wrapPcmAsWav(new Uint8Array(8), 16000, 2));
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(28)).toBe(64000);
    expect(wav.readUInt16LE(32)).toBe(4);
  });
});

describe("synthesize", () => {
  it("asks for PCM with the key in the Authorization header and wraps the reply as WAV", async () => {
    const fn = stubFetch(
      () => new Response(new Uint8Array(10), { headers: { "content-type": "audio/pcm;rate=16000;channels=1" } }),
    );
    const r = await synthesize("sk-x", "hello", "m/tts", "eve");
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(`${BASE}/audio/speech`);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "m/tts",
      input: "hello",
      voice: "eve",
      response_format: "pcm",
    });
    expect(r.format).toBe("wav");
    expect(Buffer.from(r.audio).readUInt32LE(24)).toBe(16000);
    expect(r.audio.byteLength).toBe(54);
  });

  it("omits the default voice", async () => {
    const fn = stubFetch(() => new Response(new Uint8Array(4), { headers: { "content-type": "audio/pcm" } }));
    await synthesize("k", "t", "m", "default");
    expect(JSON.parse(String(fn.mock.calls[0][1]?.body)).voice).toBeUndefined();
  });

  it("retries as MP3 when the model rejects the PCM format", async () => {
    const fn = stubFetch((_u, init) => {
      const fmt = JSON.parse(String(init?.body)).response_format;
      if (fmt === "pcm")
        return new Response('{"error":{"message":"response_format pcm unsupported"}}', { status: 400 });
      return new Response(new Uint8Array([0xff, 0xfb]), { headers: { "content-type": "audio/mpeg" } });
    });
    const r = await synthesize("k", "t", "m", "v");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.format).toBe("mp3");
  });

  it("throws a readable error on other failures", async () => {
    stubFetch(() => new Response("nope", { status: 500 }));
    await expect(synthesize("k", "t", "m", "v")).rejects.toThrow(/500.*nope/);
  });
});

describe("transcribe", () => {
  it("sends base64 audio with its format and returns the text", async () => {
    const fn = stubFetch(() => Response.json({ text: "hi there" }));
    const text = await transcribe("sk-y", Buffer.from("abc"), "wav", "openai/whisper-1", "en");
    expect(text).toBe("hi there");
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(`${BASE}/audio/transcriptions`);
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-y");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "openai/whisper-1",
      input_audio: { data: Buffer.from("abc").toString("base64"), format: "wav" },
      language: "en",
    });
  });

  it("throws on HTTP errors", async () => {
    stubFetch(() => new Response("bad", { status: 400 }));
    await expect(transcribe("k", Buffer.from("a"), "wav", "m")).rejects.toThrow(/400.*bad/);
  });
});

describe("fetchSpeechCatalog", () => {
  it("lists speech and transcription models by output modality, with voices and price tags", async () => {
    const fn = stubFetch(() =>
      Response.json({
        data: [
          {
            id: "a/tts",
            name: "Acme: A TTS",
            created: 1790000000,
            description: "A TTS is a low-latency model with inline audio tags and support for 30+ languages...",
            architecture: { output_modalities: ["speech"] },
            supported_voices: ["x", "y"],
            pricing: { prompt: "0.00008", completion: "0" },
          },
          {
            id: "b/stt",
            name: "B STT",
            architecture: { output_modalities: ["transcription"] },
            pricing: { prompt: "0.0001" },
          },
          { id: "c/chat", architecture: { output_modalities: ["text"] } },
          { id: "d/tts", architecture: { output_modalities: ["speech"] }, supported_voices: null },
        ],
      }),
    );
    const cat = await fetchSpeechCatalog();
    expect(String(fn.mock.calls[0][0]).startsWith(`${BASE}/models`)).toBe(true);
    expect(cat.tts).toEqual([
      {
        id: "a/tts",
        label: "Acme: A TTS",
        voices: ["x", "y"],
        price: "~$0.064/min",
        vendor: "Acme",
        features: ["tags", "multilingual", "fast"],
        languages: "30+ langs",
        description: "A TTS is a low-latency model with inline audio tags and support for 30+ languages...",
        created: 1790000000,
      },
      { id: "d/tts", label: "d/tts", voices: undefined, price: undefined, vendor: "d", features: [] },
    ]);
    expect(cat.stt).toEqual([{ id: "b/stt", label: "B STT", price: "$0.006/min", vendor: "b", features: [] }]);
  });

  it("lists the chat models that take or give audio, by the endpoint type the catalog names", async () => {
    const CHAT = ["/api/v1/chat/completions", "/api/v1/completions", "/api/v1/messages", "/api/v1/responses"];
    stubFetch(() =>
      Response.json({
        data: [
          // speaks and listens through /chat/completions
          {
            id: "openai/gpt-audio-mini",
            name: "OpenAI: GPT Audio Mini",
            created: 1790000001,
            description: "A cost-efficient version  of GPT Audio.",
            architecture: { input_modalities: ["text", "audio"], output_modalities: ["text", "audio"] },
            endpoints: CHAT,
            supported_voices: [],
            pricing: { prompt: "0.0000006", completion: "0.0000024", audio: "0.0000006", audio_output: "0.0000024" },
          },
          // listens through /chat/completions
          {
            id: "google/gemini-3.8-flash",
            name: "Google: Gemini 3.8 Flash",
            description:
              "Google's most intelligent Flash model, with speaker diarization and timestamps in its documentation.",
            architecture: { input_modalities: ["text", "image", "audio"], output_modalities: ["text"] },
            endpoints: CHAT,
            pricing: { prompt: "0.000000825", completion: "0.000004125", audio: "0.000000825" },
          },
          // the same model for batch jobs: not on /chat/completions
          {
            id: "google/gemini-3.8-flash:batch",
            architecture: { input_modalities: ["text", "audio"], output_modalities: ["text"] },
            endpoints: ["/api/v1/batches"],
            pricing: { prompt: "0.000000375", completion: "0.000001875" },
          },
          // a router: the audio would go to a model nobody chose
          {
            id: "openrouter/auto",
            architecture: { input_modalities: ["text", "audio"], output_modalities: ["text"] },
            endpoints: CHAT,
            pricing: { prompt: "-1", completion: "-1" },
          },
          // gives audio, but it is music
          {
            id: "google/lyria-3-clip-preview",
            description: "Lyria 3 is Google's family of music generation models.",
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "audio"] },
            endpoints: CHAT,
            pricing: {},
          },
          // a chat model without audio, and one whose endpoint types the catalog does not name
          {
            id: "acme/chat",
            architecture: { input_modalities: ["text"], output_modalities: ["text"] },
            endpoints: CHAT,
          },
          { id: "acme/unknown", architecture: { input_modalities: ["audio"], output_modalities: ["text"] } },
          // built for the purpose: the audio endpoints, as before
          {
            id: "b/stt",
            architecture: { input_modalities: ["audio"], output_modalities: ["transcription"] },
            endpoints: ["/api/v1/audio/transcriptions"],
            pricing: { prompt: "0.0001" },
          },
        ],
      }),
    );
    const cat = await fetchSpeechCatalog();
    expect(cat.tts).toEqual([
      {
        id: "openai/gpt-audio-mini",
        label: "OpenAI: GPT Audio Mini",
        price: "~$0.0036/min",
        vendor: "OpenAI",
        via: "chat",
        features: ["chat", "multilingual"],
        description:
          "A chat model asked to read; a reading that strays from the text is not played. A cost-efficient version of GPT Audio.",
        created: 1790000001,
        voices: [
          "alloy",
          "ash",
          "ballad",
          "cedar",
          "coral",
          "echo",
          "fable",
          "marin",
          "nova",
          "onyx",
          "sage",
          "shimmer",
          "verse",
        ],
      },
    ]);
    expect(cat.stt.map((m) => [m.id, m.via, m.price])).toEqual([
      ["openai/gpt-audio-mini", "chat", "~$0.00096/min"],
      ["google/gemini-3.8-flash", "chat", "~$0.0023/min"],
      ["b/stt", undefined, "$0.006/min"],
    ]);
    const gemini = cat.stt[1];
    // Its description is about chat: timestamps and speakers there say nothing of a transcript asked for.
    expect(gemini.features).toEqual(["chat", "multilingual", "fast"]);
    expect(gemini.description).toMatch(
      /^A chat model asked to transcribe; a few obey a spoken order instead\. Google's/,
    );
  });

  it("does not send an API key for the public catalog", async () => {
    const fn = stubFetch(() => Response.json({ data: [] }));
    await fetchSpeechCatalog();
    const headers = (fn.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("throws when the catalog cannot be loaded", async () => {
    stubFetch(() => new Response("down", { status: 503 }));
    await expect(fetchSpeechCatalog()).rejects.toThrow(/503/);
  });
});
