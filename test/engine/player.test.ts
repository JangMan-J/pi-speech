import { describe, expect, it } from "vitest";
import type { AudioOutput, PlayKind, PlayOutcome, PlayStart } from "../../src/engine/audio";
import { Player, REPLACED } from "../../src/engine/player";

/** An output whose playbacks end only when told to. */
function fakeOutput(name = "fake") {
  const log: string[] = [];
  const endings: Array<(o: PlayOutcome) => void> = [];
  let refuse: string | undefined;
  const output: AudioOutput = {
    name,
    async play(file: string, kind: PlayKind): Promise<PlayStart> {
      if (refuse) return { ok: false, reason: refuse };
      log.push(`play ${name} ${kind} ${file}`);
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
          log.push(`stop ${name} ${file}`);
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
    await p.play("a.wav", "message");
    await p.play("b.wav", "sample");
    expect(f.log).toEqual(["play fake message a.wav", "stop fake a.wav", "play fake sample b.wav"]);
    expect(p.playing).toBe(true);
  });

  it("replaces a playback on another route too", async () => {
    const local = fakeOutput("local");
    const bridge = fakeOutput("bridge");
    let route = local.output;
    const p = new Player(() => route);
    await p.play("a.wav", "message");
    route = bridge.output;
    await p.play("b.wav", "message");
    expect(local.log).toEqual(["play local message a.wav", "stop local a.wav"]);
    expect(bridge.log).toEqual(["play bridge message b.wav"]);
  });

  it("stop stops the playback and cancels plays still being prepared", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    await p.play("a.wav", "message");
    const ticket = p.claim();
    expect(await p.stop()).toBe(true);
    expect(p.playing).toBe(false);
    let cleaned = false;
    const late = await p.play("b.wav", "message", { ticket, cleanup: () => (cleaned = true) });
    expect(late.ok).toBe(false);
    expect(cleaned).toBe(true);
    expect(f.log).toEqual(["play fake message a.wav", "stop fake a.wav", "stop-all fake"]);
  });

  it("a newer ticket wins over an older one that arrives later", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    const first = p.claim();
    const second = p.claim();
    await p.play("second.wav", "message", { ticket: second });
    const r = await p.play("first.wav", "message", { ticket: first });
    expect(r.ok).toBe(false);
    expect(f.log).toEqual(["play fake message second.wav"]);
  });

  it("reports its state and a failed playback once", async () => {
    const f = fakeOutput();
    const states: boolean[] = [];
    const failures: string[] = [];
    const p = new Player(() => f.output, {
      onChange: (s) => states.push(s),
      onFailed: (e) => failures.push(e),
    });
    await p.play("a.wav", "message");
    await p.play("b.wav", "message");
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
    const r = await p.play("a.wav", "message");
    expect(r).toEqual({ ok: false, reason: "receiver down" });
    expect(failures).toEqual([]);
  });

  it("remembers the last message for replay, not samples", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    await p.play("m.wav", "message");
    await p.play("s.wav", "sample");
    expect(p.lastMessage).toBe("m.wav");
  });

  it("cleans up after the playback ends", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    let cleaned = 0;
    await p.play("s.wav", "sample", { cleanup: () => cleaned++ });
    f.end(0, { state: "completed" });
    await tick();
    expect(cleaned).toBe(1);
  });
});

describe("a reading: pieces played as one playback", () => {
  it("plays pieces one after another and stays playing between them until it ends", async () => {
    const f = fakeOutput();
    const states: boolean[] = [];
    const p = new Player(() => f.output, { onChange: (s) => states.push(s) });
    const r = p.read();
    expect(p.playing).toBe(false);
    expect((await r.play("1.wav")).ok).toBe(true);
    f.end(0, { state: "completed" });
    await tick();
    expect(p.playing).toBe(true);
    expect((await r.play("2.wav")).ok).toBe(true);
    f.end(1, { state: "completed" });
    await tick();
    expect(p.playing).toBe(true);
    r.end();
    expect(p.playing).toBe(false);
    expect(states.at(-1)).toBe(false);
    expect(states.filter((s) => !s)).toEqual([false]);
    expect(f.log).toEqual(["play fake message 1.wav", "play fake message 2.wav"]);
  });

  it("does not offer its pieces for replay", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    await p.play("m.wav", "message");
    await p.read().play("piece.wav");
    expect(p.lastMessage).toBe("m.wav");
  });

  it("a stop between pieces ends the reading at once and cancels its later pieces", async () => {
    const f = fakeOutput();
    const states: boolean[] = [];
    const p = new Player(() => f.output, { onChange: (s) => states.push(s) });
    const r = p.read();
    await r.play("1.wav");
    f.end(0, { state: "completed" });
    await tick();
    expect(await p.stop()).toBe(true);
    expect(p.playing).toBe(false);
    expect(states.at(-1)).toBe(false);
    expect(r.current).toBe(false);
    expect(r.signal.aborted).toBe(true);
    let cleaned = false;
    const late = await r.play("2.wav", () => (cleaned = true));
    expect(late).toEqual({ ok: false, reason: REPLACED });
    expect(cleaned).toBe(true);
    expect(f.log).toEqual(["play fake message 1.wav", "stop-all fake"]);
  });

  it("a stop during a piece stops it", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    const r = p.read();
    await r.play("1.wav");
    await p.stop();
    expect(r.signal.aborted).toBe(true);
    expect(f.log).toEqual(["play fake message 1.wav", "stop fake 1.wav", "stop-all fake"]);
  });

  it("a newer claim ends the reading; its piece plays on until the newer audio replaces it", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    const r = p.read();
    await r.play("1.wav");
    const ticket = p.claim();
    expect(r.signal.aborted).toBe(true);
    expect(p.playing).toBe(true);
    expect((await r.play("2.wav")).ok).toBe(false);
    await p.play("new.wav", "message", { ticket });
    expect(f.log).toEqual(["play fake message 1.wav", "stop fake 1.wav", "play fake message new.wav"]);
  });

  it("a replay ends the reading", async () => {
    const f = fakeOutput();
    const p = new Player(() => f.output);
    const r = p.read();
    await r.play("1.wav");
    f.end(0, { state: "completed" });
    await tick();
    await p.play("saved.wav", "message");
    expect(r.current).toBe(false);
    expect((await r.play("2.wav")).ok).toBe(false);
    expect(f.log).toEqual(["play fake message 1.wav", "play fake message saved.wav"]);
  });

  it("a piece whose start finishes after a stop is stopped at once", async () => {
    const f = fakeOutput();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: AudioOutput = {
      name: "slow",
      play: async (file, kind) => {
        await gate;
        return f.output.play(file, kind);
      },
      stop: () => f.output.stop(),
    };
    const p = new Player(() => slow);
    const r = p.read();
    const starting = r.play("1.wav");
    await p.stop();
    release();
    expect(await starting).toEqual({ ok: false, reason: REPLACED });
    expect(p.playing).toBe(false);
    expect(f.log).toEqual(["stop-all fake", "play fake message 1.wav", "stop fake 1.wav"]);
  });
});
