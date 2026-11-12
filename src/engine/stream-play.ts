/**
 * One synthesis played as a Stream (GLOSSARY.md): the provider's chunks are kept as they arrive and handed to
 * the player at the same time, so sound starts with the first chunk and the download never waits for playback.
 *
 * A stop, a newer playback, or the caller's signal before the response has fully arrived cancels the request
 * and keeps nothing, whether or not the Stream plays. A response that breaks off stops the playback and throws
 * the provider's message. Once the response has fully arrived its audio is one clip for the history, whether or
 * not it still plays. Where the selected output cannot play a Stream, nothing plays here: the caller gets the
 * whole clip to play as a file.
 */

import type { PlayKind, PlayStart } from "./audio";
import { ChunkBuffer, clipOf } from "./audio-stream";
import { errorMessage } from "./env";
import { type Player, REPLACED } from "./player";
import type { AudioStream, StreamingProvider, SynthesisRequest, SynthesizedAudio } from "./provider";

export type StreamPlay =
  /** The response fully arrived: `audio` is the whole clip; `started` says whether and where it plays. */
  | { state: "arrived"; audio: SynthesizedAudio; started: PlayStart }
  /** Stopped or replaced before the response fully arrived: the request was cancelled, nothing kept. */
  | { state: "stopped" };

/**
 * Synthesize `req` as a Stream and play it through `player` as it arrives, under `ticket` from `player.claim()`.
 * Throws "Speech synthesis failed: …" when the request fails, or after stopping the playback when the response
 * breaks off or holds no audio.
 */
export async function streamAndPlay(
  provider: StreamingProvider,
  req: SynthesisRequest,
  player: Player,
  kind: PlayKind,
  ticket: number,
): Promise<StreamPlay> {
  const stale = player.signalFor(ticket);
  const caller = req.signal;
  if (stale.aborted || caller?.aborted) return { state: "stopped" };
  const request = new AbortController();
  let started: PlayStart | undefined;
  let stopped = false;
  /** Stop: cancel the request and the playback, unless the playback has ended by itself (`ended`). */
  const stop = (ended = false) => {
    if (stopped) return;
    stopped = true;
    request.abort();
    if (started?.ok && !ended) void started.stop().catch(() => {});
  };
  const onAbort = () => stop();
  stale.addEventListener("abort", onAbort);
  caller?.addEventListener("abort", onAbort);
  const failed = async (reason: string): Promise<never> => {
    request.abort(); // a response still coming (after a Stray) is not wanted
    if (started?.ok) await started.stop().catch(() => {});
    throw new Error(`Speech synthesis failed: ${reason}`);
  };
  try {
    let stream: AudioStream;
    try {
      stream = await provider.synthesizeStream({ ...req, signal: request.signal });
    } catch (err) {
      if (stopped) return { state: "stopped" };
      return failed(errorMessage(err));
    }
    const kept = new ChunkBuffer();
    const download = (async (): Promise<unknown> => {
      try {
        for await (const chunk of stream.chunks) kept.push(chunk);
        return undefined;
      } catch (err) {
        return err ?? new Error("the response broke off");
      } finally {
        kept.end();
      }
    })();
    started = await player.playStream({ format: stream.format, chunks: kept.read() }, kind, { ticket });
    if (started.ok) {
      if (stopped) void started.stop().catch(() => {});
      void started.done.then((o) => {
        if (o.state === "cancelled") stop(true);
      });
    } else if (started.reason === REPLACED) stop();
    const failure = await download;
    if (stopped) return { state: "stopped" };
    if (failure !== undefined) return failed(errorMessage(failure));
    let audio: SynthesizedAudio;
    try {
      audio = clipOf(stream.format, kept.bytes(), provider.name);
    } catch (err) {
      return failed(errorMessage(err));
    }
    return { state: "arrived", audio, started };
  } finally {
    stale.removeEventListener("abort", onAbort);
    caller?.removeEventListener("abort", onAbort);
  }
}
