/**
 * The bundled binary (`pi-speech-receiver`, built from receiver/): it plays a Stream (`play`) and records
 * the microphone (`record`) on this machine with its own audio engine, so no other audio program is needed.
 * Every system's binary is packed in this package under `bin/<platform>-<arch>/`; the one for this machine is
 * picked at runtime. Found, in order:
 *   1. `PI_SPEECH_BINARY`: an explicit path (or a name looked up on PATH); when set it must be an executable.
 *   2. The packaged location: `bin/<platform>-<arch>/`, then `bin/` in this package.
 *   3. In a checkout: `receiver/target/release`, then `receiver/target/debug`.
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { type Env, findExecutable } from "./env";

export const BINARY_ENV = "PI_SPEECH_BINARY";
export const BINARY_BASE_URL_ENV = "PI_SPEECH_RECEIVER_BASE_URL";
export const BINARY_NAME = "pi-speech-receiver";

export type BinaryChoice =
  | { ok: true; path: string; from: "env" | "package" | "cache" | "checkout"; edition?: "cpu" | "gpu" }
  /** `chosen`: `PI_SPEECH_BINARY` names it, so nothing else may take its place. */
  | { ok: false; reason: string; chosen?: boolean };

export interface BinaryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** The package root (the directory holding package.json and receiver/). */
  root?: string;
  /** Override the receiver cache directory (tests). */
  cacheDir?: string;
  /** Preferred edition: `gpu` looks for a cached/bundled GPU build for this platform first. */
  device?: "cpu" | "gpu";
  /** Specific GPU target (`linux-x64-cuda13`) when known. */
  gpuTarget?: string;
}

export interface ReceiverAsset {
  file: string;
  size: number;
  sha256: string;
  url?: string;
}

export interface ReceiverManifest {
  version: string;
  repo: string;
  tag: string;
  assets: Record<string, ReceiverAsset>;
}

/** This package's root: src/engine/ is two levels below it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function executableName(target: string): string {
  return target.startsWith("win32-") ? `${BINARY_NAME}.exe` : BINARY_NAME;
}

/** Per-user cache directory for downloaded receiver binaries, matching `receiver/src/models/cache.rs`. */
export function receiverCacheDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  const base =
    platform === "win32"
      ? env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local")
      : env.XDG_CACHE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".cache");
  return join(base, "pi-speech", "bin");
}

/** Read `receivers.json` from the package root, or undefined if not present (e.g. a dev checkout). */
export function readReceiverManifest(root = ROOT): ReceiverManifest | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(root, "receivers.json"), "utf8")) as Partial<ReceiverManifest>;
    if (
      typeof raw.version === "string" &&
      typeof raw.repo === "string" &&
      typeof raw.tag === "string" &&
      raw.assets &&
      typeof raw.assets === "object"
    ) {
      return raw as ReceiverManifest;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Expected archive download size for `target` from `receivers.json`, when present. */
export function releaseAssetSize(target: string, root = ROOT): number | undefined {
  return readReceiverManifest(root)?.assets[target]?.size;
}

/** Where a cached GPU binary for `target` (`linux-x64`) is, if one is already in `cacheBase/version/`. */
function findCachedGpu(
  cacheBase: string,
  version: string,
  target: string,
  file: string,
  gpuTarget: string | undefined,
  at: (p: string) => string | undefined,
): string | undefined {
  if (gpuTarget) return at(join(cacheBase, version, gpuTarget, file));
  const versionDir = join(cacheBase, version);
  try {
    const entries = readdirSync(versionDir)
      .filter((d) => d.startsWith(`${target}-cuda`))
      .sort()
      .reverse();
    for (const d of entries) {
      const hit = at(join(versionDir, d, file));
      if (hit) return hit;
    }
  } catch {
    /* cache dir absent */
  }
  return undefined;
}

function findCheckoutGpu(root: string, file: string, at: (p: string) => string | undefined): string | undefined {
  for (const profile of ["release", "debug"]) {
    const hit = at(join(root, "receiver", "target-gpu", profile, file));
    if (hit) return hit;
  }
  return undefined;
}

/** Where the bundled or cached binary is, or why there is none; see the module comment for the order. */
export function findBinary(env: Env, opts: BinaryOptions = {}): BinaryChoice {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const root = opts.root ?? ROOT;
  const target = `${platform}-${arch}`;
  const file = platform === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;
  const at = (path: string) => findExecutable(path, env, platform);

  const custom = env[BINARY_ENV];
  if (custom) {
    const path = findExecutable(custom, env, platform);
    return path
      ? { ok: true, path, from: "env" }
      : { ok: false, reason: `${BINARY_ENV} (${custom}) is not an executable`, chosen: true };
  }
  const version = readReceiverManifest(root)?.version ?? packageVersion(root);
  const cacheBase = opts.cacheDir ?? receiverCacheDir(env, platform);
  if (opts.device === "gpu") {
    if (opts.gpuTarget) {
      const pkgGpu = at(join(root, "bin", opts.gpuTarget, file));
      if (pkgGpu) return { ok: true, path: pkgGpu, from: "package", edition: "gpu" };
    }
    if (version) {
      const cachedGpu = findCachedGpu(cacheBase, version, target, file, opts.gpuTarget, at);
      if (cachedGpu) return { ok: true, path: cachedGpu, from: "cache", edition: "gpu" };
    }
    if (platform === process.platform && arch === process.arch) {
      const checkoutGpu = findCheckoutGpu(root, file, at);
      if (checkoutGpu) return { ok: true, path: checkoutGpu, from: "checkout", edition: "gpu" };
    }
  }
  for (const p of [join(root, "bin", target, file), join(root, "bin", file)]) {
    const path = at(p);
    if (path) return { ok: true, path, from: "package", edition: "cpu" };
  }
  if (version) {
    const cached = at(join(cacheBase, version, target, file));
    if (cached) return { ok: true, path: cached, from: "cache", edition: "cpu" };
  }
  for (const profile of ["release", "debug"]) {
    const path = at(join(root, "receiver", "target", profile, file));
    if (path) return { ok: true, path, from: "checkout", edition: "cpu" };
  }
  return {
    ok: false,
    reason: `the bundled ${BINARY_NAME} is not installed (set ${BINARY_ENV}, or build it with cargo build --release in receiver/)`,
  };
}

/**
 * The bundled or cached binary for a machine of system `target` (`linux-x64`, `darwin-arm64`, ...), to install
 * there: this machine's own when it is the same system, else `bin/<target>/` or the downloaded cache for that
 * system; undefined when none is on disk yet.
 */
export function binaryFor(target: string, env: Env, root = ROOT, cacheDir?: string): string | undefined {
  const hostTarget = `${process.platform}-${process.arch}`;
  if (target === hostTarget) {
    const b = findBinary(env, { root, ...(cacheDir ? { cacheDir } : {}) });
    return b.ok ? b.path : undefined;
  }
  const file = executableName(target);
  const p = join(root, "bin", target, file);
  if (existsSync(p)) return p;
  const version = readReceiverManifest(root)?.version ?? packageVersion(root);
  if (version) {
    const cacheBase = cacheDir ?? receiverCacheDir(env);
    const cached = join(cacheBase, version, target, file);
    if (existsSync(cached)) return cached;
  }
  if (target.startsWith(`${hostTarget}-cuda`)) {
    return findCheckoutGpu(root, file, (candidate) => findExecutable(candidate, env, process.platform));
  }
  return undefined;
}

/** Whether `target` (e.g. `linux-x64` or `linux-x64-cuda13`) is already on disk or listed in `receivers.json`. */
export function hasBinaryFor(target: string, env: Env, root = ROOT): boolean {
  return !!binaryFor(target, env, root) || !!readReceiverManifest(root)?.assets[target];
}

function readTarString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul >= 0 ? nul : len).toString("utf8");
}

function readTarOctal(buf: Buffer, start: number, len: number): number {
  const s = readTarString(buf, start, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

/** Extract a `.tar.gz` archive buffer into `destDir`, rejecting unsafe paths and preserving executable bits. */
export function extractTarGz(archive: Buffer, destDir: string): void {
  const tar = gunzipSync(archive);
  mkdirSync(destDir, { recursive: true });
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((b) => b === 0)) break;
    const expectedSum = readTarOctal(header, 148, 8);
    let actualSum = 0;
    for (let i = 0; i < 512; i++) actualSum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (expectedSum !== actualSum) throw new Error("corrupt receiver archive: bad tar header checksum");
    const namePart = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const rawName = prefix ? `${prefix}/${namePart}` : namePart;
    const typeFlag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const size = readTarOctal(header, 124, 12);
    const mode = readTarOctal(header, 100, 8);
    const payloadBlocks = Math.ceil(size / 512) * 512;
    if (offset + payloadBlocks > tar.length) throw new Error("corrupt receiver archive: truncated entry");
    const data = tar.subarray(offset, offset + size);
    offset += payloadBlocks;
    if (typeFlag === "x" || typeFlag === "g") continue;
    const clean = rawName.replace(/^\.\//, "").replace(/\/+$/, "");
    if (
      !clean ||
      clean.startsWith("/") ||
      clean.includes("\\") ||
      /^[A-Za-z]:/.test(clean) ||
      clean.split("/").some((p) => !p || p === "." || p === "..")
    ) {
      throw new Error(`unsafe entry path in receiver archive: ${rawName}`);
    }
    const outPath = join(destDir, ...clean.split("/"));
    if (typeFlag === "5") {
      mkdirSync(outPath, { recursive: true });
      continue;
    }
    if (typeFlag !== "0") continue;
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
    if (process.platform !== "win32") {
      chmodSync(outPath, mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

const inflightDownloads = new Map<string, Promise<string>>();

export interface EnsureBinaryOptions extends BinaryOptions {
  manifest?: ReceiverManifest;
  fetchFn?: typeof fetch;
  /** For an explicit update, require the versioned release rather than reusing a checkout build. */
  releaseOnly?: boolean;
}

/** Ensure the receiver binary for `target` is present on disk, downloading from GitHub Releases if needed. */
export async function ensureBinaryFor(
  target: string,
  env: Env,
  opts: EnsureBinaryOptions = {},
): Promise<string | undefined> {
  const root = opts.root ?? ROOT;
  if (!opts.releaseOnly) {
    const existing = binaryFor(target, env, root, opts.cacheDir);
    if (existing) return existing;
  }
  if (target === `${process.platform}-${process.arch}` && env[BINARY_ENV]) return undefined;

  const manifest = opts.manifest ?? readReceiverManifest(root);
  const asset = manifest?.assets[target];
  if (!manifest || !asset) return undefined;

  const cacheBase = opts.cacheDir ?? receiverCacheDir(env, (opts.platform ?? process.platform) as NodeJS.Platform);
  const destDir = join(cacheBase, manifest.version, target);
  const exePath = join(destDir, executableName(target));
  if (existsSync(exePath)) return exePath;

  const key = `${destDir}:${asset.sha256}`;
  const pending = inflightDownloads.get(key);
  if (pending) return pending;

  const download = (async (): Promise<string> => {
    const baseOverride = env[BINARY_BASE_URL_ENV]?.trim();
    const url = baseOverride
      ? `${baseOverride.replace(/\/+$/, "")}/${asset.file}`
      : (asset.url ?? `https://github.com/${manifest.repo}/releases/download/${manifest.tag}/${asset.file}`);
    const doFetch = opts.fetchFn ?? fetch;
    const res = await doFetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      throw new Error(`cannot download ${BINARY_NAME} (${target}) from ${url}: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (asset.size > 0 && buf.length !== asset.size) {
      throw new Error(`downloaded ${asset.file} has wrong size (${buf.length} bytes, expected ${asset.size})`);
    }
    const digest = createHash("sha256").update(buf).digest("hex");
    if (digest !== asset.sha256.toLowerCase()) {
      throw new Error(`downloaded ${asset.file} failed SHA-256 check (got ${digest}, expected ${asset.sha256})`);
    }
    mkdirSync(dirname(destDir), { recursive: true });
    const stage = join(dirname(destDir), `.${target}.tmp-${randomBytes(4).toString("hex")}`);
    try {
      extractTarGz(buf, stage);
      const stagedExe = join(stage, executableName(target));
      if (!existsSync(stagedExe)) {
        throw new Error(`archive ${asset.file} did not contain ${executableName(target)}`);
      }
      rmSync(destDir, { recursive: true, force: true });
      renameSync(stage, destDir);
      return exePath;
    } catch (err) {
      rmSync(stage, { recursive: true, force: true });
      throw err;
    }
  })();

  inflightDownloads.set(key, download);
  try {
    return await download;
  } finally {
    inflightDownloads.delete(key);
  }
}

/** Ensure this machine's receiver binary is available (resolving `findBinary` or downloading from `receivers.json`). */
export async function ensureBinary(env: Env, opts: EnsureBinaryOptions = {}): Promise<BinaryChoice> {
  const choice = findBinary(env, opts);
  if (choice.ok && (opts.device !== "gpu" || choice.edition === "gpu" || !opts.gpuTarget)) return choice;
  if (!choice.ok && choice.chosen) return choice;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const target = opts.device === "gpu" && opts.gpuTarget ? opts.gpuTarget : `${platform}-${arch}`;
  try {
    const path = await ensureBinaryFor(target, env, opts);
    if (path)
      return { ok: true, path, from: "cache", edition: opts.device === "gpu" && opts.gpuTarget ? "gpu" : "cpu" };
    return choice;
  } catch (err) {
    if (choice.ok) return choice;
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The package's version from `package.json`, or undefined when unreadable. */
export function packageVersion(root = ROOT): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim() ? parsed.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The receiver version this package expects: the version its `receivers.json` names (a release whose
 * receiver did not change reuses an earlier release's binaries, which report that earlier version), else the
 * package's own version (a checkout, whose receiver build embeds it).
 */
export function expectedReceiverVersion(root = ROOT): string | undefined {
  return readReceiverManifest(root)?.version ?? packageVersion(root);
}

/** Extract a version like `0.2.5` from `pi-speech-receiver --version` output; undefined when not present. */
export function parseReceiverVersion(output: string): string | undefined {
  const m = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(output);
  return m?.[1];
}

export interface LocalBinaryStatus {
  version?: string;
  edition: "cpu" | "gpu";
  from?: Extract<BinaryChoice, { ok: true }>["from"];
}

/** Inspect the local receiver binary on disk, optionally running `--version` when not from cache/package. */
export async function inspectLocalBinary(
  env: Env,
  opts: { device: "cpu" | "gpu"; gpuTarget?: string; probeVersion?: boolean },
): Promise<LocalBinaryStatus> {
  const choice = findBinary(env, {
    device: opts.device,
    ...(opts.gpuTarget ? { gpuTarget: opts.gpuTarget } : {}),
  });
  if (!choice.ok) return { edition: opts.device };
  let version = choice.from === "cache" || choice.from === "package" ? expectedReceiverVersion() : undefined;
  if (!version && opts.probeVersion) {
    version = await new Promise<string | undefined>((resolve) => {
      execFile(choice.path, ["--version"], { timeout: 2000 }, (err, stdout) => {
        resolve(err ? undefined : parseReceiverVersion(String(stdout)));
      });
    });
  }
  return {
    ...(version ? { version } : {}),
    edition: choice.edition ?? opts.device,
    from: choice.from,
  };
}

function parseSemver(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Whether `actual` (reported by a receiver) is older than `expected` (this extension's version).
 * Prior to embedding `package.json`'s version, `receiver/Cargo.toml` stayed frozen at `0.3.0`, so `0.3.0`
 * is treated as older than any `0.2.x` extension.
 */
export function isReceiverOutdated(actual: string | undefined, expected: string | undefined): boolean {
  if (!expected || !actual) return false;
  const a = actual.trim();
  const e = expected.trim();
  if (!a || !e || a === e) return false;
  if (a === "0.3.0" && e.startsWith("0.2.")) return true;
  const pa = parseSemver(a);
  const pe = parseSemver(e);
  if (!pa || !pe) return a !== e;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pe[i]) return pa[i] < pe[i];
  }
  return false;
}
