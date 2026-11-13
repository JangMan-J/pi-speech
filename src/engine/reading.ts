/**
 * A Reading: a long text spoken in pieces (see pieces.ts). One request per piece, the first asked
 * first and at most IN_FLIGHT at once; each piece plays once it is ready and the one before has finished,
 * all of them as one reading of the player. Every piece must come in the first piece's format (a WAV of the
 * same sample format, or MP3); once every piece is synthesized they are joined (WAV data under one header, MP3
 * frames one after another) and saved as one message.
 *
 * Any problem (a failed request, a piece that is not a readable WAV or MP3, or comes in another format) is a
 * failure: no later piece plays and nothing is saved. A stop or newer audio cancels the rest and saves nothing.
 * Pieces live in a private temporary directory, removed when the reading has ended.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Playback, PlayOutcome, PlayStart } from "./audio";
import { errorMessage } from "./env";
import type { SavedMessage } from "./history";
import type { Player, Reading } from "./player";
import { REPLACED } from "./player";
import type { SynthesizedAudio } from "./provider";
import { joinWav, wavFormat } from "./wav";

/** Speech requests in flight at once. */
export const IN_FLIGHT = 2;

export interface ReadingDeps {
  pieces: readonly string[];
  /** One speech request; throws a readable error (the provider's status or message). */
  synthesize(text: string, signal: AbortSignal, index: number): Promise<SynthesizedAudio>;
  player: Player;
  /** Saves the joined pieces as one message in the history. */
  save(audio: SynthesizedAudio): Promise<SavedMessage>;
  /** Where the reading's private temporary directory is made. */
  tmpRoot: string;
  /** Aborting it stops the reading, until the reading has ended. */
  signal?: AbortSignal;
}

export type ReadingResult =
  /** Every piece was synthesized and the message saved; `player` once the first piece started. */
  | { state: "saved"; saved: SavedMessage; player?: string; notPlayed?: string }
  /** Stopped or replaced before every piece was synthesized: nothing saved. */
  | { state: "stopped" };

/** A reading ended by a failure: no later piece plays and nothing was saved. `reason` says what failed. */
export class ReadingFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The one error shown for a failed reading: `who` stopped, why, and that `what` was not saved. */
export function readingFailedMessage(who: string, what: string, reason: string): string {
  return (
    `${who} stopped: ${reason.trim().replace(/\.+$/, "")}. The ${what} was not saved; ` +
    "try /speech --replay for the last saved message, or pick another speech model in /speech."
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  value?: T;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const d: Deferred<T> = {
    promise: new Promise<T>((r) => {
      resolve = r;
    }),
    resolve: (value) => {
      if ("value" in d) return;
      d.value = value;
      resolve(value);
    },
  };
  return d;
}

type Failure = { reason: string };

/** What every piece must match: the first piece's file format, and for a WAV its `fmt ` chunk. */
type PieceKind = { format: "mp3" } | { format: "wav"; fmt: Buffer };

function kindOf(audio: SynthesizedAudio): PieceKind | undefined {
  if (audio.format === "mp3") return { format: "mp3" };
  const fmt = wavFormat(audio.audio);
  return fmt ? { format: "wav", fmt } : undefined;
}

const sameKind = (a: PieceKind, b: PieceKind) =>
  a.format === b.format && (a.format === "mp3" || (b.format === "wav" && a.fmt.equals(b.fmt)));

/** The pieces as one message: WAV data under one header, or MP3 frames one after another. */
function joinPieces(pieces: SynthesizedAudio[]): SynthesizedAudio | undefined {
  if (pieces[0].format === "mp3") return { audio: Buffer.concat(pieces.map((p) => p.audio)), format: "mp3" };
  const wav = joinWav(pieces.map((p) => p.audio));
  return wav ? { audio: wav, format: "wav" } : undefined;
}

class Run {
  private readonly reading: Reading;
  private readonly halt = new AbortController();
  private readonly halted: Promise<"halted">;
  private readonly slots: Deferred<SynthesizedAudio>[];
  /** The first piece's kind, once it is known: every piece must have it. */
  private readonly kind = deferred<PieceKind>();
  private readonly firstStart = deferred<PlayStart | undefined>();
  private readonly dir: string;
  private failure?: Failure;
  private next = 0;
  /** Later pieces waiting for the first one's format. */
  private readonly checks: Promise<void>[] = [];
  /** The reading ended itself: the end of its player reading is not a stop. */
  private ended = false;
  /** The piece of this reading that plays now. */
  private playingPiece?: Playback;
  /** Plays the pieces in order; settles when the reading has ended and its last piece stopped playing. */
  readonly playing: Promise<void>;

  constructor(private readonly d: ReadingDeps) {
    this.dir = mkdtempSync(join(d.tmpRoot, `pi-speech-reading-${process.pid}-`));
    this.reading = d.player.read();
    this.halted = new Promise((r) => this.halt.signal.addEventListener("abort", () => r("halted")));
    this.reading.signal.addEventListener("abort", () => {
      if (!this.ended) this.halt.abort();
    });
    this.slots = d.pieces.map(() => deferred<SynthesizedAudio>());
    this.playing = this.play();
  }

  /** Stop the reading and the piece of it that plays. */
  stop(): void {
    this.end();
    void this.playingPiece?.stop().catch(() => {});
  }

  /** Synthesize and play; resolves once every piece is synthesized and saved, or the reading stopped or failed. */
  async synthesizeAndSave(): Promise<ReadingResult> {
    await Promise.all(Array.from({ length: IN_FLIGHT }, () => this.worker()));
    await Promise.all(this.checks);
    const pieces = this.slots.map((s) => s.value);
    const all = pieces.every((p) => p !== undefined);
    const joined = all && !this.failure ? joinPieces(pieces as SynthesizedAudio[]) : undefined;
    if (all && !this.failure && !joined) this.fail({ reason: "the pieces could not be joined into one message" });
    if (!joined) {
      this.end();
      const f = this.failure;
      if (f) throw new ReadingFailed(f.reason);
      return { state: "stopped" };
    }
    const saved = await this.d.save(joined);
    const started = await this.firstStart.promise;
    if (started?.ok) return { state: "saved", saved, player: started.player };
    return { state: "saved", saved, notPlayed: started?.reason ?? REPLACED };
  }

  removeDir(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private end(): void {
    this.ended = true;
    this.halt.abort();
    this.reading.end();
  }

  /** The first failure ends the reading; one after a stop is only the stop's aftermath. */
  private fail(f: Failure): undefined {
    if (!this.halt.signal.aborted) this.failure = f;
    this.end();
    return undefined;
  }

  private get stopped(): boolean {
    return this.halt.signal.aborted;
  }

  /** One request slot: synthesizes pieces in order while the reading goes on. */
  private async worker(): Promise<void> {
    while (this.next < this.slots.length && !this.stopped) {
      const i = this.next++;
      const audio = await this.synthesizePiece(i);
      if (audio === undefined) return;
      if (i === 0) this.acceptFirst(audio);
      // A later piece waits for the first one's kind without holding up the next request.
      else this.checks.push(this.acceptLater(i, audio));
    }
  }

  /** Piece `i` synthesized; undefined when the reading stopped or failed. */
  private async synthesizePiece(i: number): Promise<SynthesizedAudio | undefined> {
    let audio: SynthesizedAudio;
    try {
      audio = await this.d.synthesize(this.d.pieces[i], this.halt.signal, i);
    } catch (err) {
      return this.fail({ reason: errorMessage(err) });
    }
    if (this.stopped) return;
    return audio;
  }

  /** The first piece sets the kind every piece must have. */
  private acceptFirst(audio: SynthesizedAudio): void {
    const kind = kindOf(audio);
    if (!kind) {
      this.fail({ reason: "the first piece is not a readable WAV" });
      return;
    }
    this.kind.resolve(kind);
    this.slots[0].resolve(audio);
  }

  /** A later piece must have the first piece's kind; anything else is a failure. */
  private async acceptLater(i: number, audio: SynthesizedAudio): Promise<void> {
    const first = await Promise.race([this.kind.promise, this.halted]);
    if (first === "halted") return;
    const kind = kindOf(audio);
    if (!kind) this.fail({ reason: "a piece is not a readable WAV" });
    else if (!sameKind(kind, first)) this.fail({ reason: "a piece came back in a different audio format" });
    else this.slots[i].resolve(audio);
  }

  private async play(): Promise<void> {
    let previous: Promise<PlayOutcome> | undefined;
    try {
      for (let i = 0; i < this.slots.length; i++) {
        const audio = await Promise.race([this.slots[i].promise, this.halted]);
        if (audio === "halted" || this.stopped) return;
        if (previous) {
          const outcome = await Promise.race([previous, this.halted]);
          if (outcome === "halted" || outcome.state !== "completed" || this.stopped) return;
        }
        const started = await this.playPiece(i, audio);
        if (i === 0) this.firstStart.resolve(started);
        if (!started.ok) return;
        this.playingPiece = started;
        previous = started.done;
      }
    } finally {
      this.firstStart.resolve(undefined);
      this.ended = true;
      this.reading.end();
      // A piece that plays may finish (after a failure) before the reading's files go.
      await previous;
      this.playingPiece = undefined;
    }
  }

  private async playPiece(i: number, audio: SynthesizedAudio): Promise<PlayStart> {
    const file = join(this.dir, `piece-${i}.${audio.format}`);
    try {
      writeFileSync(file, audio.audio, { flag: "wx" });
      return await this.reading.play(file, () => rmSync(file, { force: true }));
    } catch (err) {
      rmSync(file, { force: true });
      return { ok: false, reason: `cannot write the audio: ${errorMessage(err)}` };
    }
  }
}

/**
 * Speak `d.pieces` as one reading. Resolves once every piece is synthesized and the message saved (the last
 * pieces may still be playing), or once the reading stopped; throws ReadingFailed when it failed.
 */
export async function speakInPieces(d: ReadingDeps): Promise<ReadingResult> {
  if (d.signal?.aborted) return { state: "stopped" };
  const run = new Run(d);
  const onAbort = () => run.stop();
  d.signal?.addEventListener("abort", onAbort);
  const result = run.synthesizeAndSave();
  void (async () => {
    try {
      await Promise.allSettled([result, run.playing]);
    } finally {
      d.signal?.removeEventListener("abort", onAbort);
      run.removeDir();
    }
  })();
  return result;
}
