import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { READING_MIN_CHARS } from "../../src/engine/pieces";
import { LOCAL_SPEECH_UNAVAILABLE } from "../../src/engine/speech";
import { fakeOpenRouter, fakeReceiver, makeEngine, STAND_IN_BINARY, until } from "./fixtures";

afterEach(() => vi.unstubAllGlobals());
const tick = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const LONG = Array.from({ length: 10 }, (_, i) => `This is sentence ${i + 1} of a long spoken reply.`).join(" ");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** An engine whose binary is the stand-in receiver, with Speech source Local and `model` chosen. */
async function localEngine(model = "kokoro", download = true) {
  const dir = mkdtempSync(join(tmpdir(), "pi-speech-receiver-"));
  const bin = fakeReceiver(dir);
  const made = makeEngine({ PI_SPEECH_BINARY: bin.path, PI_SPEECH_AUDIO_NULL: "1" });
  if (download) await made.engine.speech.local.download(model).result;
  made.engine.speech.setSource("speech", "local");
  made.engine.speech.setLocalModel("speech", model);
  const calls = () => (existsSync(bin.log) ? readFileSync(bin.log, "utf8").trim().split("\n") : []);
  const texts = () =>
    existsSync(join(dir, "speak.log"))
      ? readFileSync(join(dir, "speak.log"), "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l) as string)
      : [];
  const pid = () => Number(readFileSync(join(dir, "speak.pid"), "utf8"));
  return { ...made, calls, texts, pid };
}

const speechRequests = (requests: Array<{ url: string }>) => requests.filter((r) => r.url.endsWith("/audio/speech"));

describe.skipIf(!STAND_IN_BINARY)("Speech source Local", () => {
  it("speaks through the binary as a pcm Stream, saves one WAV, and sends nothing over the network", async () => {
    const requests = fakeOpenRouter();
    const { engine, local, work, calls, texts } = await localEngine();
    const r = await engine.speech.speak("Hello there. How are you?");
    expect(calls().at(-1)).toBe("speak kokoro");
    expect(texts()).toEqual(["Hello there. How are you?"]);
    expect(r).toMatchObject({ model: "kokoro", voice: "default", player: "local" });
    expect(local.plays).toHaveLength(1);
    expect(local.streams[0].format).toEqual({ codec: "pcm", rate: 24000, channels: 1 });
    await tick();
    expect(Buffer.concat(local.streams[0].chunks).length).toBe(9600);
    const wavs = readdirSync(join(work, "history")).filter((f) => f.endsWith(".wav"));
    expect(wavs).toHaveLength(1);
    const wav = readFileSync(r.files[0]);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.length).toBe(44 + 9600);
    expect(speechRequests(requests)).toEqual([]);
    expect(await engine.status()).toMatch(/Speech model: kokoro \(local\)/);
  });

  it("speech_synthesize's voice is passed on, and play false saves without playing", async () => {
    fakeOpenRouter();
    const { engine, local, calls } = await localEngine();
    const r = await engine.speech.speak("Saved only.", { voice: "af_sol", play: false });
    expect(calls().at(-1)).toBe("speak kokoro --voice af_sol");
    expect(r).toMatchObject({ voice: "af_sol", notPlayed: "play was false" });
    expect(r.files).toHaveLength(1);
    expect(local.plays).toHaveLength(0);
  });

  it("a Reading is one speak of the whole text, played as one Stream and saved as one message", async () => {
    const requests = fakeOpenRouter();
    const { engine, local, work, texts } = await localEngine();
    expect(LONG.length).toBeGreaterThan(READING_MIN_CHARS);
    const r = await engine.speech.say(LONG);
    expect(texts()).toEqual([LONG]);
    expect(r.files).toHaveLength(1);
    expect(local.plays).toHaveLength(1);
    await tick();
    expect(Buffer.concat(local.streams[0].chunks).length).toBe(4800 * 10);
    expect(readdirSync(join(work, "history")).filter((f) => f.endsWith(".wav"))).toHaveLength(1);
    expect(speechRequests(requests)).toEqual([]);
  });

  it("a sample plays through the binary and is not saved", async () => {
    const requests = fakeOpenRouter();
    const { engine, local, work, texts } = await localEngine();
    const r = await engine.speech.sample();
    expect(r).toMatchObject({ model: "kokoro", voice: "default", player: "local", language: "en" });
    expect(texts()).toHaveLength(1);
    expect(local.plays).toHaveLength(1);
    expect(existsSync(join(work, "history")) ? readdirSync(join(work, "history")) : []).toEqual([]);
    expect(speechRequests(requests)).toEqual([]);
  });

  it("stopping the player kills the speak process and keeps nothing", async () => {
    fakeOpenRouter();
    const { engine, local, work, pid } = await localEngine();
    const spoken = engine.speech.speak("Please hold. This never ends.");
    // Playing (the start buffer may hold the first audio back), the binary waiting after its first sentence.
    await until(() => local.streams.length === 1 && engine.player.playing);
    await new Promise((r) => setTimeout(r, 100));
    const p = pid();
    expect(alive(p)).toBe(true);
    await engine.player.stop();
    const r = await spoken;
    expect(r.stopped).toBe(true);
    await until(() => !alive(p));
    expect(existsSync(join(work, "history")) ? readdirSync(join(work, "history")) : []).toEqual([]);
  });

  it("a model that is not downloaded fails plainly, naming the download, without the provider", async () => {
    const requests = fakeOpenRouter();
    const { engine, local } = await localEngine("kokoro", false);
    await expect(engine.speech.speak("Hello.")).rejects.toThrow(
      "Speech synthesis failed: the model kokoro is not downloaded; download it with `pi-speech-receiver models download kokoro`",
    );
    expect(local.plays).toHaveLength(0);
    expect(speechRequests(requests)).toEqual([]);
  });

  it("the chosen local voice goes to speak, a Reading and a sample as --voice; a new local model resets it", async () => {
    fakeOpenRouter();
    const { engine, calls } = await localEngine();
    expect(await engine.speech.voicesReport()).toBe("Voices of kokoro (local):\naf_alloy\naf_sol\nbm_lewis");
    await expect(engine.speech.set("voice", "eve")).rejects.toThrow(
      "eve is not a voice of kokoro; choose one of: af_alloy, af_sol, bm_lewis",
    );
    expect(await engine.speech.set("voice", "bm_lewis")).toBe("Voice: bm_lewis (local)");
    expect(engine.speech.settings).toMatchObject({ localSpeechVoice: "bm_lewis", voice: "Kore" });
    expect(await engine.status()).toMatch(/Speech model: kokoro \(local\)\nVoice: bm_lewis\n/);
    const r = await engine.speech.speak("Hello.");
    expect(r.voice).toBe("bm_lewis");
    expect(calls().at(-1)).toBe("speak kokoro --voice bm_lewis");
    await engine.speech.say(LONG);
    expect(calls().at(-1)).toBe("speak kokoro --voice bm_lewis");
    await engine.speech.sample();
    expect(calls().at(-1)).toBe("speak kokoro --voice bm_lewis");
    // A voice named for one call wins.
    await engine.speech.sample("af_sol");
    expect(calls().at(-1)).toBe("speak kokoro --voice af_sol");
    // The same model keeps the voice; another one resets it to its default.
    engine.speech.setLocalModel("speech", "kokoro");
    expect(engine.speech.settings.localSpeechVoice).toBe("bm_lewis");
    expect(await engine.speech.set("voice", "default")).toBe("Voice: default (local)");
    expect(engine.speech.settings.localSpeechVoice).toBeUndefined();
    await engine.speech.set("voice", "af_sol");
    engine.speech.setLocalModel("speech", "parakeet-v3");
    expect(engine.speech.settings.localSpeechVoice).toBeUndefined();
  });

  it("without a chosen local speech model, speaking says so", async () => {
    fakeOpenRouter();
    const { engine } = await localEngine("kokoro", false);
    engine.speech.settings.localSpeechModel = undefined;
    await expect(engine.speech.speak("Hello.")).rejects.toThrow(LOCAL_SPEECH_UNAVAILABLE);
    await expect(engine.speech.say(LONG)).rejects.toThrow(LOCAL_SPEECH_UNAVAILABLE);
    await expect(engine.speech.sample()).rejects.toThrow(LOCAL_SPEECH_UNAVAILABLE);
  });
});
