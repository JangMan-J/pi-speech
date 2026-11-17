import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inlineTags } from "../../src/engine/features";
import {
  type DownloadProgress,
  deleteModel,
  downloadModel,
  formatSize,
  isLiveCapableLocalStt,
  isSingleVoicePiper,
  type LocalModel,
  LocalModels,
  LocalModelsError,
  listModels,
  localSttLanguage,
  piperVoiceLabel,
  transcribeLocal,
} from "../../src/engine/local-models";
import { localSpeechLanguage } from "../../src/engine/local-speech";
import { TranscribeWorker } from "../../src/engine/receiver-worker";

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
if (cmd === "gpu") {
  const usable = process.env.FAKE_GPU === "yes";
  out({
    driver: usable,
    cuda: usable ? 13 : null,
    cudnn: usable,
    hardware: usable,
    edition: usable ? "gpu" : "cpu",
    target: usable ? "linux-x64-cuda13" : null,
    usable,
    why: usable ? null : "no NVIDIA driver",
  });
  process.exit(0);
}
if (cmd === "transcribe" && sub === "--serve") {
  // One process for many requests: it says how many it loaded and which process it is.
  const fs = require("node:fs"), path = require("node:path");
  let loaded, loads = 0;
  require("node:readline").createInterface({ input: process.stdin }).on("line", async (line) => {
    const r = JSON.parse(line);
    if (r.model === "missing") return out({ error: "model missing is not downloaded" });
    if (r.model === "crash") process.exit(3);
    if (loaded !== r.model) { loaded = r.model; loads++; }
    if (r.load) return out({ loaded: true });
    if (r.model === "slow") await new Promise((res) => setTimeout(res, 5000));
    const bytes = fs.readFileSync(r.audio).length;
    const on = process.env.PI_SPEECH_PROVIDER ? " on " + process.env.PI_SPEECH_PROVIDER + " " +
      (process.env.LD_LIBRARY_PATH || "").split(":")[0] : "";
    out({ text: "heard " + r.model + " " + path.extname(r.audio) + " " + bytes + (r.language ? " " + r.language : "") +
      on + " loads " + loads + " pid " + process.pid });
  });
  return;
}
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
  out({ id: "piper", kind: "speech", name: "Piper", languages: ["en"], size: 60, downloaded: false, partial: 0,
        path: "/cache/piper", lexicon: { name: "lexicon-en-us.txt", size: 6305773, downloaded: false } });
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
  if (id === "piper") for (const done of [0, 10]) out({ event: "progress", id, file: "lexicon-en-us.txt", done, total: 10 });
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
      {
        id: "piper",
        kind: "speech",
        name: "Piper",
        languages: ["en"],
        size: 60,
        downloaded: false,
        partial: 0,
        path: "/cache/piper",
        lexicon: { name: "lexicon-en-us.txt", size: 6305773, downloaded: false },
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

  it("reports the progress of a voice's lexicon, named by its file, after the archive", async () => {
    const seen: DownloadProgress[] = [];
    const d = downloadModel(fakeBinary(), "piper", { onProgress: (p) => void seen.push(p) });
    await expect(d.result).resolves.toEqual({ status: "done", path: "/cache/piper" });
    expect(seen.slice(-3)).toEqual([
      { phase: "unpacking" },
      { phase: "progress", done: 0, total: 10, file: "lexicon-en-us.txt" },
      { phase: "progress", done: 10, total: 10, file: "lexicon-en-us.txt" },
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
    expect((await local.list("speech")).map((m) => m.id)).toEqual(["kokoro", "piper"]);
    expect((await local.list("transcription")).map((m) => m.id)).toEqual(["whisper-small"]);
    await expect(local.transcribe("whisper-small", Buffer.from("RIFFabcdef"), "wav")).resolves.toMatch(
      /^heard whisper-small \.wav 10 loads 1 pid \d+$/,
    );
    local.close();
    await expect(local.transcribe("whisper-small", Buffer.from("x"), "ogg")).rejects.toThrow(
      /wav and mp3 audio, not ogg/,
    );
    await expect(local.transcribeFile("whisper-small", join(dir, "a.flac"))).rejects.toThrow(/not flac/);
  });
});

describe.skipIf(WINDOWS)("the transcription worker", () => {
  const pidOf = (t: string) => t.match(/pid (\d+)$/)?.[1];

  it("keeps one process, and the model in it, across transcriptions; a preload loads it before the audio", async () => {
    const local = new LocalModels({ PI_SPEECH_BINARY: fakeBinary(), PATH: process.env.PATH });
    local.preload("whisper-small");
    const a = await local.transcribe("whisper-small", Buffer.from("RIFF1"), "wav");
    const b = await local.transcribe("whisper-small", Buffer.from("RIFF12"), "wav", undefined, "de");
    expect(a).toMatch(/^heard whisper-small \.wav 5 loads 1 pid/);
    expect(b).toMatch(/^heard whisper-small \.wav 6 de loads 1 pid/);
    expect(pidOf(a)).toBe(pidOf(b));
    // another model: loaded in the same process
    expect(await local.transcribe("canary", Buffer.from("RIFF"), "wav")).toMatch(/loads 2 pid/);
    local.close();
  });

  it("a failed request keeps the process; one that dies is started again; an abort ends it", async () => {
    const local = new LocalModels({ PI_SPEECH_BINARY: fakeBinary(), PATH: process.env.PATH });
    const first = await local.transcribe("whisper-small", Buffer.from("RIFF"), "wav");
    await expect(local.transcribe("missing", Buffer.from("RIFF"), "wav")).rejects.toThrow(
      /^model missing is not downloaded$/,
    );
    const same = await local.transcribe("whisper-small", Buffer.from("RIFF"), "wav");
    expect(pidOf(same)).toBe(pidOf(first));
    await expect(local.transcribe("crash", Buffer.from("RIFF"), "wav")).rejects.toThrow(/worker ended/);
    const again = await local.transcribe("whisper-small", Buffer.from("RIFF"), "wav");
    expect(pidOf(again)).not.toBe(pidOf(first));
    const abort = new AbortController();
    const slow = local.transcribe("slow", Buffer.from("RIFF"), "wav", abort.signal);
    setTimeout(() => abort.abort(new Error("stopped")), 100);
    await expect(slow).rejects.toThrow(/stopped/);
    const after = await local.transcribe("whisper-small", Buffer.from("RIFF"), "wav");
    expect(pidOf(after)).not.toBe(pidOf(again));
    local.close();
  });

  it("probes GPU hardware and restarts the worker when switching device", async () => {
    const env = { PI_SPEECH_BINARY: fakeBinary(), PATH: process.env.PATH };
    const gpu = new LocalModels({ ...env, FAKE_GPU: "yes" });
    const cpu = await gpu.transcribe("whisper-small", Buffer.from("RIFF"), "wav");
    gpu.setDevice("gpu");
    const on = await gpu.transcribe("whisper-small", Buffer.from("RIFF"), "wav");
    expect(pidOf(on)).not.toBe(pidOf(cpu));
    expect(await gpu.gpu()).toMatchObject({ usable: true, hardware: true, target: "linux-x64-cuda13" });
    gpu.setDevice("cpu");
    const back = await gpu.transcribe("whisper-small", Buffer.from("RIFF"), "wav");
    expect(pidOf(back)).not.toBe(pidOf(on));
    gpu.close();

    // Unavailable hardware reports why
    const none = new LocalModels({ ...env, FAKE_GPU: "no" });
    none.setDevice("gpu");
    expect(await none.gpu()).toMatchObject({ usable: false, hardware: false, why: "no NVIDIA driver" });
    none.close();
  });

  it("ends after a while without requests", async () => {
    const worker = new TranscribeWorker(fakeBinary, () => process.env, 50);
    const file = join(dir, "idle.wav");
    writeFileSync(file, "RIFF");
    const a = await worker.transcribe("whisper-small", file);
    await new Promise((r) => setTimeout(r, 200));
    const b = await worker.transcribe("whisper-small", file);
    expect(pidOf(b)).not.toBe(pidOf(a));
    worker.close();
  });
});

describe("LocalModels without a binary", () => {
  it("says why there is none", async () => {
    const local = new LocalModels({}, () => ({ ok: false, reason: "the bundled pi-speech-receiver is not installed" }));
    await expect(local.list()).rejects.toThrow("the bundled pi-speech-receiver is not installed");
  });
});

describe("capability metadata contract", () => {
  it("prefers receiver-emitted capability fields over ID heuristics", () => {
    const stt: LocalModel = {
      id: "brand-new-asr-v9",
      kind: "transcription",
      name: "Brand New ASR",
      languages: ["en", "ja"],
      size: 100,
      downloaded: true,
      partial: 0,
      path: "/tmp/brand-new-asr-v9",
      liveCapable: "gpu",
      languageMode: "selectable",
      cpuRank: 4,
      gpuRank: 1,
    };
    expect(isLiveCapableLocalStt(stt, "cpu")).toBe(false);
    expect(isLiveCapableLocalStt(stt, "gpu")).toBe(true);
    expect(localSttLanguage(stt)).toEqual({ kind: "selectable" });

    const fixedStt: LocalModel = { ...stt, id: "custom-mono", languages: ["fr"], languageMode: "fixed" };
    expect(localSttLanguage(fixedStt)).toEqual({ kind: "fixed", language: "fr" });

    const tts: LocalModel = {
      id: "brand-new-tts",
      kind: "speech",
      name: "Brand New TTS",
      languages: ["en", "ko"],
      size: 200,
      downloaded: true,
      partial: 0,
      path: "/tmp/brand-new-tts",
      group: "piper-en",
      speakers: 12,
      languageMode: "selectable",
      tags: "[tags]",
    };
    expect(isSingleVoicePiper(tts)).toBe(true);
    expect(piperVoiceLabel({ ...tts, id: "piper-en_US-custom-medium" })).toBe("custom-medium (US, 12 voices)");
    expect(localSpeechLanguage(tts, "ko")).toBe("ko");
    expect(localSpeechLanguage(tts, "de")).toBeUndefined();
    expect(inlineTags(tts)).toBe("[tags]");
  });
});
