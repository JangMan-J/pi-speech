/**
 * HTTP client for pi-speech-receiver on the Remote machine (protocol/bridge.md): the bridge's AudioOutput and
 * AudioInput. Every playback is a Stream (`POST /v1/play/stream`); a receiver without the `stream` capability
 * is an error that says to update it. The token is sent only in the Authorization header and is scrubbed from
 * every message produced here.
 */

import type { AudioInput, AudioOutput, PlayKind, PlayOutcome, PlayStart, Recording } from "../engine/audio";
import type { AudioStream, StreamFormat } from "../engine/provider";

export interface BridgeConfig {
  url: string;
  token: string;
}

export type BridgeHealth = { ok: true; version: string } | { ok: false; reason: string };

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
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);
const CONTROL_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const POLL_WAIT_SECONDS = 30;
const MIN_POLL_MS = 100;
const MIN_TOKEN_LENGTH = 32;

/** The base URL of a loopback http receiver; throws a readable Error for anything else. */
export function loopbackBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error("the bridge URL is not a valid URL; use http://127.0.0.1:<port>");
  }
  if (u.protocol !== "http:") {
    throw new Error(`the bridge URL must be plain http on a loopback address, not ${u.protocol}//`);
  }
  if (!LOOPBACK_HOSTS.has(u.hostname)) {
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
const BUSY =
  "the Remote machine is already running a model for another client (one at a time); try again when it is done";

interface Reply {
  status: number;
  type: string;
  body: Buffer;
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

export function createBridgeAudioFrom(getConfig: () => BridgeConfig): BridgeAudio {
  /** Resolve the configuration once per operation: base URL, token, and a scrubber for messages. */
  function resolve() {
    const { url, token } = getConfig();
    const base = loopbackBase(url);
    if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("the bridge token is empty or contains invalid characters");
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`the bridge token is too short: it must be at least ${MIN_TOKEN_LENGTH} characters`);
    }
    const scrub = (text: string) => text.split(token).join("***");
    return { base, token, scrub };
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
  ): Promise<Reply> {
    const { base, token, scrub } = resolve();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...opts.headers };
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
    return { status: res.status, type, body };
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
  const base = () => resolve().base;
  const TOO_OLD =
    "the playback receiver on the Remote machine is too old to play a Stream: update pi-speech-receiver there and restart it";

  async function health(): Promise<BridgeHealth> {
    try {
      const h = await json<{ protocol?: number; name?: string; version?: string; capabilities?: unknown }>(
        await call("GET", "/v1/health"),
      );
      streamCapable.set(base(), Array.isArray(h.capabilities) && h.capabilities.includes("stream"));
      if (h.name !== "pi-speech-receiver") return { ok: false, reason: "the server there is not a pi-speech-receiver" };
      if (h.protocol !== 1) {
        return { ok: false, reason: `the receiver speaks bridge protocol ${String(h.protocol)}, not 1` };
      }
      if (!streamCapable.get(base())) return { ok: false, reason: TOO_OLD };
      return { ok: true, version: String(h.version ?? "unknown") };
    } catch (err) {
      return { ok: false, reason: message(err) };
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
  async function upload(id: string, chunks: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<void> {
    const { base, token } = resolve();
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
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
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
        const at = base();
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
        void upload(id, stream.chunks, sending.signal).catch(() => {});
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
    const at = base();
    if (modelsCapable.get(at)) return;
    const reply = await call("GET", "/v1/health");
    const h = await json<{ capabilities?: unknown }>(reply);
    const can = Array.isArray(h.capabilities) && h.capabilities.includes("models");
    modelsCapable.set(at, can);
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

  /** One model run at a time from here: each waits for the one before it to end. */
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
        const { base: at, token, scrub } = resolve();
        try {
          res = await fetch(`${at}/v1/speak`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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

  return { output, input, health, models };
}

export function createBridgeAudio(config: BridgeConfig): BridgeAudio {
  return createBridgeAudioFrom(() => config);
}

/**
 * Evidence of the bridge connection from one `GET /v1/health`: the receiver's address and port as Pi reaches
 * them (the forwarded end on This machine) and the round trip in whole milliseconds. Not ok when the
 * configuration is unusable (no token, a non-loopback URL), the receiver cannot be reached, or it refuses (a
 * wrong token, an incompatible receiver); `reason` says which, without the token.
 */
export type BridgeProbe =
  | { ok: true; address: string; port: number; ms: number; version: string }
  | { ok: false; address?: string; port?: number; reason: string };

/** Probe the receiver once (see BridgeProbe). Never throws. */
export async function probeBridge(config: BridgeConfig | (() => BridgeConfig)): Promise<BridgeProbe> {
  const get = typeof config === "function" ? config : () => config;
  let fixed: BridgeConfig;
  let where: URL;
  try {
    fixed = get();
    where = new URL(loopbackBase(fixed.url));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  const address = where.hostname.replace(/^\[(.*)\]$/, "$1");
  const port = Number(where.port) || 80;
  const started = performance.now();
  const h = await createBridgeAudio(fixed).health();
  const ms = Math.round(performance.now() - started);
  return h.ok ? { ok: true, address, port, ms, version: h.version } : { ok: false, address, port, reason: h.reason };
}
