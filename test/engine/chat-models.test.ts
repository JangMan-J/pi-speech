/** Chat models as speech and transcription models, through the engine, the /speech surface and the panel. */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechCatalog } from "../../src/engine/openrouter";
import { Panel } from "../../src/engine/panel";
import { READING_MIN_CHARS } from "../../src/engine/pieces";
import { Surface } from "../../src/engine/surface";
import { CATALOG, makeEngine as makeFixtureEngine, scriptedUi } from "./fixtures";

const WITH_CHAT: SpeechCatalog = {
  tts: [
    ...CATALOG.tts,
    {
      id: "openai/gpt-audio-mini",
      label: "OpenAI: GPT Audio Mini",
      price: "~$0.0036/min",
      vendor: "OpenAI",
      via: "chat",
      features: ["chat", "multilingual"],
      voices: ["alloy", "ash"],
      description: "A chat model asked to read the text; a reading that strays from it is not played.",
    },
    { id: "acme/talker", label: "Talker", vendor: "acme", via: "chat", features: ["chat", "multilingual"] },
  ],
  stt: [
    ...CATALOG.stt,
    {
      id: "google/gemini-3.8-flash",
      label: "Google: Gemini 3.8 Flash",
      price: "~$0.0023/min",
      vendor: "Google",
      via: "chat",
      features: ["chat", "multilingual", "fast"],
      description: "A chat model asked to transcribe; a few follow a spoken order instead of writing it down.",
    },
  ],
};

const sse = (events: unknown[]) =>
  new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });

/**
 * A fake OpenRouter with both endpoint types. A chat model reads the text between the markers, unless
 * `says` puts other words in its mouth; it writes "written by a chat model" for any recording.
 */
function fakeOpenRouter(says?: (text: string) => string) {
  const requests: Array<{ path: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.replace("/api/v1", "");
      const body = JSON.parse(String(init.body));
      requests.push({ path, body });
      if (path === "/chat/completions" && body.stream) {
        const text = /<<<\n([\s\S]*)\n>>>/.exec(body.messages[1].content)?.[1] ?? "";
        const pcm = Buffer.alloc(4800, 3).toString("base64");
        return sse([
          { choices: [{ delta: { audio: { data: pcm } } }] },
          { choices: [{ delta: { audio: { transcript: says ? says(text) : text } } }] },
        ]);
      }
      if (path === "/chat/completions") {
        return Response.json({ choices: [{ message: { content: "written by a chat model" } }] });
      }
      if (path === "/audio/speech") {
        return new Response(new Uint8Array(4800), { headers: { "content-type": "audio/pcm;rate=24000;channels=1" } });
      }
      if (path === "/audio/transcriptions") return Response.json({ text: "written by a transcription model" });
      return new Response("not found", { status: 404 });
    }),
  );
  return requests;
}

const engines: Array<ReturnType<typeof makeFixtureEngine>["engine"]> = [];
const makeEngine = () => {
  const made = makeFixtureEngine({}, undefined, WITH_CHAT);
  engines.push(made.engine);
  return made;
};
const paths = (requests: Array<{ path: string }>) => requests.map((r) => r.path);
const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

afterEach(async () => {
  for (const e of engines.splice(0)) await e.shutdown();
  await tick();
  vi.unstubAllGlobals();
});

describe("a chat model as the transcription model", () => {
  it("is reached through /chat/completions with the recording and the dictation language", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    expect(await engine.speech.set("stt-model", "google/gemini-3.8-flash")).toBe(
      "Transcription model: google/gemini-3.8-flash",
    );
    const text = await engine.speech.transcribeAudio(Buffer.from("RIFFfake"), "wav", { language: "ja" });
    expect(text).toBe("written by a chat model");
    expect(paths(requests)).toEqual(["/chat/completions"]);
    const parts = requests[0].body.messages[1].content;
    expect(parts[0].text).toContain("The language spoken is ja.");
    expect(parts[1]).toEqual({
      type: "input_audio",
      input_audio: { data: Buffer.from("RIFFfake").toString("base64"), format: "wav" },
    });
  });

  it("leaves a model built for transcription on /audio/transcriptions", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    expect(await engine.speech.transcribeAudio(Buffer.from("RIFFfake"), "wav")).toBe(
      "written by a transcription model",
    );
    expect(paths(requests)).toEqual(["/audio/transcriptions"]);
  });

  it("is listed with the others, told apart as chat, and filtered by it in the panel", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    const ui = scriptedUi();
    await new Surface(engine).run("--models", ui.ui);
    expect(ui.notes.at(-1)?.message).toContain("google/gemini-3.8-flash  ~$0.0023/min  chat · multilingual · fast");
    const panel = new Panel(engine, new Surface(engine), { ui: ui.ui, close: vi.fn(), changed: vi.fn() });
    panel.open();
    await panel.idle();
    while (panel.view().rows[panel.view().selected].label !== "Transcription model") panel.handle({ key: "down" });
    panel.handle({ key: "enter" });
    await panel.idle();
    const row = () => panel.view().picker?.items.find((i) => i.id === "google/gemini-3.8-flash");
    expect(row()).toMatchObject({ price: "~$0.0023/min", cols: ["multilingual", "chat · fast"] });
    expect(panel.view().picker?.items).toHaveLength(3);
    panel.handle({ key: "backtab" });
    await panel.idle();
    expect(panel.view().picker?.show).toBe("chat");
    expect(panel.view().picker?.items.map((i) => i.id)).toEqual(["google/gemini-3.8-flash"]);
    expect(panel.view().picker?.detail).toMatch(/^A chat model asked to transcribe/);
  });
});

describe("a chat model as the speech model", () => {
  it("is reached through /chat/completions with its voice, saved as WAV and played", async () => {
    const requests = fakeOpenRouter();
    const { engine, local } = makeEngine();
    expect(await engine.speech.set("tts-model", "openai/gpt-audio-mini")).toBe(
      "Speech model: openai/gpt-audio-mini, voice: alloy",
    );
    const r = await engine.speech.speak("The build passed.");
    expect(paths(requests)).toEqual(["/chat/completions"]);
    expect(requests[0].body.audio).toEqual({ voice: "alloy", format: "pcm16" });
    expect(r.files[0]).toMatch(/\.wav$/);
    expect(local.plays).toHaveLength(1);
  });

  it("plays and saves nothing when the model answers the text instead of reading it, and asks only once", async () => {
    const requests = fakeOpenRouter(() => "The capital of France is Paris.");
    const { engine, local, work } = makeEngine();
    await engine.speech.set("tts-model", "openai/gpt-audio-mini");
    await expect(engine.speech.speak("What is the capital of France?")).rejects.toThrow(
      /^Speech synthesis failed: the model did not read the text as written \(it said: "The capital of France is Paris\."\), so nothing was played/,
    );
    // Played as a Stream, a reading is not asked for again: part of it may have been heard.
    expect(paths(requests)).toEqual(["/chat/completions"]);
    expect(local.streams.flatMap((s) => s.chunks)).toEqual([]);
    expect(engine.speech.messages()).toEqual([]);
    const history = join(work, "history");
    expect(existsSync(history) ? readdirSync(history).filter((f) => /\.(wav|mp3)$/.test(f)) : []).toEqual([]);
  });

  it("plays as a Stream while the words match, and a Stray midway stops it and saves nothing", async () => {
    const pcm = Buffer.alloc(4800, 3).toString("base64");
    const said = (transcript: string) => ({ choices: [{ delta: { audio: { transcript } } }] });
    const audio = { choices: [{ delta: { audio: { data: pcm } } }] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sse([said("The build"), audio, said(" passed."), audio, said(" Anything else?"), audio])),
    );
    const { engine, local, work } = makeEngine();
    await engine.speech.set("tts-model", "openai/gpt-audio-mini");
    await expect(engine.speech.speak("The build passed.")).rejects.toThrow(
      /it said: "The build passed\. Anything else\?"\), so playback was stopped/,
    );
    expect(local.streams[0].outcome).toEqual({ state: "cancelled" });
    expect(engine.player.playing).toBe(false);
    const history = join(work, "history");
    expect(existsSync(history) ? readdirSync(history).filter((f) => /\.(wav|mp3)$/.test(f)) : []).toEqual([]);
  });

  it("reads a long reply in pieces, each one checked", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    await engine.speech.set("tts-model", "openai/gpt-audio-mini");
    const long = Array.from({ length: 10 }, (_, i) => `This is sentence ${i + 1} of a long spoken reply.`).join(" ");
    expect(long.length).toBeGreaterThan(READING_MIN_CHARS);
    const r = await engine.speech.say(long);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(paths(requests))).toEqual(new Set(["/chat/completions"]));
    expect(r.files).toHaveLength(1);
  });

  it("passes any voice on when the catalog lists none for it", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    expect(await engine.speech.set("tts-model", "acme/talker")).toBe("Speech model: acme/talker, voice: default");
    await engine.speech.speak("One.", { play: false });
    expect(requests.at(-1)?.body.audio).toEqual({ format: "pcm16" });
    expect(await engine.speech.set("voice", "nova")).toBe("Voice: nova");
    await engine.speech.speak("Two.", { play: false });
    expect(requests.at(-1)?.body.audio).toEqual({ voice: "nova", format: "pcm16" });
  });

  it("leaves a model built for speech on /audio/speech", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    await engine.speech.speak("Hello.", { play: false });
    expect(paths(requests)).toEqual(["/audio/speech"]);
  });
});
