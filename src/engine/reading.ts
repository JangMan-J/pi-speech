/**
 * A Reading (GLOSSARY.md): long spoken text split at sentence ends into pieces, synthesized in order with at
 * most IN_FLIGHT requests at once, played as one continuous Stream through Player, and saved as one message.
 *
 * A stop, a newer playback, or the caller's signal cancels every request and saves nothing. A piece that fails
 * stops playback, plays nothing after it, and throws ReadingFailed. Pieces that come as non-16-bit-PCM WAV
 * files are joined once under one header after all pieces arrive.
 */

import type { PlayStart } from "./audio";
import { ChunkBuffer, clipOf } from "./audio-stream";
import { errorMessage } from "./env";
import type { SavedMessage } from "./history";
import { type Player, REPLACED } from "./player";
import type { AudioStream, StreamFormat, SynthesizedAudio } from "./provider";
import { joinWav } from "./wav";

// ── Piece splitting ─────────────────────────────────────────────────────────

/** Playback-only texts longer than this are spoken in pieces; shorter ones in one request. */
export const READING_MIN_CHARS = 280;
/** The first piece: the first sentence or sentences, 40 to 240 characters. */
export const FIRST_PIECE_MIN = 40;
export const FIRST_PIECE_MAX = 240;
/** Later pieces: whole sentences, at most 300 characters for the second, then up to 600. */
export const SECOND_PIECE_MAX = 300;
export const PIECE_MAX = 600;
/** A later piece is at most this many times as long as the one before it (and within the limits above). */
const GROWTH = 3;

/** A sentence end: terminal punctuation, then closing quotes or brackets. */
const TERMINAL = /([.!?…]+|[。！？]+)(["'”’)\]」』）]*)/g;
const CJK_TERMINAL = /^[。！？]/;
/** A clause end inside a sentence. */
const CLAUSE = /[,;:—–](?=\s)|[、，；：]/g;
/** Words that end in a period without ending the sentence. */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "mt",
  "vs",
  "cf",
  "al",
  "e.g",
  "i.e",
]);

/** Whether the period that ends `before` belongs to an abbreviation or an initial. */
function abbreviation(before: string): boolean {
  const word = (/[\p{L}.]+$/u.exec(before)?.[0] ?? "").toLowerCase();
  if (!word) return false;
  return ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word) || /^(\p{L}\.)+\p{L}$/u.test(word);
}

/** Offsets just after each sentence end in `text`. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  for (const m of text.matchAll(TERMINAL)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (!CJK_TERMINAL.test(m[1])) {
      const next = text.slice(end);
      if (next && !/^\s/.test(next)) continue;
      // A lowercase word or a number after the period continues the sentence ("3 p.m. in", "No. 5").
      if (/^\s+[\p{Ll}\d]/u.test(next)) continue;
      if (m[1] === "." && abbreviation(text.slice(0, start))) continue;
    }
    ends.push(end);
  }
  return ends;
}

/** A cut at `at` that does not split a surrogate pair. */
function safeCut(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/**
 * The length of the next piece of `rest` (which starts with no whitespace): a sentence end within
 * [min, max] (the first one when `shortest`, else the last), else a clause end, else a word end, else `max`.
 */
function pieceEnd(rest: string, min: number, max: number, shortest: boolean): number {
  if (rest.length <= max) return rest.length;
  const ends = sentenceEnds(rest.slice(0, max + 1)).filter((e) => e >= min && e <= max);
  if (ends.length) return shortest ? ends[0] : ends[ends.length - 1];
  let clause = 0;
  for (const m of rest.slice(0, max).matchAll(CLAUSE)) {
    const e = (m.index ?? 0) + m[0].length;
    if (e >= min) clause = e;
  }
  if (clause) return clause;
  const space = rest.slice(0, max + 1).search(/\s\S*$/);
  if (space >= min) return space;
  return safeCut(rest, max);
}

/** Split `text` into pieces to synthesize and play in order. A text within the first piece's limit stays whole. */
export function splitForSpeech(text: string): string[] {
  const pieces: string[] = [];
  let pos = text.search(/\S/);
  if (pos < 0) return pieces;
  while (pos < text.length) {
    const rest = text.slice(pos);
    const first = pieces.length === 0;
    const prev = pieces[pieces.length - 1]?.length ?? 0;
    const max = first ? FIRST_PIECE_MAX : Math.min(PIECE_MAX, Math.max(SECOND_PIECE_MAX, GROWTH * prev));
    const end = pieceEnd(rest, first ? FIRST_PIECE_MIN : 1, max, first);
    pieces.push(rest.slice(0, end).trimEnd());
    const next = rest.slice(end).search(/\S/);
    if (next < 0) break;
    pos += end + next;
  }
  return pieces;
}

// ── Reading outcome & errors ────────────────────────────────────────────────

export type ReadingResult =
  /** Every piece arrived and the message was saved; `player` once it started playing. */
  | { state: "saved"; saved: SavedMessage; player?: string; notPlayed?: string }
  /** Stopped or replaced before every piece had arrived: nothing saved. */
  | { state: "stopped" };

/** A Reading ended by a failure: nothing plays after it and nothing was saved. `reason` says what failed. */
export class ReadingFailed extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** The one error shown for a failed Reading: `who` stopped, why, and that `what` was not saved. */
export function readingFailedMessage(who: string, what: string, reason: string): string {
  return (
    `${who} stopped: ${reason.trim().replace(/\.+$/, "")}. The ${what} was not saved; ` +
    "try /speech --replay for the last saved message, or pick another speech model in /speech."
  );
}

// ── Streaming Reading coordinator ───────────────────────────────────────────

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
  /** The whole text, for the start buffer's estimate of the Reading's length. */
  text?: string;
  /** Crossfade from what plays now into this Reading over this long. */
  fadeMs?: number;
}

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
export async function streamReading(d: StreamReadingDeps): Promise<ReadingResult> {
  const ticket = d.player.claim(d.fadeMs);
  const stale = d.player.signalFor(ticket);
  if (stale.aborted || d.signal?.aborted) return { state: "stopped" };
  const halt = new AbortController();
  const halted = new Promise<"halted">((r) => halt.signal.addEventListener("abort", () => r("halted")));
  let stopped = false;
  let failure: string | undefined;
  let started: PlayStart | undefined;
  let joinedWav: Uint8Array | undefined;

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

  const stop = (ended = false, fadeMs?: number) => {
    if (stopped) return;
    stopped = true;
    halt.abort();
    for (const p of pieces) p.request.abort();
    if (!started?.ok || ended) return;
    void (fadeMs && started.fadeOut ? started.fadeOut(fadeMs) : started.stop()).catch(() => {});
  };
  const fail = (reason: string) => {
    if (stopped) return;
    failure = reason;
    stop();
  };
  const onAbort = () => stop();
  const onStale = () => stop(false, d.player.replaceFadeFor(ticket));
  stale.addEventListener("abort", onStale);
  d.signal?.addEventListener("abort", onAbort);

  let next = 0;
  const worker = async () => {
    while (next < pieces.length && !stopped) {
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
  void workers.then(() => {
    for (const p of pieces.slice(next)) p.resolve(undefined);
  });

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

  const joinAllWav = (): Uint8Array | undefined => {
    joinedWav ??= joinWav(pieces.map((p) => p.audio.bytes()));
    return joinedWav;
  };

  async function* feed(first: StreamFormat): AsyncGenerator<Uint8Array> {
    if (first.codec === "wav") {
      for (let i = 0; i < pieces.length; i++) {
        if (!(await formatOf(i, first))) return;
        await Promise.race([pieces[i].arrived, halted]);
        if (stopped || pieces[i].error !== undefined) return;
      }
      const whole = joinAllWav();
      if (!whole) return fail("the pieces came back as WAV files that cannot be joined");
      yield whole;
      return;
    }
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
    started = await d.player.playStream({ format: first, chunks: feed(first) }, "message", {
      ticket,
      text: d.text,
      fadeMs: d.fadeMs,
    });
    if (started.ok) {
      if (stopped) void started.stop().catch(() => {});
      void started.done.then((o) => {
        if (o.state === "cancelled") stop(true);
      });
    } else if (started.reason === REPLACED) stop();
    await workers;
    for (let i = 1; i < pieces.length && !stopped; i++) await formatOf(i, first);
    if (failure !== undefined) {
      if (started.ok) await started.stop().catch(() => {});
      throw new ReadingFailed(failure);
    }
    if (stopped) return { state: "stopped" };
    let audio: SynthesizedAudio;
    try {
      if (first.codec === "wav") {
        const whole = joinAllWav();
        if (!whole) throw new Error("the pieces came back as WAV files that cannot be joined");
        audio = { audio: whole, format: "wav" };
      } else {
        const parts: Buffer[] = [];
        pieces.forEach((p, i) => {
          const bytes = p.audio.bytes();
          parts.push(bytes);
          const pad = padding(first, bytes.length);
          if (pad && i < pieces.length - 1) parts.push(Buffer.alloc(pad));
        });
        audio = clipOf(first, Buffer.concat(parts), d.who);
      }
    } catch (err) {
      if (started.ok) await started.stop().catch(() => {});
      throw new ReadingFailed(errorMessage(err));
    }
    const saved = await d.save(audio);
    if (started.ok) return { state: "saved", saved, player: started.player };
    return { state: "saved", saved, notPlayed: started.reason };
  } finally {
    stale.removeEventListener("abort", onStale);
    d.signal?.removeEventListener("abort", onAbort);
  }
}
