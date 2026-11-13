import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { choosePlayer, chooseStreamPlayer, LocalOutput } from "../../src/engine/local-output";
import type { AudioStream, PcmFormat } from "../../src/engine/provider";
import { pcmBytes, until } from "./fixtures";

const PCM: PcmFormat = { codec: "pcm", rate: 24000, channels: 1 };

/** A Stream the test feeds by hand: `send` hands over a chunk, `end` ends it; `reads` counts pulls. */
function handStream() {
  const queue: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const state = { reads: 0 };
  async function* chunks() {
    state.reads++;
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
  const stream: AudioStream = { format: PCM, chunks: chunks() };
  return {
    stream,
    state,
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

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// The fakes here are shell scripts, which Windows cannot run. Windows coverage of playback and recording
// comes with the bundled binary (portable-package slice 4), run on the null audio device.
const onWindows = process.platform === "win32";

describe.skipIf(onWindows)("local playback", () => {
  let dir: string;
  const exe = (name: string, body = "exit 0") => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-speech-play-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses PI_SPEECH_PLAYER as `<player> <file>`", () => {
    const p = exe("myplayer");
    const c = choosePlayer({ PI_SPEECH_PLAYER: p, PATH: "" });
    expect(c.ok && c.bin).toBe(p);
    expect(c.ok && c.args("/a.wav")).toEqual(["/a.wav"]);
  });

  it("finds PI_SPEECH_PLAYER by name on PATH", () => {
    exe("myplayer");
    const c = choosePlayer({ PI_SPEECH_PLAYER: "myplayer", PATH: dir });
    expect(c.ok && c.bin).toBe(join(dir, "myplayer"));
  });

  it("reports a PI_SPEECH_PLAYER that is not an executable", () => {
    exe("mpv");
    const c = choosePlayer({ PI_SPEECH_PLAYER: join(dir, "missing"), PATH: dir });
    expect(!c.ok && c.reason).toMatch(/PI_SPEECH_PLAYER/);
  });

  it("takes the first available of mpv, ffplay, paplay, pw-play, mpg123", () => {
    exe("mpg123");
    exe("paplay");
    exe("pw-play");
    expect((choosePlayer({ PATH: dir }) as { name: string }).name).toBe("paplay");
    exe("ffplay");
    expect((choosePlayer({ PATH: dir }) as { name: string }).name).toBe("ffplay");
  });

  it("says why there is no player", () => {
    const c = choosePlayer({ PATH: dir });
    expect(!c.ok && c.reason).toMatch(/no audio player/i);
  });

  it("starts without waiting and reports completion", async () => {
    const log = join(dir, "log");
    const p = exe("slow", `sleep 0.3; echo "$1" >> "${log}"`);
    const out = new LocalOutput({ PI_SPEECH_PLAYER: p, PATH: "/usr/bin:/bin" });
    const started = Date.now();
    const r = await out.play("/some/file.wav", "message");
    expect(Date.now() - started).toBeLessThan(250);
    expect(r.ok).toBe(true);
    if (r.ok) expect(await r.done).toEqual({ state: "completed" });
    expect(readFileSync(log, "utf8").trim()).toBe("/some/file.wav");
  });

  it("a stopped playback ends cancelled; a failing player ends failed", async () => {
    const out = new LocalOutput({ PI_SPEECH_PLAYER: exe("long", "sleep 5"), PATH: "/usr/bin:/bin" });
    const r = await out.play("/a.wav", "message");
    if (!r.ok) throw new Error(r.reason);
    await r.stop();
    expect(await r.done).toEqual({ state: "cancelled" });
    const bad = new LocalOutput({ PI_SPEECH_PLAYER: exe("bad", "exit 4"), PATH: "/usr/bin:/bin" });
    const b = await bad.play("/a.wav", "message");
    if (!b.ok) throw new Error(b.reason);
    expect(await b.done).toMatchObject({ state: "failed" });
  });

  it("never hands the OpenRouter key or the bridge token to the player", async () => {
    const log = join(dir, "env");
    const p = exe("envdump", `env > "${log}"`);
    const out = new LocalOutput({
      PI_SPEECH_PLAYER: p,
      PATH: "/usr/bin:/bin",
      OPENROUTER_API_KEY: "sk-secret",
      PI_SPEECH_BRIDGE_TOKEN: "tok-secret",
    });
    const r = await out.play("/a.wav", "message");
    if (r.ok) await r.done;
    const env = readFileSync(log, "utf8");
    expect(env).not.toContain("sk-secret");
    expect(env).not.toContain("tok-secret");
  });

  describe("a Stream", () => {
    it("PI_SPEECH_STREAM_PLAYER runs as `<player> s16le <rate> <channels>`", () => {
      const p = exe("mystream");
      const c = chooseStreamPlayer({ PI_SPEECH_STREAM_PLAYER: p, PATH: "" }, PCM);
      expect(c.ok && c.bin).toBe(p);
      expect(c.ok && c.args).toEqual(["s16le", "24000", "1"]);
    });

    it("takes the first available of pacat, pw-cat, ffplay, mpv, aplay", () => {
      exe("aplay");
      exe("mpv");
      expect((chooseStreamPlayer({ PATH: dir }, PCM) as { name: string }).name).toBe("mpv");
      exe("pw-cat");
      expect((chooseStreamPlayer({ PATH: dir }, PCM) as { name: string }).name).toBe("pw-cat");
      exe("pacat");
      const c = chooseStreamPlayer({ PATH: dir }, PCM);
      expect(c.ok && c.name).toBe("pacat");
      expect(c.ok && c.args).toEqual(["--playback", "--format=s16le", "--rate=24000", "--channels=1"]);
    });

    it("an MP3 Stream goes to ffplay, mpv or mpg123, reading the file from stdin", () => {
      exe("pacat");
      exe("mpg123");
      const m = chooseStreamPlayer({ PATH: dir }, { codec: "mp3" });
      expect(m.ok && m.name).toBe("mpg123");
      expect(m.ok && m.args).toEqual(["-q", "-"]);
      exe("ffplay");
      expect((chooseStreamPlayer({ PATH: dir }, { codec: "mp3" }) as { name: string }).name).toBe("ffplay");
    });

    it("a WAV Stream that is not 16-bit PCM needs ffplay or mpv; mpg123 does not do WAV", () => {
      exe("mpg123");
      const c = chooseStreamPlayer({ PATH: dir }, { codec: "wav" });
      expect(!c.ok && c.reason).toMatch(/ffplay, mpv/);
    });

    it("PI_SPEECH_STREAM_PLAYER gets the file format of an MP3 Stream as its one argument", () => {
      const c = chooseStreamPlayer({ PI_SPEECH_STREAM_PLAYER: exe("mystream"), PATH: "" }, { codec: "mp3" });
      expect(c.ok && c.args).toEqual(["mp3"]);
    });

    it("keeps to PI_SPEECH_PLAYER, which plays files only, and says how to play a Stream", () => {
      exe("pacat");
      const c = chooseStreamPlayer({ PI_SPEECH_PLAYER: exe("myplayer"), PATH: dir }, PCM);
      expect(!c.ok && c.reason).toMatch(/PI_SPEECH_PLAYER/);
      expect(!c.ok && c.reason).toMatch(/PI_SPEECH_STREAM_PLAYER/);
    });

    it("says why there is no player for a Stream", () => {
      const c = chooseStreamPlayer({ PATH: dir }, PCM);
      expect(!c.ok && c.reason).toMatch(/pacat/);
    });

    it("without a player for a Stream it cannot start and reads nothing of the Stream", async () => {
      const h = handStream();
      const r = await new LocalOutput({ PATH: dir }).playStream(h.stream, "message");
      expect(r.ok).toBe(false);
      expect(!r.ok && r.cannotStream).toBe(true);
      expect(h.state.reads).toBe(0);
    });

    it("feeds each chunk to the player as it arrives and completes when the Stream ends", async () => {
      const got = join(dir, "got");
      const args = join(dir, "args");
      const p = exe("cat-player", `echo "$@" > "${args}"; cat > "${got}"`);
      const out = new LocalOutput({ PI_SPEECH_STREAM_PLAYER: p, PATH: "/usr/bin:/bin" });
      const h = handStream();
      const r = await out.playStream(h.stream, "message");
      if (!r.ok) throw new Error(r.reason);
      h.send(pcmBytes(1000));
      await until(() => existsSync(got) && statSync(got).size === 1000);
      h.send(pcmBytes(500, 1000));
      h.end();
      expect(await r.done).toEqual({ state: "completed" });
      expect(Array.from(readFileSync(got))).toEqual(Array.from(pcmBytes(1500)));
      expect(readFileSync(args, "utf8").trim()).toBe("s16le 24000 1");
    });

    it("stopped mid-Stream, it ends cancelled and the player process is gone", async () => {
      const pidFile = join(dir, "pid");
      const p = exe("cat-player", `echo $$ > "${pidFile}"; exec cat > /dev/null`);
      const out = new LocalOutput({ PI_SPEECH_STREAM_PLAYER: p, PATH: "/usr/bin:/bin" });
      const h = handStream();
      const r = await out.playStream(h.stream, "message");
      if (!r.ok) throw new Error(r.reason);
      h.send(pcmBytes(100));
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
      const pid = Number(readFileSync(pidFile, "utf8"));
      await r.stop();
      expect(await r.done).toEqual({ state: "cancelled" });
      await until(() => !alive(pid));
    });

    it("stop() of the output stops a Stream of that kind", async () => {
      const p = exe("cat-player", "exec cat > /dev/null");
      const out = new LocalOutput({ PI_SPEECH_STREAM_PLAYER: p, PATH: "/usr/bin:/bin" });
      const h = handStream();
      const r = await out.playStream(h.stream, "sample");
      if (!r.ok) throw new Error(r.reason);
      await out.stop("sample");
      expect(await r.done).toEqual({ state: "cancelled" });
    });

    it("a player that exits midway ends failed, while the Stream goes on", async () => {
      const p = exe("quitter", "head -c 10 > /dev/null; exit 3");
      const out = new LocalOutput({ PI_SPEECH_STREAM_PLAYER: p, PATH: "/usr/bin:/bin" });
      const h = handStream();
      const r = await out.playStream(h.stream, "message");
      if (!r.ok) throw new Error(r.reason);
      for (let i = 0; i < 20; i++) h.send(pcmBytes(70000));
      const outcome = await r.done;
      h.end();
      expect(outcome).toMatchObject({ state: "failed" });
    });
  });
});
