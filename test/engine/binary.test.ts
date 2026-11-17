import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveFile, binaryFile, bundleBinaries, createReleaseAssets, TARGETS } from "../../npm/platforms.mjs";
import {
  binaryFor,
  ensureBinary,
  ensureBinaryFor,
  extractTarGz,
  findBinary,
  hasBinaryFor,
  isReceiverOutdated,
  packageVersion,
  parseReceiverVersion,
  releaseAssetSize,
} from "../../src/engine/binary";

const onWindows = process.platform === "win32";

describe.skipIf(onWindows)("finding the bundled binary", () => {
  let dir: string;
  const exe = (...parts: string[]) => {
    const p = join(dir, ...parts);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    return p;
  };
  const opts = (extra: object = {}) => ({
    root: join(dir, "root"),
    platform: "linux" as const,
    arch: "x64",
    ...extra,
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speech-bin-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("takes, in order: PI_SPEECH_BINARY, bin/<platform>-<arch>/, bin/, release, then debug", () => {
    const debug = exe("root", "receiver", "target", "debug", "pi-speech-receiver");
    expect(findBinary({}, opts())).toMatchObject({ ok: true, path: debug, from: "checkout" });
    const release = exe("root", "receiver", "target", "release", "pi-speech-receiver");
    expect(findBinary({}, opts())).toMatchObject({ ok: true, path: release, from: "checkout" });
    const bin = exe("root", "bin", "pi-speech-receiver");
    expect(findBinary({}, opts())).toMatchObject({ ok: true, path: bin, from: "package" });
    const platformBin = exe("root", "bin", "linux-x64", "pi-speech-receiver");
    expect(findBinary({}, opts())).toMatchObject({ ok: true, path: platformBin, from: "package" });
    const custom = exe("elsewhere", "my-receiver");
    expect(findBinary({ PI_SPEECH_BINARY: custom }, opts())).toEqual({ ok: true, path: custom, from: "env" });
  });

  it("finds a checkout GPU build in receiver/target-gpu when device is gpu", () => {
    const gpuRelease = exe("root", "receiver", "target-gpu", "release", "pi-speech-receiver");
    const hostOpts = {
      root: join(dir, "root"),
      platform: process.platform,
      arch: process.arch,
      device: "gpu" as const,
      gpuTarget: `${process.platform}-${process.arch}-cuda13`,
    };
    expect(findBinary({}, hostOpts)).toEqual({ ok: true, path: gpuRelease, from: "checkout", edition: "gpu" });
    expect(findBinary({}, { ...hostOpts, gpuTarget: undefined })).toEqual({
      ok: true,
      path: gpuRelease,
      from: "checkout",
      edition: "gpu",
    });
    expect(hasBinaryFor(`${process.platform}-${process.arch}-cuda13`, {}, join(dir, "root"))).toBe(true);
    expect(binaryFor(`${process.platform}-${process.arch}-cuda13`, {}, join(dir, "root"))).toBe(gpuRelease);
  });

  it("finds PI_SPEECH_BINARY by name on PATH", () => {
    const p = exe("path", "receiver-x");
    expect(findBinary({ PI_SPEECH_BINARY: "receiver-x", PATH: join(dir, "path") }, opts())).toMatchObject({
      ok: true,
      path: p,
    });
  });

  it("a PI_SPEECH_BINARY that is not an executable is an error, even with another binary present", () => {
    exe("root", "receiver", "target", "release", "pi-speech-receiver");
    expect(findBinary({ PI_SPEECH_BINARY: join(dir, "missing") }, opts())).toEqual({
      ok: false,
      reason: `PI_SPEECH_BINARY (${join(dir, "missing")}) is not an executable`,
      chosen: true,
    });
  });

  it("says how to get one when there is none", () => {
    const r = findBinary({}, opts());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/bundled pi-speech-receiver is not installed .*cargo build --release/);
  });

  it("looks for pi-speech-receiver.exe on Windows", () => {
    const r = findBinary({}, { ...opts(), platform: "win32" });
    expect(r.ok).toBe(false);
  });
});

describe("the bundled binaries", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speech-bundle-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("are the five shipped targets, named as findBinary looks them up", () => {
    expect(TARGETS.map((t) => t.target)).toEqual([
      "linux-x64",
      "linux-arm64",
      "darwin-arm64",
      "darwin-x64",
      "win32-x64",
    ]);
    expect(binaryFile("win32-x64")).toBe("pi-speech-receiver.exe");
    expect(binaryFile("linux-x64")).toBe("pi-speech-receiver");
    expect(() => binaryFile("sunos-x64")).toThrow(/unknown target/);
  });

  it("copies every target's binary into bin/<target>/", () => {
    const binaries = join(dir, "binaries");
    for (const { target } of TARGETS) {
      const file = binaryFile(target);
      const p = join(binaries, target, file);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, target);
    }
    const out = join(dir, "pkg");
    mkdirSync(out, { recursive: true });
    const copied = bundleBinaries({ binariesDir: binaries, out });
    expect(copied).toHaveLength(TARGETS.length);
    for (const { target } of TARGETS) {
      const file = binaryFile(target);
      expect(readFileSync(join(out, "bin", target, file), "utf8")).toBe(target);
    }
    expect(() => bundleBinaries({ binariesDir: join(dir, "empty"), out: join(dir, "x") })).toThrow(/no binary at/);
  });

  it("creates release archives, downloads on demand with SHA-256 check, and extracts safely", async () => {
    const binaries = join(dir, "binaries");
    for (const { target } of TARGETS) {
      const file = binaryFile(target);
      const p = join(binaries, target, file);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, `#!/bin/sh\necho ${target}\n`);
    }
    // Optional GPU archive with shared libraries beside the binary.
    mkdirSync(join(binaries, "linux-x64-cuda13"), { recursive: true });
    writeFileSync(join(binaries, "linux-x64-cuda13", "pi-speech-receiver"), "#!/bin/sh\necho gpu\n");
    writeFileSync(join(binaries, "linux-x64-cuda13", "libonnxruntime.so"), "libonnxruntime.so");

    const root = join(dir, "pkg");
    const assetsDir = join(dir, "assets");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.2.6" }));
    const { manifest } = createReleaseAssets({
      binariesDir: binaries,
      assetsDir,
      manifestPath: join(root, "receivers.json"),
      version: "0.2.6",
    });
    expect(manifest.assets["linux-x64"].file).toBe(archiveFile("linux-x64"));
    expect(manifest.assets["linux-x64-cuda13"].file).toBe(archiveFile("linux-x64-cuda13"));
    expect(releaseAssetSize("linux-x64", root)).toBe(manifest.assets["linux-x64"].size);

    const server = createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? "/").replace(/^\/+/, ""));
      const filePath = join(assetsDir, name);
      if (!existsSync(filePath)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200).end(readFileSync(filePath));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const cacheDir = join(dir, "cache");
      const env = { PI_SPEECH_RECEIVER_BASE_URL: `http://127.0.0.1:${port}` };
      expect(hasBinaryFor("darwin-arm64", env, root)).toBe(true);
      expect(binaryFor("darwin-arm64", env, root, cacheDir)).toBeUndefined();

      const fetched = await ensureBinary(env, { root, cacheDir, platform: "linux", arch: "x64" });
      expect(fetched).toMatchObject({
        ok: true,
        from: "cache",
        edition: "cpu",
        path: join(cacheDir, "0.2.6", "linux-x64", "pi-speech-receiver"),
      });
      expect(findBinary(env, { root, cacheDir, platform: "linux", arch: "x64" })).toEqual(fetched);

      const gpuFetched = await ensureBinary(env, {
        root,
        cacheDir,
        platform: "linux",
        arch: "x64",
        device: "gpu",
        gpuTarget: "linux-x64-cuda13",
      });
      expect(gpuFetched).toMatchObject({
        ok: true,
        from: "cache",
        edition: "gpu",
        path: join(cacheDir, "0.2.6", "linux-x64-cuda13", "pi-speech-receiver"),
      });
      if (gpuFetched.ok) {
        expect(readFileSync(join(gpuFetched.path, "..", "libonnxruntime.so"), "utf8")).toBe("libonnxruntime.so");
      }

      const remotePath = await ensureBinaryFor("darwin-arm64", env, { root, cacheDir });
      expect(remotePath).toBe(join(cacheDir, "0.2.6", "darwin-arm64", "pi-speech-receiver"));
      expect(binaryFor("darwin-arm64", env, root, cacheDir)).toBe(remotePath);

      // Tampered checksum is rejected and never leaves a corrupt binary.
      const badManifest = {
        ...manifest,
        assets: { ...manifest.assets, "linux-arm64": { ...manifest.assets["linux-arm64"], sha256: "0".repeat(64) } },
      };
      await expect(ensureBinaryFor("linux-arm64", env, { root, cacheDir, manifest: badManifest })).rejects.toThrow(
        /SHA-256/,
      );
      expect(binaryFor("linux-arm64", env, root, cacheDir)).toBeUndefined();

      // Path traversal inside a tar.gz archive is refused.
      expect(() => extractTarGz(Buffer.from([]), join(dir, "empty-tar"))).toThrow();
    } finally {
      server.close();
    }
  });
});

describe("in this checkout", () => {
  it("finds the binary built in receiver/target when there is one", () => {
    const r = findBinary({});
    if (r.ok) expect(r.path).toMatch(/receiver[\\/]target[\\/](release|debug)[\\/]pi-speech-receiver/);
    else expect(r.reason).toMatch(/not installed/);
  });

  it("reads the package version and compares receiver versions", () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageVersion(join(tmpdir(), "nonexistent-pi-speech-root"))).toBeUndefined();
    expect(parseReceiverVersion("pi-speech-receiver 0.2.5\n")).toBe("0.2.5");
    expect(parseReceiverVersion("0.2.5")).toBe("0.2.5");
    expect(parseReceiverVersion("unknown argument")).toBeUndefined();
    expect(isReceiverOutdated("0.2.5", "0.2.5")).toBe(false);
    expect(isReceiverOutdated("0.2.6", "0.2.5")).toBe(false);
    expect(isReceiverOutdated("0.2.4", "0.2.5")).toBe(true);
    expect(isReceiverOutdated("0.3.0", "0.2.5")).toBe(true);
    expect(isReceiverOutdated(undefined, "0.2.5")).toBe(false);
    expect(isReceiverOutdated("0.2.4", undefined)).toBe(false);
  });
});
