/**
 * Playback on the Pi host. Files: `PI_SPEECH_PLAYER`, when set, names an executable run as
 * `<player> <audio file>`; otherwise the first available of mpv, ffplay, paplay, pw-play, mpg123.
 * A Stream, fed on stdin as it arrives: `PI_SPEECH_STREAM_PLAYER`, when set, names an executable run as
 * `<player> s16le <rate> <channels>` for raw PCM and `<player> mp3` or `<player> wav` for those files;
 * otherwise for PCM the first available of pacat, pw-cat, ffplay, mpv, aplay, and for MP3 or WAV of ffplay,
 * mpv, mpg123 (MP3 only). A `PI_SPEECH_PLAYER` without `PI_SPEECH_STREAM_PLAYER` is kept to: a Stream then
 * cannot play here.
 * Playback never blocks. Derived from pi-openrouter-multimodal (MIT).
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AudioOutput, PlayKind, PlayOutcome, PlayStart } from "./audio";
import { childEnv, type Env, errorMessage, findExecutable } from "./env";
import type { AudioStream, PcmFormat, StreamFormat } from "./provider";

const PLAYERS: ReadonlyArray<readonly [string, (file: string) => string[]]> = [
  ["mpv", (f) => ["--no-video", "--really-quiet", f]],
  ["ffplay", (f) => ["-nodisp", "-autoexit", "-loglevel", "quiet", f]],
  ["paplay", (f) => [f]],
  ["pw-play", (f) => [f]],
  ["mpg123", (f) => ["-q", f]],
];

/** Players of raw signed 16-bit little-endian PCM on stdin; each exits once its input has ended and played. */
const STREAM_PLAYERS: ReadonlyArray<readonly [string, (f: PcmFormat) => string[]]> = [
  ["pacat", (f) => ["--playback", "--format=s16le", `--rate=${f.rate}`, `--channels=${f.channels}`]],
  [
    "pw-cat",
    (f) => ["--playback", "--raw", "--format", "s16", "--rate", `${f.rate}`, "--channels", `${f.channels}`, "-"],
  ],
  [
    "ffplay",
    (f) => [
      ...["-nodisp", "-autoexit", "-loglevel", "quiet", "-f", "s16le", "-ar", `${f.rate}`],
      ...["-ch_layout", f.channels === 1 ? "mono" : "stereo", "-i", "-"],
    ],
  ],
  [
    "mpv",
    (f) => [
      ...["--no-video", "--really-quiet", "--demuxer=rawaudio", "--demuxer-rawaudio-format=s16le"],
      ...[`--demuxer-rawaudio-rate=${f.rate}`, `--demuxer-rawaudio-channels=${f.channels}`, "-"],
    ],
  ],
  ["aplay", (f) => ["-q", "-t", "raw", "-f", "S16_LE", "-r", `${f.rate}`, "-c", `${f.channels}`]],
];

/** Players of an MP3 or WAV file on stdin; `formats` are the ones each decodes. */
const FILE_STREAM_PLAYERS: ReadonlyArray<readonly [string, ReadonlyArray<string>, string[]]> = [
  ["ffplay", ["mp3", "wav"], ["-nodisp", "-autoexit", "-loglevel", "quiet", "-i", "-"]],
  ["mpv", ["mp3", "wav"], ["--no-video", "--really-quiet", "-"]],
  ["mpg123", ["mp3"], ["-q", "-"]],
];

export type PlayerChoice =
  | { ok: true; name: string; bin: string; args: (file: string) => string[] }
  | { ok: false; reason: string };

export type StreamPlayerChoice =
  | { ok: true; name: string; bin: string; args: string[] }
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

/** The player of a Stream in `format`, or why there is none. */
export function chooseStreamPlayer(env: Env, format: StreamFormat): StreamPlayerChoice {
  const custom = env.PI_SPEECH_STREAM_PLAYER;
  if (custom) {
    const bin = findExecutable(custom, env);
    if (!bin) return { ok: false, reason: `PI_SPEECH_STREAM_PLAYER (${custom}) is not an executable` };
    const args = format.codec === "pcm" ? ["s16le", `${format.rate}`, `${format.channels}`] : [format.codec];
    return { ok: true, name: custom, bin, args };
  }
  if (env.PI_SPEECH_PLAYER) {
    return {
      ok: false,
      reason: "PI_SPEECH_PLAYER plays files only; set PI_SPEECH_STREAM_PLAYER to play speech as it arrives",
    };
  }
  if (format.codec === "pcm") {
    for (const [name, args] of STREAM_PLAYERS) {
      const bin = findExecutable(name, env);
      if (bin) return { ok: true, name, bin, args: args(format) };
    }
    const names = STREAM_PLAYERS.map(([n]) => n).join(", ");
    return { ok: false, reason: `no player for speech as it arrives (install one of ${names})` };
  }
  const players = FILE_STREAM_PLAYERS.filter(([, formats]) => formats.includes(format.codec));
  for (const [name, , args] of players) {
    const bin = findExecutable(name, env);
    if (bin) return { ok: true, name, bin, args };
  }
  const names = players.map(([n]) => n).join(", ");
  return {
    ok: false,
    reason: `no player for ${format.codec.toUpperCase()} speech as it arrives (install one of ${names})`,
  };
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

/** Plays on the Pi host, each file or Stream in its own player process. */
export class LocalOutput implements AudioOutput {
  readonly name = "local";
  private readonly playing = new Map<ChildProcess, PlayKind>();
  private readonly stopped = new WeakSet<ChildProcess>();

  constructor(private readonly env: Env) {}

  async play(file: string, kind: PlayKind): Promise<PlayStart> {
    const choice = choosePlayer(this.env);
    if (!choice.ok) return choice;
    return this.launch(choice.name, choice.bin, choice.args(file), kind);
  }

  canStream(format: StreamFormat): { ok: true } | { ok: false; reason: string } {
    const choice = chooseStreamPlayer(this.env, format);
    return choice.ok ? { ok: true } : choice;
  }

  async playStream(stream: AudioStream, kind: PlayKind): Promise<PlayStart> {
    const choice = chooseStreamPlayer(this.env, stream.format);
    if (!choice.ok) return { ...choice, cannotStream: true };
    return this.launch(choice.name, choice.bin, choice.args, kind, stream.chunks);
  }

  async stop(kind?: PlayKind): Promise<void> {
    for (const [child, k] of this.playing) {
      if (kind && k !== kind) continue;
      this.stopped.add(child);
      kill(child);
    }
  }

  /** Start `bin` with `args`; with `input`, its chunks are written to the player's stdin as they arrive. */
  private launch(
    name: string,
    bin: string,
    args: string[],
    kind: PlayKind,
    input?: AsyncIterable<Uint8Array>,
  ): PlayStart {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        detached: true,
        stdio: [input ? "pipe" : "ignore", "ignore", "ignore"],
        env: childEnv(this.env),
      });
    } catch (err) {
      return { ok: false, reason: `cannot start ${name}: ${errorMessage(err)}` };
    }
    child.unref();
    this.playing.set(child, kind);
    let exited = false;
    const done = new Promise<PlayOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: PlayOutcome) => {
        exited = true;
        if (settled) return;
        settled = true;
        this.playing.delete(child);
        resolve(outcome);
      };
      child.on("error", (err) => finish({ state: "failed", error: `cannot run ${name}: ${err.message}` }));
      child.on("exit", (code, signal) => {
        if (this.stopped.has(child)) finish({ state: "cancelled" });
        else if (code === 0) finish({ state: "completed" });
        else finish({ state: "failed", error: `${name} exited with ${code ?? signal}` });
      });
    });
    if (input && child.stdin) void this.feed(child, input, () => exited || this.stopped.has(child));
    return {
      ok: true,
      player: name,
      done,
      stop: async () => {
        this.stopped.add(child);
        kill(child);
        await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
      },
    };
  }

  /** Write the chunks to the player's stdin as they arrive, waiting when its pipe is full; end it after the last. */
  private async feed(child: ChildProcess, input: AsyncIterable<Uint8Array>, gone: () => boolean): Promise<void> {
    const stdin = child.stdin!;
    stdin.on("error", () => {}); // a player that exits early closes the pipe: its exit reports the outcome
    try {
      for await (const chunk of input) {
        if (gone() || stdin.destroyed) return;
        if (!stdin.write(chunk)) {
          await new Promise<void>((r) => {
            const go = () => {
              stdin.off("drain", go);
              stdin.off("close", go);
              r();
            };
            stdin.on("drain", go);
            stdin.on("close", go);
          });
        }
      }
      stdin.end();
    } catch {
      // The Stream broke off: whoever owns it reports why and stops this playback.
      stdin.end();
    }
  }
}
