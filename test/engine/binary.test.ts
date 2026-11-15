import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { binaryFile, bundleBinaries, TARGETS } from "../../npm/platforms.mjs";
import { findBinary } from "../../src/engine/binary";

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
    expect(findBinary({}, opts())).toEqual({ ok: true, path: debug, from: "checkout" });
    const release = exe("root", "receiver", "target", "release", "pi-speech-receiver");
    expect(findBinary({}, opts())).toEqual({ ok: true, path: release, from: "checkout" });
    const bin = exe("root", "bin", "pi-speech-receiver");
    expect(findBinary({}, opts())).toEqual({ ok: true, path: bin, from: "package" });
    const platformBin = exe("root", "bin", "linux-x64", "pi-speech-receiver");
    expect(findBinary({}, opts())).toEqual({ ok: true, path: platformBin, from: "package" });
    const custom = exe("elsewhere", "my-receiver");
    expect(findBinary({ PI_SPEECH_BINARY: custom }, opts())).toEqual({ ok: true, path: custom, from: "env" });
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
});

describe("in this checkout", () => {
  it("finds the binary built in receiver/target when there is one", () => {
    const r = findBinary({});
    if (r.ok) expect(r.path).toMatch(/receiver[\\/]target[\\/](release|debug)[\\/]pi-speech-receiver/);
    else expect(r.reason).toMatch(/not installed/);
  });
});
