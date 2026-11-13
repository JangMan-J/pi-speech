import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeAudio, probeBridge } from "../../src/bridge/index";

const TOKEN = "t".repeat(40);

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

let server: Server;
let url: string;
let seen: Seen[];
let handler: (req: Seen, res: ServerResponse) => void;
let dir: string;

const send = (res: ServerResponse, status: number, body: unknown, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type });
  res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bridge-client-"));
  seen = [];
  handler = (_r, res) => send(res, 404, { error: "unexpected" });
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const s = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      seen.push(s);
      handler(s, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

/** A short Stream that has fully arrived. */
const clip = (bytes = "abcd") => ({
  format: { codec: "pcm" as const, rate: 24000, channels: 1 },
  chunks: (async function* () {
    yield Buffer.from(bytes);
  })(),
});

const HEALTH = {
  protocol: 1,
  name: "pi-speech-receiver",
  version: "0.4.0",
  capabilities: ["play", "record", "stream"],
};

/**
 * A receiver that starts every Stream as `ids()`, takes its audio, and answers status polls, cancels and stops
 * with `rest`.
 */
const receiver =
  (rest: (r: Seen, res: ServerResponse) => void, ids: () => string = () => "p1") =>
  (r: Seen, res: ServerResponse) => {
    if (r.url === "/v1/health") return send(res, 200, HEALTH);
    if (r.method === "POST" && r.url === "/v1/play/stream") return send(res, 202, { id: ids() });
    if (r.method === "POST" && r.url.endsWith("/audio")) return send(res, 200, { state: "playing" });
    rest(r, res);
  };

describe("health", () => {
  it("returns the version and sends the token only in Authorization", async () => {
    handler = (_r, res) => send(res, 200, { ...HEALTH, version: "1.2.3" });
    const h = await createBridgeAudio({ url, token: TOKEN }).health();
    expect(h).toEqual({ ok: true, version: "1.2.3" });
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].url).toBe("/v1/health");
    expect(seen[0].url).not.toContain(TOKEN);
  });

  it("names the reason when the receiver is unreachable, without the token", async () => {
    const closed = url;
    await new Promise((r) => server.close(r));
    const h = await createBridgeAudio({ url: closed, token: TOKEN }).health();
    expect(h.ok).toBe(false);
    if (!h.ok) {
      expect(h.reason).toMatch(/not reachable/);
      expect(h.reason).toContain(closed);
      expect(h.reason).not.toContain(TOKEN);
    }
    server = createServer();
  });

  it("reports 401 with the receiver's message", async () => {
    handler = (_r, res) => send(res, 401, { error: "unauthorized" });
    const h = await createBridgeAudio({ url, token: TOKEN }).health();
    expect(h).toMatchObject({ ok: false });
    if (!h.ok) expect(h.reason).toMatch(/401.*unauthorized/);
  });

  it("a receiver without the stream capability is an error that says to update it", async () => {
    handler = (_r, res) => send(res, 200, { ...HEALTH, capabilities: ["play", "record"] });
    const h = await createBridgeAudio({ url, token: TOKEN }).health();
    expect(h).toMatchObject({ ok: false, reason: expect.stringMatching(/update pi-speech-receiver/) });
  });

  it("rejects something that is not a pi-speech-receiver", async () => {
    handler = (_r, res) => send(res, 200, { hello: 1 });
    expect((await createBridgeAudio({ url, token: TOKEN }).health()).ok).toBe(false);
  });
});

describe("probe", () => {
  it("returns the address, port and round trip of GET /v1/health", async () => {
    handler = (_r, res) => setTimeout(() => send(res, 200, HEALTH), 30);
    const p = await probeBridge({ url, token: TOKEN });
    expect(p).toMatchObject({ ok: true, address: "127.0.0.1", port: Number(new URL(url).port), version: "0.4.0" });
    if (p.ok) {
      expect(Number.isInteger(p.ms)).toBe(true);
      expect(p.ms).toBeGreaterThanOrEqual(25);
      expect(p.ms).toBeLessThan(5000);
    }
    expect(seen.map((s) => s.url)).toEqual(["/v1/health"]);
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("names where it looked when the receiver is unreachable, without the token", async () => {
    const closed = url;
    await new Promise((r) => server.close(r));
    const p = await probeBridge(() => ({ url: closed, token: TOKEN }));
    expect(p).toMatchObject({ ok: false, address: "127.0.0.1", port: Number(new URL(closed).port) });
    if (!p.ok) {
      expect(p.reason).toMatch(/not reachable/);
      expect(p.reason).not.toContain(TOKEN);
    }
    server = createServer();
  });

  it("a wrong token is not a connection", async () => {
    handler = (_r, res) => send(res, 401, { error: "unauthorized" });
    const p = await probeBridge({ url, token: TOKEN });
    expect(p).toMatchObject({ ok: false, reason: expect.stringMatching(/401/) });
  });

  it("an unusable configuration is reported, not thrown", async () => {
    const p = await probeBridge(() => {
      throw new Error("no bridge token: set PI_SPEECH_BRIDGE_TOKEN");
    });
    expect(p).toEqual({ ok: false, reason: "no bridge token: set PI_SPEECH_BRIDGE_TOKEN" });
    const q = await probeBridge({ url: "http://192.0.2.1:47613", token: TOKEN });
    expect(q).toMatchObject({ ok: false, reason: expect.stringMatching(/loopback/) });
    expect(q).not.toHaveProperty("address");
  });

  it("gives an IPv6 address without brackets and the default port of a URL without one", async () => {
    const p = await probeBridge({ url: "http://[::1]", token: TOKEN });
    expect(p).toMatchObject({ address: "::1", port: 80 });
  });
});

describe("URL policy", () => {
  it.each([
    "http://192.0.2.1:47613",
    "https://127.0.0.1:47613",
    "http://example.com",
    "http://127.0.0.1.evil.test:1",
    "http://user:pw@127.0.0.1:1",
    "not a url",
  ])("refuses %s before connecting", async (bad) => {
    const b = createBridgeAudio({ url: bad, token: TOKEN });
    const h = await b.health();
    expect(h.ok).toBe(false);
    const p = await b.output.playStream(clip(), "message");
    expect(p.ok).toBe(false);
    await expect(b.input.start()).rejects.toThrow();
    await expect(b.output.stop()).rejects.toThrow();
    expect(JSON.stringify([h, p])).not.toContain(TOKEN);
  });

  it("names loopback in the refusal", async () => {
    const h = await createBridgeAudio({ url: "http://192.0.2.1:47613", token: TOKEN }).health();
    expect(h).toMatchObject({ ok: false, reason: expect.stringMatching(/loopback/) });
  });

  it.each(["http://127.0.0.1:1", "http://[::1]:1", "http://localhost:1"])("accepts %s", async (ok) => {
    const h = await createBridgeAudio({ url: ok, token: TOKEN }).health();
    expect(h).toMatchObject({ ok: false, reason: expect.stringMatching(/not reachable/) });
  });

  it("does not follow a redirect (the token must not leave)", async () => {
    handler = (_r, res) => {
      res.writeHead(302, { Location: "http://192.0.2.1/" });
      res.end();
    };
    const h = await createBridgeAudio({ url, token: TOKEN }).health();
    expect(h.ok).toBe(false);
  });

  it("refuses a token that cannot be a header value, without echoing it", async () => {
    const bad = "abc\ndef";
    const h = await createBridgeAudio({ url, token: bad }).health();
    expect(h.ok).toBe(false);
    expect(seen).toHaveLength(0);
    expect(JSON.stringify(h)).not.toContain("abc");
  });
});

describe("playing a Stream", () => {
  it("starts it with its format and kind, sends its audio, and follows it to completion", async () => {
    let polls = 0;
    handler = receiver((_r, res) => {
      polls++;
      send(res, 200, { id: "p1", state: polls < 2 ? "playing" : "completed" });
    });
    const p = await createBridgeAudio({ url, token: TOKEN }).output.playStream(clip("RIFF0000WAVEabc"), "sample");
    expect(p).toMatchObject({ ok: true, player: "pi-speech-receiver" });
    if (p.ok) expect(await p.done).toEqual({ state: "completed" });
    const start = seen.find((s) => s.url === "/v1/play/stream");
    expect(start?.headers["x-pi-speech-kind"]).toBe("sample");
    expect(start?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(start?.body.toString() ?? "")).toEqual({ format: "pcm", rate: 24000, channels: 1 });
    expect(seen.find((s) => s.url === "/v1/play/p1/audio")?.body.toString()).toBe("RIFF0000WAVEabc");
    expect(seen.some((s) => /^\/v1\/play\/p1\?wait=\d+$/.test(s.url))).toBe(true);
    expect(seen.some((s) => s.url === "/v1/play")).toBe(false);
    expect(polls).toBe(2);
  });

  it("an MP3 Stream is started as mp3", async () => {
    handler = receiver(() => {});
    const out = createBridgeAudio({ url, token: TOKEN }).output;
    await out.playStream({ format: { codec: "mp3" }, chunks: clip().chunks }, "message");
    expect(JSON.parse(seen.find((s) => s.url === "/v1/play/stream")?.body.toString() ?? "")).toEqual({
      format: "mp3",
    });
  });

  it("returns the receiver's message when it cannot start; nothing of the Stream is read", async () => {
    handler = (r, res) =>
      r.url === "/v1/health" ? send(res, 200, HEALTH) : send(res, 503, { error: "no audio device" });
    let reads = 0;
    const stream = {
      format: { codec: "pcm" as const, rate: 24000, channels: 1 },
      chunks: (async function* () {
        reads++;
        yield new Uint8Array(4);
      })(),
    };
    const p = await createBridgeAudio({ url, token: TOKEN }).output.playStream(stream, "message");
    expect(p).toMatchObject({ ok: false, reason: expect.stringMatching(/503.*no audio device/) });
    expect(reads).toBe(0);
  });

  it("returns a reason when the receiver is not reachable", async () => {
    const p = await createBridgeAudio({ url: "http://127.0.0.1:1", token: TOKEN }).output.playStream(clip(), "message");
    expect(p).toMatchObject({ ok: false, reason: expect.stringMatching(/not reachable at http:\/\/127\.0\.0\.1:1/) });
  });

  it("ends as failed with the receiver's error", async () => {
    handler = receiver((_r, res) => send(res, 200, { state: "failed", error: "player exited 1" }));
    const p = await createBridgeAudio({ url, token: TOKEN }).output.playStream(clip(), "message");
    if (!p.ok) throw new Error(p.reason);
    expect(await p.done).toEqual({ state: "failed", error: "player exited 1" });
  });

  it("ends as failed when contact is lost", async () => {
    handler = receiver((_r, res) => res.socket?.destroy());
    const p = await createBridgeAudio({ url, token: TOKEN }).output.playStream(clip(), "message");
    expect(p.ok).toBe(true);
    if (p.ok) {
      const o = await p.done;
      expect(o.state).toBe("failed");
      expect(JSON.stringify(o)).not.toContain(TOKEN);
    }
  });

  it("stop() cancels that playback", async () => {
    let cancelled = false;
    handler = receiver(
      (r, res) => {
        if (r.url === "/v1/play/p9/cancel") {
          cancelled = true;
          return send(res, 200, { id: "p9", state: "cancelled" });
        }
        setTimeout(() => send(res, 200, { state: cancelled ? "cancelled" : "playing" }), 20);
      },
      () => "p9",
    );
    const p = await createBridgeAudio({ url, token: TOKEN }).output.playStream(clip(), "message");
    if (!p.ok) throw new Error("not started");
    await p.stop();
    expect(await p.done).toEqual({ state: "cancelled" });
    expect(seen.some((s) => s.method === "POST" && s.url === "/v1/play/p9/cancel")).toBe(true);
  });

  it("output.stop() posts /v1/stop; stop(kind) cancels only that kind", async () => {
    let n = 0;
    handler = receiver(
      (r, res) => {
        if (r.url === "/v1/stop") return send(res, 200, { stopped: 1 });
        if (r.method === "POST") return send(res, 200, { state: "cancelled" });
        // polls stay open
      },
      () => `p${++n}`,
    );
    const b = createBridgeAudio({ url, token: TOKEN });
    await b.output.playStream(clip(), "message");
    await b.output.playStream(clip(), "sample");
    await b.output.stop("sample");
    const cancels = seen.filter((s) => s.url.endsWith("/cancel")).map((s) => s.url);
    expect(cancels).toEqual(["/v1/play/p2/cancel"]);
    await b.output.stop();
    expect(seen.some((s) => s.method === "POST" && s.url === "/v1/stop")).toBe(true);
  });
});

describe("review fixes", () => {
  it("stop(kind) cancels the others and does not throw when one cancel fails", async () => {
    let n = 0;
    handler = receiver(
      (r, res) => {
        if (r.url === "/v1/play/p1/cancel") return send(res, 404, { error: "unknown id" });
        if (r.method === "POST") return send(res, 200, { state: "cancelled" });
      },
      () => `p${++n}`,
    );
    const b = createBridgeAudio({ url, token: TOKEN });
    await b.output.playStream(clip(), "sample");
    await b.output.playStream(clip(), "sample");
    await expect(b.output.stop("sample")).resolves.toBeUndefined();
    expect(seen.filter((s) => s.url.endsWith("/cancel")).map((s) => s.url)).toEqual([
      "/v1/play/p1/cancel",
      "/v1/play/p2/cancel",
    ]);
    seen.length = 0;
    await b.output.stop("sample");
    expect(seen.filter((s) => s.url.endsWith("/cancel")).map((s) => s.url)).toEqual(["/v1/play/p2/cancel"]);
  });

  it("refuses a token shorter than 32 characters with a readable error", async () => {
    const b = createBridgeAudio({ url, token: "short-token" });
    expect(await b.health()).toMatchObject({ ok: false, reason: expect.stringMatching(/at least 32 characters/) });
    expect(await b.output.playStream(clip(), "message")).toMatchObject({ ok: false });
    expect(seen).toHaveLength(0);
  });
});

describe("record", () => {
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(40, 1)]);

  it("starts, stops and returns the WAV", async () => {
    handler = (r, res) => {
      if (r.url === "/v1/record/start") return send(res, 201, { id: "r1", max_seconds: 300 });
      if (r.url === "/v1/record/r1/stop") return send(res, 200, wav, "audio/wav");
      send(res, 404, { error: "no" });
    };
    const rec = await createBridgeAudio({ url, token: TOKEN }).input.start();
    const out = await rec.stop();
    expect(out.format).toBe("wav");
    expect(out.audio.equals(wav)).toBe(true);
    expect(seen.every((s) => s.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("cancel() posts /cancel", async () => {
    handler = (r, res) =>
      r.url === "/v1/record/start"
        ? send(res, 201, { id: "r1", max_seconds: 300 })
        : send(res, 200, { id: "r1", state: "cancelled" });
    const rec = await createBridgeAudio({ url, token: TOKEN }).input.start();
    await rec.cancel();
    expect(seen[1]).toMatchObject({ method: "POST", url: "/v1/record/r1/cancel" });
  });

  it.each([
    [409, "a recording is already active"],
    [503, "no such audio device"],
    [401, "unauthorized"],
  ])("start: %i becomes an Error with the receiver's message", async (status, msg) => {
    handler = (_r, res) => send(res, status, { error: msg });
    await expect(createBridgeAudio({ url, token: TOKEN }).input.start()).rejects.toThrow(
      new RegExp(`${status}.*${msg}`),
    );
  });

  it("stop: 422 becomes an Error with the receiver's message", async () => {
    handler = (r, res) =>
      r.url === "/v1/record/start"
        ? send(res, 201, { id: "r1", max_seconds: 300 })
        : send(res, 422, { error: "recording too short" });
    const rec = await createBridgeAudio({ url, token: TOKEN }).input.start();
    await expect(rec.stop()).rejects.toThrow(/422.*recording too short/);
  });

  it("stop: refuses a body that is not a WAV", async () => {
    handler = (r, res) =>
      r.url === "/v1/record/start"
        ? send(res, 201, { id: "r1", max_seconds: 300 })
        : send(res, 200, Buffer.from("nope"), "audio/wav");
    const rec = await createBridgeAudio({ url, token: TOKEN }).input.start();
    await expect(rec.stop()).rejects.toThrow(/WAV/);
  });

  it("start: unreachable becomes an Error saying so", async () => {
    await expect(createBridgeAudio({ url: "http://127.0.0.1:1", token: TOKEN }).input.start()).rejects.toThrow(
      /not reachable/,
    );
  });
});

describe("a Stream", () => {
  /** A receiver that sees the audio of a Stream as it arrives. */
  async function streamReceiver(opts: { capabilities?: string[]; streamStatus?: number } = {}) {
    const got: Buffer[] = [];
    const asked: Array<{ url: string; body?: string; kind?: string }> = [];
    let audioEnded = false;
    let state = "playing";
    const srv = createServer((req, res) => {
      const u = req.url ?? "";
      asked.push({ url: u, kind: req.headers["x-pi-speech-kind"] as string | undefined });
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: "unauthorized" });
      if (u === "/v1/play/s1/audio") {
        req.on("data", (c: Buffer) => got.push(c));
        req.on("end", () => {
          audioEnded = true;
          send(res, 200, { id: "s1", state });
        });
        req.on("error", () => {});
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        asked[asked.length - 1].body = Buffer.concat(chunks).toString();
        if (u === "/v1/health") {
          return send(res, 200, {
            protocol: 1,
            name: "pi-speech-receiver",
            version: "0.2.0",
            capabilities: opts.capabilities ?? ["play", "record", "stream"],
          });
        }
        if (u === "/v1/play/stream") {
          if (opts.streamStatus === 503) return send(res, 503, { error: "no player for a Stream: install pacat" });
          if (opts.streamStatus === 400) return send(res, 400, { error: "rate must be 8000..=192000" });
          return send(res, 202, { id: "s1" });
        }
        if (u === "/v1/play/s1/cancel") {
          state = "cancelled";
          return send(res, 200, { id: "s1", state });
        }
        if (u.startsWith("/v1/play/s1")) {
          const wait = () =>
            state === "playing" && !audioEnded
              ? setTimeout(wait, 10)
              : send(res, 200, { id: "s1", state: state === "playing" ? "completed" : state });
          return wait();
        }
        send(res, 404, { error: "not found" });
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    return {
      at,
      got,
      asked,
      bytes: () => Buffer.concat(got).length,
      ended: () => audioEnded,
      close: async () => {
        srv.closeAllConnections();
        await new Promise((r) => srv.close(r));
      },
    };
  }

  /** A Stream fed by hand. */
  function hand() {
    const queue: Uint8Array[] = [];
    let ended = false;
    let wake: (() => void) | undefined;
    const reads = { n: 0 };
    async function* chunks() {
      reads.n++;
      while (true) {
        if (queue.length) yield queue.shift()!;
        else if (ended) return;
        else await new Promise<void>((r) => (wake = r));
      }
    }
    const poke = () => {
      const w = wake;
      wake = undefined;
      w?.();
    };
    return {
      reads,
      stream: { format: { codec: "pcm" as const, rate: 24000, channels: 1 }, chunks: chunks() },
      send: (b: Uint8Array) => {
        queue.push(b);
        poke();
      },
      end: () => {
        ended = true;
        poke();
      },
    };
  }

  const until = async (cond: () => boolean) => {
    const end = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > end) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it("starts the receiver's player with the format, then sends the audio as it arrives", async () => {
    const rx = await streamReceiver();
    const out = createBridgeAudio({ url: rx.at, token: TOKEN }).output;
    const h = hand();
    const r = await out.playStream(h.stream, "sample");
    if (!r.ok) throw new Error(r.reason);
    expect(r.player).toBe("pi-speech-receiver");
    const start = rx.asked.find((a) => a.url === "/v1/play/stream");
    expect(JSON.parse(start?.body ?? "")).toEqual({ format: "pcm", rate: 24000, channels: 1 });
    expect(start?.kind).toBe("sample");
    h.send(Buffer.alloc(1000, 1));
    await until(() => rx.bytes() === 1000);
    expect(rx.ended()).toBe(false);
    h.send(Buffer.alloc(500, 2));
    h.end();
    expect(await r.done).toEqual({ state: "completed" });
    expect(rx.bytes()).toBe(1500);
    await rx.close();
  });

  it("an older receiver without the stream capability is an error that says to update it, not a fallback", async () => {
    const rx = await streamReceiver({ capabilities: ["play", "record"] });
    const out = createBridgeAudio({ url: rx.at, token: TOKEN }).output;
    const h = hand();
    const r = await out.playStream(h.stream, "message");
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/Remote machine .*update pi-speech-receiver/) });
    expect(h.reads.n).toBe(0);
    expect(rx.asked.map((a) => a.url)).toEqual(["/v1/health"]);
    // Asked again next time: it may have been updated since.
    await out.playStream(hand().stream, "message");
    expect(rx.asked.map((a) => a.url)).toEqual(["/v1/health", "/v1/health"]);
    await rx.close();
  });

  it("a receiver that cannot start the player (503) fails with its reason; nothing is sent as a file", async () => {
    const rx = await streamReceiver({ streamStatus: 503 });
    const out = createBridgeAudio({ url: rx.at, token: TOKEN }).output;
    const r = await out.playStream(hand().stream, "message");
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/503.*install pacat/) });
    expect(rx.asked.some((a) => a.url === "/v1/play")).toBe(false);
    await rx.close();
  });

  it("a format the receiver refuses (400) fails with its reason", async () => {
    const rx = await streamReceiver({ streamStatus: 400 });
    const out = createBridgeAudio({ url: rx.at, token: TOKEN }).output;
    const r = await out.playStream(hand().stream, "message");
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/400.*rate must be/) });
    await rx.close();
  });

  it("stop() cancels the playback on the receiver and ends the upload", async () => {
    const rx = await streamReceiver();
    const out = createBridgeAudio({ url: rx.at, token: TOKEN }).output;
    const h = hand();
    const r = await out.playStream(h.stream, "message");
    if (!r.ok) throw new Error(r.reason);
    h.send(Buffer.alloc(100));
    await until(() => rx.bytes() === 100);
    await r.stop();
    expect(await r.done).toEqual({ state: "cancelled" });
    expect(rx.asked.some((a) => a.url === "/v1/play/s1/cancel")).toBe(true);
    await rx.close();
  });
});
