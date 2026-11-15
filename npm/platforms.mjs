#!/usr/bin/env node
// The bundled binaries: the main package carries every system's pi-speech-receiver under
// bin/<os>-<cpu>/, so one npm package serves every machine. src/engine/binary.ts picks the
// one that matches this machine at runtime. No platform packages, no optionalDependencies:
// a release is `npm version <bump> && git push --follow-tags`.
//
//   node npm/platforms.mjs targets
//       The targets, one per line (linux-x64, ...).
//   node npm/platforms.mjs bundle --binaries-dir <dir> [--out <dir>]
//       Copy each target's binary from <dir>/<target>/<binary-file> into <out>/bin/<target>/,
//       emptying <out>/bin first. Default <out> is the package root. Fails on a missing binary.
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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

export function findTarget(target) {
  const t = TARGETS.find((x) => x.target === target);
  if (!t) throw new Error(`unknown target ${target}; the targets are ${TARGETS.map((x) => x.target).join(", ")}`);
  return t;
}

/** The executable file name of a target's binary. */
export function binaryFile(target) {
  const t = findTarget(target);
  return t.os === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;
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
  }
  return copied;
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      "binaries-dir": { type: "string" },
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
    default:
      throw new Error("usage: node npm/platforms.mjs targets | bundle --binaries-dir <dir> [--out <dir>]");
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
