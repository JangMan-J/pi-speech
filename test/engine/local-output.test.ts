import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { choosePlayer, LocalOutput } from "../../src/engine/local-output";

describe("local playback", () => {
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
});
