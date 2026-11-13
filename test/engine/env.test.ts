import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findExecutable } from "../../src/engine/env";

describe("findExecutable", () => {
  let dir: string;
  const file = (name: string, mode = 0o755) => {
    const p = join(dir, name);
    writeFileSync(p, "");
    chmodSync(p, mode);
    return p;
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speech-env-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe.skipIf(process.platform === "win32")("on Unix", () => {
    it("finds a bare name on PATH and checks a path as given; both must be executable files", () => {
      const p = file("player");
      file("readonly", 0o644);
      mkdirSync(join(dir, "adir"), { mode: 0o755 });
      expect(findExecutable("player", { PATH: dir }, "linux")).toBe(p);
      expect(findExecutable(p, { PATH: "" }, "linux")).toBe(p);
      expect(findExecutable("readonly", { PATH: dir }, "linux")).toBeUndefined();
      expect(findExecutable("adir", { PATH: dir }, "linux")).toBeUndefined();
      expect(findExecutable("missing", { PATH: dir }, "linux")).toBeUndefined();
    });
  });

  describe("on Windows", () => {
    it("finds a bare name with the program extensions of PATHEXT, on a PATH split at semicolons", () => {
      const p = file("player.EXE");
      const env = { PATH: `C:\\nowhere;${dir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      expect(findExecutable("player", env, "win32")).toBe(p);
      expect(findExecutable("player.EXE", env, "win32")).toBe(p);
    });

    it("never takes a .cmd or .bat script, which Node cannot start without a shell", () => {
      file("script.cmd");
      file("other.bat");
      const env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
      expect(findExecutable("script", env, "win32")).toBeUndefined();
      expect(findExecutable("other.bat", env, "win32")).toBeUndefined();
      expect(findExecutable(join(dir, "script.cmd"), env, "win32")).toBeUndefined();
    });

    it("checks a path as given, with or without its extension; a file there is enough (no execute bit)", () => {
      const p = file("rec.exe", 0o644);
      expect(findExecutable(p, { PATH: "" }, "win32")).toBe(p);
      expect(findExecutable(join(dir, "rec"), { PATH: "" }, "win32")).toBe(p);
      expect(findExecutable(join(dir, "missing"), { PATH: "" }, "win32")).toBeUndefined();
    });

    it("uses .COM and .EXE when PATHEXT is not set", () => {
      const p = file("tool.exe");
      expect(findExecutable("tool", { PATH: dir }, "win32")).toBe(p);
    });
  });
});
