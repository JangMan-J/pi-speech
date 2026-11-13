import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AudioOutput, PlayKind, PlayOutcome, PlayStart } from "../../src/engine/audio";
import { Player, REPLACED } from "../../src/engine/player";
import type { AudioStream } from "../../src/engine/provider";
import { wrapPcmAsWav } from "../../src/engine/wav";

/** A short PCM Stream named `tag` (the name shows in the log). */
function clip(tag: string): AudioStream {
  return {
    format: { codec: "pcm", rate: 24000, channels: 1 },
    chunks: (async function* () {
      yield new Uint8Array(480);
    })(),
    file: tag,
  };
}

/** An output whose playbacks end only when told to; it records what each Stream carried. */
function fakeOutput(name = "fake") {
  const log: string[] = [];
  const endings: Array<(o: PlayOutcome) => void> = [];
  const received: Array<{ format: AudioStream["format"]; bytes: number }> = [];
  let refuse: string | undefined;
  const output: AudioOutput = {
    name,
    async playStream(stream: AudioStream, kind: PlayKind): Promise<PlayStart> {
      if (refuse) return { ok: false, reason: refuse };
      const tag = stream.file ?? "stream";
      log.push(`play ${name} ${kind} ${tag}`);
      const got = { format: stream.format, bytes: 0 };
      received.push(got);
      void (async () => {
        for await (const c of stream.chunks) got.bytes += c.byteLength;
      })();
      let end!: (o: PlayOutcome) => void;
      const done = new Promise<PlayOutcome>((r) => {
        end = r;
      });
      endings.push(end);
      return {
        ok: true,
        player: name,
        done,
        stop: async () => {
          log.push(`stop ${name} ${tag}`);
          end({ state: "cancelled" });
        },
      };
    },
    async stop() {
      log.push(`stop-all ${name}`);
    },
  };
  return {
    output,
    log,
    received,
    end: (i: number, o: PlayOutcome) => endings[i](o),
    refuse: (r?: string) => {
      refuse = r;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the player", () => {
  it("plays one thing at a time: a new playback replaces the one in progress", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    await p.playStream(clip("a"), "message");
    await p.playStream(clip("b"), "sample");
    expect(f.log).toEqual(["play fake message a", "stop fake a", "play fake sample b"]);
    expect(p.playing).toBe(true);
  });

  it("replaces a playback on another route too", async () => {
    const local = fakeOutput("local");
    const bridge = fakeOutput("bridge");
    let route = local.output;
    const p = new Player(() => route);
    await p.playStream(clip("a"), "message");
    route = bridge.output;
    await p.playStream(clip("b"), "message");
    expect(local.log).toEqual(["play local message a", "stop local a"]);
    expect(bridge.log).toEqual(["play bridge message b"]);
  });

  it("stop stops the playback and cancels plays still being prepared", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    await p.playStream(clip("a"), "message");
    const ticket = p.claim();
    expect(await p.stop()).toBe(true);
    expect(p.playing).toBe(false);
    let cleaned = false;
    const late = await p.playStream(clip("b"), "message", { ticket, cleanup: () => (cleaned = true) });
    expect(late).toEqual({ ok: false, reason: REPLACED });
    expect(cleaned).toBe(true);
    expect(f.log).toEqual(["play fake message a", "stop fake a", "stop-all fake"]);
  });

  it("a newer ticket wins over an older one that arrives later", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    const first = p.claim();
    const second = p.claim();
    await p.playStream(clip("second"), "message", { ticket: second });
    const r = await p.playStream(clip("first"), "message", { ticket: first });
    expect(r.ok).toBe(false);
    expect(f.log).toEqual(["play fake message second"]);
  });

  it("reports its state and a failed playback once", async () => {
    const f = fakeOutput();
    const states: boolean[] = [];
    const failures: string[] = [];
    const p = new Player(() => f.output, {
      onChange: (s) => states.push(s),
      onFailed: (e) => failures.push(e),
    });
    await p.playStream(clip("a"), "message");
    await p.playStream(clip("b"), "message");
    f.end(1, { state: "failed", error: "no device" });
    await tick();
    expect(states).toEqual([true, true, false]);
    expect(failures).toEqual(["no device"]);
    expect(p.playing).toBe(false);
  });

  it("a playback that cannot start is returned, not reported as a failure", async () => {
    const f = fakeOutput();
    const failures: string[] = [];
    const p = new Player(() => f.output, { onFailed: (e) => failures.push(e) });
    f.refuse("receiver down");
    const r = await p.playStream(clip("a"), "message");
    expect(r).toEqual({ ok: false, reason: "receiver down" });
    expect(failures).toEqual([]);
  });

  it("cleans up after the playback ends", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    let cleaned = 0;
    await p.playStream(clip("s"), "sample", { cleanup: () => cleaned++ });
    f.end(0, { state: "completed" });
    await tick();
    expect(cleaned).toBe(1);
  });

  it("a Stream whose start finishes after a stop is stopped at once", async () => {
    const f = fakeOutput();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: AudioOutput = {
      name: "slow",
      playStream: async (stream, kind) => {
        await gate;
        return f.output.playStream(stream, kind);
      },
      stop: () => f.output.stop(),
    };
    const p = new Player(() => slow);
    const ticket = p.claim();
    const starting = p.playStream(clip("a"), "message", { ticket });
    await p.stop();
    release();
    expect(await starting).toEqual({ ok: false, reason: REPLACED });
    expect(p.playing).toBe(false);
    expect(f.log).toEqual(["stop-all fake", "play fake message a", "stop fake a"]);
  });
});

describe("replay: a saved message played as a Stream", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speech-player-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("feeds a saved WAV to the output as a PCM Stream of its samples", async () => {
    const file = join(dir, "m.wav");
    writeFileSync(file, wrapPcmAsWav(new Uint8Array(4800), 24000, 1));
    const f = fakeOutput();
    const p = new Player(() => f.output);
    const r = await p.play(file, "message");
    expect(r.ok).toBe(true);
    expect(f.log).toEqual([`play fake message ${file}`]);
    await tick();
    expect(f.received).toEqual([{ format: { codec: "pcm", rate: 24000, channels: 1 }, bytes: 4800 }]);
  });

  it("feeds a saved MP3 as an MP3 Stream, and remembers messages, not samples", async () => {
    const mp3 = join(dir, "m.mp3");
    writeFileSync(mp3, Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]));
    const wav = join(dir, "s.wav");
    writeFileSync(wav, wrapPcmAsWav(new Uint8Array(480), 24000, 1));
    const f = fakeOutput();
    const p = new Player(() => f.output);
    await p.play(mp3, "message");
    await p.play(wav, "sample");
    expect(f.received[0].format).toEqual({ codec: "mp3" });
    expect(p.lastMessage).toBe(mp3);
  });

  it("a file that cannot be read does not play, and says why", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    const r = await p.play(join(dir, "gone.wav"), "message");
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/cannot read .*gone\.wav: ENOENT/) });
    expect(f.log).toEqual([]);
  });
});
