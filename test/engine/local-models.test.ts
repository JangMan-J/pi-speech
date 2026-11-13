import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DownloadProgress,
  deleteModel,
  downloadModel,
  formatSize,
  LocalModels,
  LocalModelsError,
  listModels,
  transcribeLocal,
} from "../../src/engine/local-models";

// The stand-in binary is a script with a shebang line, which Windows cannot start.
const WINDOWS = process.platform === "win32";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-speech-models-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A stand-in for the receiver binary's `models` commands. Downloads of "slow" send progress until standard input
 * closes, then report "stopped", as the binary does.
 */
function fakeBinary(): string {
  const p = join(dir, "fake-receiver");
  writeFileSync(
    p,
    `#!${process.execPath}
const [, , cmd, sub, id] = process.argv;
const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
if (cmd === "transcribe") {
  if (sub === "missing") { process.stderr.write("pi-speech-receiver: model missing is not downloaded\\n"); process.exit(1); }
  const bytes = require("node:fs").readFileSync(id).length;
  process.stdout.write("heard " + sub + " " + require("node:path").extname(id) + " " + bytes + "\\n");
  process.exit(0);
}
if (cmd !== "models") process.exit(2);
if (sub === "list") {
  out({ id: "whisper-small", kind: "transcription", name: "Whisper small", languages: ["en", "de"], size: 639387718,
        downloaded: true, partial: 0, path: "/cache/sherpa-onnx-whisper-small" });
  out({ id: "kokoro", kind: "speech", name: "Kokoro", languages: ["en", "zh"], size: 100, downloaded: false,
        partial: 40, path: "/cache/kokoro" });
  process.exit(0);
}
if (sub === "delete") {
  if (id === "nope") { process.stderr.write("pi-speech-receiver: unknown model\\n");
    out({ event: "error", id, message: 'unknown model "nope"' }); process.exit(1); }
  out({ event: "deleted", id, freed: 1234 });
  process.exit(0);
}
if (sub === "download") {
  if (id === "broken") {
    out({ event: "progress", id, done: 0, total: 10 });
    out({ event: "error", id, message: "the archive of broken does not match the catalogue's checksum" });
    process.exit(1);
  }
  if (id === "silent") { process.stderr.write("pi-speech-receiver: cannot find the model cache\\n"); process.exit(1); }
  if (id === "slow") {
    let done = 0;
    out({ event: "progress", id, done, total: 1000 });
    const t = setInterval(() => { done += 10; out({ event: "progress", id, done, total: 1000 }); }, 10);
    process.stdin.on("data", () => {});
    process.stdin.on("end", () => { clearInterval(t); out({ event: "stopped", id, done, total: 1000 }); process.exit(1); });
    return;
  }
  for (const done of [0, 50, 100]) out({ event: "progress", id, done, total: 100 });
  out({ event: "verifying", id });
  out({ event: "unpacking", id });
  out({ event: "done", id, path: "/cache/" + id });
  process.exit(0);
}
process.exit(2);
`,
  );
  chmodSync(p, 0o755);
  return p;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(WINDOWS)("listModels", () => {
  it("gives typed entries with their state in the cache", async () => {
    const models = await listModels(fakeBinary());
    expect(models).toEqual([
      {
        id: "whisper-small",
        kind: "transcription",
        name: "Whisper small",
        languages: ["en", "de"],
        size: 639387718,
        downloaded: true,
        partial: 0,
        path: "/cache/sherpa-onnx-whisper-small",
      },
      {
        id: "kokoro",
        kind: "speech",
        name: "Kokoro",
        languages: ["en", "zh"],
        size: 100,
        downloaded: false,
        partial: 40,
        path: "/cache/kokoro",
      },
    ]);
  });

  it("rejects when the binary cannot run", async () => {
    await expect(listModels(join(dir, "missing"))).rejects.toBeInstanceOf(LocalModelsError);
  });
});

describe.skipIf(WINDOWS)("downloadModel", () => {
  it("reports each step to an async callback, in order, before the result", async () => {
    const seen: DownloadProgress[] = [];
    const d = downloadModel(fakeBinary(), "kokoro", {
      onProgress: async (p) => {
        await sleep(5);
        seen.push(p);
      },
    });
    await expect(d.result).resolves.toEqual({ status: "done", path: "/cache/kokoro" });
    expect(seen).toEqual([
      { phase: "progress", done: 0, total: 100 },
      { phase: "progress", done: 50, total: 100 },
      { phase: "progress", done: 100, total: 100 },
      { phase: "verifying" },
      { phase: "unpacking" },
    ]);
  });

  it("cancel stops the download and reports what is kept", async () => {
    let progressed = 0;
    const d = downloadModel(fakeBinary(), "slow", {
      onProgress: (p) => {
        if (p.phase === "progress") progressed = p.done;
      },
    });
    while (progressed < 30) await sleep(5);
    d.cancel();
    const r = await d.result;
    expect(r.status).toBe("stopped");
    if (r.status === "stopped") {
      expect(r.done).toBeGreaterThanOrEqual(30);
      expect(r.total).toBe(1000);
    }
  });

  it("an aborted signal stops it too", async () => {
    const ac = new AbortController();
    const d = downloadModel(fakeBinary(), "slow", { signal: ac.signal });
    await sleep(50);
    ac.abort();
    await expect(d.result).resolves.toMatchObject({ status: "stopped", total: 1000 });
  });

  it("rejects with the binary's message on an error", async () => {
    const d = downloadModel(fakeBinary(), "broken");
    await expect(d.result).rejects.toThrow("does not match the catalogue's checksum");
    const silent = downloadModel(fakeBinary(), "silent");
    await expect(silent.result).rejects.toThrow(/^cannot find the model cache$/);
  });

  it("rejects when a progress callback throws", async () => {
    const d = downloadModel(fakeBinary(), "kokoro", {
      onProgress: () => {
        throw new Error("panel gone");
      },
    });
    await expect(d.result).rejects.toThrow("panel gone");
  });
});

describe.skipIf(WINDOWS)("deleteModel", () => {
  it("resolves to the bytes freed, and rejects on an unknown id", async () => {
    await expect(deleteModel(fakeBinary(), "kokoro")).resolves.toBe(1234);
    await expect(deleteModel(fakeBinary(), "nope")).rejects.toThrow('unknown model "nope"');
  });
});

describe("formatSize", () => {
  it("shows sizes as the pickers do", () => {
    expect([639387718, 1_234_000_000, 80_000, 5_500_000, 12].map(formatSize)).toEqual([
      "639 MB",
      "1.2 GB",
      "80 KB",
      "5.5 MB",
      "12 B",
    ]);
  });
});

describe.skipIf(WINDOWS)("transcription with a local model", () => {
  it("runs transcribe <id> <file> and gives its text", async () => {
    const file = join(dir, "a.wav");
    writeFileSync(file, "RIFF1234");
    await expect(transcribeLocal(fakeBinary(), "whisper-small", file)).resolves.toBe("heard whisper-small .wav 8");
    await expect(transcribeLocal(fakeBinary(), "missing", file)).rejects.toThrow(/^model missing is not downloaded$/);
  });

  it("LocalModels finds the binary, lists by kind, and transcribes audio in memory through a temporary file", async () => {
    const local = new LocalModels({ PI_SPEECH_BINARY: fakeBinary(), PATH: process.env.PATH });
    expect((await local.list("speech")).map((m) => m.id)).toEqual(["kokoro"]);
    expect((await local.list("transcription")).map((m) => m.id)).toEqual(["whisper-small"]);
    await expect(local.transcribe("whisper-small", Buffer.from("RIFFabcdef"), "wav")).resolves.toBe(
      "heard whisper-small .wav 10",
    );
    await expect(local.transcribe("whisper-small", Buffer.from("x"), "ogg")).rejects.toThrow(
      /wav and mp3 audio, not ogg/,
    );
    await expect(local.transcribeFile("whisper-small", join(dir, "a.flac"))).rejects.toThrow(/not flac/);
  });
});

describe("LocalModels without a binary", () => {
  it("says why there is none", async () => {
    const local = new LocalModels({}, () => ({ ok: false, reason: "the bundled pi-speech-receiver is not installed" }));
    await expect(local.list()).rejects.toThrow("the bundled pi-speech-receiver is not installed");
  });
});
