#!/usr/bin/env node
// Launch Pi against a packed copy of this extension (without receiver/target/) and an ephemeral
// local HTTP server mimicking GitHub Releases, so you can experience the real first-run receiver
// download, SHA-256 verification, and extraction interactively.
//
// Usage:
//   node scripts/first-run.mjs [pi-args...]
//
// Starts with an empty receiver cache (`bin/`), while symlinking your existing `~/.cache/pi-speech/models`
// (if present) so downloaded speech/transcription models stay available.
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryFile, createReleaseAssets, LIBRARIES, TARGETS } from "../npm/platforms.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = `${process.platform}-${process.arch}`;
const exeName = binaryFile(target);
const releaseBin = join(root, "receiver", "target", "release", exeName);

if (!existsSync(releaseBin)) {
  console.error(
    `Missing ${releaseBin}. Build it first:\n  cd ${join(root, "receiver")} && cargo build --release --locked`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("Usage: node scripts/first-run.mjs [--dry-run] [pi-args...]");
  process.exit(0);
}
const dryRun = args.includes("--dry-run");
const piArgs = args.filter((a) => a !== "--dry-run");

const scratch = mkdtempSync(join(tmpdir(), "pi-speech-first-run-"));
const pkgDir = join(scratch, "pkg");
const binsDir = join(scratch, "bins");
const assetsCacheRoot = join(root, "receiver", "target", ".first-run-assets");
const cacheHome = join(scratch, "cache");
let server;

try {
  mkdirSync(pkgDir, { recursive: true });
  for (const entry of ["index.ts", "package.json", "src"]) {
    cpSync(join(root, entry), join(pkgDir, entry), { recursive: true });
  }

  const gpuBin = join(root, "receiver", "target-gpu", "release", exeName);
  const realModels = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "pi-speech", "models");
  const cuda13Lib = join(realModels, "sherpa-onnx-v2.0.1-cuda-13.x-cudnn-9.x-onnxruntime1.28.2-linux-x64-gpu", "lib");
  const hasGpu = process.platform === "linux" && process.arch === "x64" && existsSync(gpuBin) && existsSync(cuda13Lib);
  const cpuStat = statSync(releaseBin);
  const gpuStat = hasGpu ? statSync(gpuBin) : undefined;
  const cacheKey = [
    manifest.version,
    target,
    `${cpuStat.size}-${Math.trunc(cpuStat.mtimeMs)}`,
    gpuStat ? `${gpuStat.size}-${Math.trunc(gpuStat.mtimeMs)}` : "nogpu",
  ].join("_");
  const assetsDir = join(assetsCacheRoot, cacheKey);
  const cachedManifest = join(assetsDir, "receivers.json");

  if (!existsSync(cachedManifest)) {
    rmSync(assetsCacheRoot, { recursive: true, force: true });
    mkdirSync(assetsDir, { recursive: true });
    for (const { target: t } of TARGETS) {
      const dir = join(binsDir, t);
      mkdirSync(dir, { recursive: true });
      const file = binaryFile(t);
      if (t === target) {
        copyFileSync(releaseBin, join(dir, file));
        if (process.platform !== "win32") chmodSync(join(dir, file), 0o755);
      } else {
        writeFileSync(join(dir, file), "#!/bin/sh\nexit 0\n");
      }
      for (const lib of LIBRARIES[t] ?? []) writeFileSync(join(dir, lib), "");
    }
    if (hasGpu) {
      const gpuDir = join(binsDir, "linux-x64-cuda13");
      mkdirSync(gpuDir, { recursive: true });
      copyFileSync(gpuBin, join(gpuDir, exeName));
      chmodSync(join(gpuDir, exeName), 0o755);
      for (const f of readdirSync(cuda13Lib)) {
        if (f.includes(".so")) copyFileSync(join(cuda13Lib, f), join(gpuDir, f));
      }
    }
    createReleaseAssets({
      binariesDir: binsDir,
      assetsDir,
      manifestPath: cachedManifest,
      version: manifest.version,
      tag: `v${manifest.version}`,
    });
  }
  copyFileSync(cachedManifest, join(pkgDir, "receivers.json"));

  // Start with empty bin/ cache, but preserve existing downloaded speech/STT models if present.
  const testSpeechCache = join(cacheHome, "pi-speech");
  mkdirSync(testSpeechCache, { recursive: true });
  if (existsSync(realModels)) {
    symlinkSync(realModels, join(testSpeechCache, "models"), "dir");
  }

  const fetched = [];
  server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").replace(/^\/+/, ""));
    const filePath = join(assetsDir, name);
    if (!name || name.includes("/") || !existsSync(filePath)) {
      fetched.push(`${req.method} ${req.url} -> 404`);
      res.writeHead(404).end();
      return;
    }
    fetched.push(`${req.method} ${req.url} -> 200`);
    res.writeHead(200, { "content-type": "application/gzip", "content-length": statSync(filePath).size });
    createReadStream(filePath).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.error(`[first-run] serving ${assetsDir} at ${baseUrl}`);
  console.error(`[first-run] isolated cache: ${cacheHome} (bin/ empty)`);
  console.error(`[first-run] extension: ${join(pkgDir, "index.ts")}`);

  if (dryRun) {
    console.error("[first-run] dry-run ok");
  } else {
    const code = await new Promise((resolveExit, reject) => {
      const child = spawn("pi", ["--no-extensions", "-e", join(pkgDir, "index.ts"), ...piArgs], {
        stdio: "inherit",
        env: {
          ...process.env,
          PI_SPEECH_RECEIVER_BASE_URL: baseUrl,
          XDG_CACHE_HOME: cacheHome,
          LOCALAPPDATA: cacheHome,
        },
        shell: process.platform === "win32",
      });
      child.on("error", reject);
      child.on("close", (c) => resolveExit(c ?? 0));
    });

    console.error(
      `[first-run] HTTP requests: ${fetched.length ? fetched.join(", ") : "none (receiver not triggered)"}`,
    );
    process.exitCode = code;
  }
} finally {
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
}
