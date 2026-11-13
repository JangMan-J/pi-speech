import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, Surface, usage } from "../../src/engine/surface";
import { fakeOpenRouter, fakeReceiver, makeEngine, scriptedUi } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());

describe("parsing /speech", () => {
  it("no arguments open the menu", () => {
    expect(parse("")).toEqual({ kind: "menu" });
    expect(parse("   ")).toEqual({ kind: "menu" });
  });

  it("text is speech, even when it looks like an action", () => {
    expect(parse("hello there friend")).toEqual({ kind: "speak", text: "hello there friend" });
    expect(parse("stop the presses")).toEqual({ kind: "speak", text: "stop the presses" });
    expect(parse("status")).toEqual({ kind: "speak", text: "status" });
    expect(parse("-x marks the spot")).toEqual({ kind: "speak", text: "-x marks the spot" });
  });

  it("-- speaks text that starts with dashes", () => {
    expect(parse("-- --dashes here")).toEqual({ kind: "speak", text: "--dashes here" });
    expect(parse("--").kind).toBe("error");
  });

  it("parses actions and their arguments", () => {
    expect(parse("--stop")).toEqual({ kind: "action", name: "stop", args: [] });
    expect(parse("--dictate ja")).toEqual({ kind: "action", name: "dictate", args: ["ja"] });
    expect(parse("--type hello   --world")).toEqual({ kind: "action", name: "type", args: ["hello   --world"] });
    expect(parse("--transcribe note.wav pt")).toEqual({ kind: "action", name: "transcribe", args: ["note.wav", "pt"] });
    expect(parse("--sample")).toEqual({ kind: "action", name: "sample", args: [] });
    expect(parse("--sample jf_alpha")).toEqual({ kind: "action", name: "sample", args: ["jf_alpha"] });
    expect(parse("--set voice Puck")).toEqual({ kind: "action", name: "set", args: ["voice", "Puck"] });
    expect(parse("--language eve fr")).toEqual({ kind: "action", name: "language", args: ["eve", "fr"] });
    expect(parse("--bridge status")).toEqual({ kind: "action", name: "bridge", args: ["status"] });
  });

  it("an unknown action is an error that lists the usage", () => {
    const p = parse("--frobnicate");
    expect(p.kind).toBe("error");
    if (p.kind === "error") {
      expect(p.message).toMatch(/Unknown action --frobnicate/);
      expect(p.message).toContain("--stop");
    }
  });

  it("wrong arguments are an error with the usage", () => {
    for (const bad of [
      "--stop now",
      "--status please",
      "--language eve",
      "--read-aloud",
      "--set voice",
      "--sample a b",
    ]) {
      const p = parse(bad);
      expect(p.kind, bad).toBe("error");
      if (p.kind === "error") expect(p.message).toContain("Usage:");
    }
  });

  it("the usage lists every action", () => {
    const u = usage();
    for (const a of [
      "--stop",
      "--replay",
      "--dictate [language|auto]",
      "--type <text>",
      "--transcribe <audio-file> [language|auto]",
      "--sample [voice]",
      "--status",
      "--models",
      "--voices",
      "--languages",
      "--help",
      "--read-aloud on|off",
      "--bridge auto|on|off|status",
      "--language <voice> <tag|auto>",
      "--set tts-model|voice|stt-model|stt-language|tools|dictation-output|tts-source|stt-source <value>",
    ]) {
      expect(u).toContain(a);
    }
  });
});

describe("running /speech", () => {
  it("speaks text with the current model and voice, saves it, and plays it", async () => {
    const requests = fakeOpenRouter();
    const { engine, local, work } = makeEngine();
    const { ui, notes } = scriptedUi();
    await new Surface(engine).run("stop the presses", ui);
    expect(requests.at(-1)?.body).toMatchObject({
      model: "google/gemini-3.8-flash-tts",
      voice: "Kore",
      input: "stop the presses",
    });
    expect(readdirSync(join(work, "history")).filter((f) => f.endsWith(".wav"))).toHaveLength(1);
    expect(local.plays).toHaveLength(1);
    expect(notes).toEqual([{ message: expect.stringMatching(/Speaking/), level: "info" }]);
  });

  it("--dictate accepts a one-off language and keeps it when the second toggle has no arguments", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine(
      {},
      {
        name: "local",
        start: async () => ({
          stop: async () => ({ audio: Buffer.from("RIFFfake"), format: "wav" }),
          cancel: async () => {},
        }),
      },
    );
    const s = new Surface(engine);
    const { ui, pasted } = scriptedUi();
    await s.run("--dictate ja", ui);
    await s.run("--dictate", ui);
    expect(requests.at(-1)?.body).toMatchObject({ model: "openai/whisper-large-v3-turbo", language: "ja" });
    expect(pasted).toEqual(["hello world"]);
  });

  it("status reports one line per item", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    const { ui, notes } = scriptedUi();
    await new Surface(engine).run("--status", ui);
    const lines = notes[0].message.split("\n");
    expect(lines.map((l) => l.split(":")[0])).toEqual([
      "Speech model",
      "Voice",
      "Transcription model",
      "Tools",
      "History",
      "Audio",
      "Read-aloud",
      "Dictation",
    ]);
    expect(lines).toContain("Tools: on");
    expect(lines).toContain("Read-aloud: off");
    expect(lines).toContain("Audio: local (auto)");
  });

  it("stop stops the playback and replay plays the last message again without a request", async () => {
    const requests = fakeOpenRouter();
    const { engine, local } = makeEngine();
    const s = new Surface(engine);
    const { ui, notes } = scriptedUi();
    await s.run("first words", ui);
    expect(engine.player.playing).toBe(true);
    await s.run("--stop", ui);
    expect(engine.player.playing).toBe(false);
    const n = requests.length;
    await s.run("--replay", ui);
    expect(requests.length).toBe(n);
    // The message played as a Stream; replay plays its saved file.
    expect(local.plays.map((p) => p.file)).toEqual([undefined, engine.speech.lastMessage()]);
    expect(notes.map((x) => x.level)).not.toContain("error");
  });

  it("replay with nothing in the history is an error", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    await expect(new Surface(engine).run("--replay", scriptedUi().ui)).rejects.toThrow(/Nothing to replay/);
  });

  it("--set changes and saves one versioned settings file; a bad value is refused", async () => {
    fakeOpenRouter();
    const { engine, work } = makeEngine();
    const s = new Surface(engine);
    const { ui } = scriptedUi();
    await s.run("--set voice Puck", ui);
    await expect(s.run("--set voice nobody", ui)).rejects.toThrow(/Kore, Puck/);
    await expect(s.run("--set tts-model openai/whisper-1", ui)).rejects.toThrow(/not a speech model/);
    const dir = join(work, "agent", "pi-speech");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    const saved = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(saved).toMatchObject({ version: 1, voice: "Puck" });
  });

  it("--set tools tells the adapter", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    const changed = vi.fn();
    engine.onToolsChanged = changed;
    await new Surface(engine).run("--set tools off", scriptedUi().ui);
    expect(engine.speech.settings.tools).toBe(false);
    expect(changed).toHaveBeenCalled();
  });

  it("read-aloud is turned on and off, and is not saved", async () => {
    fakeOpenRouter();
    const { engine, work } = makeEngine();
    const s = new Surface(engine);
    await s.run("--read-aloud on", scriptedUi().ui);
    expect(engine.readAloud.enabled).toBe(true);
    expect(existsSync(join(work, "agent", "pi-speech", "settings.json"))).toBe(false);
    engine.start();
    expect(engine.readAloud.enabled).toBe(false);
  });

  it("--bridge on selects the bridge and saves the mode; status names it", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    const s = new Surface(engine);
    const { ui, notes } = scriptedUi();
    await s.run("--bridge on", ui);
    expect(engine.routes.route).toBe("bridge");
    expect(engine.speech.settings.bridge).toBe("on");
    await s.run("--bridge status", ui);
    expect(notes.at(-1)?.message).toMatch(/Bridge mode: on/);
    await expect(s.run("--bridge sideways", ui)).rejects.toThrow(/auto\|on\|off\|status/);
  });

  it("samples in the voice language without touching the history or the selected voice", async () => {
    const requests = fakeOpenRouter();
    const { engine, work, local } = makeEngine();
    const s = new Surface(engine);
    const { ui, notes } = scriptedUi();
    await s.run("--set tts-model hexgrad/kokoro-82m", ui);
    await s.run("--sample jf_alpha", ui);
    expect(requests.at(-1)?.body.voice).toBe("jf_alpha");
    expect(requests.at(-1)?.body.input).toMatch(/[\u3040-\u30ff]/);
    expect(notes.at(-1)?.message).toMatch(/\bja\b/);
    expect(existsSync(join(work, "history"))).toBe(false);
    expect(local.plays.at(-1)?.kind).toBe("sample");
    expect(engine.speech.settings.voice).toBe("af_heart");
  });

  it("a multilingual voice samples in English and says so", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    const { ui, notes } = scriptedUi();
    await new Surface(engine).run("--sample Puck", ui);
    expect(requests.at(-1)?.body.input).toMatch(/Hello/);
    expect(notes.at(-1)?.message).toMatch(/multilingual/);
    expect(notes.at(-1)?.message).toMatch(/English/);
  });

  it("a language override is saved, listed, used by samples, and removed with auto", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    const s = new Surface(engine);
    const { ui, notes } = scriptedUi();
    await s.run("--set tts-model x-ai/grok-voice-tts-1.0", ui);
    await s.run("--language eve fr", ui);
    await s.run("--sample eve", ui);
    expect(requests.at(-1)?.body.input).toMatch(/Bonjour/);
    await s.run("--languages", ui);
    expect(notes.at(-1)?.message).toMatch(/eve: fr \(override\)/);
    await s.run("--language eve auto", ui);
    await s.run("--languages", ui);
    expect(notes.at(-1)?.message).toMatch(/eve: unknown/);
    await expect(s.run("--language eve not-a-language!", ui)).rejects.toThrow(/Invalid language tag/);
    await expect(s.run("--language nobody fr", ui)).rejects.toThrow(/eve, ara/);
  });
});

describe("the menu", () => {
  const WORDS = [
    "Speak",
    "Stop",
    "Replay",
    "Dictate",
    "Sample",
    "Read-aloud",
    "Audio",
    "Speech model",
    "Voice",
    "Voice language",
    "Transcription model",
    "Tools",
    "Status",
  ];

  it("offers the actions and settings; Status reports the status and closes it", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    const { ui, notes, dialogs } = scriptedUi([(_t, o) => o?.find((x) => x.startsWith("Status"))]);
    await new Surface(engine).run("", ui);
    expect(dialogs).toHaveLength(1);
    const options = dialogs[0].options ?? [];
    expect(options).toHaveLength(WORDS.length);
    for (const [i, w] of WORDS.entries()) expect(options[i].startsWith(w)).toBe(true);
    expect(notes[0].message).toMatch(/^Speech model:/);
  });

  it("Speak text… asks for the text and speaks it", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    const { ui } = scriptedUi([(_t, o) => o?.find((x) => x.startsWith("Speak")), () => "words from the menu"]);
    await new Surface(engine).run("", ui);
    expect(requests.at(-1)?.body.input).toBe("words from the menu");
  });

  it("Escape in a step goes back to the menu; Escape in the menu leaves it", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    const { ui, dialogs, notes } = scriptedUi([(_t, o) => o?.find((x) => x.startsWith("Voice:")), () => undefined]);
    await new Surface(engine).run("", ui);
    expect(dialogs.map((d) => d.kind)).toEqual(["select", "pick", "select"]);
    expect(requests.filter((r) => r.url.endsWith("/audio/speech"))).toHaveLength(0);
    expect(notes).toEqual([]);
  });

  it("a voice picked from the searchable list is saved", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    const { ui, dialogs } = scriptedUi([(_t, o) => o?.find((x) => x.startsWith("Voice:")), () => "Puck"]);
    await new Surface(engine).run("", ui);
    expect(dialogs[1]).toMatchObject({ kind: "pick", options: ["Kore", "Puck"] });
    expect(engine.speech.settings.voice).toBe("Puck");
  });

  it("models are picked by their priced labels", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    const { ui } = scriptedUi([
      (_t, o) => o?.find((x) => x.startsWith("Transcription model")),
      (_t, o) => o?.find((x) => x.startsWith("openai/whisper-1")),
    ]);
    await new Surface(engine).run("", ui);
    expect(engine.speech.settings.transcriptionModel).toBe("openai/whisper-1");
  });

  // The stand-in receiver is a script started as a program (shebang): Unix only.
  it.skipIf(process.platform === "win32")(
    "with Speech source Local, Sample a voice lists the local voices, or asks for a local model first",
    async () => {
      const requests = fakeOpenRouter();
      const bin = fakeReceiver(mkdtempSync(join(tmpdir(), "pi-speech-receiver-")));
      const { engine } = makeEngine({ PI_SPEECH_BINARY: bin.path, PI_SPEECH_AUDIO_NULL: "1" });
      engine.speech.setSource("speech", "local");
      const sample = (o?: string[]) => o?.find((x) => x.startsWith("Sample"));
      await expect(new Surface(engine).run("", scriptedUi([(_t, o) => sample(o)]).ui)).rejects.toThrow(
        "Choose a local speech model first: /speech, Speech model",
      );
      await engine.speech.local.download("kokoro").result;
      engine.speech.setLocalModel("speech", "kokoro");
      const { ui, dialogs, notes } = scriptedUi([(_t, o) => sample(o), () => "af_sol"]);
      await new Surface(engine).run("", ui);
      expect(dialogs[1]).toMatchObject({ kind: "pick", options: ["af_alloy", "af_sol", "bm_lewis"] });
      expect(notes.at(-1)?.message).toMatch(/Sample of af_sol \(kokoro\)/);
      expect(requests.filter((r) => r.url.endsWith("/audio/speech"))).toHaveLength(0);
    },
  );

  it("with Speech source Local, Voice language offers no provider voices and says why", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    engine.speech.setSource("speech", "local");
    const { ui, dialogs, notes } = scriptedUi([(_t, o) => o?.find((x) => x.startsWith("Voice language"))]);
    await new Surface(engine).run("", ui);
    expect(dialogs.map((d) => d.kind)).toEqual(["select"]);
    expect(notes).toEqual([{ message: expect.stringMatching(/do not apply to local voices/), level: "info" }]);
  });

  it("toggles read-aloud and tools in one step", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    const s = new Surface(engine);
    await s.run("", scriptedUi([(_t, o) => o?.find((x) => x.startsWith("Read-aloud"))]).ui);
    expect(engine.readAloud.enabled).toBe(true);
    await s.run("", scriptedUi([(_t, o) => o?.find((x) => x.startsWith("Tools"))]).ui);
    expect(engine.speech.settings.tools).toBe(false);
  });
});
