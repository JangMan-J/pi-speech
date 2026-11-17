#!/usr/bin/env node
// Pack the package as the publish job does (without `bin/`, carrying `receivers.json` with the
// GitHub Release archives' checksums), install it into a scratch project as `pi install npm:`
// would, and check:
//   1. The packed tarball contains `receivers.json` and no `bin/`;
//   2. `ensureBinary` downloads the matching release archive from an ephemeral HTTP server, checks
//      its SHA-256, extracts it into the per-user cache, and `findBinary` finds it from cache;
//   3. Pi's real extension loader loads the extension.
//
// The release binaries are stand-ins (or this machine's real release binary via
// PI_SPEECH_SMOKE_BINARY, else receiver/target/release's); with the real binary it also runs
// `models list`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { binaryFile, createReleaseAssets, LIBRARIES, TARGETS } from "../npm/platforms.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = `${process.platform}-${process.arch}`;
const exeName = binaryFile(target);

const scratch = mkdtempSync(join(tmpdir(), "pi-package-smoke-"));
let server;
try {
  const npmrc = join(scratch, "npmrc");
  writeFileSync(npmrc, "");
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.toLowerCase().startsWith("npm_config_")),
  );
  const npm = (args, cwd) =>
    execFileSync("npm", ["--userconfig", npmrc, ...args], {
      cwd,
      encoding: "utf8",
      env: cleanEnv,
      stdio: ["ignore", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
  const pack = (dir, dest) =>
    join(dest, npm(["pack", "--silent", "--pack-destination", dest], dir).trim().split("\n").pop());

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
    for (const lib of LIBRARIES[t] ?? []) writeFileSync(join(dir, lib), "");
  }

  // Build release archives + receivers.json, and pack the npm tarball without bin/.
  const packed = pack(root, scratch);
  const stage = join(scratch, "stage");
  mkdirSync(stage);
  execFileSync("tar", ["-xzf", packed, "-C", stage]);
  const pkgDir = join(stage, "package");
  if (existsSync(join(pkgDir, "bin"))) throw new Error("packed npm package must not carry bin/");
  const assetsDir = join(scratch, "release-assets");
  createReleaseAssets({
    binariesDir: binaries,
    assetsDir,
    manifestPath: join(pkgDir, "receivers.json"),
    version: manifest.version,
    tag: `v${manifest.version}`,
  });
  mkdirSync(join(scratch, "main"));
  const mainTarball = pack(pkgDir, join(scratch, "main"));

  const project = join(scratch, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  npm(["install", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts", mainTarball], project);
  const installed = join(project, "node_modules", manifest.name);
  if (!existsSync(installed)) throw new Error(`npm did not install ${manifest.name}`);
  if (!existsSync(join(installed, "receivers.json"))) throw new Error("installed package is missing receivers.json");

  // Serve the release archives over HTTP to verify on-demand download + SHA-256 + extraction.
  server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").replace(/^\/+/, ""));
    const filePath = join(assetsDir, name);
    if (!name || name.includes("/") || !existsSync(filePath)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(readFileSync(filePath));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  // The Pi under test is the one this repo develops against.
  const piName = (dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name;
    } catch {
      return undefined;
    }
  };
  let piDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  while (piName(piDir) !== "@earendil-works/pi-coding-agent") {
    if (dirname(piDir) === piDir) throw new Error("Cannot find the installed @earendil-works/pi-coding-agent");
    piDir = dirname(piDir);
  }
  const { loadExtensions, createExtensionRuntime } = await import(
    pathToFileURL(join(piDir, "dist/core/extensions/loader.js")).href
  );

  // 1. ensureBinary downloads from the release server into the cache, and findBinary finds it there.
  const { createJiti } = createRequire(join(piDir, "package.json"))("jiti");
  const { ensureBinary, findBinary } = await createJiti(import.meta.url, { moduleCache: false }).import(
    join(installed, "src", "engine", "binary.ts"),
  );
  const cacheHome = join(scratch, "cache");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: scratch,
    XDG_CACHE_HOME: cacheHome,
    LOCALAPPDATA: cacheHome,
    PI_SPEECH_RECEIVER_BASE_URL: `http://127.0.0.1:${port}`,
  };
  const downloaded = await ensureBinary(env);
  if (!downloaded.ok || downloaded.from !== "cache") {
    throw new Error(`ensureBinary did not download into cache: ${JSON.stringify(downloaded)}`);
  }
  const choice = findBinary(env);
  if (!choice.ok || choice.from !== "cache" || resolve(choice.path) !== resolve(downloaded.path)) {
    throw new Error(`findBinary did not take the cached binary: ${JSON.stringify(choice)}`);
  }
  let binaryNote = "a stand-in binary";
  if (realBinary) {
    const lines = execFileSync(choice.path, ["models", "list"], { encoding: "utf8" }).trim().split(/\r?\n/);
    for (const line of lines) JSON.parse(line);
    binaryNote = `its binary (models list: ${lines.length} JSON lines)`;
  }
  console.log(
    `${manifest.name}@${manifest.version}: installed without bin/; ensureBinary fetched ${binaryNote} to ${relative(scratch, choice.path)}`,
  );

  // 2. Pi loads the extension.
  const runtime = createExtensionRuntime();
  const entries = manifest.pi.extensions.map((entry) => resolve(installed, entry));
  const loaded = await loadExtensions(entries, installed, undefined, runtime);
  if (loaded.errors.length) {
    throw new Error(`Pi could not load the packed extension:\n${JSON.stringify(loaded.errors, null, 2)}`);
  }

  const registered = {
    tools: loaded.extensions.flatMap((extension) => [...extension.tools.keys()]),
    commands: loaded.extensions.flatMap((extension) => [...extension.commands.keys()]),
    providers: runtime.pendingNativeProviderRegistrations.map((registration) => registration.provider.id),
  };
  if (!Object.values(registered).some((list) => list.length)) {
    throw new Error("The packed extension loaded but registered no tools, commands, or providers");
  }
  const summary = Object.entries(registered)
    .filter(([, list]) => list.length)
    .map(([kind, list]) => `${kind} ${list.join(", ")}`)
    .join("; ");
  console.log(
    `${manifest.name}@${manifest.version}: packed tarball loads in Pi ${JSON.parse(readFileSync(join(piDir, "package.json"), "utf8")).version}; ${summary}`,
  );
} finally {
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
}
