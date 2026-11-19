import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyJingConfig,
  JING_CONFIG_NAME,
  jingConfigFrom,
  jingConfigPath,
  parseJingConfig,
  readJingConfig,
  writeJingConfig,
} from "../../src/engine/jing-config";
import { DEFAULT_SETTINGS, type Settings } from "../../src/engine/settings";

const defaults = (): Settings => structuredClone({ ...DEFAULT_SETTINGS }) as Settings;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-speech-jing-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("jingConfigPath", () => {
  it("prefers XDG_CONFIG_HOME, then HOME/.config, else undefined", () => {
    expect(JING_CONFIG_NAME).toBe("pi-speech.json");
    expect(jingConfigPath({ XDG_CONFIG_HOME: "/x", HOME: "/h" })).toBe(join("/x", "zellij", "pi-speech.json"));
    expect(jingConfigPath({ XDG_CONFIG_HOME: "", HOME: "/h" })).toBe(join("/h", ".config", "zellij", "pi-speech.json"));
    expect(jingConfigPath({})).toBeUndefined();
  });
});

describe("parseJingConfig", () => {
  it("gives nothing for non-objects", () => {
    expect(parseJingConfig(null)).toEqual({});
    expect(parseJingConfig([1])).toEqual({});
    expect(parseJingConfig("x")).toEqual({});
  });

  it("reads aliases in priority order, trimming and skipping empty or non-strings", () => {
    expect(
      parseJingConfig({
        model: "  ",
        localSpeechModel: 3,
        speech_model: " kokoro ",
        voice: "af_heart",
        localSpeechVoice: "other",
        localTranscriptionModel: "whisper",
        speechModel: "p/tts",
        providerVoice: "Kore",
        transcriptionModel: "p/stt",
        bridgeAddress: "1.2.3.4:5",
        speech_url: "ignored",
      }),
    ).toEqual({
      model: "kokoro",
      voice: "af_heart",
      sttModel: "whisper",
      providerTtsModel: "p/tts",
      providerVoice: "Kore",
      providerSttModel: "p/stt",
      url: "1.2.3.4:5",
    });
  });

  it("accepts only local/provider sources, case-insensitively", () => {
    expect(parseJingConfig({ ttsSource: "bogus", speechSource: "LOCAL", sttSource: "Provider" })).toEqual({
      ttsSource: "local",
      sttSource: "provider",
    });
    expect(parseJingConfig({ sttSource: "cloud", transcriptionSource: 1 })).toEqual({});
  });
});

describe("readJingConfig", () => {
  it("is undefined for missing or invalid files", () => {
    expect(readJingConfig(join(dir, "none.json"))).toBeUndefined();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{nope");
    expect(readJingConfig(bad)).toBeUndefined();
    expect(readJingConfig(dir)).toBeUndefined();
  });

  it("parses a valid file", () => {
    const f = join(dir, "c.json");
    writeFileSync(f, JSON.stringify({ ttsSource: "local", model: "kokoro" }));
    expect(readJingConfig(f)).toEqual({ ttsSource: "local", model: "kokoro" });
  });
});

describe("applyJingConfig", () => {
  it("maps every field but url and reports changes", () => {
    const s = defaults();
    const changed = applyJingConfig(s, {
      ttsSource: "local",
      sttSource: "local",
      model: "kokoro",
      voice: "af_heart",
      sttModel: "whisper",
      providerTtsModel: "p/tts",
      providerVoice: "Puck",
      providerSttModel: "p/stt",
      url: "1.2.3.4:5",
    });
    expect(changed).toBe(true);
    expect(s).toMatchObject({
      speechSource: "local",
      transcriptionSource: "local",
      localSpeechModel: "kokoro",
      localSpeechVoice: "af_heart",
      localTranscriptionModel: "whisper",
      speechModel: "p/tts",
      voice: "Puck",
      transcriptionModel: "p/stt",
    });
    expect(s.bridgeAddress).toBeUndefined();
  });

  it("returns false when nothing changes", () => {
    const s = defaults();
    expect(applyJingConfig(s, {})).toBe(false);
    expect(applyJingConfig(s, { providerVoice: s.voice, ttsSource: "provider", url: "x" })).toBe(false);
    expect(s).toEqual(defaults());
  });
});

describe("jingConfigFrom", () => {
  it("writes sources and provider models always, local ones when set", () => {
    const s = defaults();
    expect(jingConfigFrom(s)).toEqual({
      ttsSource: "provider",
      sttSource: "provider",
      providerTtsModel: s.speechModel,
      providerVoice: s.voice,
      providerSttModel: s.transcriptionModel,
    });
    s.localSpeechModel = "kokoro";
    s.localSpeechVoice = "af_heart";
    s.localTranscriptionModel = "whisper";
    expect(jingConfigFrom(s)).toMatchObject({ model: "kokoro", voice: "af_heart", sttModel: "whisper" });
  });
});

describe("writeJingConfig", () => {
  it("creates directories and writes formatted JSON", () => {
    const f = join(dir, "a", "zellij", JING_CONFIG_NAME);
    const s = defaults();
    writeJingConfig(f, s);
    const text = readFileSync(f, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(jingConfigFrom(s));
  });

  it("merges over the existing file, keeping unknown keys", () => {
    const f = join(dir, "zellij", JING_CONFIG_NAME);
    mkdirSync(join(dir, "zellij"));
    writeFileSync(f, JSON.stringify({ url: "1.2.3.4:5", extra: 1, ttsSource: "local" }));
    const s = defaults();
    s.localSpeechModel = "kokoro";
    writeJingConfig(f, s);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ url: "1.2.3.4:5", extra: 1, ...jingConfigFrom(s) });
    expect(readJingConfig(f)).toMatchObject({ ttsSource: "provider", model: "kokoro", url: "1.2.3.4:5" });
  });

  it("replaces an invalid existing file", () => {
    const f = join(dir, JING_CONFIG_NAME);
    writeFileSync(f, "garbage");
    writeJingConfig(f, defaults());
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual(jingConfigFrom(defaults()));
  });
});
