import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type BinaryChoice, findBinary } from "../../src/engine/binary";
import { chooseRecorder, LocalInput } from "../../src/engine/local-input";
import { wavSeconds } from "../../src/engine/wav";

// A private temporary directory for this file: LocalInput puts its recordings in os.tmpdir(), and the
// leftover counts below must not see the recordings of other test runs on the same machine.
const savedTmp = process.env.TMPDIR;
let privateTmp: string;
beforeAll(() => {
  privateTmp = mkdtempSync(join(tmpdir(), "pi-speech-local-input-"));
  process.env.TMPDIR = privateTmp;
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmp;
  rmSync(privateTmp, { recursive: true, force: true });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-speech-dict-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function wav(seconds: number, rate = 16000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** A node recorder: `<script> out.wav`; `body` runs in place of the recording. */
function recorder(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!${process.execPath}\nconst fs = require("node:fs");\nconst out = process.argv[2];\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

const WAV_FN = `const wav = (s) => { const d = Buffer.alloc(Math.round(s*16000)*2); const h = Buffer.alloc(44);
h.write("RIFF",0); h.writeUInt32LE(36+d.length,4); h.write("WAVEfmt ",8); h.writeUInt32LE(16,16); h.writeUInt16LE(1,20);
h.writeUInt16LE(1,22); h.writeUInt32LE(16000,24); h.writeUInt32LE(32000,28); h.writeUInt16LE(2,32); h.writeUInt16LE(16,34);
h.write("data",36); h.writeUInt32LE(d.length,40); return Buffer.concat([h,d]); };`;

const base = { PATH: process.env.PATH };
/** No bundled binary installed. */
const NONE = (): BinaryChoice => ({ ok: false, reason: "the bundled pi-speech-receiver is not installed" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith("pi-speech-rec-"));

describe("wavSeconds", () => {
  it("measures PCM audio and rejects other data", () => {
    expect(wavSeconds(wav(1.5))).toBeCloseTo(1.5);
    expect(wavSeconds(wav(0))).toBe(0);
    expect(wavSeconds(Buffer.from("not a wav file at all"))).toBeUndefined();
  });

  it("trusts the file size when the recorder never finished the header", () => {
    const w = wav(1);
    w.writeUInt32LE(0xffffffff, 40);
    expect(wavSeconds(w)).toBeCloseTo(1);
  });
});

// The fakes here are shell scripts, which Windows cannot run. Windows coverage of playback and recording
// comes with the bundled binary (portable-package slice 4), run on the null audio device.
const onWindows = process.platform === "win32";

describe.skipIf(onWindows)("chooseRecorder", () => {
  it("prefers PI_SPEECH_RECORDER and reports one that is not executable", () => {
    const r = recorder("mine", "");
    expect(chooseRecorder({ ...base, PI_SPEECH_RECORDER: r })).toMatchObject({ ok: true, name: r });
    expect(chooseRecorder({ ...base, PI_SPEECH_RECORDER: join(dir, "missing") })).toMatchObject({ ok: false });
  });

  it("takes the bundled binary, run as `pi-speech-receiver record <out.wav>` and stopped by its stdin too", () => {
    writeFileSync(join(dir, "pw-record"), "");
    chmodSync(join(dir, "pw-record"), 0o755);
    const bin = join(dir, "pi-speech-receiver");
    const c = chooseRecorder({ PATH: dir }, () => ({ ok: true, path: bin, from: "package" }));
    expect(c).toMatchObject({ ok: true, name: "pi-speech-receiver", bin, stdinStops: true });
    expect(c.ok && c.args("/o.wav")).toEqual(["record", "/o.wav"]);
    const r = recorder("myrec", "");
    const custom = chooseRecorder({ PATH: dir, PI_SPEECH_RECORDER: r }, () => ({
      ok: true,
      path: bin,
      from: "package",
    }));
    expect(custom).toMatchObject({ ok: true, name: r });
  });

  it("without the bundled binary, falls back to the first available of pw-record, parecord, arecord, in that order", () => {
    for (const n of ["arecord", "parecord"]) {
      const p = join(dir, n);
      writeFileSync(p, "#!/bin/sh\n");
      chmodSync(p, 0o755);
    }
    expect(chooseRecorder({ PATH: dir }, NONE)).toMatchObject({ ok: true, name: "parecord" });
    expect(chooseRecorder({ PATH: join(dir, "nowhere") }, NONE)).toMatchObject({ ok: false });
  });

  it("records mono 16 kHz 16-bit WAV", () => {
    const p = join(dir, "arecord");
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    const c = chooseRecorder({ PATH: dir }, NONE);
    expect(c.ok && c.args("/x.wav").join(" ")).toBe("-q -t wav -f S16_LE -r 16000 -c 1 /x.wav");
  });
});

describe.skipIf(onWindows)("LocalInput", () => {
  const good = () =>
    recorder(
      "good",
      `${WAV_FN}\nprocess.on("SIGINT", () => { fs.writeFileSync(out, wav(1)); process.exit(0); });\nsetInterval(() => {}, 100);`,
    );

  it("records until stopped and returns the WAV, leaving no file behind", async () => {
    const before = leftovers().length;
    const input = new LocalInput({ ...base, PI_SPEECH_RECORDER: good() });
    const rec = await input.start();
    expect(leftovers().length).toBe(before + 1);
    const { audio, format } = await rec.stop();
    expect(format).toBe("wav");
    expect(wavSeconds(audio)).toBeCloseTo(1);
    expect(leftovers().length).toBe(before);
  });

  it("gives the recorder no OpenRouter key", async () => {
    const r = recorder(
      "envcheck",
      `${WAV_FN}\nprocess.on("SIGINT", () => { fs.writeFileSync(out, wav(1)); fs.writeFileSync(${JSON.stringify(join(dir, "env.txt"))}, Object.keys(process.env).join("\\n")); process.exit(0); });\nsetInterval(() => {}, 100);`,
    );
    const rec = await new LocalInput({ ...base, PI_SPEECH_RECORDER: r, OPENROUTER_API_KEY: "sk-secret" }).start();
    await rec.stop();
    const names = readFileSync(join(dir, "env.txt"), "utf8").split("\n");
    expect(names).toContain("PATH");
    expect(names).not.toContain("OPENROUTER_API_KEY");
  });

  it("a recorder that exits within the start window fails with the end of its error output", async () => {
    const before = leftovers().length;
    // A shell stand-in, not node: it must exit well inside the 500 ms start window even on a
    // cold machine, where launching node alone can take longer than that.
    const r = join(dir, "dead");
    writeFileSync(r, '#!/bin/sh\necho "opening the default input" >&2\necho "no such audio device" >&2\nexit 1\n');
    chmodSync(r, 0o755);
    await expect(new LocalInput({ ...base, PI_SPEECH_RECORDER: r }).start()).rejects.toThrow(/no such audio device/);
    expect(leftovers().length).toBe(before);
  });

  it("a recorder that cannot be spawned fails readably", async () => {
    const p = join(dir, "notexec");
    writeFileSync(p, "#!/nonexistent/interpreter\n");
    chmodSync(p, 0o755);
    await expect(new LocalInput({ ...base, PI_SPEECH_RECORDER: p }).start()).rejects.toThrow(/cannot start|exited/);
  });

  it("less than 0.1 s of audio is an empty recording", async () => {
    const r = recorder(
      "silent",
      `${WAV_FN}\nprocess.on("SIGINT", () => { fs.writeFileSync(out, wav(0.05)); process.exit(0); });\nsetInterval(() => {}, 100);`,
    );
    const rec = await new LocalInput({ ...base, PI_SPEECH_RECORDER: r }).start();
    await expect(rec.stop()).rejects.toThrow(/empty/);
  });

  it("a recorder that writes nothing fails on stop", async () => {
    const r = recorder("nofile", `process.on("SIGINT", () => process.exit(0));\nsetInterval(() => {}, 100);`);
    const rec = await new LocalInput({ ...base, PI_SPEECH_RECORDER: r }).start();
    await expect(rec.stop()).rejects.toThrow(/no recording/);
  });

  it("a recorder that crashes after starting is reported on stop with its error output", async () => {
    const r = recorder("crash", `setTimeout(() => { console.error("stream error"); process.exit(2); }, 700);`);
    const rec = await new LocalInput({ ...base, PI_SPEECH_RECORDER: r }).start();
    await sleep(900);
    await expect(rec.stop()).rejects.toThrow(/stopped unexpectedly: stream error/);
  });

  it("a recorder that ends by itself settles `ended` at once and leaves no file behind", async () => {
    const before = leftovers().length;
    const r = recorder("crash2", `setTimeout(() => { console.error("stream error"); process.exit(2); }, 700);`);
    const rec = await new LocalInput({ ...base, PI_SPEECH_RECORDER: r }).start();
    expect(await rec.ended).toMatch(/stopped unexpectedly: stream error/);
    expect(leftovers().length).toBe(before);
    await expect(rec.stop()).rejects.toThrow(/stopped unexpectedly: stream error/);
  });

  it("`ended` never settles for a recording that is stopped or cancelled", async () => {
    const a = await new LocalInput({ ...base, PI_SPEECH_RECORDER: good() }).start();
    const b = await new LocalInput({ ...base, PI_SPEECH_RECORDER: good() }).start();
    let settled = false;
    void a.ended?.then(() => (settled = true));
    void b.ended?.then(() => (settled = true));
    await a.stop();
    await b.cancel();
    await sleep(50);
    expect(settled).toBe(false);
  });

  it("removes the recording directory when Pi exits while recording", async () => {
    vi.resetModules();
    const handlers: Array<() => void> = [];
    const spy = vi.spyOn(process, "once").mockImplementation(((ev: string, fn: () => void) => {
      if (ev === "exit") handlers.push(fn);
      return process;
    }) as never);
    const before = leftovers().length;
    try {
      const mod = await import("../../src/engine/local-input");
      const rec = await new mod.LocalInput({ ...base, PI_SPEECH_RECORDER: good() }).start();
      expect(leftovers().length).toBe(before + 1);
      expect(handlers.length).toBe(1);
      handlers[0]?.();
      expect(leftovers().length).toBe(before);
      await rec.cancel();
    } finally {
      spy.mockRestore();
    }
  });

  it("kills a recorder that ignores SIGINT after the grace period", async () => {
    const r = recorder("stubborn", `process.on("SIGINT", () => {});\nsetInterval(() => {}, 100);`);
    const rec = await new LocalInput({ ...base, PI_SPEECH_RECORDER: r }).start();
    const t = Date.now();
    await expect(rec.stop()).rejects.toThrow(/no recording/);
    expect(Date.now() - t).toBeGreaterThanOrEqual(1900);
  }, 10000);

  it("cancel discards the audio and the file", async () => {
    const before = leftovers().length;
    const rec = await new LocalInput({ ...base, PI_SPEECH_RECORDER: good() }).start();
    await rec.cancel();
    expect(leftovers().length).toBe(before);
  });

  describe("remote hosts", () => {
    it("refuse to record over SSH and point to the playback bridge", async () => {
      const marker = join(dir, "started");
      const r = recorder("marker", `fs.writeFileSync(${JSON.stringify(marker)}, "x");`);
      for (const ssh of [{ SSH_CONNECTION: "1 2 3 4" }, { SSH_TTY: "/dev/pts/1" }]) {
        const input = new LocalInput({ ...base, ...ssh, PI_SPEECH_RECORDER: r });
        await expect(input.start()).rejects.toThrow(/\/speech --bridge on/);
      }
      expect(existsSync(marker)).toBe(false);
    });

    it("PI_SPEECH_LOCAL_MIC=1 states the host's microphone is the user's", async () => {
      const input = new LocalInput({
        ...base,
        SSH_CONNECTION: "1 2 3 4",
        PI_SPEECH_LOCAL_MIC: "1",
        PI_SPEECH_RECORDER: good(),
      });
      const rec = await input.start();
      await rec.cancel();
    });
  });
});

// The bundled binary on the null audio device: PATH holds no audio program. Built by cargo build in receiver/.
const built = findBinary({});
describe.skipIf(!built.ok || onWindows)("dictation through the bundled binary (null audio device)", () => {
  it("records until stopped and returns a WAV of the null device's silence", async () => {
    const before = leftovers();
    const input = new LocalInput({ PATH: "", PI_SPEECH_AUDIO_NULL: "1" });
    const rec = await input.start();
    await sleep(400);
    const { audio, format } = await rec.stop();
    expect(format).toBe("wav");
    expect(wavSeconds(audio)).toBeGreaterThan(0.3);
    expect(leftovers().filter((d) => !before.includes(d))).toEqual([]);
  });

  it("cancel stops it and leaves nothing behind", async () => {
    const before = leftovers();
    const rec = await new LocalInput({ PATH: "", PI_SPEECH_AUDIO_NULL: "1" }).start();
    await rec.cancel();
    expect(leftovers().filter((d) => !before.includes(d))).toEqual([]);
  });
});
