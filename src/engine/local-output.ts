/**
 * Playback on this machine. Every playback is a Stream (GLOSSARY.md), fed to one player process on its stdin as
 * it arrives. The player is, in order:
 *   1. `PI_SPEECH_STREAM_PLAYER`, when set: an executable run as `<player> s16le <rate> <channels>` for raw PCM
 *      and `<player> mp3` or `<player> wav` for those files.
 *   2. The bundled binary (binary.ts), run as `pi-speech-receiver play` with the same arguments.
 *   3. Without the bundled binary: for PCM the first available of pacat, pw-cat, ffplay, mpv, aplay, and for MP3
 *      or WAV of ffplay, mpv, mpg123 (MP3 only).
 * Playback never blocks. Derived from pi-openrouter-multimodal (MIT).
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AudioOutput, PlayKind, PlayOutcome, PlayStart } from "./audio";
import { type BinaryChoice, findBinary } from "./binary";
import { childEnv, type Env, errorMessage, findExecutable } from "./env";
import type { AudioStream, PcmFormat, StreamFormat } from "./provider";

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

export type StreamPlayerChoice =
  | { ok: true; name: string; bin: string; args: string[] }
  | { ok: false; reason: string };

/** The player of a Stream in `format`, or why there is none. */
export function chooseStreamPlayer(
  env: Env,
  format: StreamFormat,
  binary: () => BinaryChoice = () => findBinary(env),
): StreamPlayerChoice {
  const args = format.codec === "pcm" ? ["s16le", `${format.rate}`, `${format.channels}`] : [format.codec];
  const custom = env.PI_SPEECH_STREAM_PLAYER;
  if (custom) {
    const bin = findExecutable(custom, env);
    if (!bin) return { ok: false, reason: `PI_SPEECH_STREAM_PLAYER (${custom}) is not an executable` };
    return { ok: true, name: custom, bin, args };
  }
  const bundled = binary();
  if (bundled.ok) return { ok: true, name: "pi-speech-receiver", bin: bundled.path, args: ["play", ...args] };
  if (bundled.chosen) return { ok: false, reason: bundled.reason };
  if (format.codec === "pcm") {
    for (const [name, args] of STREAM_PLAYERS) {
      const bin = findExecutable(name, env);
      if (bin) return { ok: true, name, bin, args: args(format) };
    }
    const names = STREAM_PLAYERS.map(([n]) => n).join(", ");
    return { ok: false, reason: `no audio player found: ${bundled.reason}, and none of ${names} is installed` };
  }
  const players = FILE_STREAM_PLAYERS.filter(([, formats]) => formats.includes(format.codec));
  for (const [name, , args] of players) {
    const bin = findExecutable(name, env);
    if (bin) return { ok: true, name, bin, args };
  }
  const names = players.map(([n]) => n).join(", ");
  return {
    ok: false,
    reason: `no player for ${format.codec.toUpperCase()} audio found: ${bundled.reason}, and none of ${names} is installed`,
  };
}

function kill(c: ChildProcess): void {
  if (!c.pid || c.exitCode !== null || c.signalCode !== null) return;
  try {
    // The player's whole process group on Unix; Windows has none, and kill() ends the process there.
    if (process.platform === "win32") c.kill();
    else process.kill(-c.pid, "SIGTERM");
  } catch {
    try {
      c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

export interface LocalOutputOptions {
  /** Where the bundled binary is; replaceable for tests. */
  binary?: () => BinaryChoice;
}

/** Plays on this machine, each Stream in its own player process. */
export class LocalOutput implements AudioOutput {
  readonly name = "local";
  private readonly playing = new Map<ChildProcess, PlayKind>();
  private readonly stopped = new WeakSet<ChildProcess>();

  constructor(
    private readonly env: Env,
    private readonly opts: LocalOutputOptions = {},
  ) {}

  async playStream(stream: AudioStream, kind: PlayKind): Promise<PlayStart> {
    const choice = chooseStreamPlayer(this.env, stream.format, this.opts.binary);
    if (!choice.ok) return choice;
    return this.launch(choice.name, choice.bin, choice.args, kind, stream.chunks);
  }

  async stop(kind?: PlayKind): Promise<void> {
    for (const [child, k] of this.playing) {
      if (kind && k !== kind) continue;
      this.stopped.add(child);
      kill(child);
    }
  }

  /** Start `bin` with `args`; the chunks of `input` are written to the player's stdin as they arrive. */
  private launch(
    name: string,
    bin: string,
    args: string[],
    kind: PlayKind,
    input: AsyncIterable<Uint8Array>,
  ): PlayStart {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        // Its own process group on Unix, so stop() ends whatever the player starts; on Windows that would
        // open a console window instead.
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
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
    if (child.stdin) void this.feed(child, input, () => exited || this.stopped.has(child));
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
