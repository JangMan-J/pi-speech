import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDictationOutput } from "../../src/engine/dictation-output";

describe("the dictation output command", () => {
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

  it("rejects with the command's stderr when it fails", async () => {
    await expect(runDictationOutput("echo boom >&2; exit 3", "x", env)).rejects.toThrow(/boom/);
  });

  it("rejects when the command times out", async () => {
    await expect(runDictationOutput("sleep 5", "x", env, 50)).rejects.toThrow(/timed out/);
  });
});
