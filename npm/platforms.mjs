#!/usr/bin/env node
// The platform packages: one npm package per system and processor, each carrying only that
// machine's pi-speech-receiver in bin/. The main package lists all of them as
// optionalDependencies at its own version; npm (and so `pi install npm:@jangmanj/pi-speech`)
// installs only the one whose `os`, `cpu` (and on Linux `libc`) match this machine.
//
//   node npm/platforms.mjs targets
//       The targets, one per line (linux-x64, ...).
//   node npm/platforms.mjs build --target <os-cpu> --binary <file> [--out <dir>]
//       Generate the platform package in <dir> (default npm/dist/<os-cpu>) from
//       npm/platform-package.template.json: package.json, bin/<binary>, README.md, LICENSE.
//   node npm/platforms.mjs stamp [--manifest <package.json>]
//       Write the optionalDependencies on every platform package, at the manifest's version.
//   node npm/platforms.mjs verify-stamped [--manifest <package.json>]
//       Fail unless the manifest lists exactly the platform packages, at its own version.
//
// Why the committed package.json does not list them: `npm ci` refuses a lock file that lacks
// an entry for a dependency in package.json, and npm can write that entry only once the
// platform package of that version is on the registry. A committed list would break `npm ci`
// in CI (and in the publish run's checks, which come before the platform packages are
// published) after every version bump. So the publish job stamps them into package.json just
// before it publishes the main package, and `npm run smoke:pack` stamps them into the
// manifest it packs.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, "..");
export const BINARY_NAME = "pi-speech-receiver";

/** Every system and processor a platform package is built for, as Node names them. */
export const TARGETS = [
  { os: "linux", cpu: "x64" },
  { os: "linux", cpu: "arm64" },
  { os: "darwin", cpu: "arm64" },
  { os: "darwin", cpu: "x64" },
  { os: "win32", cpu: "x64" },
].map((t) => ({ ...t, target: `${t.os}-${t.cpu}` }));

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const fill = (text, values) =>
  text.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`unknown template placeholder ${match}`);
    return values[key];
  });

/** The npm name of a target's platform package, after the main package's scope and name. */
export function platformName(mainName, target) {
  return `${mainName}-${target}`;
}

export function findTarget(target) {
  const t = TARGETS.find((x) => x.target === target);
  if (!t) throw new Error(`unknown target ${target}; the targets are ${TARGETS.map((x) => x.target).join(", ")}`);
  return t;
}

/** The optionalDependencies of the main package: every platform package at `version`. */
export function optionalDependencies(mainName, version) {
  return Object.fromEntries(TARGETS.map(({ target }) => [platformName(mainName, target), version]));
}

/** The main manifest with the platform packages stamped in (other optionalDependencies kept). */
export function stamp(manifest) {
  return {
    ...manifest,
    optionalDependencies: {
      ...manifest.optionalDependencies,
      ...optionalDependencies(manifest.name, manifest.version),
    },
  };
}

/** Why the manifest does not list exactly the platform packages at its own version, or undefined. */
export function stampProblem(manifest) {
  const want = optionalDependencies(manifest.name, manifest.version);
  const have = Object.fromEntries(
    Object.entries(manifest.optionalDependencies ?? {}).filter(([name]) => name.startsWith(`${manifest.name}-`)),
  );
  const problems = [];
  for (const [name, version] of Object.entries(want)) {
    if (have[name] !== version) problems.push(`${name} must be ${version}, is ${have[name] ?? "missing"}`);
  }
  for (const name of Object.keys(have)) if (!(name in want)) problems.push(`${name} is not a platform package`);
  return problems.length ? problems.join("; ") : undefined;
}

/**
 * Generate the platform package for `target` in `out` (emptied first), carrying `binary`.
 * Identity fields (version, license, author, repository, homepage, bugs) come from the main
 * manifest; npm provenance needs `repository` to match the GitHub repository that publishes.
 */
export function buildPlatformPackage({ target, binary, out, manifest = readJson(join(ROOT, "package.json")) }) {
  const t = findTarget(target);
  if (!existsSync(binary)) throw new Error(`no binary at ${binary}`);
  const file = t.os === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;
  if (basename(binary).toLowerCase() !== file.toLowerCase()) {
    throw new Error(`the ${target} binary must be named ${file}, got ${basename(binary)}`);
  }
  const values = { ...t, version: manifest.version };
  const pkg = JSON.parse(fill(readFileSync(join(here, "platform-package.template.json"), "utf8"), values));
  if (pkg.name !== platformName(manifest.name, target)) {
    throw new Error(`the template names the package ${pkg.name}, expected ${platformName(manifest.name, target)}`);
  }
  for (const key of ["license", "author", "repository", "homepage", "bugs"]) {
    if (manifest[key] !== undefined) pkg[key] = manifest[key];
  }
  // A Linux build links glibc; on musl (Alpine) npm then installs nothing rather than a binary that cannot start.
  if (t.os === "linux") pkg.libc = ["glibc"];

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "bin"), { recursive: true });
  writeJson(join(out, "package.json"), pkg);
  writeFileSync(join(out, "README.md"), fill(readFileSync(join(here, "platform-README.template.md"), "utf8"), values));
  if (existsSync(join(ROOT, "LICENSE"))) copyFileSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
  const dest = join(out, "bin", file);
  copyFileSync(binary, dest);
  // A downloaded workflow artifact loses the executable bit; npm keeps it from here on.
  chmodSync(dest, 0o755);
  return { dir: out, name: pkg.name, version: pkg.version, binary: dest };
}

function main(argv) {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      target: { type: "string" },
      binary: { type: "string" },
      out: { type: "string" },
      manifest: { type: "string", default: join(ROOT, "package.json") },
    },
  });
  switch (command) {
    case "targets":
      for (const { target } of TARGETS) console.log(target);
      return;
    case "build": {
      if (!values.target || !values.binary) throw new Error("build needs --target and --binary");
      const built = buildPlatformPackage({
        target: values.target,
        binary: resolve(values.binary),
        out: resolve(values.out ?? join(here, "dist", values.target)),
      });
      console.log(`${built.name}@${built.version} in ${built.dir}`);
      return;
    }
    case "stamp": {
      const stamped = stamp(readJson(values.manifest));
      writeJson(values.manifest, stamped);
      console.log(`${values.manifest}: optionalDependencies ${JSON.stringify(stamped.optionalDependencies)}`);
      return;
    }
    case "verify-stamped": {
      const problem = stampProblem(readJson(values.manifest));
      if (problem) throw new Error(`${values.manifest} does not list the platform packages: ${problem}`);
      console.log(`${values.manifest} lists all ${TARGETS.length} platform packages at its version`);
      return;
    }
    default:
      throw new Error(
        "usage: node npm/platforms.mjs targets | build --target <os-cpu> --binary <file> [--out <dir>] | stamp | verify-stamped [--manifest <file>]",
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
