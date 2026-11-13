/**
 * Hand a dictation transcript to a user-defined command, run by sh (PowerShell on Windows). The text is given
 * three safe ways: on the command's stdin, as the environment variable DICTATION_TEXT, and in place of %s in the
 * command (which expands to the variable, never the text itself, so nothing a person says can inject a command).
 */

import { spawn } from "node:child_process";
import { childEnv, type Env } from "./env";

/**
 * The program and arguments that run `command`: sh on Unix, PowerShell on Windows. Both read %s's variable when
 * the command runs, so dictated text is never parsed as part of it (cmd.exe would paste it in first).
 */
export function outputCommand(command: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === "win32") {
    const script = command.replace(/%s/g, "$env:DICTATION_TEXT");
    return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]];
  }
  return ["sh", ["-c", command.replace(/%s/g, '"$DICTATION_TEXT"')]];
}

export function runDictationOutput(command: string, text: string, env: Env, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, args] = outputCommand(command);
    const child = spawn(bin, args, {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...childEnv(env), DICTATION_TEXT: text },
      windowsHide: true,
    });
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the command timed out"));
    }, timeoutMs);
    timer.unref?.();
    child.stderr?.on("data", (d) => {
      err += String(d);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `the command exited with code ${code ?? "unknown"}`));
    });
    // A command that takes the text as %s or $DICTATION_TEXT may exit without reading its stdin; the write
    // then fails (EPIPE), which is no failure of the command.
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}
