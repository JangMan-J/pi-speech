import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBridgeAudio } from "../../src/bridge/index";

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

const file = (name: string, bytes = "RIFFxxxxWAVEdata") => {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
};

describe("health", () => {
  it("returns the version and sends the token only in Authorization", async () => {
    handler = (_r, res) =>
      send(res, 200, { protocol: 1, name: "pi-speech-receiver", version: "1.2.3", capabilities: ["play"] });
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

  it("rejects something that is not a pi-speech-receiver", async () => {
    handler = (_r, res) => send(res, 200, { hello: 1 });
    expect((await createBridgeAudio({ url, token: TOKEN }).health()).ok).toBe(false);
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
    const p = await b.output.play(file("a.wav"), "message");
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

describe("play", () => {
  it("uploads wav with its kind and follows to completion", async () => {
    let polls = 0;
    handler = (r, res) => {
      if (r.method === "POST" && r.url === "/v1/play") return send(res, 202, { id: "p1" });
      polls++;
      send(res, 200, { id: "p1", state: polls < 2 ? "playing" : "completed" });
    };
    const f = file("a.wav", "RIFF0000WAVEabc");
    const p = await createBridgeAudio({ url, token: TOKEN }).output.play(f, "sample");
    expect(p).toMatchObject({ ok: true, player: "pi-speech-receiver" });
    if (p.ok) expect(await p.done).toEqual({ state: "completed" });
    expect(seen[0].headers["content-type"]).toBe("audio/wav");
    expect(seen[0].headers["x-pi-speech-kind"]).toBe("sample");
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].body.toString()).toBe("RIFF0000WAVEabc");
    expect(seen[1].url).toMatch(/^\/v1\/play\/p1\?wait=\d+$/);
    expect(polls).toBe(2);
  });

  it("sends mp3 as audio/mpeg", async () => {
    handler = (_r, res) => send(res, 202, { id: "p1" });
    await createBridgeAudio({ url, token: TOKEN }).output.play(file("a.mp3", "ID3"), "message");
    expect(seen[0].headers["content-type"]).toBe("audio/mpeg");
    expect(seen[0].headers["x-pi-speech-kind"]).toBe("message");
  });

  it("does not play other file types", async () => {
    const p = await createBridgeAudio({ url, token: TOKEN }).output.play(file("a.ogg"), "message");
    expect(p.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it("returns the receiver's message when it cannot start", async () => {
    handler = (_r, res) => send(res, 503, { error: "no audio player found" });
    const p = await createBridgeAudio({ url, token: TOKEN }).output.play(file("a.wav"), "message");
    expect(p).toMatchObject({ ok: false, reason: expect.stringMatching(/503.*no audio player found/) });
  });

  it("returns a reason when the receiver is not reachable", async () => {
    const p = await createBridgeAudio({ url: "http://127.0.0.1:1", token: TOKEN }).output.play(
      file("a.wav"),
      "message",
    );
    expect(p).toMatchObject({ ok: false, reason: expect.stringMatching(/not reachable at http:\/\/127\.0\.0\.1:1/) });
  });

  it("ends as failed with the receiver's error", async () => {
    handler = (r, res) =>
      r.method === "POST"
        ? send(res, 202, { id: "p1" })
        : send(res, 200, { state: "failed", error: "player exited 1" });
    const p = await createBridgeAudio({ url, token: TOKEN }).output.play(file("a.wav"), "message");
    if (p.ok) expect(await p.done).toEqual({ state: "failed", error: "player exited 1" });
  });

  it("ends as failed when contact is lost", async () => {
    handler = (r, res) => {
      if (r.method === "POST") return send(res, 202, { id: "p1" });
      res.socket?.destroy();
    };
    const p = await createBridgeAudio({ url, token: TOKEN }).output.play(file("a.wav"), "message");
    expect(p.ok).toBe(true);
    if (p.ok) {
      const o = await p.done;
      expect(o.state).toBe("failed");
      expect(JSON.stringify(o)).not.toContain(TOKEN);
    }
  });

  it("stop() cancels that playback", async () => {
    let cancelled = false;
    handler = (r, res) => {
      if (r.url === "/v1/play") return send(res, 202, { id: "p9" });
      if (r.url === "/v1/play/p9/cancel") {
        cancelled = true;
        return send(res, 200, { id: "p9", state: "cancelled" });
      }
      setTimeout(() => send(res, 200, { state: cancelled ? "cancelled" : "playing" }), 20);
    };
    const p = await createBridgeAudio({ url, token: TOKEN }).output.play(file("a.wav"), "message");
    if (!p.ok) throw new Error("not started");
    await p.stop();
    expect(await p.done).toEqual({ state: "cancelled" });
    expect(seen.some((s) => s.method === "POST" && s.url === "/v1/play/p9/cancel")).toBe(true);
  });

  it("output.stop() posts /v1/stop; stop(kind) cancels only that kind", async () => {
    let n = 0;
    handler = (r, res) => {
      if (r.url === "/v1/play") return send(res, 202, { id: `p${++n}` });
      if (r.url === "/v1/stop") return send(res, 200, { stopped: 1 });
      if (r.method === "POST") return send(res, 200, { state: "cancelled" });
      // polls stay open
    };
    const b = createBridgeAudio({ url, token: TOKEN });
    await b.output.play(file("m.wav"), "message");
    await b.output.play(file("s.wav"), "sample");
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
    handler = (r, res) => {
      if (r.url === "/v1/play") return send(res, 202, { id: `p${++n}` });
      if (r.url === "/v1/play/p1/cancel") return send(res, 404, { error: "unknown id" });
      if (r.method === "POST") return send(res, 200, { state: "cancelled" });
    };
    const b = createBridgeAudio({ url, token: TOKEN });
    await b.output.play(file("a.wav"), "sample");
    await b.output.play(file("b.wav"), "sample");
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
    expect(await b.output.play(file("a.wav"), "message")).toMatchObject({ ok: false });
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
    const r = await out.playStream!(h.stream, "sample");
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

  it("an older receiver without the stream capability cannot play it; nothing of the Stream is read", async () => {
    const rx = await streamReceiver({ capabilities: ["play", "record"] });
    const out = createBridgeAudio({ url: rx.at, token: TOKEN }).output;
    const h = hand();
    const r = await out.playStream!(h.stream, "message");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.cannotStream).toBe(true);
    expect(!r.ok && r.reason).toMatch(/update pi-speech-receiver/);
    expect(h.reads.n).toBe(0);
    expect(out.canStream!({ codec: "pcm", rate: 24000, channels: 1 }).ok).toBe(false);
    await rx.close();
  });

  it("a receiver with no player for a Stream (503) cannot play it, with the receiver's reason", async () => {
    const rx = await streamReceiver({ streamStatus: 503 });
    const out = createBridgeAudio({ url: rx.at, token: TOKEN }).output;
    const r = await out.playStream!(hand().stream, "message");
    expect(!r.ok && r.cannotStream).toBe(true);
    expect(!r.ok && r.reason).toMatch(/install pacat/);
    await rx.close();
  });

  it("a format the receiver refuses (400) cannot play as a Stream; it is not asked again for a while", async () => {
    const rx = await streamReceiver({ streamStatus: 400 });
    const out = createBridgeAudio({ url: rx.at, token: TOKEN }).output;
    const r = await out.playStream!(hand().stream, "message");
    expect(!r.ok && r.cannotStream).toBe(true);
    expect(out.canStream!({ codec: "pcm", rate: 24000, channels: 1 }).ok).toBe(false);
    expect(out.canStream!({ codec: "mp3" }).ok).toBe(true);
    await rx.close();
  });

  it("stop() cancels the playback on the receiver and ends the upload", async () => {
    const rx = await streamReceiver();
    const out = createBridgeAudio({ url: rx.at, token: TOKEN }).output;
    const h = hand();
    const r = await out.playStream!(h.stream, "message");
    if (!r.ok) throw new Error(r.reason);
    h.send(Buffer.alloc(100));
    await until(() => rx.bytes() === 100);
    await r.stop();
    expect(await r.done).toEqual({ state: "cancelled" });
    expect(rx.asked.some((a) => a.url === "/v1/play/s1/cancel")).toBe(true);
    await rx.close();
  });
});
