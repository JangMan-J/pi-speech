/**
 * Plumbing for a Stream (GLOSSARY.md): audio handed over chunk by chunk while the provider still produces it.
 *   bodyChunks       a response body as chunks, with a readable error when it breaks off
 *   streamFromBody   a speech response of any kind (PCM, WAV, MP3) as a Stream, told by its type and bytes
 *   streamOfClip     a whole clip as a Stream of one chunk, for a service that sends nothing earlier
 *   clipOf           the chunks of a Stream as one clip for the history (WAV, or MP3 as sent)
 *   ChunkBuffer      the chunks of one Stream kept as they arrive, so the download never waits for the player
 */

import { errorMessage } from "./env";
import type { AudioStream, StreamFormat, SynthesizedAudio } from "./provider";
import { joinWav, wrapPcmAsWav } from "./wav";

/** The chunks of a response body as they arrive. A body that breaks off throws "`who` stopped sending audio: …". */
export async function* bodyChunks(body: ReadableStream<Uint8Array>, who: string): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        throw new Error(`${who} stopped sending audio: ${errorMessage(err)}`);
      }
      if (next.done) return;
      if (next.value.byteLength) yield next.value;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** All chunks joined into one buffer. */
export async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of chunks) parts.push(c);
  return Buffer.concat(parts);
}

const isMp3 = (b: Uint8Array) =>
  (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0);

/** Bytes held before giving up on finding where a WAV header ends. */
const MAX_HEAD = 64 * 1024;

type WavHead =
  /** The header is not complete yet. */
  | { state: "more" }
  /** 16-bit PCM: the samples start at `data`. */
  | { state: "pcm"; rate: number; channels: number; data: number }
  /** Another encoding: the player decodes the file. */
  | { state: "other" };

/** Where the samples of a WAV start, from as much of its head as has arrived; sizes may be left open. */
function wavHead(b: Buffer): WavHead {
  let fmt: { tag: number; channels: number; rate: number; bits: number } | undefined;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = b.toString("latin1", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "data") {
      if (!fmt) return { state: "other" };
      const pcm = (fmt.tag === 1 || fmt.tag === 0xfffe) && fmt.bits === 16;
      return pcm ? { state: "pcm", rate: fmt.rate, channels: fmt.channels, data: body } : { state: "other" };
    }
    if (id === "fmt ") {
      if (body + 16 > b.length) return { state: "more" };
      fmt = {
        tag: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        rate: b.readUInt32LE(body + 4),
        bits: b.readUInt16LE(body + 14),
      };
    }
    pos = body + size + (size % 2);
  }
  return { state: "more" };
}

/**
 * A speech response as a Stream: raw PCM when its Content-Type says so (`audio/pcm` or `audio/l16`, rate and
 * channels from the type), at once; otherwise told by its bytes first and its type second, since services
 * disagree on the type: a WAV (its header removed when it holds 16-bit PCM) or MP3, once enough has arrived to
 * tell. Throws when the response holds no audio or audio of another kind.
 */
export async function streamFromBody(
  body: ReadableStream<Uint8Array> | null,
  contentType: string,
  who: string,
): Promise<AudioStream> {
  if (!body) throw new Error(`${who} returned no audio`);
  if (/audio\/(?:pcm|l16)/i.test(contentType)) {
    const rate = Number(/rate=(\d+)/i.exec(contentType)?.[1] ?? 24000);
    const channels = Number(/channels=(\d+)/i.exec(contentType)?.[1] ?? 1);
    return { format: { codec: "pcm", rate, channels }, chunks: bodyChunks(body, who) };
  }
  const it = bodyChunks(body, who)[Symbol.asyncIterator]();
  let head = Buffer.alloc(0);
  const more = async () => {
    const n = await it.next();
    if (n.done) return false;
    head = Buffer.concat([head, n.value]);
    return true;
  };
  const rest = (from: number) =>
    (async function* () {
      if (from < head.length) yield head.subarray(from);
      while (true) {
        const n = await it.next();
        if (n.done) return;
        yield n.value;
      }
    })();
  const fail = (message: string): never => {
    void it.return?.(undefined);
    throw new Error(message);
  };
  while (head.length < 12 && (await more()));
  if (head.length === 0) fail(`${who} returned no audio`);
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WAVE") {
    let w = wavHead(head);
    while (w.state === "more" && head.length < MAX_HEAD && (await more())) w = wavHead(head);
    if (w.state === "pcm")
      return { format: { codec: "pcm", rate: w.rate, channels: w.channels }, chunks: rest(w.data) };
    if (w.state === "other") return { format: { codec: "wav" }, chunks: rest(0) };
    return fail(`${who} sent a WAV whose header never ended`);
  }
  if (isMp3(head) || /mp3|mpeg/i.test(contentType)) return { format: { codec: "mp3" }, chunks: rest(0) };
  return fail(`unexpected audio from ${who}: ${contentType || "no content type"}`);
}

/** A whole clip as a Stream of one chunk. */
export function streamOfClip(clip: SynthesizedAudio, who: string): Promise<AudioStream> {
  const bytes = new Uint8Array(clip.audio);
  const type = clip.format === "mp3" ? "audio/mpeg" : "audio/wav";
  return streamFromBody(new Response(bytes).body, type, who);
}

/** The audio of a Stream that has fully arrived, as one clip for the history. Throws when there is none. */
export function clipOf(format: StreamFormat, bytes: Buffer, who: string): SynthesizedAudio {
  const none = () => new Error(`${who} returned no audio`);
  if (format.codec === "pcm") {
    const frame = 2 * format.channels;
    const whole = bytes.subarray(0, bytes.length - (bytes.length % frame));
    if (whole.length === 0) throw none();
    return { audio: wrapPcmAsWav(whole, format.rate, format.channels), format: "wav" };
  }
  if (bytes.length === 0) throw none();
  if (format.codec === "mp3") return { audio: bytes, format: "mp3" };
  const wav = joinWav([bytes]);
  if (!wav) throw new Error(`${who} sent a WAV that cannot be read`);
  return { audio: wav, format: "wav" };
}

/**
 * The chunks of one Stream, kept as they arrive. The writer (the download) never waits; `read()` hands the
 * chunks to one reader (the player) in order, waiting for more until the writer ends. A reader that stops
 * early stops only itself.
 */
export class ChunkBuffer {
  private readonly parts: Uint8Array[] = [];
  private ended = false;
  private wake?: () => void;

  push(chunk: Uint8Array): void {
    this.parts.push(chunk);
    this.notify();
  }

  /** No more chunks will come: a reader ends after the last one. */
  end(): void {
    this.ended = true;
    this.notify();
  }

  /** Every chunk so far, joined. */
  bytes(): Buffer {
    return Buffer.concat(this.parts);
  }

  async *read(): AsyncGenerator<Uint8Array> {
    let i = 0;
    while (true) {
      if (i < this.parts.length) yield this.parts[i++];
      else if (this.ended) return;
      else await new Promise<void>((r) => (this.wake = r));
    }
  }

  private notify(): void {
    const w = this.wake;
    this.wake = undefined;
    w?.();
  }
}
