/** The process environment pi-speech reads, and helpers over it. */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

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

/** Path of an executable: a name with a slash is checked as is, a bare name is looked up on PATH. */
export function findExecutable(name: string, env: Env): string | undefined {
  if (name.includes("/")) return isExecutable(name) ? name : undefined;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
