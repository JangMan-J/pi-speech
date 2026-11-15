#!/usr/bin/env node
// Pack the package as the publish job does (every platform's binary bundled into bin/<os>-<cpu>/),
// install it into a scratch project as `pi install npm:` would, and check two things:
//   1. findBinary, run from the installed package, finds bin/<platform>-<arch>/;
//   2. Pi's real extension loader loads the extension.
// This catches a broken `files` list, a missing runtime dependency, an import that only resolves
// inside the repo, or a bundled binary that lost its executable mode.
//
// The bundled binaries are stand-ins (or this machine's real release binary via
// PI_SPEECH_SMOKE_BINARY, else receiver/target/release's); with the real binary it also runs
// `models list`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { binaryFile, bundleBinaries, TARGETS } from "../npm/platforms.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = `${process.platform}-${process.arch}`;
const exeName = binaryFile(target);

const scratch = mkdtempSync(join(tmpdir(), "pi-package-smoke-"));
try {
  const npm = (args, cwd) =>
    execFileSync("npm", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
  const pack = (dir, dest) => join(dest, npm(["pack", "--silent", "--pack-destination", dest], dir).trim().split("\n").pop());

  // A binary per target: this machine's real release binary when there is one, else a stand-in.
  const realBinary = [process.env.PI_SPEECH_SMOKE_BINARY, join(root, "receiver", "target", "release", exeName)].find(
    (p) => p && existsSync(p),
  );
  const binaries = join(scratch, "binaries");
  for (const { target: t } of TARGETS) {
    const file = binaryFile(t);
    const dir = join(binaries, t);
    mkdirSync(dir, { recursive: true });
    if (t === target && realBinary) {
      execFileSync("cp", ["-p", realBinary, join(dir, file)], { shell: process.platform === "win32" });
    } else {
      writeFileSync(join(dir, file), "#!/bin/sh\nexit 0\n");
    }
  }

  // The package as the publish job packs it: the root's files, plus bin/ bundled in.
  const packed = pack(root, scratch);
  const stage = join(scratch, "stage");
  mkdirSync(stage);
  execFileSync("tar", ["-xzf", packed, "-C", stage]);
  const pkgDir = join(stage, "package");
  bundleBinaries({ binariesDir: binaries, out: pkgDir });
  mkdirSync(join(scratch, "main"));
  const mainTarball = pack(pkgDir, join(scratch, "main"));

  const project = join(scratch, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  npm(["install", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts", mainTarball], project);
  const installed = join(project, "node_modules", manifest.name);
  if (!existsSync(installed)) throw new Error(`npm did not install ${manifest.name}`);

  // The Pi under test is the one this repo develops against.
  const piName = (dir) => { try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name; } catch { return undefined; } };
  let piDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  while (piName(piDir) !== "@earendil-works/pi-coding-agent") {
    if (dirname(piDir) === piDir) throw new Error("Cannot find the installed @earendil-works/pi-coding-agent");
    piDir = dirname(piDir);
  }
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(piDir, "dist/core/extensions/loader.js")).href);

  // 1. The installed extension finds its own bundled binary.
  const { createJiti } = createRequire(join(piDir, "package.json"))("jiti");
  const { findBinary } = await createJiti(import.meta.url, { moduleCache: false }).import(join(installed, "src", "engine", "binary.ts"));
  const choice = findBinary({});
  const expected = join(installed, "bin", target, exeName);
  if (!choice.ok || choice.from !== "package" || resolve(choice.path) !== resolve(expected)) {
    throw new Error(`findBinary did not take the bundled binary (${expected}): ${JSON.stringify(choice)}`);
  }
  let binaryNote = "a stand-in binary";
  if (realBinary) {
    const lines = execFileSync(choice.path, ["models", "list"], { encoding: "utf8" }).trim().split(/\r?\n/);
    for (const line of lines) JSON.parse(line);
    binaryNote = `its binary (models list: ${lines.length} JSON lines)`;
  }
  console.log(`${manifest.name}@${manifest.version}: installed with ${TARGETS.length} bundled binaries; findBinary takes ${binaryNote} at ${relative(project, choice.path)}`);

  // 2. Pi loads the extension.

  const runtime = createExtensionRuntime();
  const entries = manifest.pi.extensions.map((entry) => resolve(installed, entry));
  const loaded = await loadExtensions(entries, installed, undefined, runtime);
  if (loaded.errors.length) throw new Error(`Pi could not load the packed extension:\n${JSON.stringify(loaded.errors, null, 2)}`);

  const registered = {
    tools: loaded.extensions.flatMap((extension) => [...extension.tools.keys()]),
    commands: loaded.extensions.flatMap((extension) => [...extension.commands.keys()]),
    providers: runtime.pendingNativeProviderRegistrations.map((registration) => registration.provider.id),
  };
  if (!Object.values(registered).some((list) => list.length)) throw new Error("The packed extension loaded but registered no tools, commands, or providers");
  const summary = Object.entries(registered).filter(([, list]) => list.length).map(([kind, list]) => `${kind} ${list.join(", ")}`).join("; ");
  console.log(`${manifest.name}@${manifest.version}: packed tarball loads in Pi ${JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version}; ${summary}`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
