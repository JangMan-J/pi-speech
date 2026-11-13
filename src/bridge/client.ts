/**
 * HTTP client for pi-speech-receiver on the Remote machine (protocol/bridge.md): the bridge's AudioOutput and
 * AudioInput. Every playback is a Stream (`POST /v1/play/stream`); a receiver without the `stream` capability
 * is an error that says to update it. The token is sent only in the Authorization header and is scrubbed from
 * every message produced here.
 *
 * Every request names this Pi process (`X-Pi-Speech-Client`, random per process), so the receiver replaces and
 * stops only this process's plays and leaves those of the user's other Pi sessions playing. With spare ports
 * (the ssh forwards of the user's sessions), the first port that answers is kept until a request to it fails, and
 * the ports are probed again then.
 */

import { randomBytes } from "node:crypto";
import type { AudioInput, AudioOutput, PlayKind, PlayOutcome, PlayStart, Recording } from "../engine/audio";
import type { AudioStream, StreamFormat } from "../engine/provider";

export interface BridgeConfig {
  url: string;
  token: string;
  /** Ports on the URL's host tried, in order, when the URL's own port does not answer. */
  ports?: number[];
  /** The URL may name an address that is not loopback (one the user typed: Tailscale, LAN). */
  network?: boolean;
}

/** A failure carries the receiver's HTTP status when it answered (401: the token is not its token). */
export type BridgeHealth = { ok: true; version: string } | { ok: false; reason: string; status?: number };

/** This Pi process, as the receiver tells its clients apart. */
export const CLIENT_ID = randomBytes(8).toString("hex");
const CLIENT_HEADER = "X-Pi-Speech-Client";

/** A voice of a speech model, as `speak <id> --list-voices` names it. */
export interface BridgeVoice {
  name: string;
  number: number;
}

/**
 * Local models run by the receiver on the Remote machine (protocol/bridge.md, "Running local models"). The
 * receiver runs one transcription or speech at a time; these calls wait for each other, so only another
 * client's run is refused.
 */
export interface BridgeModels {
  /** The catalogue with each model's state on the Remote machine, as `models list` prints it. */
  list(): Promise<Record<string, unknown>[]>;
  voices(id: string, signal?: AbortSignal): Promise<BridgeVoice[]>;
  transcribe(id: string, audio: Buffer, format: "wav" | "mp3", signal?: AbortSignal): Promise<string>;
  /** Resolves once the model has loaded there; the chunks are the PCM as it is generated. */
  speak(
    id: string,
    text: string,
    opts?: { voice?: string; speed?: number; signal?: AbortSignal },
  ): Promise<AudioStream>;
}

export interface BridgeAudio {
  output: AudioOutput;
  input: AudioInput;
  health(): Promise<BridgeHealth>;
  /** Local models run on the Remote machine; absent in stand-ins that have none. */
  models?: BridgeModels;
  /** The base URL requests go to now (a spare port once found); undefined before the first. */
  at?(): string | undefined;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const CONTROL_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const POLL_WAIT_SECONDS = 30;
const MIN_POLL_MS = 100;
const MIN_TOKEN_LENGTH = 32;

/** The base URL of a loopback http receiver; throws a readable Error for anything else. */
export function loopbackBase(url: string): string {
  return bridgeBase(url, false);
}

/**
 * The base URL of an http receiver: on a loopback address, or with `network` on any address (the user typed it:
 * a Tailscale or LAN address). Throws a readable Error for anything else.
 */
export function bridgeBase(url: string, network = false): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("the bridge URL is not a valid URL; use http://127.0.0.1:<port>");
  }
  if (u.protocol !== "http:") {
    throw new Error(`the bridge URL must be plain http on a loopback address, not ${u.protocol}//`);
  }
  if (!network && !LOOPBACK_HOSTS.has(u.hostname)) {
    throw new Error(
      `the bridge URL must use a loopback address (127.0.0.1, ::1 or localhost), not ${u.hostname}: the token travels in plain HTTP`,
    );
  }
  if (u.username || u.password) throw new Error("the bridge URL must not contain a user name or password");
  return u.origin;
}

/** The URL for display: no credentials, whatever else it is. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    u.username = "";
    u.password = "";
    return u.origin === "null" ? u.href : u.origin;
  } catch {
    return "(invalid URL)";
  }
}

class ReceiverError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The receiver's own message of an error answer. */
    readonly detail?: string,
  ) {
    super(message);
  }
}

const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
const MODELS_TIMEOUT_MS = 60_000;
/** How long a port may take to answer while the ports are probed. */
const FIND_TIMEOUT_MS = 2_000;
const BUSY =
  "the Remote machine has too many model runs waiting (runs of all your Pi sessions take turns); try again when they are done";

interface Reply {
  status: number;
  type: string;
  body: Buffer;
  /** The base URL that answered. */
  base: string;
}

/** The same URL on another port. */
function onPort(base: string, port: number): string {
  const u = new URL(base);
  u.port = String(port);
  return u.origin;
}

/** Whether a pi-speech-receiver that takes this token answers at `base`. Never throws. */
async function answers(base: string, token: string, clientId: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/v1/health`, {
      headers: { Authorization: `Bearer ${token}`, [CLIENT_HEADER]: clientId },
      redirect: "error",
      signal: AbortSignal.timeout(FIND_TIMEOUT_MS),
    });
    const h = (await res.json()) as { name?: unknown };
    return res.ok && h.name === "pi-speech-receiver";
  } catch {
    return false;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const detail = cause instanceof Error ? cause.message : "";
    if (err.name === "TimeoutError" || err.name === "AbortError") return "the request timed out";
    return detail ? `${err.message} (${detail})` : err.message;
  }
  return String(err);
}

export function createBridgeAudioFrom(getConfig: () => BridgeConfig, opts: { clientId?: string } = {}): BridgeAudio {
  const clientId = opts.clientId ?? CLIENT_ID;

  /** Resolve the configuration once per operation: base URL, token, spare ports, and a scrubber for messages. */
  function resolve() {
    const { url, token, ports = [], network } = getConfig();
    const base = bridgeBase(url, network);
    if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("the bridge token is empty or contains invalid characters");
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`the bridge token is too short: it must be at least ${MIN_TOKEN_LENGTH} characters`);
    }
    const scrub = (text: string) => text.split(token).join("***");
    return { base, token, scrub, ports, key: `${base} ${ports.join(",")}` };
  }

  /** With spare ports: the base that answered, kept until a request to it fails. */
  let found: { key: string; base: string } | undefined;
  /** The base requests went to last. */
  let last: string | undefined;

  /** The configuration with the base to use now: the URL's own, or a spare port's that answers. */
  async function target() {
    const r = resolve();
    if (!r.ports.length) {
      last = r.base;
      return r;
    }
    if (found?.key === r.key) {
      last = found.base;
      return { ...r, base: found.base };
    }
    let base: string | undefined;
    if (await answers(r.base, r.token, clientId)) base = r.base;
    else {
      const spare = r.ports.map((p) => onPort(r.base, p));
      const ok = await Promise.all(spare.map((b) => answers(b, r.token, clientId)));
      base = spare[ok.indexOf(true)];
    }
    // Nothing answers: the URL's own, so that what fails names it.
    if (base) found = { key: r.key, base };
    last = base ?? r.base;
    return { ...r, base: last };
  }

  /** A request to `base` could not be made: look for the receiver again next time. Whether that may help. */
  function lost(base: string): boolean {
    if (found?.base !== base) return false;
    found = undefined;
    return true;
  }

  async function call(
    method: "GET" | "POST",
    path: string,
    opts: {
      body?: Buffer;
      contentType?: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
    retried = false,
  ): Promise<Reply> {
    const { base, token, scrub } = await target();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      [CLIENT_HEADER]: clientId,
      ...opts.headers,
    };
    if (opts.contentType) headers["Content-Type"] = opts.contentType;
    let res: Response;
    let body: Buffer;
    try {
      res = await fetch(base + path, {
        method,
        headers,
        body: opts.body ? new Uint8Array(opts.body) : undefined,
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(opts.timeoutMs ?? CONTROL_TIMEOUT_MS),
          ...(opts.signal ? [opts.signal] : []),
        ]),
      });
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      opts.signal?.throwIfAborted();
      // The forward it went through has gone (its ssh session ended): once more, through another that answers.
      if (!retried && lost(base)) return call(method, path, opts, true);
      throw new ReceiverError(
        scrub(`the playback receiver is not reachable at ${displayUrl(base)}: ${describeError(err)}`),
      );
    }
    const type = res.headers.get("content-type") ?? "";
    if (res.status >= 400) {
      let message = res.statusText || "request failed";
      try {
        const parsed = JSON.parse(body.toString("utf8")) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error) message = parsed.error;
      } catch {
        /* not JSON: keep the status text */
      }
      const hint = res.status === 401 ? " (check the bridge token)" : "";
      throw new ReceiverError(
        scrub(`the playback receiver answered ${res.status}: ${message}${hint}`),
        res.status,
        scrub(message),
      );
    }
    return { status: res.status, type, body, base };
  }

  async function json<T>(reply: Reply): Promise<T> {
    try {
      return JSON.parse(reply.body.toString("utf8")) as T;
    } catch {
      throw new ReceiverError("the playback receiver sent an unreadable answer");
    }
  }

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** Whether the receiver at a base URL plays a Stream (its health lists `stream`); unknown until asked. */
  const streamCapable = new Map<string, boolean>();
  const TOO_OLD =
    "the playback receiver on the Remote machine is too old to play a Stream: update pi-speech-receiver there and restart it";

  async function health(): Promise<BridgeHealth> {
    try {
      const reply = await call("GET", "/v1/health");
      const h = await json<{ protocol?: number; name?: string; version?: string; capabilities?: unknown }>(reply);
      const stream = Array.isArray(h.capabilities) && h.capabilities.includes("stream");
      streamCapable.set(reply.base, stream);
      if (h.name !== "pi-speech-receiver") return { ok: false, reason: "the server there is not a pi-speech-receiver" };
      if (h.protocol !== 1) {
        return { ok: false, reason: `the receiver speaks bridge protocol ${String(h.protocol)}, not 1` };
      }
      if (!stream) return { ok: false, reason: TOO_OLD };
      return { ok: true, version: String(h.version ?? "unknown") };
    } catch (err) {
      const status = err instanceof ReceiverError ? err.status : undefined;
      return { ok: false, reason: message(err), ...(status ? { status } : {}) };
    }
  }

  // ── Playback ────────────────────────────────────────────────────────────

  /** Ids of playbacks started here and not yet ended, with their kinds. */
  const active = new Map<string, PlayKind>();

  async function follow(id: string): Promise<PlayOutcome> {
    try {
      for (;;) {
        const started = Date.now();
        const reply = await call("GET", `/v1/play/${encodeURIComponent(id)}?wait=${POLL_WAIT_SECONDS}`, {
          timeoutMs: (POLL_WAIT_SECONDS + 10) * 1000,
        });
        const s = await json<{ state?: string; error?: string }>(reply);
        if (s.state === "completed") return { state: "completed" };
        if (s.state === "cancelled") return { state: "cancelled" };
        if (s.state === "failed") return { state: "failed", error: s.error || "the receiver's player failed" };
        if (s.state !== "playing") return { state: "failed", error: `unknown playback state ${String(s.state)}` };
        const spent = Date.now() - started;
        if (spent < MIN_POLL_MS) await new Promise((r) => setTimeout(r, MIN_POLL_MS - spent));
      }
    } catch (err) {
      return { state: "failed", error: message(err) };
    } finally {
      active.delete(id);
    }
  }

  /** Send the chunks of a Stream as the body of POST /v1/play/<id>/audio, each as it arrives. */
  async function upload(
    base: string,
    id: string,
    chunks: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<void> {
    const { token } = resolve();
    const it = chunks[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        const n = await it.next();
        if (n.done) c.close();
        else c.enqueue(n.value);
      },
      cancel() {
        void it.return?.(undefined);
      },
    });
    const res = await fetch(`${base}/v1/play/${encodeURIComponent(id)}/audio`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        [CLIENT_HEADER]: clientId,
        "Content-Type": "application/octet-stream",
      },
      body,
      duplex: "half",
      redirect: "error",
      signal,
    } as RequestInit & { duplex: "half" });
    await res.arrayBuffer().catch(() => {});
  }

  const formatBody = (f: StreamFormat) =>
    f.codec === "pcm" ? { format: "pcm", rate: f.rate, channels: f.channels } : { format: f.codec };

  const output: AudioOutput = {
    name: "bridge",

    async playStream(stream: AudioStream, kind: PlayKind): Promise<PlayStart> {
      try {
        const { base: at } = await target();
        // Asked again until it can: an old receiver may have been updated since.
        if (streamCapable.get(at) !== true) {
          const h = await health();
          if (!h.ok) return { ok: false, reason: h.reason };
        }
        const reply = await call("POST", "/v1/play/stream", {
          body: Buffer.from(JSON.stringify(formatBody(stream.format))),
          contentType: "application/json",
          headers: { "X-Pi-Speech-Kind": kind },
        });
        const { id } = await json<{ id?: string }>(reply);
        if (!id) return { ok: false, reason: "the playback receiver did not return a playback id" };
        active.set(id, kind);
        const sending = new AbortController();
        // A body that breaks off ends the playback as failed on the receiver; `done` reports it.
        void upload(reply.base, id, stream.chunks, sending.signal).catch(() => {});
        const done = follow(id);
        // Cancelled on the receiver: nothing more to send. A failed status check is not a reason to stop sending.
        void done.then((o) => {
          if (o.state === "cancelled") sending.abort();
        });
        return {
          ok: true,
          player: "pi-speech-receiver",
          done,
          async stop() {
            try {
              await call("POST", `/v1/play/${encodeURIComponent(id)}/cancel`);
            } catch {
              sending.abort();
              return; // `done` reports a receiver that cannot be reached
            }
            sending.abort();
            await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
          },
        };
      } catch (err) {
        return { ok: false, reason: message(err) };
      }
    },

    async stop(kind?: PlayKind): Promise<void> {
      if (!kind) {
        // With this process's id: the user's other Pi sessions keep playing.
        await call("POST", "/v1/stop");
        return;
      }
      // The receiver cannot stop one kind; cancel the playbacks of that kind started here.
      // One failed cancel (a restarted receiver lost the id) must not keep the others playing.
      for (const [id, k] of [...active]) {
        if (k !== kind) continue;
        try {
          await call("POST", `/v1/play/${encodeURIComponent(id)}/cancel`);
        } catch {
          active.delete(id);
        }
      }
    },
  };

  // ── Recording ───────────────────────────────────────────────────────────

  const input: AudioInput = {
    name: "bridge",

    async start(): Promise<Recording> {
      const reply = await call("POST", "/v1/record/start");
      const { id } = await json<{ id?: string }>(reply);
      if (!id) throw new Error("the playback receiver did not return a recording id");
      const path = `/v1/record/${encodeURIComponent(id)}`;
      return {
        async stop() {
          const r = await call("POST", `${path}/stop`, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
          if (!/audio\/(x-)?wav/i.test(r.type) || r.body.subarray(0, 4).toString("latin1") !== "RIFF") {
            throw new Error("the playback receiver did not return a WAV recording");
          }
          return { audio: r.body, format: "wav" as const };
        },
        async cancel() {
          await call("POST", `${path}/cancel`);
        },
      };
    },
  };

  // ── Local models on the Remote machine ─────────────────────────────────

  /** Whether the receiver at a base URL runs models (its health lists `models`). */
  const modelsCapable = new Map<string, boolean>();
  const MODELS_TOO_OLD =
    "the receiver on the Remote machine is too old to run models: update pi-speech-receiver there and restart it, or set Run models on to This machine";

  async function requireModels(): Promise<void> {
    const { base: at } = await target();
    if (modelsCapable.get(at)) return;
    const reply = await call("GET", "/v1/health");
    const h = await json<{ capabilities?: unknown }>(reply);
    const can = Array.isArray(h.capabilities) && h.capabilities.includes("models");
    modelsCapable.set(reply.base, can);
    if (!can) throw new Error(MODELS_TOO_OLD);
  }

  /** A model run's failure in plain words: the receiver's own message, said to be on the Remote machine. */
  function modelError(err: unknown): Error {
    if (err instanceof ReceiverError && err.status === 409) return new Error(BUSY);
    if (err instanceof ReceiverError && err.detail && (err.status === 422 || err.status === 503)) {
      return new Error(`on the Remote machine: ${err.detail}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /** One model run at a time from here: each waits for the one before it to end (the receiver queues the runs of other clients). */
  let queue: Promise<void> = Promise.resolve();
  function turn(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const before = queue;
    queue = before.then(() => mine);
    return before.then(() => release);
  }

  const models: BridgeModels = {
    async list() {
      try {
        await requireModels();
        const r = await json<{ models?: unknown }>(await call("GET", "/v1/models", { timeoutMs: MODELS_TIMEOUT_MS }));
        return Array.isArray(r.models) ? r.models.filter((m) => m && typeof m === "object") : [];
      } catch (err) {
        throw modelError(err);
      }
    },

    async voices(id, signal) {
      try {
        await requireModels();
        const r = await json<{ voices?: unknown }>(
          await call("GET", `/v1/voices?model=${encodeURIComponent(id)}`, { timeoutMs: MODELS_TIMEOUT_MS, signal }),
        );
        const list = Array.isArray(r.voices) ? (r.voices as Array<Record<string, unknown>>) : [];
        return list.flatMap((v) =>
          typeof v.name === "string" && typeof v.number === "number" ? [{ name: v.name, number: v.number }] : [],
        );
      } catch (err) {
        throw modelError(err);
      }
    },

    async transcribe(id, audio, format, signal) {
      const release = await turn();
      try {
        await requireModels();
        const r = await json<{ text?: unknown }>(
          await call("POST", `/v1/transcribe?model=${encodeURIComponent(id)}`, {
            body: audio,
            contentType: format === "mp3" ? "audio/mpeg" : "audio/wav",
            timeoutMs: TRANSCRIBE_TIMEOUT_MS,
            signal,
          }),
        );
        if (typeof r.text !== "string") throw new Error("the receiver on the Remote machine sent no text");
        return r.text.trim();
      } catch (err) {
        throw modelError(err);
      } finally {
        release();
      }
    },

    async speak(id, text, opts = {}) {
      const { signal } = opts;
      signal?.throwIfAborted();
      const release = await turn();
      const ending = new AbortController();
      // Aborting frees the turn even when the chunks are never read.
      const onAbort = () => {
        ending.abort(signal?.reason);
        release();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const finish = () => {
        signal?.removeEventListener("abort", onAbort);
        ending.abort();
        release();
      };
      let res: Response;
      try {
        await requireModels();
        const { base: at, token, scrub } = await target();
        try {
          res = await fetch(`${at}/v1/speak`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              [CLIENT_HEADER]: clientId,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: id,
              text,
              ...(opts.voice ? { voice: opts.voice } : {}),
              ...(opts.speed !== undefined && opts.speed !== 1 ? { speed: opts.speed } : {}),
            }),
            redirect: "error",
            signal: ending.signal,
          });
        } catch (err) {
          signal?.throwIfAborted();
          lost(at);
          throw new Error(scrub(`the playback receiver is not reachable at ${displayUrl(at)}: ${describeError(err)}`));
        }
        if (!res.ok) {
          let detail = res.statusText || "speak failed";
          try {
            const parsed = (await res.json()) as { error?: unknown };
            if (typeof parsed.error === "string" && parsed.error) detail = parsed.error;
          } catch {
            /* keep the status text */
          }
          throw new ReceiverError(`the playback receiver answered ${res.status}: ${detail}`, res.status, scrub(detail));
        }
      } catch (err) {
        finish();
        throw modelError(err);
      }
      const rate = Number(res.headers.get("x-pi-speech-rate"));
      const channels = Number(res.headers.get("x-pi-speech-channels")) || 1;
      if (!res.body || !(rate > 0)) {
        finish();
        throw new Error("the receiver on the Remote machine sent speech without its format");
      }
      const reader = res.body.getReader();
      async function* chunks(): AsyncGenerator<Uint8Array> {
        try {
          for (;;) {
            let n: ReadableStreamReadResult<Uint8Array>;
            try {
              n = await reader.read();
            } catch {
              signal?.throwIfAborted();
              throw new Error("the speech broke off on the Remote machine before its end");
            }
            if (n.done) return;
            yield n.value;
          }
        } finally {
          finish();
        }
      }
      return { format: { codec: "pcm", rate, channels }, chunks: chunks() };
    },
  };

  return { output, input, health, models, at: () => last };
}

export function createBridgeAudio(config: BridgeConfig, opts: { clientId?: string } = {}): BridgeAudio {
  return createBridgeAudioFrom(() => config, opts);
}

/**
 * Evidence of the bridge connection from one `GET /v1/health`: the receiver's address and port as Pi reaches
 * them (the forwarded end on This machine) and the round trip in whole milliseconds. Not ok when the
 * configuration is unusable (no token, a non-loopback URL), the receiver cannot be reached, or it refuses (a
 * wrong token, an incompatible receiver); `reason` says which, without the token.
 */
export type BridgeProbe =
  | { ok: true; address: string; port: number; ms: number; version: string }
  | { ok: false; address?: string; port?: number; reason: string; status?: number };

/** Probe the receiver once (see BridgeProbe). With spare ports, it names the port that answered. Never throws. */
export async function probeBridge(config: BridgeConfig | (() => BridgeConfig)): Promise<BridgeProbe> {
  const get = typeof config === "function" ? config : () => config;
  let fixed: BridgeConfig;
  try {
    fixed = get();
    bridgeBase(fixed.url, fixed.network);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const bridge = createBridgeAudio(fixed);
  const started = performance.now();
  const h = await bridge.health();
  const ms = Math.round(performance.now() - started);
  const where = new URL(bridge.at?.() ?? bridgeBase(fixed.url, fixed.network));
  const address = where.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(where.port) || 80;
  return h.ok
    ? { ok: true, address, port, ms, version: h.version }
    : { ok: false, address, port, reason: h.reason, ...(h.status ? { status: h.status } : {}) };
}

// ── Pairing ─────────────────────────────────────────────────────────────

/** Why a pairing code was not taken: `wrong` (attempts may be left), `expired` (ask for a new code), or other. */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly kind: "wrong" | "expired" | "other",
    readonly attemptsLeft?: number,
  ) {
    super(message);
  }
}

/** POST /v1/pair, which needs no token; the answer's status and JSON. */
async function pairRequest(
  url: string,
  network: boolean | undefined,
  body: object,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const base = bridgeBase(url, network);
  let res: Response;
  try {
    res = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [CLIENT_HEADER]: CLIENT_ID },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new PairingError(`the receiver is not reachable at ${displayUrl(base)}: ${describeError(err)}`, "other");
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* no JSON: the status says enough */
  }
  return { status: res.status, json };
}

const said = (json: Record<string, unknown>, fallback: string) =>
  typeof json.error === "string" && json.error ? json.error : fallback;

/**
 * Ask the receiver at `url` for a pairing code: it shows six digits on its own terminal (never to Pi), valid for
 * `expiresIn` seconds.
 */
export async function requestPairingCode(
  url: string,
  opts: { network?: boolean } = {},
): Promise<{ expiresIn: number }> {
  const { status, json } = await pairRequest(url, opts.network, {});
  if (status === 404) {
    throw new PairingError("the receiver there is too old to pair: update pi-speech-receiver and restart it", "other");
  }
  if (status !== 202)
    throw new PairingError(`the receiver answered ${status}: ${said(json, "no pairing code")}`, "other");
  return { expiresIn: typeof json.expires_in === "number" ? json.expires_in : 120 };
}

/** Send the code the user read on the receiver's terminal; the bridge token it earns. */
export async function sendPairingCode(url: string, code: string, opts: { network?: boolean } = {}): Promise<string> {
  const { status, json } = await pairRequest(url, opts.network, { code });
  if (status === 200 && typeof json.token === "string" && json.token.length >= MIN_TOKEN_LENGTH) return json.token;
  if (status === 403) {
    const left = typeof json.attempts_left === "number" ? json.attempts_left : 0;
    throw new PairingError(said(json, "wrong pairing code"), "wrong", left);
  }
  if (status === 410) throw new PairingError(said(json, "the pairing code expired"), "expired");
  if (status === 400) throw new PairingError(said(json, "the code is six digits"), "wrong");
  throw new PairingError(`the receiver answered ${status}: ${said(json, "no token")}`, "other");
}
