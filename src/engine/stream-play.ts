/**
 * One synthesis played as a Stream (GLOSSARY.md): the provider's chunks are kept as they arrive and handed to
 * the player at the same time, so sound starts with the first chunk and the download never waits for playback.
 *
 * Stopped or replaced before the response has fully arrived, the request is cancelled and nothing is kept. A
 * response that breaks off stops the playback and throws the provider's message. Once the response has fully
 * arrived the audio is one WAV clip for the history, whether or not it still plays. Where the selected output
 * cannot play a Stream, nothing plays here: the caller gets the whole clip to play as a file.
 */

import type { PlayKind, PlayStart } from "./audio";
import { ChunkBuffer } from "./audio-stream";
import { errorMessage } from "./env";
import { type Player, REPLACED } from "./player";
import type { AudioStream, SpeechProvider, SynthesisRequest } from "./provider";
import { wrapPcmAsWav } from "./wav";

export type StreamPlay =
  /** The response fully arrived: `wav` is the whole clip; `started` says whether and where it plays. */
  | { state: "arrived"; wav: Uint8Array; started: PlayStart }
  /** Stopped or replaced before the response fully arrived: the request was cancelled, nothing kept. */
  | { state: "stopped" };

/**
 * Synthesize `req` as a Stream and play it through `player` as it arrives. Throws "Speech synthesis failed: …"
 * when the request fails, or after stopping the playback when the response breaks off or holds no audio.
 */
export async function streamAndPlay(
  provider: SpeechProvider & Required<Pick<SpeechProvider, "synthesizeStream">>,
  req: SynthesisRequest,
  player: Player,
  kind: PlayKind,
  ticket: number,
): Promise<StreamPlay> {
  const request = new AbortController();
  const caller = req.signal;
  /** The player stopped or replaced this playback: the request is cancelled because of it. */
  let stopped = false;
  const onCaller = () => request.abort();
  caller?.addEventListener("abort", onCaller);
  try {
    let stream: AudioStream;
    try {
      stream = await provider.synthesizeStream({ ...req, signal: request.signal });
    } catch (err) {
      throw new Error(`Speech synthesis failed: ${errorMessage(err)}`);
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
    const started = await player.playStream({ format: stream.format, chunks: kept.read() }, kind, { ticket });
    if (started.ok) {
      void started.done.then((o) => {
        if (o.state !== "cancelled") return;
        stopped = true;
        request.abort();
      });
      caller?.addEventListener("abort", () => void started.stop().catch(() => {}), { once: true });
    } else if (started.reason === REPLACED) {
      stopped = true;
      request.abort();
    }
    const failure = await download;
    if (failure !== undefined) {
      if (stopped) return { state: "stopped" };
      if (started.ok) await started.stop().catch(() => {});
      throw new Error(`Speech synthesis failed: ${errorMessage(failure)}`);
    }
    if (stopped) return { state: "stopped" };
    const pcm = kept.bytes();
    if (pcm.length < 2) {
      if (started.ok) await started.stop().catch(() => {});
      throw new Error(`Speech synthesis failed: ${provider.name} returned no audio`);
    }
    const even = pcm.subarray(0, pcm.length - (pcm.length % 2));
    return { state: "arrived", wav: wrapPcmAsWav(even, stream.format.rate, stream.format.channels), started };
  } finally {
    caller?.removeEventListener("abort", onCaller);
  }
}

/** Whether `provider` can synthesize as a Stream. */
export function streams(
  provider: SpeechProvider,
): provider is SpeechProvider & Required<Pick<SpeechProvider, "synthesizeStream">> {
  return typeof provider.synthesizeStream === "function";
}
