/**
 * Hand a dictation transcript to a user-defined command. The text is given three safe ways: on the command's
 * stdin, as the environment variable DICTATION_TEXT, and in place of %s in the command (which expands to the
 * quoted variable, never the text itself, so nothing a person says can inject shell).
 */

import { spawn } from "node:child_process";
import { childEnv, type Env } from "./env";

export function runDictationOutput(command: string, text: string, env: Env, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = command.replace(/%s/g, '"$DICTATION_TEXT"');
    const child = spawn("sh", ["-c", script], {
      stdio: ["pipe", "ignore", "pipe"],
      env: { ...childEnv(env), DICTATION_TEXT: text },
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
    child.stdin?.end(text);
  });
}
