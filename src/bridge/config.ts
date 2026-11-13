/**
 * Bridge configuration: the receiver's address (the one saved in Bridge connection's Pairing, else
 * PI_SPEECH_BRIDGE_URL, else the ssh forward at 127.0.0.1:47613 and the spare forwards after it) and the token.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BridgeConfig } from "./client";

type Env = Record<string, string | undefined>;

export const DEFAULT_PORT = 47613;
export const DEFAULT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;
/** The spare ports `pi-speech-receiver ssh` forwards, one per session, tried after 47613. */
export const SPARE_PORTS: readonly number[] = Array.from({ length: 20 }, (_, i) => DEFAULT_PORT + 1 + i);

export function bridgeUrl(env: Env): string {
  return env.PI_SPEECH_BRIDGE_URL?.trim() || DEFAULT_URL;
}

/** Where the receiver is, without the token. `from` says where the address came from. */
export interface BridgeTarget {
  url: string;
  ports?: number[];
  network?: boolean;
  from: "pairing" | "env" | "default";
}

/**
 * An address as the user types it (`host:port`, `host`, `[::1]:47613`, or an http URL) as a base URL; the port
 * is 47613 when it has none. Throws a readable Error for anything else.
 */
export function addressUrl(address: string): string {
  const a = address.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(a) ? a : `http://${a}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`not an address: ${a} (use host:port, such as 100.64.0.2:47613)`);
  }
  if (u.protocol !== "http:") throw new Error(`the bridge is plain http, not ${u.protocol}//`);
  if (!u.hostname || u.username || u.password || (u.pathname !== "/" && u.pathname !== "")) {
    throw new Error(`not an address: ${a} (use host:port, such as 100.64.0.2:47613)`);
  }
  if (!u.port) u.port = String(DEFAULT_PORT);
  return u.origin;
}

/** The host:port of a base URL, as the panel shows it. */
export function addressOf(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || 80}`;
}

/** Where the receiver is: a saved address, else PI_SPEECH_BRIDGE_URL, else 127.0.0.1:47613 and the spare ports. */
export function bridgeTarget(env: Env, address?: string): BridgeTarget {
  if (address?.trim()) return { url: addressUrl(address), network: true, from: "pairing" };
  const url = env.PI_SPEECH_BRIDGE_URL?.trim();
  if (url) return { url, from: "env" };
  return { url: DEFAULT_URL, ports: [...SPARE_PORTS], from: "default" };
}

/** The token file: PI_SPEECH_BRIDGE_TOKEN_FILE, else ~/.config/pi-speech/bridge.token. */
export function bridgeTokenFile(env: Env): string {
  return env.PI_SPEECH_BRIDGE_TOKEN_FILE || join(env.HOME || homedir(), ".config", "pi-speech", "bridge.token");
}

/** Token from PI_SPEECH_BRIDGE_TOKEN, else the file PI_SPEECH_BRIDGE_TOKEN_FILE, else ~/.config/pi-speech/bridge.token. */
export function bridgeToken(env: Env): string {
  const direct = env.PI_SPEECH_BRIDGE_TOKEN?.trim();
  if (direct) return direct;
  const file = bridgeTokenFile(env);
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

/** Save a token from pairing as the token file (mode 0600, its directory 0700), whole or not at all; its path. */
export function saveBridgeToken(env: Env, token: string): string {
  const file = bridgeTokenFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

export function bridgeConfig(env: Env, address?: string): BridgeConfig {
  const { from: _from, ...target } = bridgeTarget(env, address);
  return { ...target, token: bridgeToken(env) };
}

/** Read lazily so a token file written after Pi started is picked up. */
export function lazyConfig(env: Env): () => BridgeConfig {
  return () => bridgeConfig(env);
}
