import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DownloadProgress,
  deleteModel,
  downloadModel,
  LocalModelsError,
  listModels,
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
    `#!/usr/bin/env node
const [, , cmd, sub, id] = process.argv;
const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
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
