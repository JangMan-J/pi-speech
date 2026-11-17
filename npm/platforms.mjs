#!/usr/bin/env node
import { createHash } from "node:crypto";
// The bundled binaries: the main package carries every system's pi-speech-receiver under
// bin/<os>-<cpu>/, so one npm package serves every machine. src/engine/binary.ts picks the
// one that matches this machine at runtime. No platform packages, no optionalDependencies:
// a release is `npm version <bump> && git push --follow-tags`.
//
//   node npm/platforms.mjs targets
//       The targets, one per line (linux-x64, ...).
//   node npm/platforms.mjs bundle --binaries-dir <dir> [--out <dir>]
//       Copy each target's binary from <dir>/<target>/<binary-file> into <out>/bin/<target>/,
//       with the shared libraries beside it there (Linux x64: sherpa-onnx's and ONNX Runtime's,
//       which the binary finds through its $ORIGIN rpath), emptying <out>/bin first. Default <out>
//       is the package root. Fails on a missing binary, or a missing library a target needs.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..");
export const BINARY_NAME = "pi-speech-receiver";

/** Every system and processor a binary is built for, as Node names them. */
export const TARGETS = [
  { os: "linux", cpu: "x64" },
  { os: "linux", cpu: "arm64" },
  { os: "darwin", cpu: "arm64" },
  { os: "darwin", cpu: "x64" },
  { os: "win32", cpu: "x64" },
].map((t) => ({ ...t, target: `${t.os}-${t.cpu}` }));

/** Optional self-contained GPU receiver targets (built with `--features shared` and bundled CUDA libs). */
export const GPU_TARGETS = [
  { os: "linux", cpu: "x64", target: "linux-x64-cuda13" },
  { os: "linux", cpu: "x64", target: "linux-x64-cuda12" },
];

/** The shared libraries a target's binary links, which go beside it (none: all CPU targets are static). */
export const LIBRARIES = {};

export function findTarget(target) {
  const t = TARGETS.find((x) => x.target === target) ?? GPU_TARGETS.find((x) => x.target === target);
  if (!t) {
    const all = [...TARGETS, ...GPU_TARGETS].map((x) => x.target).join(", ");
    throw new Error(`unknown target ${target}; the targets are ${all}`);
  }
  return t;
}

/** The executable file name of a target's binary. */
export function binaryFile(target) {
  const t = findTarget(target);
  return t.os === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;
}

/** The GitHub Release archive name for `target`. */
export function archiveFile(target) {
  findTarget(target);
  return `${BINARY_NAME}-${target}.tar.gz`;
}

/** Pack `entries` (`[{ name, data, mode }]`) into a deterministic POSIX ustar `.tar.gz` buffer. */
function packTarGz(entries) {
  const blocks = [];
  for (const { name, data, mode } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
    header.write("0000000\0", 108, 8, "ascii");
    header.write("0000000\0", 116, 8, "ascii");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
    header.write("00000000000\0", 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header);
    if (data.length > 0) {
      blocks.push(data);
      const rem = data.length % 512;
      if (rem !== 0) blocks.push(Buffer.alloc(512 - rem));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

/**
 * Create a `.tar.gz` release archive per target in `assetsDir` and write the manifest (`receivers.json`)
 * naming each archive's file, size, and SHA-256. Returns the written manifest and archive paths.
 */
export function createReleaseAssets({
  binariesDir,
  assetsDir,
  manifestPath = join(ROOT, "receivers.json"),
  version,
  repo = "JangMan-J/pi-speech",
  tag = version ? `v${version}` : "",
}) {
  if (!version) throw new Error("release needs --version <semver>");
  if (!tag) throw new Error("release needs --tag <tag>");
  rmSync(assetsDir, { recursive: true, force: true });
  mkdirSync(assetsDir, { recursive: true });
  const assets = {};
  const archives = [];
  const packTarget = (target, required) => {
    const file = binaryFile(target);
    const dir = join(binariesDir, target);
    const src = join(dir, file);
    if (!existsSync(src)) {
      if (required) throw new Error(`no binary at ${src}`);
      return;
    }
    const entries = [{ name: file, data: readFileSync(src), mode: 0o755 }];
    const there = readdirSync(dir);
    for (const extra of there.sort()) {
      if (extra === file) continue;
      if (/\.(so(\.\d+)*|dylib|dll)$/.test(extra)) {
        entries.push({ name: extra, data: readFileSync(join(dir, extra)), mode: 0o644 });
      }
    }
    const archive = archiveFile(target);
    const dest = join(assetsDir, archive);
    const gz = packTarGz(entries);
    writeFileSync(dest, gz);
    const sha256 = createHash("sha256").update(gz).digest("hex");
    assets[target] = { file: archive, size: gz.length, sha256 };
    archives.push(dest);
  };
  for (const { target } of TARGETS) packTarget(target, true);
  for (const { target } of GPU_TARGETS) packTarget(target, false);
  const manifest = { version, repo, tag, assets };
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, manifestPath, archives };
}

/**
 * Copy every target's binary from `binariesDir/<target>/<file>` into `out/bin/<target>/<file>`,
 * emptying `out/bin` first. Returns the copied destinations.
 */
export function bundleBinaries({ binariesDir, out = ROOT }) {
  const bin = join(out, "bin");
  rmSync(bin, { recursive: true, force: true });
  const copied = [];
  for (const { target } of TARGETS) {
    const file = binaryFile(target);
    const src = join(binariesDir, target, file);
    if (!existsSync(src)) throw new Error(`no binary at ${src}`);
    const dest = join(bin, target, file);
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileSync(src, dest);
    chmodSync(dest, 0o755);
    copied.push(dest);
    const libs = LIBRARIES[target] ?? [];
    const there = readdirSync(join(binariesDir, target));
    for (const lib of libs) {
      if (!there.includes(lib)) throw new Error(`no ${lib} beside ${src}`);
      const to = join(bin, target, lib);
      copyFileSync(join(binariesDir, target, lib), to);
      chmodSync(to, 0o644);
      copied.push(to);
    }
  }
  return copied;
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      "binaries-dir": { type: "string" },
      "assets-dir": { type: "string" },
      manifest: { type: "string" },
      version: { type: "string" },
      repo: { type: "string" },
      tag: { type: "string" },
      out: { type: "string" },
    },
  });
  switch (command) {
    case "targets":
      for (const { target } of TARGETS) console.log(target);
      return;
    case "bundle": {
      if (!values["binaries-dir"]) throw new Error("bundle needs --binaries-dir <dir>");
      const copied = bundleBinaries({
        binariesDir: resolve(values["binaries-dir"]),
        out: resolve(values.out ?? ROOT),
      });
      for (const p of copied) console.log(p);
      return;
    }
    case "release": {
      if (!values["binaries-dir"]) throw new Error("release needs --binaries-dir <dir>");
      if (!values["assets-dir"]) throw new Error("release needs --assets-dir <dir>");
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      const version = values.version ?? pkg.version;
      const { manifestPath, archives } = createReleaseAssets({
        binariesDir: resolve(values["binaries-dir"]),
        assetsDir: resolve(values["assets-dir"]),
        manifestPath: resolve(values.manifest ?? join(ROOT, "receivers.json")),
        version,
        ...(values.repo ? { repo: values.repo } : {}),
        ...(values.tag ? { tag: values.tag } : {}),
      });
      console.log(manifestPath);
      for (const p of archives) console.log(p);
      return;
    }
    default:
      throw new Error(
        "usage: node npm/platforms.mjs targets | bundle --binaries-dir <dir> [--out <dir>] | release --binaries-dir <dir> --assets-dir <dir> [--manifest <path>]",
      );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`platforms: ${e.message}`);
    process.exit(1);
  }
}
