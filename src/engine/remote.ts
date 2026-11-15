/**
 * The Remote machine over SSH, from a Pi session on this machine: Connect in the settings panel.
 *
 * One SSH master connection (OpenSSH ControlMaster on a private socket) is made to the destination the user
 * names (a Host of ~/.ssh/config, or user@host), authenticating with keys or the agent, or with a password asked
 * in the panel (handed to ssh through SSH_ASKPASS, never written down); a host key not yet known is shown and
 * trusted only when the user says so. Over that connection:
 * - `pi-speech-receiver` is found there (on PATH or in ~/.local/bin); when it is missing, or too old to hold a
 *   lease, the one for that machine's system is copied to ~/.local/bin, once the user agrees;
 * - `pi-speech-receiver lease` runs there: it joins that machine's shared receiver (starting it), says its port
 *   and token, and holds it while this connection lives; the receiver stops once the last Pi talking to it is gone;
 * - a local port is forwarded to the receiver's port, so the bridge talks to 127.0.0.1.
 *
 * Every remote command goes through `sh -c`, whatever the login shell there (fish, for one, is not sh).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createReadStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface RemotePrompts {
  /** The password for `who`; undefined when the user does not give one. */
  password(who: string): Promise<string | undefined>;
  /** Whether the user agrees to `question`. */
  confirm(question: string): Promise<boolean>;
  /** What is happening now, for the status line. */
  progress(text: string): void;
}

export interface RemoteLink {
  /** The destination, as the user named it. */
  readonly dest: string;
  /** Where the bridge reaches the receiver: `127.0.0.1:<forwarded port>`. */
  readonly address: string;
  readonly token: string;
  /** The receiver's version there. */
  readonly version: string;
  /** The connection is up and the lease held. */
  alive(): boolean;
  /** Called once when the connection ends without close(). */
  onLost?: () => void;
  /** Give up the lease and close the connection. */
  close(): Promise<void>;
}

export interface ConnectOptions {
  env?: NodeJS.ProcessEnv;
  /** The bundled receiver for a system, `linux-x64` and so on; undefined when this install has none. */
  binaryFor(platform: string): string | undefined;
  /** The receiver version this extension carries, for the install prompt. */
  version?: string;
  signal?: AbortSignal;
}

export class RemoteError extends Error {
  override name = "RemoteError";
}

/** How long ssh tries to reach the machine. */
const CONNECT_TIMEOUT_S = 10;
/** How long the master stays after its last session (so a Pi gone without closing it does not leave it). */
const PERSIST_S = 15;
const RECEIVER = "pi-speech-receiver";

/** A word for `sh -c '…'`: single-quoted, so no shell there reads anything in it. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The Host names of ~/.ssh/config that name one machine (no patterns), in order. */
export function sshConfigHosts(home = homedir()): string[] {
  let text: string;
  try {
    text = readFileSync(join(home, ".ssh", "config"), "utf8");
  } catch {
    return [];
  }
  const hosts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*Host\s+(.+)$/i.exec(line);
    if (!m) continue;
    for (const h of m[1].split(/\s+/)) {
      if (h && !/[*?!]/.test(h) && !hosts.includes(h)) hosts.push(h);
    }
  }
  return hosts;
}

/** The system of `uname -sm` as the package names it (`linux-x64`); undefined for one it has no receiver for. */
export function platformOf(uname: string): string | undefined {
  const [os, cpu] = uname.trim().split(/\s+/);
  const o = { Linux: "linux", Darwin: "darwin" }[os ?? ""];
  const c = { x86_64: "x64", amd64: "x64", aarch64: "arm64", arm64: "arm64" }[cpu ?? ""];
  return o && c ? `${o}-${c}` : undefined;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: NodeJS.ProcessEnv, input?: string | NodeJS.ReadableStream): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    child.on("error", (e) => reject(new RemoteError(`cannot run ssh: ${e.message}`)));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.on("error", () => {});
    if (typeof input === "string") child.stdin.end(input);
    else if (input) input.pipe(child.stdin);
    else child.stdin.end();
  });
}

/** The last meaningful line ssh wrote to standard error. */
const sshWhy = (stderr: string) =>
  stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Warning: Permanently added/.test(l) && !/^Pseudo-terminal/.test(l))
    .at(-1) ?? "ssh failed";

/** A local port nobody listens on now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** A private directory for the control socket and the askpass helper; short, as socket paths must be. */
function privateDir(env: NodeJS.ProcessEnv): string {
  for (const base of [env.XDG_RUNTIME_DIR, "/tmp", tmpdir()]) {
    if (!base) continue;
    try {
      return mkdtempSync(join(base, "pi-ssh-"));
    } catch {
      /* the next */
    }
  }
  throw new RemoteError("cannot make a private directory for the SSH connection");
}

/**
 * Connect to `dest` and lease its receiver; see the module comment. Throws a RemoteError that says what failed
 * (in ssh's words where it gave any).
 */
export async function connectRemote(dest: string, prompts: RemotePrompts, opts: ConnectOptions): Promise<RemoteLink> {
  if (process.platform === "win32") {
    throw new RemoteError(
      "Connect over SSH needs OpenSSH with ControlMaster, which Windows lacks: pair by address instead",
    );
  }
  if (!dest.trim() || /^-/.test(dest.trim())) throw new RemoteError("name the machine: a Host or user@host");
  dest = dest.trim();
  const env = { ...(opts.env ?? process.env) };
  // Its effective configuration: whether ssh knows how to reach it, and its host and port for the host key.
  const g = await run(["-G", "--", dest], env);
  if (g.code !== 0) throw new RemoteError(`not a destination ssh can use: ${sshWhy(g.stderr)}`);
  const field = (k: string) => new RegExp(`^${k} (.+)$`, "m").exec(g.stdout)?.[1]?.trim();
  const host = field("hostname") ?? dest;
  const port = field("port") ?? "22";
  const user = field("user");
  const who = user ? `${user}@${host}` : host;

  const dir = privateDir(env);
  const sock = join(dir, "cm");
  const via = ["-S", sock, "-o", "ControlMaster=no"];
  let lease: ChildProcess | undefined;
  const cleanup = async () => {
    lease?.stdin?.end();
    lease?.kill();
    await run(["-S", sock, "-O", "exit", "--", dest], env).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    // ── The master connection ────────────────────────────────────────────
    const master = (extra: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      run(
        [
          "-M",
          "-S",
          sock,
          "-o",
          `ControlPersist=${PERSIST_S}`,
          "-o",
          `ConnectTimeout=${CONNECT_TIMEOUT_S}`,
          "-N",
          ...extra,
          "--",
          dest,
        ],
        { ...env, ...extraEnv },
      );
    prompts.progress(`… connecting to ${dest}`);
    let accept: string[] = [];
    let m = await master(["-o", "BatchMode=yes"]);
    if (
      m.code !== 0 &&
      /host key verification failed|no .*host key is known|host key for .* has changed/i.test(m.stderr)
    ) {
      if (/has changed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(m.stderr)) {
        throw new RemoteError(
          `${host}'s host key has changed since it was trusted: check it, then fix ~/.ssh/known_hosts`,
        );
      }
      const fp = await hostKeyFingerprints(host, port, env);
      const ok = await prompts.confirm(
        `${host} is not a known host. Trust its key${fp ? ` (${fp})` : ""} and connect?`,
      );
      if (!ok) throw new RemoteError(`not connected: ${host}'s host key was not trusted`);
      accept = ["-o", "StrictHostKeyChecking=accept-new"];
      m = await master(["-o", "BatchMode=yes", ...accept]);
    }
    if (m.code !== 0 && /permission denied|authentication/i.test(m.stderr)) {
      const pw = await prompts.password(who);
      if (pw === undefined) throw new RemoteError(`not connected: ${who} needs a password`);
      // The password goes to ssh through a helper that prints it from the environment of ssh alone.
      const askpass = join(dir, "askpass");
      writeFileSync(askpass, '#!/bin/sh\nprintf "%s\\n" "$PI_SPEECH_ASKPASS"\n', { mode: 0o700 });
      prompts.progress(`… signing in to ${who}`);
      m = await master(
        [
          ...accept,
          "-o",
          "BatchMode=no",
          "-o",
          "NumberOfPasswordPrompts=1",
          "-o",
          "PreferredAuthentications=keyboard-interactive,password",
        ],
        { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force", DISPLAY: env.DISPLAY ?? ":0", PI_SPEECH_ASKPASS: pw },
      );
      rmSync(askpass, { force: true });
      if (m.code !== 0 && /permission denied/i.test(m.stderr))
        throw new RemoteError(`not connected: the password for ${who} was refused`);
    }
    if (m.code !== 0) throw new RemoteError(`not connected to ${dest}: ${sshWhy(m.stderr)}`);
    opts.signal?.throwIfAborted();

    // ── The receiver there ───────────────────────────────────────────────
    const sh = (script: string, input?: string | NodeJS.ReadableStream) =>
      run([...via, "--", dest, `sh -c ${shQuote(script)}`], env, input);
    const find = await sh(
      `command -v ${RECEIVER} 2>/dev/null || { p="$HOME/.local/bin/${RECEIVER}"; [ -x "$p" ] && echo "$p"; }; echo "uname: $(uname -sm)"`,
    );
    const lines = find.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const uname = lines.find((l) => l.startsWith("uname: "))?.slice(7) ?? "";
    let path = lines.find((l) => !l.startsWith("uname: "));
    let canLease = false;
    if (path) {
      // A receiver that knows `lease` answers its usage for an argument it does not take; an older one does not.
      const probe = await sh(`${shQuote(path)} lease --probe`);
      canLease = /usage: pi-speech-receiver lease/.test(probe.stderr);
    }
    if (!path || !canLease) {
      const platform = platformOf(uname);
      const binary = platform ? opts.binaryFor(platform) : undefined;
      if (!platform || !binary) {
        throw new RemoteError(
          `${dest} has ${path ? "a pi-speech-receiver too old to connect to" : "no pi-speech-receiver"}, and this install has none for ${uname || "its system"}: install pi-speech there`,
        );
      }
      const size = statSync(binary).size;
      const mb = Math.round(size / 1e6);
      const ok = await prompts.confirm(
        `${dest} has ${path ? "an older pi-speech-receiver" : "no pi-speech-receiver"}. Install ${opts.version ? `version ${opts.version} ` : ""}for ${platform} in ~/.local/bin there (${mb} MB)?`,
      );
      if (!ok) throw new RemoteError(`not connected: ${dest} needs pi-speech-receiver`);
      prompts.progress(`… installing pi-speech-receiver on ${dest} (${mb} MB)`);
      const target = `$HOME/.local/bin/${RECEIVER}`;
      const put = await sh(
        `mkdir -p "$HOME/.local/bin" && cat > "${target}.new" && chmod 755 "${target}.new" && mv -f "${target}.new" "${target}" && echo "${target}"`,
        createReadStream(binary),
      );
      if (put.code !== 0) throw new RemoteError(`cannot install pi-speech-receiver on ${dest}: ${sshWhy(put.stderr)}`);
      path = put.stdout.trim().split(/\r?\n/).at(-1);
      if (!path) throw new RemoteError(`cannot install pi-speech-receiver on ${dest}`);
    }

    // ── The lease, and the forward ───────────────────────────────────────
    prompts.progress(`… starting the receiver on ${dest}`);
    const child = spawn("ssh", [...via, "--", dest, `sh -c ${shQuote(`exec ${shQuote(path)} lease`)}`], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    lease = child;
    child.stdin?.on("error", () => {});
    let leaseErr = "";
    child.stderr?.setEncoding("utf8").on("data", (d: string) => {
      leaseErr = (leaseErr + d).slice(-2000);
    });
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const rl = createInterface({ input: child.stdout! });
      const fail = (why: string) => reject(new RemoteError(why));
      rl.on("line", (line) => {
        let v: Record<string, unknown>;
        try {
          v = JSON.parse(line);
        } catch {
          return;
        }
        if (v.event === "ready") resolve(v);
        else if (v.event === "error") fail(`the receiver on ${dest} did not start: ${String(v.message)}`);
      });
      child.on("close", () => fail(`the receiver on ${dest} did not start: ${sshWhy(leaseErr)}`));
      child.on("error", (e) => fail(`cannot run ssh: ${e.message}`));
    });
    const remotePort = Number(ready.port);
    const token = String(ready.token ?? "");
    if (!remotePort || !token) throw new RemoteError(`the receiver on ${dest} gave no port or token`);
    const localPort = await freePort();
    const fwd = await run(
      ["-S", sock, "-O", "forward", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, "--", dest],
      env,
    );
    if (fwd.code !== 0) throw new RemoteError(`cannot forward a port to ${dest}: ${sshWhy(fwd.stderr)}`);

    let closed = false;
    const link: RemoteLink = {
      dest,
      address: `127.0.0.1:${localPort}`,
      token,
      version: String(ready.version ?? ""),
      alive: () => !closed && child.exitCode === null && child.signalCode === null,
      async close() {
        if (closed) return;
        closed = true;
        await cleanup();
      },
    };
    child.on("close", () => {
      if (closed) return;
      closed = true;
      void cleanup();
      link.onLost?.();
    });
    return link;
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** The fingerprints of `host`'s keys, as ssh-keygen shows them; empty when they cannot be read. */
async function hostKeyFingerprints(host: string, port: string, env: NodeJS.ProcessEnv): Promise<string> {
  const scan = await new Promise<string>((resolve) => {
    const c = spawn("ssh-keyscan", ["-p", port, "-t", "ed25519,ecdsa,rsa", host], { env, windowsHide: true });
    let out = "";
    c.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
    });
    c.on("error", () => resolve(""));
    c.on("close", () => resolve(out));
    setTimeout(() => c.kill(), CONNECT_TIMEOUT_S * 1000).unref();
  });
  if (!scan.trim()) return "";
  return new Promise((resolve) => {
    const c = spawn("ssh-keygen", ["-lf", "-"], { env, windowsHide: true });
    let out = "";
    c.stdout.setEncoding("utf8").on("data", (d: string) => {
      out += d;
    });
    c.on("error", () => resolve(""));
    c.on("close", () => {
      // "256 SHA256:abc… host (ED25519)": the first key's hash and type.
      const first = out.split(/\r?\n/).find(Boolean) ?? "";
      const m = /(SHA256:\S+).*\((\w+)\)/.exec(first);
      resolve(m ? `${m[2]} ${m[1]}` : "");
    });
    c.stdin.end(scan);
  });
}
