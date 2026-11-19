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
import { createReadStream, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { isReceiverOutdated, parseReceiverVersion } from "./binary";
import { formatSize } from "./local-models";

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
  /** The receiver's version there (from /v1/health, or lease ready). */
  readonly version: string;
  /** The receiver's edition (`cpu` or `gpu`), when reported. */
  readonly edition?: "cpu" | "gpu";
  /** Whether the running receiver there is older than the extension's expected version. */
  readonly outdated?: boolean;
  /** The remote machine's system (`linux-x64`), when known. */
  readonly platform?: string;
  /** The connection is up and the lease held. */
  alive(): boolean;
  /** Called once when the connection ends without close(). */
  onLost?: () => void;
  /** Give up the lease and close the connection. */
  close(): Promise<void>;
}

export interface ConnectOptions {
  env?: NodeJS.ProcessEnv;
  /** Ensure the bundled or release receiver for `platform` (`linux-x64`) is on disk and return its path. */
  binaryFor(platform: string): Promise<string | undefined> | string | undefined;
  /** Whether a receiver is available (on disk or downloadable) for `platform` before fetching it. */
  hasBinaryFor?(platform: string): boolean;
  /** Expected download/install size in bytes for `platform`, for the install prompt. */
  binarySizeFor?(platform: string): number | undefined;
  /** The receiver version this extension carries, for verifying and updating the remote binary. */
  version?: string;
  /** Update an existing remote receiver without prompting (`force`), or prompt when outdated (default). */
  update?: boolean | "force";
  /** Target platform override when installing/updating a specific edition (e.g. `linux-x64-cuda13`). */
  targetOverride?: string;
  signal?: AbortSignal;
}

export type RemoteInstallPlan =
  | { action: "none" }
  | { action: "install"; reason: "missing" | "too-old" }
  | { action: "update"; reason: "outdated" | "forced"; confirm: boolean };

/**
 * Decide whether the remote receiver should be kept, installed (required), or updated (optional unless forced).
 */
export function planRemoteReceiver(opts: {
  hasPath: boolean;
  canLease: boolean;
  remoteVersion?: string;
  expectedVersion?: string;
  hasBinary: boolean;
  forceUpdate?: boolean;
}): RemoteInstallPlan {
  if (!opts.hasPath) return { action: "install", reason: "missing" };
  if (!opts.canLease) return { action: "install", reason: "too-old" };
  if (!opts.hasBinary) return { action: "none" };
  if (opts.forceUpdate) return { action: "update", reason: "forced", confirm: false };
  if (opts.expectedVersion && (!opts.remoteVersion || isReceiverOutdated(opts.remoteVersion, opts.expectedVersion))) {
    return { action: "update", reason: "outdated", confirm: true };
  }
  return { action: "none" };
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

/** Authenticate a private connection shared by the receiver connection and maintenance flows. */
async function openSsh(dest: string, prompts: RemotePrompts, opts: ConnectOptions, maintenance = false) {
  if (process.platform === "win32") {
    throw new RemoteError(
      "Receiver SSH needs OpenSSH with ControlMaster, which Windows lacks: pair by address instead",
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
  const effectiveHost = port === "22" ? host : `${host.includes(":") ? `[${host}]` : host}:${port}`;
  const who = user ? `${user}@${effectiveHost}` : effectiveHost;

  const dir = privateDir(env);
  const sock = join(dir, "cm");
  const transport = maintenance ? ["-T", "-o", "ClearAllForwardings=yes"] : [];
  // With no control socket, maintenance commands must fail, not open a new SSH session.
  const via = [
    "-S",
    sock,
    "-o",
    "ControlMaster=no",
    ...transport,
    ...(maintenance ? ["-o", "ProxyCommand=false"] : []),
  ];
  const close = async () => {
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
          ...transport,
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

    const sh = (script: string, input?: string | NodeJS.ReadableStream) =>
      run([...via, "--", dest, `sh -c ${shQuote(script)}`], env, input);
    return { dest, who, env, sock, via, sh, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Connect to `dest`, lease its receiver, and open the audio bridge. */
export async function connectRemote(dest: string, prompts: RemotePrompts, opts: ConnectOptions): Promise<RemoteLink> {
  const ssh = await openSsh(dest, prompts, opts);
  dest = ssh.dest;
  const { sh, env, sock, via } = ssh;
  let lease: ChildProcess | undefined;
  const cleanup = async () => {
    lease?.stdin?.end();
    lease?.kill();
    await ssh.close();
  };
  try {
    const find = await sh(
      `command -v ${RECEIVER} 2>/dev/null || { p="$HOME/.local/bin/${RECEIVER}"; [ -x "$p" ] && echo "$p"; }; echo "uname: $(uname -sm)"`,
    );
    const lines = find.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const uname = lines.find((l) => l.startsWith("uname: "))?.slice(7) ?? "";
    const platform = platformOf(uname);
    let path = lines.find((l) => !l.startsWith("uname: "));
    let canLease = false;
    let remoteVersion: string | undefined;
    if (path) {
      // A receiver that knows `lease` answers its usage for an argument it does not take; an older one does not.
      // Check `--version` in the same round-trip (older binaries exit non-zero and print nothing to stdout).
      const probe = await sh(
        `${shQuote(path)} lease --probe 2>&1; printf '\\n__VER__:'; ${shQuote(path)} --version 2>/dev/null || true`,
      );
      canLease = /usage: pi-speech-receiver lease/.test(probe.stdout);
      const verPart = probe.stdout.split("__VER__:")[1]?.trim() ?? "";
      remoteVersion = parseReceiverVersion(verPart);
    }
    const targetPlatform = (opts.targetOverride ?? platform) || undefined;
    let binary = targetPlatform && !opts.hasBinaryFor ? await opts.binaryFor(targetPlatform) : undefined;
    const hasBinary = targetPlatform ? (opts.hasBinaryFor ? opts.hasBinaryFor(targetPlatform) : !!binary) : false;
    const plan = planRemoteReceiver({
      hasPath: !!path,
      canLease,
      remoteVersion,
      expectedVersion: opts.version,
      hasBinary,
      forceUpdate: opts.update === "force",
    });
    if (plan.action === "install" && (!targetPlatform || !hasBinary)) {
      throw new RemoteError(
        `${dest} has ${path ? "a pi-speech-receiver too old to connect to" : "no pi-speech-receiver"}, and this install has none for ${uname || "its system"}: install pi-speech there`,
      );
    }
    let updated = false;
    if (plan.action !== "none" && targetPlatform && hasBinary) {
      const knownBytes = opts.binarySizeFor?.(targetPlatform);
      const sizeNote = knownBytes ? ` (${Math.round(knownBytes / 1e6)} MB)` : "";
      let ok = true;
      if (plan.action === "install") {
        ok = await prompts.confirm(
          `${dest} has ${path ? "an older pi-speech-receiver" : "no pi-speech-receiver"}. Install ${opts.version ? `version ${opts.version} ` : ""}for ${targetPlatform} in ~/.local/bin there${sizeNote}?`,
        );
        if (!ok) throw new RemoteError(`not connected: ${dest} needs pi-speech-receiver`);
      } else if (plan.confirm) {
        const current = remoteVersion ?? "an older build";
        ok = await prompts.confirm(
          `${dest} has pi-speech-receiver ${current}${opts.version ? ` (this extension carries ${opts.version})` : ""}. Update it in ~/.local/bin there${sizeNote}?`,
        );
      }
      if (ok) {
        if (!binary) {
          prompts.progress(`… fetching pi-speech-receiver for ${targetPlatform}`);
          binary = await opts.binaryFor(targetPlatform);
          if (!binary) {
            if (plan.action === "install") {
              throw new RemoteError(`cannot obtain pi-speech-receiver for ${targetPlatform}`);
            }
          }
        }
        if (binary) {
          // The binary and the shared libraries beside it (Linux x64 carries sherpa-onnx's and ONNX Runtime's),
          // installed together in ~/.local/lib/pi-speech-receiver, the binary linked from ~/.local/bin: it finds
          // the libraries beside its real path.
          const files = [binary, ...libraries(binary)];
          const size = files.reduce((n, f) => n + statSync(f).size, 0);
          const mb = Math.round(size / 1e6);
          prompts.progress(
            `… ${plan.action === "update" ? "updating" : "installing"} pi-speech-receiver on ${dest} (${mb} MB)`,
          );
          const home = `$HOME/.local/lib/${RECEIVER}`;
          await transferReceiver(sh, binary, `"${home}"`);
          const target = `$HOME/.local/bin/${RECEIVER}`;
          const link = await sh(
            `mkdir -p "$HOME/.local/bin" && ln -sf "${home}/${basename(binary)}" "${target}" && echo "${target}"`,
          );
          if (link.code !== 0)
            throw new RemoteError(`cannot install pi-speech-receiver on ${dest}: ${sshWhy(link.stderr)}`);
          path = link.stdout.trim().split(/\r?\n/).at(-1);
          if (!path) throw new RemoteError(`cannot install pi-speech-receiver on ${dest}`);
          updated = true;
        }
      }
    }
    if (updated) {
      // Give a just-released shared receiver a moment to exit before starting lease on the new binary.
      await sh(
        'i=0; while [ -e "$HOME/.config/pi-speech/receiver.port" ] && [ "$i" -lt 6 ]; do sleep 0.1; i=$((i+1)); done',
      ).catch(() => {});
    }

    // ── The lease, and the forward ───────────────────────────────────────
    prompts.progress(`… starting the receiver on ${dest}`);
    const child = spawn("ssh", [...via, "--", dest, `sh -c ${shQuote(`exec ${shQuote(path!)} lease`)}`], {
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

    // Read the running shared receiver's version and edition from /v1/health.
    let runningVersion = String(ready.version ?? "");
    let runningEdition: "cpu" | "gpu" | undefined =
      ready.edition === "cpu" || ready.edition === "gpu" ? ready.edition : undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${localPort}/v1/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const h = (await res.json()) as { version?: unknown; edition?: unknown };
        if (typeof h.version === "string" && h.version) runningVersion = h.version;
        if (h.edition === "cpu" || h.edition === "gpu") runningEdition = h.edition;
      }
    } catch {
      /* keep lease ready version */
    }
    const outdated = opts.version ? isReceiverOutdated(runningVersion || remoteVersion, opts.version) : false;

    let closed = false;
    const link: RemoteLink = {
      dest,
      address: `127.0.0.1:${localPort}`,
      token,
      version: runningVersion,
      ...(runningEdition ? { edition: runningEdition } : {}),
      outdated,
      platform,
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

type Ssh = Awaited<ReturnType<typeof openSsh>>;

/** `dir` is a shell-quoted path or a trusted shell expansion. Transfer libraries before the executable. */
async function transferReceiver(sh: Ssh["sh"], binary: string, dir: string): Promise<void> {
  for (const file of [...libraries(binary), binary]) {
    const path = `${dir}/${shQuote(basename(file))}`;
    const temp = `${path}.new`;
    const mode = file === binary ? 755 : 644;
    const r = await sh(
      `mkdir -p ${dir} && cat > ${temp} && chmod ${mode} ${temp} && mv -f ${temp} ${path}`,
      createReadStream(file),
    );
    if (r.code !== 0) throw new RemoteError(`cannot transfer ${basename(file)}: ${sshWhy(r.stderr)}`);
  }
}

const RECEIVER_UNIT = `${RECEIVER}.service`;
const unitProperty = [
  "Id",
  "LoadState",
  "ActiveState",
  "Type",
  "User",
  "MainPID",
  "ExecStart",
  "ExecStartPre",
  "ExecStartPost",
  "ExecStop",
  "ExecStopPost",
];
const userSystemctl = `systemctl --user`;

function serverCommand(command: string | undefined, expectedPath: string): boolean {
  const match = /^\{ path=(.+?) ; argv\[\]=(.*?) ; [^{}]*\}$/.exec(command ?? "");
  if (match?.[1] !== expectedPath || !match[2].startsWith(expectedPath)) return false;
  const args = match[2].slice(expectedPath.length);
  if (args && !args.startsWith(" ")) return false;
  return /^(?:serve(?: |$))?(?:(?:--network|--(?:listen|token-file)(?:=| )[\w./:[\]%-]+)(?: |$))*$/.test(args.trim());
}

/** Interpret systemctl's effective unit, never shell-evaluating its reported command. */
export function readReceiverService(output: string, path: string) {
  const fields = Object.fromEntries(
    output
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
  if (fields.Id !== RECEIVER_UNIT || !fields.LoadState) {
    throw new RemoteError("cannot identify the systemd user receiver service");
  }
  if (fields.LoadState === "not-found") return { exists: false, active: false, pid: 0 };
  if (
    fields.LoadState !== "loaded" ||
    !["simple", "exec"].includes(fields.Type ?? "") ||
    fields.User ||
    fields.ExecStartPre ||
    fields.ExecStartPost ||
    fields.ExecStop ||
    fields.ExecStopPost ||
    !serverCommand(fields.ExecStart, path)
  ) {
    throw new RemoteError(`refusing to change ${RECEIVER_UNIT}: expected a user service that runs ${path} directly`);
  }
  if (!["active", "inactive", "failed"].includes(fields.ActiveState ?? "")) {
    throw new RemoteError(`${RECEIVER_UNIT} is ${fields.ActiveState ?? "changing state"}; try again when it settles`);
  }
  const active = fields.ActiveState === "active";
  const pid = Number(fields.MainPID);
  if (active && (!Number.isSafeInteger(pid) || pid < 1)) throw new RemoteError("cannot identify the running receiver");
  return { exists: true, active, pid, command: fields.ExecStart };
}

async function receiverService(sh: Ssh["sh"], path: string) {
  const report = await sh(`${userSystemctl} show ${RECEIVER_UNIT} ${unitProperty.map((p) => `-p ${p}`).join(" ")}`);
  if (report.code !== 0)
    throw new RemoteError(`cannot inspect the systemd user receiver service: ${sshWhy(report.stderr)}`);
  return readReceiverService(report.stdout, path);
}

async function receiverVersion(sh: Ssh["sh"], path: string): Promise<string | undefined> {
  const r = await sh(`${shQuote(path)} --version`);
  return r.code === 0 ? parseReceiverVersion(r.stdout) : undefined;
}

async function runningReceiverVersion(sh: Ssh["sh"], pid: number, home: string, path: string) {
  const proc = `/proc/${pid}/exe`;
  const r = await sh(`readlink ${proc} && readlink -f ${shQuote(path)}`);
  const [live, disk] = r.stdout.trim().split(/\r?\n/);
  const exe = live?.replace(/ \(deleted\)$/, "");
  const lib = `${home}/.local/lib/${RECEIVER}`;
  const suffix = exe?.startsWith(`${lib}.`) ? exe.slice(lib.length + 1) : "";
  if (
    !exe ||
    (exe !== disk && exe !== path && exe !== `${lib}/${RECEIVER}` && !/^[a-z0-9]{6}\/pi-speech-receiver$/i.test(suffix))
  ) {
    throw new RemoteError("the running service does not point to the expected receiver executable");
  }
  return receiverVersion(sh, proc);
}

/** A host CUDA probe is not the installed edition: inspect the installed provider for its CUDA major. */
async function receiverTarget(sh: Ssh["sh"], path: string, platform: string): Promise<string> {
  const gpu = await sh(`${shQuote(path)} gpu`);
  let info: { edition?: string; why?: string } | undefined;
  try {
    if (gpu.code === 0) info = JSON.parse(gpu.stdout);
  } catch {
    /* diagnosed below */
  }
  if (info?.edition === "cpu" || info?.why === "this build of pi-speech-receiver runs models on the CPU only")
    return platform;
  if (info?.edition === "gpu") {
    const deps = await sh(
      `dir=$(dirname "$(readlink -f ${shQuote(path)})") && readelf -d "$dir/libonnxruntime_providers_cuda.so"`,
    );
    const majors = new Set(Array.from(deps.stdout.matchAll(/\[libcudart\.so\.(12|13)(?:\.\d+)*\]/g), (m) => m[1]));
    if (deps.code === 0 && majors.size === 1) return `${platform}-cuda${[...majors][0]}`;
  }
  throw new RemoteError("cannot verify the installed receiver edition; refusing to switch it during an update");
}

const STARTUP_UNIT = `[Unit]
Description=Pi Speech receiver
After=pipewire.service pipewire-pulse.service

[Service]
ExecStart="%h/.local/bin/${RECEIVER}" serve --listen 127.0.0.1:47613
Restart=on-failure

[Install]
WantedBy=default.target
`;

/** Maintain the user service over SSH without taking a lease or changing the existing bridge. */
export async function manageRemoteReceiver(
  dest: string,
  action: "update" | "restart",
  prompts: RemotePrompts,
  opts: ConnectOptions,
): Promise<{ action: "installed" | "updated" | "restarted" | "current" | "cancelled"; version?: string }> {
  const { sh, who, close } = await openSsh(dest, prompts, opts, true);
  const checked = async (script: string, why: string, input?: string) => {
    const r = await sh(script, input);
    if (r.code !== 0) throw new RemoteError(`${why} on ${who}: ${sshWhy(r.stderr)}`);
    return r.stdout.trim();
  };
  try {
    const [system, home] = (await checked(`uname -sm && printf '%s\\n' "$HOME"`, "cannot identify the SSH host")).split(
      /\r?\n/,
    );
    const platform = platformOf(system ?? "");
    if (!platform?.startsWith("linux-") || !home?.startsWith("/")) {
      throw new RemoteError("Manage over SSH supports Linux receiver hosts with a systemd user service");
    }
    const path = `${home}/.local/bin/${RECEIVER}`;
    const qPath = shQuote(path);
    const unit = await receiverService(sh, path);
    const onDisk = (await sh(`test -x ${qPath}`)).code === 0;
    if (unit.active && !onDisk)
      throw new RemoteError(`the running service on ${who} has no installed executable to verify`);
    const diskVersion = onDisk ? await receiverVersion(sh, path) : undefined;
    const runningVersion = unit.active ? await runningReceiverVersion(sh, unit.pid, home, path) : undefined;
    const verifyUnchanged = async () => {
      const now = await receiverService(sh, path);
      if (
        now.exists !== unit.exists ||
        now.command !== unit.command ||
        now.active !== unit.active ||
        now.pid !== unit.pid
      ) {
        throw new RemoteError("the receiver service changed while waiting; reopen Manage over SSH and try again");
      }
    };
    const restart = async (expected?: string) => {
      prompts.progress(`… ${unit.active ? "restarting" : "starting"} the receiver on ${who}`);
      await checked(`${userSystemctl} restart ${RECEIVER_UNIT}`, "cannot start the receiver service");
      const state = await receiverService(sh, path);
      const version = state.active ? await runningReceiverVersion(sh, state.pid, home, path) : undefined;
      if (!version || (expected && version !== expected))
        throw new RemoteError(`the receiver service on ${who} did not start${expected ? ` at v${expected}` : ""}`);
      return version;
    };

    const installedTarget = onDisk ? await receiverTarget(sh, path, platform) : undefined;
    const target = opts.targetOverride === "cpu" ? platform : (opts.targetOverride ?? installedTarget ?? platform);
    const editionMatches = !opts.targetOverride || installedTarget === target;

    if (
      action === "restart" ||
      (editionMatches && unit.exists && diskVersion && opts.version && !isReceiverOutdated(diskVersion, opts.version))
    ) {
      if (!unit.exists) throw new RemoteError(`no receiver service on ${who}; use Install / update first`);
      if (!onDisk) throw new RemoteError(`the service on ${who} has no executable; use Install / update first`);
      if (action === "update" && runningVersion && runningVersion === diskVersion)
        return { action: "current", version: diskVersion };
      if (
        !(await prompts.confirm(
          `${unit.active ? "Restart" : "Start"} ${RECEIVER_UNIT} on ${who}${diskVersion ? ` (v${diskVersion})` : ""}?`,
        ))
      )
        return { action: "cancelled" };
      await verifyUnchanged();
      return { action: "restarted", version: await restart(diskVersion) };
    }
    if (!opts.version) throw new RemoteError("this extension does not know its receiver release version");
    if (opts.hasBinaryFor && !opts.hasBinaryFor(target))
      throw new RemoteError(`no v${opts.version} release archive for ${target}`);
    const sz = opts.binarySizeFor?.(target);
    const sizeNote = sz ? `, ${formatSize(sz)}` : "";
    if (
      !(await prompts.confirm(
        `${unit.exists ? "Update and restart" : "Install and start"} ${RECEIVER_UNIT} on ${who} (v${opts.version}, ${target}${sizeNote})?`,
      ))
    )
      return { action: "cancelled" };
    opts.signal?.throwIfAborted();
    prompts.progress(`… fetching the ${target} receiver`);
    const binary = await opts.binaryFor(target);
    if (!binary) throw new RemoteError(`no v${opts.version} release archive for ${target}`);
    if (basename(binary) !== RECEIVER) throw new RemoteError("the release archive does not contain pi-speech-receiver");
    const stage = await checked(
      `mkdir -p "$HOME/.local/lib" && mktemp -d "$HOME/.local/lib/${RECEIVER}.XXXXXX"`,
      "cannot stage the receiver",
    );
    const stagePrefix = `${home}/.local/lib/${RECEIVER}.`;
    if (!stage.startsWith(stagePrefix) || !/^[a-z0-9]{6}$/i.test(stage.slice(stagePrefix.length))) {
      throw new RemoteError("SSH did not return a valid receiver staging directory");
    }
    const qStage = shQuote(stage);
    const before = `${qStage}/previous`;
    const next = `${qStage}/${RECEIVER}`;
    const unitFile = `"\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${RECEIVER_UNIT}"`;
    let changed = false;
    let createdUnit = false;
    let keep = false;
    try {
      prompts.progress(`… transferring the receiver to ${who}`);
      await transferReceiver(sh, binary, qStage);
      if (
        (await receiverVersion(sh, `${stage}/${RECEIVER}`)) !== opts.version ||
        (await receiverTarget(sh, `${stage}/${RECEIVER}`, platform)) !== target
      ) {
        throw new RemoteError(`the downloaded receiver on ${who} is not v${opts.version} (${target})`);
      }
      await verifyUnchanged();
      opts.signal?.throwIfAborted();
      // Save the old link or regular file and atomically switch the launch path after verifying the full bundle.
      await checked(
        `set -e; mkdir -p "$HOME/.local/bin"; if [ -e ${qPath} ] || [ -L ${qPath} ]; then cp -a ${qPath} ${before}; fi; ln -s ${next} ${qStage}/next; mv -Tf ${qStage}/next ${qPath}`,
        "cannot install the receiver",
      );
      changed = true;
      if (!unit.exists) {
        await checked(
          `set -e; mkdir -p "\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; cat > ${qStage}/unit; (set -C; cat ${qStage}/unit > ${unitFile})`,
          "cannot create the receiver service",
          STARTUP_UNIT,
        );
        createdUnit = true;
        await checked(`${userSystemctl} daemon-reload`, "cannot load the receiver service");
      }
      const version = await restart(opts.version);
      if (createdUnit) await checked(`${userSystemctl} enable ${RECEIVER_UNIT}`, "cannot enable the receiver service");
      keep = true;
      await sh(`rm -f ${before} ${qStage}/unit`).catch(() => {});
      return { action: unit.exists ? "updated" : "installed", version };
    } catch (err) {
      if (changed) {
        // If SSH is lost during rollback, keep the staged files rather than deleting a possibly live binary.
        keep = true;
        const rollback = await sh(
          [
            "set -e",
            ...(createdUnit
              ? [
                  `${userSystemctl} disable --now ${RECEIVER_UNIT}`,
                  `rm -f ${unitFile}`,
                  `${userSystemctl} daemon-reload`,
                ]
              : unit.exists && !unit.active
                ? [`${userSystemctl} stop ${RECEIVER_UNIT}`]
                : []),
            `if [ -e ${before} ] || [ -L ${before} ]; then mv -Tf ${before} ${qPath}; else rm -f ${qPath}; fi`,
            ...(unit.active ? [`${userSystemctl} restart ${RECEIVER_UNIT}`] : []),
          ].join("; "),
        ).catch(() => undefined);
        if (rollback?.code === 0) keep = false;
        else
          throw new RemoteError(
            `${err instanceof Error ? err.message : err}; rollback could not be verified on ${who}`,
          );
      }
      throw err;
    } finally {
      if (!keep) {
        // If the install's response was lost, don't remove a bundle that became the launch target.
        await sh(`if [ "$(readlink ${qPath})" != ${next} ]; then rm -rf ${qStage}; fi`).catch(() => {});
      }
    }
  } finally {
    await close();
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

/** The shared libraries beside a bundled receiver binary (none for a statically linked one). */
export function libraries(binary: string): string[] {
  const dir = dirname(binary);
  try {
    return readdirSync(dir)
      .filter((f) => /\.(so(\.\d+)*|dylib|dll)$/.test(f))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}
