/**
 * Plumbing for a Stream (GLOSSARY.md): audio handed over chunk by chunk while the provider still produces it.
 *   bodyChunks  a response body as chunks, with a readable error when it breaks off
 *   collect     every chunk joined, for callers that need the whole clip
 *   ChunkBuffer the chunks of one Stream kept as they arrive, so the download never waits for the player
 */

import { errorMessage } from "./env";

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
