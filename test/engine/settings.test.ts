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
    });
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
