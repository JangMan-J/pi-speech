import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_KEEP, History, historyDir } from "../../src/engine/history";

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
  const mp3 = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);

  it("lists the messages, the newest first, with the time and the start of the text", async () => {
    let t = new Date(2026, 10, 11, 9, 5, 0).getTime();
    const h = new History(dir, () => {
      t += 60_000;
      return new Date(t);
    });
    expect(h.list()).toEqual([]);
    await h.save("Hello, world!", wav, "wav");
    await h.save("…", wav, "wav");
    await h.save("Stop the presses", mp3, "mp3");
    const list = h.list();
    expect(list.map((m) => [m.time, m.title])).toEqual([
      ["11-11 09:08", "stop the presses"],
      ["11-11 09:07", "(no words)"],
      ["11-11 09:06", "hello world"],
    ]);
    expect(list.every((m) => existsSync(m.file))).toBe(true);
    expect(list[0].file.endsWith(".mp3")).toBe(true);
    expect(list[0].file).toBe(h.newest());
  });

  it("saves each message once, in the format it came in", async () => {
    const h = new History(dir);
    const a = await h.save("Hello, world!", wav, "wav");
    const b = await h.save("An MP3 message", mp3, "mp3");
    expect(a.files).toHaveLength(1);
    expect(a.files[0].endsWith(".wav")).toBe(true);
    expect(b.files).toHaveLength(1);
    expect(b.files[0].endsWith(".mp3")).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([a.files[0], b.files[0]].map((f) => f.split("/").at(-1)).sort());
  });

  it("runs onWritten once the file exists", async () => {
    let seen: string | undefined;
    const r = await new History(dir).save("x", wav, "wav", (file) => {
      seen = existsSync(file) ? file : undefined;
    });
    expect(seen).toBe(r.files[0]);
  });

  it("keeps names unique when the same text is spoken twice within one second", async () => {
    const now = new Date(2026, 9, 31, 10, 0, 0, 500);
    const h = new History(dir, () => now);
    const a = await h.save("same", wav, "wav");
    const b = await h.save("same", wav, "wav");
    expect(a.files[0]).not.toBe(b.files[0]);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it("keeps names unique across instances writing the same directory", async () => {
    const now = new Date(2026, 9, 31, 10, 0, 0, 500);
    const a = await new History(dir, () => now).save("same", wav, "wav");
    const b = await new History(dir, () => now).save("same", wav, "wav");
    expect(a.files[0]).not.toBe(b.files[0]);
  });

  it(`keeps only the newest ${HISTORY_KEEP} messages, in spoken order`, async () => {
    expect(HISTORY_KEEP).toBe(10);
    const now = new Date(2026, 9, 31, 10, 0, 0, 0);
    const h = new History(dir, () => now);
    const saved = [];
    for (let i = 1; i <= 12; i++) saved.push(await h.save(`message number ${i}`, wav, "wav"));
    expect(readdirSync(dir)).toHaveLength(10);
    for (const r of saved.slice(0, 2)) expect(existsSync(r.files[0])).toBe(false);
    for (const r of saved.slice(2)) expect(existsSync(r.files[0])).toBe(true);
  });

  it("reads a history saved in both formats: one message each, both files pruned together", async () => {
    // Earlier versions kept every message as a .wav and an .mp3.
    for (let i = 0; i < 3; i++) {
      const stem = `2026-10-0${i + 1}_10-00-00-000_old-message-${i}`;
      writeFileSync(join(dir, `${stem}.wav`), wav);
      writeFileSync(join(dir, `${stem}.mp3`), mp3);
    }
    const h = new History(dir, () => new Date(2026, 10, 1));
    expect(h.list()).toHaveLength(3);
    for (let i = 0; i < 9; i++) await h.save(`new ${i}`, wav, "wav");
    expect(h.list()).toHaveLength(10);
    const left = readdirSync(dir).filter((f) => f.includes("old-message"));
    expect(left.sort()).toEqual([
      "2026-10-03_10-00-00-000_old-message-2.mp3",
      "2026-10-03_10-00-00-000_old-message-2.wav",
    ]);
  });

  it("leaves unrelated files alone", async () => {
    writeFileSync(join(dir, "notes.txt"), "keep me");
    writeFileSync(join(dir, "song.mp3"), "keep me");
    const h = new History(dir);
    for (let i = 0; i < 12; i++) await h.save(`m${i}`, wav, "wav");
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, "song.mp3"))).toBe(true);
  });
});
