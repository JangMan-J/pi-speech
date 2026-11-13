import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, hotkeyId, keyLabel, SettingsFile } from "../../src/engine/settings";

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "pi-speech-settings-")), "pi-speech");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the settings file", () => {
  it("gives the defaults when nothing is saved", () => {
    const s = new SettingsFile(dir).load();
    expect(s).toEqual({
      speechModel: "google/gemini-3.8-flash-tts",
      voice: "Kore",
      transcriptionModel: "openai/whisper-large-v3-turbo",
      tools: true,
      bridge: "auto",
      languages: {},
      modelSort: "price",
      endpoints: {},
      hotkeys: { speak: "alt+s", dictate: "alt+z" },
      readAloud: { length: "abridged", truncate: 0 },
      speechSource: "provider",
      transcriptionSource: "provider",
    });
  });

  it("saves each source and local model, independently; an unknown source keeps Provider", () => {
    const f = new SettingsFile(dir);
    const s = f.load();
    s.transcriptionSource = "local";
    s.localTranscriptionModel = "parakeet-v3";
    f.save(s);
    const saved = JSON.parse(readFileSync(f.file, "utf8"));
    expect(saved).toMatchObject({ transcriptionSource: "local", localTranscriptionModel: "parakeet-v3" });
    expect(saved.speechSource).toBeUndefined();
    expect(f.load()).toMatchObject({
      speechSource: "provider",
      transcriptionSource: "local",
      localTranscriptionModel: "parakeet-v3",
    });
    writeFileSync(f.file, JSON.stringify({ version: 1, speechSource: "cloud", transcriptionSource: "local" }));
    expect(f.load()).toMatchObject({ speechSource: "provider", transcriptionSource: "local" });
  });

  it("saves the local speech voice only when it is set", () => {
    const f = new SettingsFile(dir);
    const s = f.load();
    s.speechSource = "local";
    s.localSpeechModel = "kokoro-multi-lang-v1.1-int8";
    f.save(s);
    expect(JSON.parse(readFileSync(f.file, "utf8")).localSpeechVoice).toBeUndefined();
    expect(f.load().localSpeechVoice).toBeUndefined();
    s.localSpeechVoice = "af_sol";
    f.save(s);
    expect(JSON.parse(readFileSync(f.file, "utf8")).localSpeechVoice).toBe("af_sol");
    expect(f.load()).toMatchObject({ localSpeechModel: "kokoro-multi-lang-v1.1-int8", localSpeechVoice: "af_sol" });
    writeFileSync(f.file, JSON.stringify({ version: 1, localSpeechVoice: 3 }));
    expect(f.load().localSpeechVoice).toBeUndefined();
  });

  it("saves the read-aloud options that differ from the defaults, and ignores values that are not choices", () => {
    const f = new SettingsFile(dir);
    const s = f.load();
    f.save(s);
    expect(JSON.parse(readFileSync(f.file, "utf8")).readAloud).toBeUndefined();
    s.readAloud = { summarizer: "anthropic/claude-haiku", length: "full", truncate: 60 };
    f.save(s);
    expect(f.load().readAloud).toEqual({ summarizer: "anthropic/claude-haiku", length: "full", truncate: 60 });
    writeFileSync(f.file, JSON.stringify({ version: 1, readAloud: { length: "huge", truncate: 7, summarizer: 3 } }));
    expect(f.load().readAloud).toEqual({ length: "abridged", truncate: 0 });
  });

  it("saves one versioned file and reads it back", () => {
    const f = new SettingsFile(dir);
    const s = f.load();
    s.voice = "Puck";
    s.tools = false;
    s.bridge = "on";
    s.languages = { "x-ai/grok": { eve: "fr" } };
    f.save(s);
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(raw.version).toBe(1);
    expect(new SettingsFile(dir).load()).toEqual(s);
  });

  it("migrates the earlier three files at load: writes the versioned file and removes them at once", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({
        ttsModel: "hexgrad/kokoro-82m",
        ttsVoice: "af_heart",
        sttModel: "openai/whisper-1",
        toolsEnabled: false,
      }),
    );
    writeFileSync(join(dir, "bridge.json"), '{"route":"bridge"}\n');
    writeFileSync(join(dir, "language-overrides.json"), JSON.stringify({ "hexgrad/kokoro-82m": { jf_alpha: "fr" } }));
    const f = new SettingsFile(dir);
    const s = f.load();
    expect(s).toMatchObject({
      speechModel: "hexgrad/kokoro-82m",
      voice: "af_heart",
      transcriptionModel: "openai/whisper-1",
      tools: false,
      bridge: "on",
      languages: { "hexgrad/kokoro-82m": { jf_alpha: "fr" } },
    });
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(raw.version).toBe(1);
    expect(new SettingsFile(dir).load()).toEqual(s);
  });

  it("migrates a lone earlier file at load", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "language-overrides.json"), JSON.stringify({ "x-ai/grok": { eve: "de" } }));
    const s = new SettingsFile(dir).load();
    expect(s.languages).toEqual({ "x-ai/grok": { eve: "de" } });
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    expect(new SettingsFile(dir).load()).toEqual(s);
  });

  it("removes unreadable earlier files at load", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bridge.json"), "{broken");
    writeFileSync(join(dir, "language-overrides.json"), "[]");
    expect(new SettingsFile(dir).load()).toEqual({ ...DEFAULT_SETTINGS, languages: {} });
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("keeps the dictation language and the model order; leaves them out of the file at their defaults", () => {
    const f = new SettingsFile(dir);
    f.save({ ...DEFAULT_SETTINGS, languages: {}, dictationLanguage: "ja", modelSort: "provider" });
    expect(f.load()).toMatchObject({ dictationLanguage: "ja", modelSort: "provider" });
    f.save({ ...DEFAULT_SETTINGS, languages: {} });
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(raw).not.toHaveProperty("dictationLanguage");
    expect(raw).not.toHaveProperty("modelSort");
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ version: 1, modelSort: "random", dictationLanguage: 3 }),
    );
    expect(f.load()).toEqual({ ...DEFAULT_SETTINGS, languages: {} });
  });

  it("writes nothing when there is nothing to migrate", () => {
    const f = new SettingsFile(dir);
    f.load();
    expect(existsSync(dir)).toBe(false);
  });

  it("maps the earlier bridge choices: route local is off, a saved mode is kept", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bridge.json"), '{"route":"local"}');
    expect(new SettingsFile(dir).load().bridge).toBe("off");
    expect(existsSync(join(dir, "bridge.json"))).toBe(false);
    writeFileSync(join(dir, "bridge.json"), '{"mode":"auto"}');
    expect(new SettingsFile(dir).load().bridge).toBe("auto");
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("ignores unreadable files and invalid values", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{not json");
    expect(new SettingsFile(dir).load()).toEqual({ ...DEFAULT_SETTINGS, languages: {} });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, tools: "yes", bridge: "maybe", voice: 3 }));
    expect(new SettingsFile(dir).load()).toEqual({ ...DEFAULT_SETTINGS, languages: {} });
    expect(existsSync(join(dir, "settings.json"))).toBe(true);
  });
});

describe("the macOS Option-key notice", () => {
  it("is remembered once shown, and left out of the file until then", () => {
    const f = new SettingsFile(dir);
    const s = f.load();
    expect(s.optionKeyHintShown).toBeUndefined();
    f.save(s);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).not.toHaveProperty("optionKeyHintShown");
    f.save({ ...s, optionKeyHintShown: true });
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).optionKeyHintShown).toBe(true);
    expect(new SettingsFile(dir).load().optionKeyHintShown).toBe(true);
  });
});

describe("the hotkeys", () => {
  it("are saved only when changed, and read back", () => {
    const f = new SettingsFile(dir);
    const s = f.load();
    f.save(s);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).hotkeys).toBeUndefined();
    s.hotkeys = { speak: "alt+d", dictate: "alt+z" };
    f.save(s);
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).hotkeys).toEqual({
      speak: "alt+d",
      dictate: "alt+z",
    });
    expect(new SettingsFile(dir).load().hotkeys).toEqual({ speak: "alt+d", dictate: "alt+z" });
  });

  it("keep the default for a key that is not a hotkey, and for both on one key", () => {
    mkdirSync(dir, { recursive: true });
    const write = (hotkeys: unknown) =>
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ version: 1, hotkeys }));
    write({ speak: "ctrl+c", dictate: "Alt+X" });
    expect(new SettingsFile(dir).load().hotkeys).toEqual({ speak: "alt+s", dictate: "alt+x" });
    write({ speak: "alt+q", dictate: "alt+q" });
    expect(new SettingsFile(dir).load().hotkeys).toEqual({ speak: "alt+s", dictate: "alt+z" });
    write("alt+q");
    expect(new SettingsFile(dir).load().hotkeys).toEqual({ speak: "alt+s", dictate: "alt+z" });
  });

  it("are Alt with a letter or digit, in Pi's spelling, shown capitalised", () => {
    expect(hotkeyId("alt+d")).toBe("alt+d");
    expect(hotkeyId("Shift+Alt+7")).toBe("alt+shift+7");
    expect(hotkeyId("alt+ctrl+k")).toBe("ctrl+alt+k");
    for (const bad of ["ctrl+s", "d", "alt+enter", "alt+up", "alt+meta+d", "alt+alt", ""]) {
      expect(hotkeyId(bad)).toBeUndefined();
    }
    expect(keyLabel("ctrl+alt+d")).toBe("Ctrl+Alt+D");
    expect(keyLabel("alt+s")).toBe("Alt+S");
  });
});
