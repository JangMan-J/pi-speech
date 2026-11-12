/**
 * A Reading played as one Stream (GLOSSARY.md): a long text split into pieces, requested in order with at most
 * IN_FLIGHT at once, each piece's audio kept as it arrives and fed to one player straight after the piece
 * before it. Sound starts with the first chunk of the first piece; no gap and no new player between pieces.
 *
 * A stop, a newer playback, or the caller's signal cancels every request and saves nothing. A piece that fails
 * (its request, its response breaking off, a Stray, another audio format) stops playback, plays nothing after
 * it, and throws ReadingFailed. Once every piece has fully arrived they are saved as one message.
 *
 * Where the first piece turns out not to play as a Stream (the output cannot, or it is a WAV file), nothing
 * plays here and the result is `files`: the pieces already asked for go on arriving and are handed to the
 * caller, so none is asked for twice.
 */

import type { PlayStart } from "./audio";
import { ChunkBuffer, clipOf } from "./audio-stream";
import { errorMessage } from "./env";
import type { SavedMessage } from "./history";
import { type Player, REPLACED } from "./player";
import type { AudioStream, StreamFormat, SynthesizedAudio } from "./provider";
import { ReadingFailed, type ReadingResult } from "./reading";

/** Speech requests in flight at once. */
export const IN_FLIGHT = 2;

export interface StreamReadingDeps {
  pieces: readonly string[];
  /** One piece as a Stream; throws a readable error (the provider's status or message). */
  synthesize(text: string, signal: AbortSignal): Promise<AudioStream>;
  player: Player;
  /** Saves the whole Reading as one message in the history. */
  save(audio: SynthesizedAudio): Promise<SavedMessage>;
  /** For messages, e.g. "xAI". */
  who: string;
  /** Aborting it stops the Reading. */
  signal?: AbortSignal;
}

export type StreamReadingResult =
  | ReadingResult
  /**
   * The Reading cannot play as a Stream (`reason`); nothing played. `requested(i, signal)` is piece `i` as one
   * clip when it was already asked for (aborting `signal` cancels it), else undefined: ask for it then.
   */
  | {
      state: "files";
      reason: string;
      requested(i: number, signal: AbortSignal): Promise<SynthesizedAudio> | undefined;
    };

const sameFormat = (a: StreamFormat, b: StreamFormat) =>
  a.codec === b.codec && (a.codec !== "pcm" || (b.codec === "pcm" && a.rate === b.rate && a.channels === b.channels));

/** Bytes to add after a piece of `length` bytes so the next piece starts on a whole sample frame. */
const padding = (format: StreamFormat, length: number) => {
  if (format.codec !== "pcm") return 0;
  const frame = 2 * format.channels;
  return (frame - (length % frame)) % frame;
};

interface Piece {
  /** Resolves with the piece's format once its response has started, or undefined when it never will. */
  format: Promise<StreamFormat | undefined>;
  resolve(format: StreamFormat | undefined): void;
  audio: ChunkBuffer;
  /** Cancels this piece's request. */
  request: AbortController;
  /** Settles once the piece has fully arrived, or failed (`error`). */
  arrived: Promise<void>;
  arrive(): void;
  error?: string;
}

/** Speak `d.pieces` as one Reading played as a Stream; see the module comment. */
export async function streamReading(d: StreamReadingDeps): Promise<StreamReadingResult> {
  const ticket = d.player.claim();
  const stale = d.player.signalFor(ticket);
  if (stale.aborted || d.signal?.aborted) return { state: "stopped" };
  const halt = new AbortController();
  const halted = new Promise<"halted">((r) => halt.signal.addEventListener("abort", () => r("halted")));
  let stopped = false;
  /** The pieces go to the caller as files: no new piece is asked for here. */
  let handedOff = false;
  let failure: string | undefined;
  let started: PlayStart | undefined;

  const pieces: Piece[] = d.pieces.map(() => {
    let resolve!: (f: StreamFormat | undefined) => void;
    const format = new Promise<StreamFormat | undefined>((r) => {
      resolve = r;
    });
    let arrive!: () => void;
    const arrived = new Promise<void>((r) => {
      arrive = r;
    });
    return { format, resolve, audio: new ChunkBuffer(), request: new AbortController(), arrived, arrive };
  });

  const stop = (ended = false) => {
    if (stopped) return;
    stopped = true;
    halt.abort();
    for (const p of pieces) p.request.abort();
    if (started?.ok && !ended) void started.stop().catch(() => {});
  };
  const fail = (reason: string) => {
    if (stopped || handedOff) return;
    failure = reason;
    stop();
  };
  const onAbort = () => stop();
  stale.addEventListener("abort", onAbort);
  d.signal?.addEventListener("abort", onAbort);

  let next = 0;
  const worker = async () => {
    while (next < pieces.length && !stopped && !handedOff) {
      const piece = pieces[next];
      const text = d.pieces[next++];
      try {
        const stream = await d.synthesize(text, piece.request.signal);
        piece.resolve(stream.format);
        for await (const chunk of stream.chunks) piece.audio.push(chunk);
      } catch (err) {
        piece.error = errorMessage(err);
        piece.resolve(undefined);
        fail(piece.error);
        return;
      } finally {
        piece.audio.end();
        piece.arrive();
      }
    }
  };
  const workers = Promise.all(Array.from({ length: IN_FLIGHT }, worker));
  // A piece never asked for (the Reading stopped or was handed off first) has no format.
  void workers.then(() => {
    for (const p of pieces.slice(next)) p.resolve(undefined);
  });

  /** Hand the pieces asked for so far to the caller, to play as files. */
  const handOff = (reason: string): StreamReadingResult => {
    handedOff = true;
    const asked = next;
    return {
      state: "files",
      reason,
      requested(i, signal) {
        if (i >= asked) return undefined;
        const p = pieces[i];
        const cancel = () => p.request.abort();
        signal.addEventListener("abort", cancel);
        return (async () => {
          try {
            const format = await p.format;
            await p.arrived;
            if (p.error !== undefined || !format) throw new Error(p.error ?? "the piece was cancelled");
            return clipOf(format, p.audio.bytes(), d.who);
          } finally {
            signal.removeEventListener("abort", cancel);
          }
        })();
      },
    };
  };

  /** The format of piece `i`, checked against the first piece's; undefined when the Reading is over. */
  const formatOf = async (i: number, first: StreamFormat): Promise<StreamFormat | undefined> => {
    const f = await Promise.race([pieces[i].format, halted]);
    if (f === "halted" || f === undefined) return undefined;
    if (!sameFormat(f, first)) {
      fail("a piece came back in a different audio format");
      return undefined;
    }
    return f;
  };

  async function* feed(first: StreamFormat): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < pieces.length; i++) {
      if (!(await formatOf(i, first))) return;
      let length = 0;
      for await (const chunk of pieces[i].audio.read()) {
        if (stopped) return;
        length += chunk.byteLength;
        yield chunk;
      }
      if (stopped || pieces[i].error !== undefined) return;
      const pad = padding(first, length);
      if (pad && i < pieces.length - 1) yield new Uint8Array(pad);
    }
  }

  try {
    const first = await Promise.race([pieces[0].format, halted]);
    if (first === "halted" || first === undefined) {
      await workers;
      if (failure !== undefined) throw new ReadingFailed(failure);
      return { state: "stopped" };
    }
    if (first.codec === "wav") return handOff("the pieces come as WAV files that cannot be joined as they play");
    started = await d.player.playStream({ format: first, chunks: feed(first) }, "message", { ticket });
    if (started.ok) {
      if (stopped) void started.stop().catch(() => {});
      void started.done.then((o) => {
        if (o.state === "cancelled") stop(true);
      });
    } else if (started.cannotStream) {
      return handOff(started.reason);
    } else if (started.reason === REPLACED) stop();
    await workers;
    for (let i = 1; i < pieces.length && !stopped; i++) await formatOf(i, first);
    if (failure !== undefined) {
      if (started.ok) await started.stop().catch(() => {});
      throw new ReadingFailed(failure);
    }
    if (stopped) return { state: "stopped" };
    const parts: Buffer[] = [];
    pieces.forEach((p, i) => {
      const bytes = p.audio.bytes();
      parts.push(bytes);
      const pad = padding(first, bytes.length);
      if (pad && i < pieces.length - 1) parts.push(Buffer.alloc(pad));
    });
    let audio: SynthesizedAudio;
    try {
      audio = clipOf(first, Buffer.concat(parts), d.who);
    } catch (err) {
      if (started.ok) await started.stop().catch(() => {});
      throw new ReadingFailed(errorMessage(err));
    }
    const saved = await d.save(audio);
    if (started.ok) return { state: "saved", saved, player: started.player };
    return { state: "saved", saved, notPlayed: started.reason };
  } finally {
    stale.removeEventListener("abort", onAbort);
    d.signal?.removeEventListener("abort", onAbort);
  }
}
