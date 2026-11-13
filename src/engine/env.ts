/** The process environment pi-speech reads, and helpers over it. */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

/** True when Pi runs over SSH: SSH_CONNECTION or SSH_TTY is set and not empty. */
export function overSsh(env: Env): boolean {
  return Boolean(env.SSH_CONNECTION?.trim() || env.SSH_TTY?.trim());
}

/** Environment for child processes: a player or recorder never gets the OpenRouter key or the bridge token. */
export function childEnv(env: Env): NodeJS.ProcessEnv {
  const { OPENROUTER_API_KEY: _key, PI_SPEECH_BRIDGE_TOKEN: _token, ...rest } = env;
  return rest as NodeJS.ProcessEnv;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/**
 * Path of an executable: a name with a path separator is checked as is, a bare name is looked up on PATH.
 * On Windows a program is a file with an extension from PATHEXT (default .COM;.EXE), the name taken with or
 * without it; .cmd and .bat scripts are never taken, since Node cannot start them without a shell.
 */
export function findExecutable(
  name: string,
  env: Env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") {
    if (name.includes("/")) return isExecutable(name) ? name : undefined;
    for (const dir of (env.PATH ?? "").split(":")) {
      if (!dir) continue;
      const p = join(dir, name);
      if (isExecutable(p)) return p;
    }
    return undefined;
  }
  const exts: string[] = (env.PATHEXT ?? ".COM;.EXE")
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e === ".exe" || e === ".com");
  const ext = /\.[^.\\/]+$/.exec(name)?.[0].toLowerCase();
  if (ext === ".cmd" || ext === ".bat") return undefined;
  // The file itself when it already has a program extension, else the name with each extension.
  const candidates = (base: string) =>
    ext && exts.includes(ext) ? [base] : exts.flatMap((e) => [base + e, base + e.toUpperCase()]);
  const find = (base: string) => candidates(base).find(isFile);
  if (/[\\/]/.test(name)) return find(name);
  for (const dir of (env.PATH ?? "").split(";")) {
    if (!dir) continue;
    const found = find(join(dir, name));
    if (found) return found;
  }
  return undefined;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
