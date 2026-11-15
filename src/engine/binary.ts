/**
 * The bundled binary (`pi-speech-receiver`, built from receiver/): it plays a Stream (`play`) and records
 * the microphone (`record`) on this machine with its own audio engine, so no other audio program is needed.
 * Every system's binary is packed in this package under `bin/<platform>-<arch>/`; the one for this machine is
 * picked at runtime. Found, in order:
 *   1. `PI_SPEECH_BINARY`: an explicit path (or a name looked up on PATH); when set it must be an executable.
 *   2. The packaged location: `bin/<platform>-<arch>/`, then `bin/` in this package.
 *   3. In a checkout: `receiver/target/release`, then `receiver/target/debug`.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Env, findExecutable } from "./env";

export const BINARY_ENV = "PI_SPEECH_BINARY";
export const BINARY_NAME = "pi-speech-receiver";

export type BinaryChoice =
  | { ok: true; path: string; from: "env" | "package" | "checkout" }
  /** `chosen`: `PI_SPEECH_BINARY` names it, so nothing else may take its place. */
  | { ok: false; reason: string; chosen?: boolean };

export interface BinaryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** The package root (the directory holding package.json and receiver/). */
  root?: string;
}

/** This package's root: src/engine/ is two levels below it. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Where the bundled binary is, or why there is none; see the module comment for the order. */
export function findBinary(env: Env, opts: BinaryOptions = {}): BinaryChoice {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const root = opts.root ?? ROOT;
  const file = platform === "win32" ? `${BINARY_NAME}.exe` : BINARY_NAME;
  const at = (path: string) => findExecutable(path, env, platform);

  const custom = env[BINARY_ENV];
  if (custom) {
    const path = findExecutable(custom, env, platform);
    return path
      ? { ok: true, path, from: "env" }
      : { ok: false, reason: `${BINARY_ENV} (${custom}) is not an executable`, chosen: true };
  }
  for (const p of [join(root, "bin", `${platform}-${arch}`, file), join(root, "bin", file)]) {
    const path = at(p);
    if (path) return { ok: true, path, from: "package" };
  }
  for (const profile of ["release", "debug"]) {
    const path = at(join(root, "receiver", "target", profile, file));
    if (path) return { ok: true, path, from: "checkout" };
  }
  return {
    ok: false,
    reason: `the bundled ${BINARY_NAME} is not installed (set ${BINARY_ENV}, or build it with cargo build --release in receiver/)`,
  };
}
