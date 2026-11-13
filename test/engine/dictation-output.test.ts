import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { outputCommand, runDictationOutput } from "../../src/engine/dictation-output";

describe.skipIf(process.platform === "win32")("the dictation output command", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "pi-speech-out-"));
    dirs.push(d);
    return d;
  };
  const env = {} as Record<string, string>;
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("gives the text to the command on stdin", async () => {
    const out = join(tmp(), "out");
    await runDictationOutput(`cat > "${out}"`, "hello world", env);
    expect(readFileSync(out, "utf8")).toBe("hello world");
  });

  it("gives the text as $DICTATION_TEXT", async () => {
    const out = join(tmp(), "out");
    await runDictationOutput(
      `printf '[%d]' "$DICTATION_TEXT" 2>/dev/null; echo "$DICTATION_TEXT" > "${out}"`,
      "hi there",
      env,
    );
    expect(readFileSync(out, "utf8").trim()).toBe("hi there");
  });

  it("substitutes %s with the text, as one argument", async () => {
    const out = join(tmp(), "out");
    await runDictationOutput(`echo %s > "${out}"`, "spaced out words", env);
    expect(readFileSync(out, "utf8").trim()).toBe("spaced out words");
  });

  it("keeps text with shell metacharacters literal — a transcript cannot inject a command", async () => {
    const dir = tmp();
    const marker = join(dir, "pwned");
    const out = join(dir, "out");
    await runDictationOutput(`echo %s > "${out}"`, `; touch ${marker}`, env);
    expect(readFileSync(out, "utf8").trim()).toBe(`; touch ${marker}`);
    expect(existsSync(marker)).toBe(false); // the injected command never ran
  });

  it("a command that exits without reading its stdin is no failure", async () => {
    // It took the text as %s or $DICTATION_TEXT. The write to its stdin then fails now and then (EPIPE: about
    // once in 400 runs on a quiet machine, far more often on a loaded one) and must not surface as an error.
    for (let i = 0; i < 50; i++) await runDictationOutput("exit 0", "some words", env);
  });

  it("rejects with the command's stderr when it fails", async () => {
    await expect(runDictationOutput("echo boom >&2; exit 3", "x", env)).rejects.toThrow(/boom/);
  });

  it("rejects when the command times out", async () => {
    await expect(runDictationOutput("sleep 5", "x", env, 50)).rejects.toThrow(/timed out/);
  });
});

describe("how the dictation output command is run", () => {
  it("on Unix by sh, %s standing for the quoted variable", () => {
    expect(outputCommand("notify-send %s", "linux")).toEqual(["sh", ["-c", 'notify-send "$DICTATION_TEXT"']]);
  });

  it("on Windows by PowerShell 7 when installed, else Windows PowerShell; %s is the variable, read at run time", () => {
    const args = ["-NoProfile", "-NonInteractive", "-Command", "Set-Clipboard $env:DICTATION_TEXT"];
    expect(outputCommand("Set-Clipboard %s", "win32", () => true)).toEqual(["pwsh.exe", args]);
    expect(outputCommand("Set-Clipboard %s", "win32", () => false)).toEqual(["powershell.exe", args]);
  });
});
