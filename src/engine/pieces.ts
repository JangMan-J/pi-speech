/**
 * Pieces of a long spoken text, for streamed playback: split at sentence ends so the first piece can play
 * while the rest is synthesized. Put together with single spaces, the pieces are the text (whitespace
 * aside): nothing is lost, repeated or added.
 */

/** Playback-only texts longer than this are spoken in pieces; shorter ones in one request. */
export const STREAM_MIN_CHARS = 280;
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
