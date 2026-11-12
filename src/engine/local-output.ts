/**
 * Playback on the Pi host. `PI_SPEECH_PLAYER`, when set, names an executable run as `<player> <audio file>`;
 * otherwise the first available of mpv, ffplay, paplay, pw-play, mpg123. Playback never blocks.
 * Derived from pi-openrouter-multimodal (MIT).
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AudioOutput, PlayKind, PlayOutcome, PlayStart } from "./audio";
import { childEnv, type Env, findExecutable } from "./env";

const PLAYERS: ReadonlyArray<readonly [string, (file: string) => string[]]> = [
  ["mpv", (f) => ["--no-video", "--really-quiet", f]],
  ["ffplay", (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f]],
  ["paplay", (f) => [f]],
  ["pw-play", (f) => [f]],
  ["mpg123", (f) => ["-q", f]],
];

export type PlayerChoice =
  | { ok: true; name: string; bin: string; args: (file: string) => string[] }
  | { ok: false; reason: string };

export function choosePlayer(env: Env): PlayerChoice {
  const custom = env.PI_SPEECH_PLAYER;
  if (custom) {
    const bin = findExecutable(custom, env);
    if (!bin) return { ok: false, reason: `PI_SPEECH_PLAYER (${custom}) is not an executable` };
    return { ok: true, name: custom, bin, args: (f) => [f] };
  }
  for (const [name, args] of PLAYERS) {
    const bin = findExecutable(name, env);
    if (bin) return { ok: true, name, bin, args };
  }
  const names = PLAYERS.map(([n]) => n).join(", ");
  return { ok: false, reason: `no audio player found (set PI_SPEECH_PLAYER or install one of ${names})` };
}

function kill(c: ChildProcess): void {
  if (!c.pid || c.exitCode !== null || c.signalCode !== null) return;
  try {
    process.kill(-c.pid, "SIGTERM"); // the player's whole process group
  } catch {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

/** Plays on the Pi host, each file in its own player process. */
export class LocalOutput implements AudioOutput {
  readonly name = "local";
  private readonly playing = new Map<ChildProcess, PlayKind>();
  private readonly stopped = new WeakSet<ChildProcess>();

  constructor(private readonly env: Env) {}

  async play(file: string, kind: PlayKind): Promise<PlayStart> {
    const choice = choosePlayer(this.env);
    if (!choice.ok) return choice;
    let child: ChildProcess;
    try {
      child = spawn(choice.bin, choice.args(file), { detached: true, stdio: "ignore", env: childEnv(this.env) });
    } catch (err) {
      return { ok: false, reason: `cannot start ${choice.name}: ${err instanceof Error ? err.message : String(err)}` };
    }
    child.unref();
    this.playing.set(child, kind);
    const done = new Promise<PlayOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: PlayOutcome) => {
        if (settled) return;
        settled = true;
        this.playing.delete(child);
        resolve(outcome);
      };
      child.on("error", (err) => finish({ state: "failed", error: `cannot run ${choice.name}: ${err.message}` }));
      child.on("exit", (code, signal) => {
        if (this.stopped.has(child)) finish({ state: "cancelled" });
        else if (code === 0) finish({ state: "completed" });
        else finish({ state: "failed", error: `${choice.name} exited with ${code ?? signal}` });
      });
    });
    return {
      ok: true,
      player: choice.name,
      done,
      stop: async () => {
        this.stopped.add(child);
        kill(child);
        await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
      },
    };
  }

  async stop(kind?: PlayKind): Promise<void> {
    for (const [child, k] of this.playing) {
      if (kind && k !== kind) continue;
      this.stopped.add(child);
      kill(child);
    }
  }
}
