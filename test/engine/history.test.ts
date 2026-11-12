import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_KEEP, History, historyDir } from "../../src/engine/history";

/** A converter that copies the source bytes, so both files exist. */
const copyConvert = async (from: string, to: string) => {
  const { copyFileSync } = await import("node:fs");
  copyFileSync(from, to);
  return true;
};
const failConvert = async () => false;

describe("historyDir", () => {
  it("uses PI_SPEECH_DIR, else ~/Music/pi-speech", () => {
    expect(historyDir({ PI_SPEECH_DIR: "/x/y" }, "/home/u")).toBe("/x/y");
    expect(historyDir({ PI_SPEECH_DIR: "" }, "/home/u")).toBe(join("/home/u", "Music", "pi-speech"));
    expect(historyDir({}, "/home/u")).toBe(join("/home/u", "Music", "pi-speech"));
  });
});

describe("History", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speech-history-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const wav = new Uint8Array([82, 73, 70, 70]);

  it("lists the messages, the newest first, with the time and the start of the text, preferring the MP3", async () => {
    let t = new Date(2026, 10, 11, 9, 5, 0).getTime();
    const h = new History(dir, copyConvert, () => {
      t += 60_000;
      return new Date(t);
    });
    expect(h.list()).toEqual([]);
    await h.save("Hello, world!", wav, "wav");
    await h.save("…", wav, "wav");
    await h.save("Stop the presses", wav, "wav");
    const list = h.list();
    expect(list.map((m) => [m.time, m.title])).toEqual([
      ["11-11 09:08", "stop the presses"],
      ["11-11 09:07", "(no words)"],
      ["11-11 09:06", "hello world"],
    ]);
    expect(list.every((m) => m.file.endsWith(".mp3") && existsSync(m.file))).toBe(true);
    expect(new History(dir, failConvert).list()[0].file).toBe(h.newest());
  });

  it("saves a WAV message and its MP3", async () => {
    const h = new History(dir, copyConvert);
    const r = await h.save("Hello, world!", wav, "wav");
    expect(r.files.map((f) => f.slice(-4)).sort()).toEqual([".mp3", ".wav"]);
    expect(r.wav && existsSync(r.wav)).toBe(true);
    expect(r.mp3 && existsSync(r.mp3)).toBe(true);
    expect(r.conversionError).toBeUndefined();
  });

  it("saves an MP3-only message and converts it to WAV", async () => {
    const h = new History(dir, copyConvert);
    const r = await h.save("x", new Uint8Array([0xff]), "mp3");
    expect(r.wav && existsSync(r.wav)).toBe(true);
    expect(r.mp3 && existsSync(r.mp3)).toBe(true);
  });

  it("names only the files that exist when conversion fails, and says so", async () => {
    const h = new History(dir, failConvert);
    const r = await h.save("x", wav, "wav");
    expect(r.files).toHaveLength(1);
    expect(r.files[0].endsWith(".wav")).toBe(true);
    expect(r.mp3).toBeUndefined();
    expect(r.conversionError).toMatch(/mp3/i);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("keeps names unique when the same text is spoken twice within one second", async () => {
    const now = new Date(2026, 9, 31, 10, 0, 0, 500);
    const h = new History(dir, copyConvert, () => now);
    const a = await h.save("same", wav, "wav");
    const b = await h.save("same", wav, "wav");
    expect(a.wav).not.toBe(b.wav);
    expect(readdirSync(dir)).toHaveLength(4);
  });

  it("keeps names unique across instances writing the same directory", async () => {
    const now = new Date(2026, 9, 31, 10, 0, 0, 500);
    const a = await new History(dir, copyConvert, () => now).save("same", wav, "wav");
    const b = await new History(dir, copyConvert, () => now).save("same", wav, "wav");
    expect(a.wav).not.toBe(b.wav);
  });

  it(`keeps only the newest ${HISTORY_KEEP} messages, both files of each, in spoken order`, async () => {
    expect(HISTORY_KEEP).toBe(10);
    const now = new Date(2026, 9, 31, 10, 0, 0, 0);
    const h = new History(dir, copyConvert, () => now);
    const saved = [];
    for (let i = 1; i <= 12; i++) saved.push(await h.save(`message number ${i}`, wav, "wav"));
    const files = readdirSync(dir);
    expect(files).toHaveLength(20);
    for (const r of saved.slice(0, 2)) for (const f of r.files) expect(existsSync(f)).toBe(false);
    for (const r of saved.slice(2)) for (const f of r.files) expect(existsSync(f)).toBe(true);
  });

  it("leaves unrelated files alone", async () => {
    writeFileSync(join(dir, "notes.txt"), "keep me");
    writeFileSync(join(dir, "song.mp3"), "keep me");
    const h = new History(dir, copyConvert);
    for (let i = 0; i < 12; i++) await h.save(`m${i}`, wav, "wav");
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "song.mp3"))).toBe(true);
  });
});
