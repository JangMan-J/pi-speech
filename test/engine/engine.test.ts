import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeModels } from "../../src/bridge/index";
import type { AudioInput } from "../../src/engine/audio";
import type { Machine } from "../../src/engine/settings";
import { LOCAL_SPEECH_UNAVAILABLE } from "../../src/engine/speech";
import { Surface } from "../../src/engine/surface";
import { CATALOG, fakeOpenRouter, fakeReceiver, makeEngine, STAND_IN_BINARY, scriptedUi, wavFixture } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the engine", () => {
  it("drives the single status from the player and the route", async () => {
    fakeOpenRouter();
    const { engine, local } = makeEngine();
    const statuses: Array<string | undefined> = [];
    engine.indicator.attach((t) => statuses.push(t));
    const s = new Surface(engine);
    await s.run("hello", scriptedUi().ui);
    expect(statuses.at(-1)).toBe("▶ speaking");
    local.end(0, { state: "completed" });
    await tick();
    expect(statuses.at(-1)).toBeUndefined();
    await s.run("--bridge on", scriptedUi().ui);
    expect(statuses.at(-1)).toBe("speech: bridge");
  });

  it("a new message replaces the one playing, also across routes", async () => {
    fakeOpenRouter();
    const { engine, local, bridgeOut } = makeEngine();
    const s = new Surface(engine);
    const { ui } = scriptedUi();
    await s.run("first", ui);
    await s.run("--bridge on", ui);
    await s.run("second", ui);
    expect(local.plays).toHaveLength(1);
    expect(bridgeOut.plays).toHaveLength(1);
    expect(engine.player.playing).toBe(true);
    expect(local.cancelled).toBe(1);
  });

  it("a failed playback is notified once", async () => {
    fakeOpenRouter();
    const { engine, local, notes } = makeEngine();
    await new Surface(engine).run("hello", scriptedUi().ui);
    local.end(0, { state: "failed", error: "cannot open device" });
    await tick();
    expect(notes.filter((n) => n.level === "error")).toEqual([
      { level: "error", message: "Playback failed (local): cannot open device" },
    ]);
  });

  it("over SSH in auto mode the bridge is announced once per session", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine({ SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" });
    expect(engine.routes.route).toBe("bridge");
    expect((await engine.announce())?.message).toMatch(/SSH/);
    expect(await engine.announce()).toBeUndefined();
    engine.start();
    expect(await engine.announce()).toBeDefined();
  });

  it("a saved model missing from the catalog is replaced with a warning", async () => {
    fakeOpenRouter();
    const { engine, notes } = makeEngine();
    engine.speech.settings.speechModel = "gone/model";
    engine.speech.save();
    engine.start();
    await engine.speech.ready();
    expect(engine.speech.settings.speechModel).toBe(CATALOG.tts[0].id);
    expect(notes).toEqual([{ level: "warning", message: expect.stringMatching(/gone\/model/) }]);
  });

  it("without a key nothing is sent", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine({ OPENROUTER_API_KEY: "" });
    await expect(new Surface(engine).run("hello", scriptedUi().ui)).rejects.toThrow(/API key/);
    expect(requests).toEqual([]);
  });

  it("takes the key from models.json when OPENROUTER_API_KEY is empty", async () => {
    const requests = fakeOpenRouter();
    const { engine, work } = makeEngine({ OPENROUTER_API_KEY: "" });
    mkdirSync(join(work, "agent"), { recursive: true });
    writeFileSync(
      join(work, "agent", "models.json"),
      JSON.stringify({ providers: { openrouter: { apiKey: "sk-mj" } } }),
    );
    await new Surface(engine).run("models json key", scriptedUi().ui);
    expect(requests.at(-1)?.auth).toBe("Bearer sk-mj");
  });

  it("sends the key only in the Authorization header to OpenRouter", async () => {
    const requests = fakeOpenRouter();
    const { engine } = makeEngine();
    await new Surface(engine).run("hello", scriptedUi().ui);
    expect(requests.every((r) => r.url.startsWith("https://openrouter.ai/"))).toBe(true);
    expect(requests.at(-1)?.auth).toBe("Bearer sk-test");
    expect(JSON.stringify(requests.map((r) => r.body))).not.toContain("sk-test");
  });

  it("dictation records, transcribes, and pastes without submitting; the status shows each step", async () => {
    fakeOpenRouter("dictated words");
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
    const { engine, work } = makeEngine(
      {},
      {
        name: "local",
        start: async () => ({ stop: async () => ({ audio: wav, format: "wav" as const }), cancel: async () => {} }),
      },
    );
    const statuses: Array<string | undefined> = [];
    engine.indicator.attach((t) => statuses.push(t));
    const { ui, pasted } = scriptedUi();
    await engine.dictation.toggle(ui);
    expect(statuses.at(-1)).toMatch(/^● REC 0:0\d$/);
    await engine.dictation.toggle(ui);
    expect(statuses).toContain("… transcribing");
    expect(statuses.at(-1)).toBeUndefined();
    expect(pasted).toEqual(["dictated words"]);
    expect(existsSync(join(work, "history"))).toBe(false);
  });

  it("the saved dictation language goes with every dictation; a toggle may name another, or auto", async () => {
    const requests = fakeOpenRouter("dictated words");
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]);
    const { engine } = makeEngine(
      {},
      {
        name: "local",
        start: async () => ({ stop: async () => ({ audio: wav, format: "wav" as const }), cancel: async () => {} }),
      },
    );
    const { ui } = scriptedUi();
    const dictate = async (language?: string) => {
      await engine.dictation.toggle(ui, language);
      await engine.dictation.toggle(ui);
      return requests.at(-1)?.body.language;
    };
    expect(await dictate()).toBeUndefined();
    expect(await engine.speech.set("stt-language", "ja")).toBe("Dictation language: ja");
    expect(await dictate()).toBe("ja");
    expect(await dictate("fr")).toBe("fr");
    expect(await dictate("auto")).toBeUndefined();
    await expect(engine.speech.set("stt-language", "japanese!")).rejects.toThrow(/Invalid language tag/);
    expect(await engine.speech.set("stt-language", "auto")).toBe("Dictation language: auto");
    expect(await dictate()).toBeUndefined();
  });

  it("the models report says what each model offers", async () => {
    fakeOpenRouter();
    const { engine } = makeEngine();
    const report = await engine.speech.modelsReport();
    expect(report).toContain("google/gemini-3.8-flash-tts  ~$0.03/min  tags · fast · 2 voices  (selected)");
    expect(report).toContain("openai/whisper-1  $0.006/min  translate");
  });
});

describe("the engine is Pi-independent", () => {
  it("nothing under src/engine, src/bridge, or src/voice-language imports Pi", () => {
    const root = join(__dirname, "..", "..", "src");
    for (const dir of ["engine", "bridge", "voice-language"]) {
      for (const f of readdirSync(join(root, dir))) {
        const text = readFileSync(join(root, dir, f), "utf8");
        expect(text, `${dir}/${f}`).not.toMatch(/@earendil-works\//);
        expect(text, `${dir}/${f}`).not.toMatch(/from "\.\.\/pi\//);
      }
    }
  });
});

describe.skipIf(!STAND_IN_BINARY)("DIRECTION over SSH: Play audio on, Record audio on, Run models on", () => {
  /** A microphone that records one short WAV and counts its recordings. */
  const micOf = (name: string) => {
    const mic = {
      name,
      used: 0,
      start: async () => {
        mic.used++;
        return { stop: async () => ({ audio: wavFixture(), format: "wav" as const }), cancel: async () => {} };
      },
    };
    return mic;
  };
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-speech-receiver-"));
    const bin = fakeReceiver(dir);
    writeFileSync(join(dir, "downloaded.json"), JSON.stringify(["parakeet-v3", "kokoro"]));
    const here = micOf("local");
    const made = makeEngine({ PI_SPEECH_BINARY: bin.path, SSH_CONNECTION: "10.0.0.1 1 10.0.0.2 22" }, here);
    const there = micOf("bridge");
    const remoteCalls: string[] = [];
    const models: BridgeModels = {
      list: async () => [],
      voices: async () => [],
      transcribe: async (id) => {
        remoteCalls.push(`transcribe ${id}`);
        return `remote words from ${id}`;
      },
      speak: async (id, text) => {
        remoteCalls.push(`speak ${id} ${text}`);
        return {
          format: { codec: "pcm", rate: 24000, channels: 1 },
          chunks: (async function* () {
            yield new Uint8Array(4800);
          })(),
        };
      },
    };
    made.engine.routes.bridge.input = there;
    made.engine.routes.bridge.models = models;
    const s = made.engine.speech;
    s.setSource("speech", "local");
    s.setLocalModel("speech", "kokoro");
    s.setSource("transcription", "local");
    s.setLocalModel("transcription", "parakeet-v3");
    const localCalls = () => (existsSync(bin.log) ? readFileSync(bin.log, "utf8").trim().split("\n") : []);
    return { ...made, here, there, remoteCalls, localCalls };
  };

  it("each of the eight combinations plays, records and runs its models where it says", async () => {
    fakeOpenRouter();
    const { engine, local, bridgeOut, here, there, remoteCalls, localCalls } = setup();
    const machines: Machine[] = ["this", "remote"];
    for (const playOn of machines)
      for (const recordOn of machines)
        for (const modelsOn of machines) {
          const at = `${playOn}/${recordOn}/${modelsOn}`;
          Object.assign(engine.speech.settings, { playOn, recordOn, modelsOn });
          const plays = { this: local.plays.length, remote: bridgeOut.plays.length };
          const ran = { this: localCalls().length, remote: remoteCalls.length };
          const mics = { this: here.used, remote: there.used };

          await engine.speech.speak(`Hello from ${at}.`);
          expect(local.plays.length - plays.this, at).toBe(playOn === "this" ? 1 : 0);
          expect(bridgeOut.plays.length - plays.remote, at).toBe(playOn === "remote" ? 1 : 0);
          const spoke = modelsOn === "remote" ? remoteCalls.at(-1) : localCalls().at(-1);
          expect(spoke, at).toMatch(modelsOn === "remote" ? `speak kokoro Hello from ${at}.` : /^speak kokoro/);

          const { ui, pasted } = scriptedUi();
          await engine.dictation.toggle(ui);
          await engine.dictation.toggle(ui);
          await vi.waitFor(() => expect(pasted).toHaveLength(1));
          expect(pasted[0], at).toBe(`${modelsOn === "remote" ? "remote" : "local"} words from parakeet-v3`);
          expect(here.used - mics.this, at).toBe(recordOn === "this" ? 1 : 0);
          expect(there.used - mics.remote, at).toBe(recordOn === "remote" ? 1 : 0);
          // Every model run of this round happened on one machine only.
          const other = modelsOn === "remote" ? localCalls().length - ran.this : remoteCalls.length - ran.remote;
          expect(other, at).toBe(0);
        }
  });

  it("provider models are unaffected by Run models on", async () => {
    const requests = fakeOpenRouter("from the provider");
    const { engine, remoteCalls } = setup();
    engine.speech.setSource("speech", "provider");
    engine.speech.setSource("transcription", "provider");
    await engine.speech.speak("spoken by the provider");
    expect(await engine.speech.transcribeAudio(wavFixture(), "wav")).toBe("from the provider");
    expect(requests.at(-2)?.body.input).toBe("spoken by the provider");
    expect(remoteCalls).toEqual([]);
  });

  it("recording on This machine without a microphone there says so plainly, with the way out", async () => {
    fakeOpenRouter();
    const { engine } = setup();
    engine.routes.bridge.input = micOf("bridge");
    engine.speech.settings.recordOn = "this";
    // This machine (the SSH host) has no microphone.
    const noMic: AudioInput = {
      name: "local",
      start: async () => {
        throw new Error("no microphone here");
      },
    };
    (engine.routes as unknown as { localInput: AudioInput }).localInput = noMic;
    await expect(engine.routes.input().start()).rejects.toThrow(
      "Record audio on is This machine, and Pi runs over SSH: recording on This machine failed: no microphone here. To use the Remote machine, set Record audio on to Remote machine",
    );
  });

  it("downloads are refused plainly while models run on the Remote machine", async () => {
    fakeOpenRouter();
    const { engine } = setup();
    expect(() => engine.speech.local.download("whisper-small")).toThrow(
      /Run models on is Remote machine: download whisper-small there with pi-speech-receiver models download whisper-small/,
    );
  });
});

describe.skipIf(!STAND_IN_BINARY)("Speech source and Transcription source in one session", () => {
  /** A microphone on This machine that records one short WAV. */
  const mic: AudioInput = {
    name: "local",
    start: async () => ({ stop: async () => ({ audio: wavFixture(), format: "wav" }), cancel: async () => {} }),
  };
  const engineWithReceiver = () => {
    const bin = fakeReceiver(mkdtempSync(join(tmpdir(), "pi-speech-receiver-")));
    const made = makeEngine({ PI_SPEECH_BINARY: bin.path, PI_SPEECH_LOCAL_MIC: "1" }, mic);
    const calls = () => (existsSync(bin.log) ? readFileSync(bin.log, "utf8").trim().split("\n") : []);
    return { ...made, calls };
  };

  it("dictation transcribes with a local model and no network request; Provider speech still works", async () => {
    const requests = fakeOpenRouter("from the provider");
    const { engine, calls } = engineWithReceiver();
    engine.speech.setSource("transcription", "local");
    engine.speech.setLocalModel("transcription", "parakeet-v3");
    const before = requests.length;
    const { ui, pasted } = scriptedUi();
    await engine.dictation.toggle(ui);
    await engine.dictation.toggle(ui);
    await vi.waitFor(() => expect(pasted).toEqual(["local words from parakeet-v3"]));
    expect(requests.length).toBe(before);
    expect(calls().at(-1)).toMatch(/^transcribe parakeet-v3 .*audio.wav$/);
    // Transcribe file… too, from the file itself.
    const file = join(engine.speech.historyDir, "..", "note.wav");
    writeFileSync(file, wavFixture());
    expect(await engine.speech.transcribeFile(file, { cwd: "/" })).toBe("local words from parakeet-v3");
    expect(requests.length).toBe(before);
    // Provider speech in the same session.
    const r = await engine.speech.speak("still spoken by the provider");
    expect(r.files).toHaveLength(1);
    expect(requests.at(-1)?.body.input).toBe("still spoken by the provider");
  });

  it("a local model that is not downloaded fails plainly, without falling back to the provider", async () => {
    const requests = fakeOpenRouter();
    const { engine } = engineWithReceiver();
    engine.speech.setSource("transcription", "local");
    await expect(engine.speech.transcribeAudio(wavFixture(), "wav")).rejects.toThrow(
      /Choose a local transcription model/,
    );
    engine.speech.setLocalModel("transcription", "whisper-small");
    await expect(engine.speech.transcribeAudio(wavFixture(), "wav")).rejects.toThrow(
      "Transcription failed: whisper-small is not downloaded",
    );
    expect(requests.filter((r) => r.url.endsWith("/audio/transcriptions"))).toEqual([]);
  });

  it("Local speech without a model says to choose one; Provider transcription still works", async () => {
    const requests = fakeOpenRouter("from the provider");
    const { engine, calls } = engineWithReceiver();
    engine.speech.setSource("speech", "local");
    await expect(engine.speech.speak("hello")).rejects.toThrow(LOCAL_SPEECH_UNAVAILABLE);
    await expect(engine.speech.say("hello")).rejects.toThrow(LOCAL_SPEECH_UNAVAILABLE);
    await expect(engine.speech.sample()).rejects.toThrow(LOCAL_SPEECH_UNAVAILABLE);
    expect(requests.filter((r) => r.url.endsWith("/audio/speech"))).toEqual([]);
    expect(await engine.speech.transcribeAudio(wavFixture(), "wav")).toBe("from the provider");
    expect(calls().filter((c) => c.startsWith("transcribe"))).toEqual([]);
    const status = await engine.status();
    expect(status).toMatch(/Speech model: none chosen \(local\)\n/);
    expect(status).not.toMatch(/not available/);
  });
});
