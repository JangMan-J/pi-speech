/** Bridge configuration from the environment: PI_SPEECH_BRIDGE_URL and the token. */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BridgeConfig } from "./client";

type Env = Record<string, string | undefined>;

export const DEFAULT_URL = "http://127.0.0.1:47613";

export function bridgeUrl(env: Env): string {
  return env.PI_SPEECH_BRIDGE_URL?.trim() || DEFAULT_URL;
}

/** Token from PI_SPEECH_BRIDGE_TOKEN, else the file PI_SPEECH_BRIDGE_TOKEN_FILE, else ~/.config/pi-speech/bridge.token. */
export function bridgeToken(env: Env): string {
  const direct = env.PI_SPEECH_BRIDGE_TOKEN?.trim();
  if (direct) return direct;
  const file = env.PI_SPEECH_BRIDGE_TOKEN_FILE || join(env.HOME || homedir(), ".config", "pi-speech", "bridge.token");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(
      `no bridge token: set PI_SPEECH_BRIDGE_TOKEN, or put it in ${file} (${code}; PI_SPEECH_BRIDGE_TOKEN_FILE names another file)`,
    );
  }
  const token = text.split(/\r?\n/)[0].trim();
  if (!token) throw new Error(`no bridge token: ${file} is empty`);
  return token;
}

export function bridgeConfig(env: Env): BridgeConfig {
  return { url: bridgeUrl(env), token: bridgeToken(env) };
}

/** Read lazily so a token file written after Pi started is picked up. */
export function lazyConfig(env: Env): () => BridgeConfig {
  return () => bridgeConfig(env);
}
