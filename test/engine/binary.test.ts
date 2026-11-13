import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlatformPackage, optionalDependencies, stamp, stampProblem, TARGETS } from "../../npm/platforms.mjs";
import { findBinary, platformPackage } from "../../src/engine/binary";

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
  const opts = (pkg?: string) => ({
    root: join(dir, "root"),
    platform: "linux" as const,
    arch: "x64",
    packageDir: (name: string) => (name === "@jangmanj/pi-speech-linux-x64" ? pkg : undefined),
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speech-bin-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names the platform package after the platform and architecture", () => {
    expect(platformPackage("darwin", "arm64")).toBe("@jangmanj/pi-speech-darwin-arm64");
  });

  it("takes, in order: PI_SPEECH_BINARY, the platform package, bin/ in the package, release, then debug", () => {
    const debug = exe("root", "receiver", "target", "debug", "pi-speech-receiver");
    expect(findBinary({}, opts())).toEqual({ ok: true, path: debug, from: "checkout" });
    const release = exe("root", "receiver", "target", "release", "pi-speech-receiver");
    expect(findBinary({}, opts())).toEqual({ ok: true, path: release, from: "checkout" });
    const bin = exe("root", "bin", "pi-speech-receiver");
    expect(findBinary({}, opts())).toEqual({ ok: true, path: bin, from: "package" });
    const platformBin = exe("root", "bin", "linux-x64", "pi-speech-receiver");
    expect(findBinary({}, opts())).toEqual({ ok: true, path: platformBin, from: "package" });
    const pkg = exe("pkg", "bin", "pi-speech-receiver");
    expect(findBinary({}, opts(join(dir, "pkg")))).toEqual({ ok: true, path: pkg, from: "package" });
    const custom = exe("elsewhere", "my-receiver");
    expect(findBinary({ PI_SPEECH_BINARY: custom }, opts(join(dir, "pkg")))).toEqual({
      ok: true,
      path: custom,
      from: "env",
    });
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

describe("the platform packages", () => {
  const manifest = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"));
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speech-platform-"));
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
    expect(Object.keys(optionalDependencies(manifest.name, manifest.version))).toEqual(
      TARGETS.map((t) => platformPackage(t.os as NodeJS.Platform, t.cpu)),
    );
  });

  it("are stamped into the main manifest at its version, not committed there", () => {
    expect(manifest.optionalDependencies).toBeUndefined();
    expect(stampProblem(manifest)).toMatch(/pi-speech-linux-x64 must be .*, is missing/);
    const stamped = stamp(manifest);
    expect(stampProblem(stamped)).toBeUndefined();
    expect(Object.values(stamped.optionalDependencies)).toEqual(TARGETS.map(() => manifest.version));
    expect(stampProblem({ ...stamped, version: "9.9.9" })).toMatch(/must be 9\.9\.9, is /);
    const extra = {
      ...stamped,
      optionalDependencies: { ...stamped.optionalDependencies, [`${manifest.name}-sunos-x64`]: manifest.version },
    };
    expect(stampProblem(extra)).toMatch(/sunos-x64 is not a platform package/);
  });

  it("are generated with os, cpu, the main package's identity, and the binary in bin/", () => {
    const binary = join(dir, "pi-speech-receiver.exe");
    writeFileSync(binary, "MZ");
    const built = buildPlatformPackage({ target: "win32-x64", binary, out: join(dir, "out"), manifest });
    const pkg = JSON.parse(readFileSync(join(built.dir, "package.json"), "utf8"));
    expect(pkg).toMatchObject({
      name: "@jangmanj/pi-speech-win32-x64",
      version: manifest.version,
      os: ["win32"],
      cpu: ["x64"],
      license: manifest.license,
      repository: manifest.repository,
    });
    expect(pkg.libc).toBeUndefined();
    expect(readFileSync(built.binary, "utf8")).toBe("MZ");
    expect(() => buildPlatformPackage({ target: "linux-x64", binary, out: join(dir, "x"), manifest })).toThrow(
      /must be named pi-speech-receiver/,
    );
    expect(() => buildPlatformPackage({ target: "sunos-x64", binary, out: join(dir, "x"), manifest })).toThrow(
      /unknown target/,
    );
  });

  it.skipIf(onWindows)("carry an executable binary that findBinary takes", () => {
    const binary = join(dir, "pi-speech-receiver");
    writeFileSync(binary, "#!/bin/sh\n");
    const built = buildPlatformPackage({ target: "linux-arm64", binary, out: join(dir, "pkg"), manifest });
    const pkg = JSON.parse(readFileSync(join(built.dir, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ os: ["linux"], cpu: ["arm64"], libc: ["glibc"] });
    expect(statSync(built.binary).mode & 0o111).toBe(0o111);
    const found = findBinary(
      {},
      {
        root: join(dir, "root"),
        platform: "linux",
        arch: "arm64",
        packageDir: (name) => (name === built.name ? built.dir : undefined),
      },
    );
    expect(found).toEqual({ ok: true, path: built.binary, from: "package" });
  });
});

describe("in this checkout", () => {
  it("finds the binary built in receiver/target when there is one", () => {
    const r = findBinary({});
    if (r.ok) expect(r.path).toMatch(/receiver[\\/]target[\\/](release|debug)[\\/]pi-speech-receiver/);
    else expect(r.reason).toMatch(/not installed/);
  });
});
