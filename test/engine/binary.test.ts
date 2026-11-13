import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("in this checkout", () => {
  it("finds the binary built in receiver/target when there is one", () => {
    const r = findBinary({});
    if (r.ok) expect(r.path).toMatch(/receiver[\\/]target[\\/](release|debug)[\\/]pi-speech-receiver/);
    else expect(r.reason).toMatch(/not installed/);
  });
});
