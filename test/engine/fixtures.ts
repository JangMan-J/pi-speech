/** Test fixtures: an engine with a fixed catalog, a recording fake output, and a fake OpenRouter fetch. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { BridgeAudio } from "../../src/bridge/index";
import type { AudioInput, AudioOutput, PlayKind, PlayOutcome, PlayStart } from "../../src/engine/audio";
import { Engine } from "../../src/engine/engine";
import type { SpeechCatalog } from "../../src/engine/openrouter";
import type { AudioStream, StreamFormat } from "../../src/engine/provider";
import type { SurfaceUi } from "../../src/engine/surface";

export const CATALOG: SpeechCatalog = {
  tts: [
    {
      id: "google/gemini-3.8-flash-tts",
      label: "Gemini",
      voices: ["Kore", "Puck"],
      price: "~$0.03/min",
      vendor: "Google",
      features: ["tags", "fast"],
      created: 300,
      description: "Gemini 3.8 Flash TTS is a text-to-speech model from Google.",
    },
    {
      id: "hexgrad/kokoro-82m",
      label: "Kokoro",
      voices: ["af_heart", "jf_alpha"],
      price: "~$0.001/min",
      vendor: "hexgrad",
      features: ["multilingual"],
      languages: "8 langs",
      created: 100,
      description: "Kokoro 82M is a lightweight text-to-speech model across 8 languages.",
    },
    {
      id: "x-ai/grok-voice-tts-1.0",
      label: "Grok",
      voices: ["eve", "ara"],
      price: "~$0.01/min",
      vendor: "SpaceXAI",
      features: ["multilingual"],
      languages: "20+ langs",
      created: 200,
    },
  ],
  stt: [
    {
      id: "openai/whisper-large-v3-turbo",
      label: "Whisper turbo",
      price: "$0.0007/min",
      vendor: "OpenAI",
      features: ["multilingual", "fast"],
      languages: "99+ langs",
    },
    { id: "openai/whisper-1", label: "Whisper", price: "$0.006/min", vendor: "OpenAI", features: ["translate"] },
  ],
};

/** A Stream the fake output plays: every chunk it has read, when, and how the playback ended. */
export interface FakeStreamPlay {
  kind: PlayKind;
  format: StreamFormat;
  chunks: Uint8Array[];
  /** The Stream ended: every chunk was read. */
  ended: boolean;
  /** How the playback ended, once it has. */
  outcome?: PlayOutcome;
  /** End the playback, as a player that finished (or failed) would. */
  finish(o: PlayOutcome): void;
}

export interface FakeOutput extends AudioOutput {
  /** Every playback in order: a file (`file`) or a Stream (`stream`); `end(i)` ends the i-th. */
  plays: Array<{ file?: string; kind: PlayKind; stream?: FakeStreamPlay }>;
  /** The Streams among `plays`. */
  streams: FakeStreamPlay[];
  /** Playbacks stopped one by one. */
  cancelled: number;
  /** Calls of stop() for the whole output. */
  stops: number;
  end(i: number, o: PlayOutcome): void;
}

/** A fake output; with `streams` it plays a Stream too, reading its chunks as they arrive. */
export function fakeOutput(name: string, opts: { streams?: boolean } = {}): FakeOutput {
  const endings: Array<(o: PlayOutcome) => void> = [];
  const out: FakeOutput = {
    name,
    plays: [],
    streams: [],
    cancelled: 0,
    stops: 0,
    end: (i, o) => endings[i](o),
    async play(file, kind): Promise<PlayStart> {
      out.plays.push({ file, kind });
      let end!: (o: PlayOutcome) => void;
      const done = new Promise<PlayOutcome>((r) => {
        end = r;
      });
      endings.push(end);
      const stop = async () => {
        out.cancelled++;
        end({ state: "cancelled" });
      };
      return { ok: true, player: name, done, stop };
    },
    async stop() {
      out.stops++;
    },
  };
  if (opts.streams) {
    out.playStream = async (stream: AudioStream, kind: PlayKind): Promise<PlayStart> => {
      let end!: (o: PlayOutcome) => void;
      const done = new Promise<PlayOutcome>((r) => {
        end = r;
      });
      const play: FakeStreamPlay = { kind, format: stream.format, chunks: [], ended: false, finish: (o) => end(o) };
      void done.then((o) => {
        play.outcome = o;
      });
      out.streams.push(play);
      out.plays.push({ kind, stream: play });
      endings.push(end);
      void (async () => {
        try {
          for await (const c of stream.chunks) {
            if (play.outcome) return;
            play.chunks.push(c);
          }
          play.ended = true;
        } catch {
          /* the owner of the Stream reports it */
        }
      })();
      const stop = async () => {
        out.cancelled++;
        end({ state: "cancelled" });
        await done;
      };
      return { ok: true, player: name, done, stop };
    };
  }
  return out;
}

/** Stub fetch: speech requests answer WAV-wrapped PCM, transcriptions a fixed text; returns the request log. */
export function fakeOpenRouter(transcript = "hello world") {
  const requests: Array<{ url: string; body: any; auth?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body, auth: (init?.headers as Record<string, string>)?.Authorization });
      if (url.endsWith("/audio/speech")) {
        return new Response(new Uint8Array(4800), { headers: { "content-type": "audio/pcm;rate=24000;channels=1" } });
      }
      if (url.endsWith("/audio/transcriptions")) return Response.json({ text: transcript });
      return new Response("not found", { status: 404 });
    }),
  );
  return requests;
}

export function makeEngine(
  env: Record<string, string> = {},
  localInput?: AudioInput,
  catalog: SpeechCatalog = CATALOG,
) {
  const work = mkdtempSync(join(tmpdir(), "pi-speech-engine-"));
  const local = fakeOutput("local", { streams: true });
  const bridgeOut = fakeOutput("bridge");
  const noInput: AudioInput = {
    name: "local",
    start: async () => {
      throw new Error("no microphone here");
    },
  };
  const bridge: BridgeAudio = {
    output: bridgeOut,
    input: { ...noInput, name: "bridge" },
    health: async () => ({ ok: true, version: "0.1.0" }),
  };
  const engine = new Engine({
    agentDir: join(work, "agent"),
    env: { OPENROUTER_API_KEY: "sk-test", PI_SPEECH_DIR: join(work, "history"), ...env },
    home: join(work, "home"),
    fetchCatalog: async () => catalog,
    bridge,
    localOutput: local,
    localInput: localInput ?? noInput,
  });
  const notes: Array<{ message: string; level: string }> = [];
  engine.notify = (message, level) => notes.push({ message, level });
  engine.start();
  return { engine, work, local, bridgeOut, notes };
}

/** A UI that answers dialogs from a script and records what it was shown. */
export function scriptedUi(answers: Array<(title: string, options?: string[]) => string | undefined> = []) {
  const notes: Array<{ message: string; level: string }> = [];
  const dialogs: Array<{ kind: string; title: string; options?: string[] }> = [];
  const pasted: string[] = [];
  const next = (kind: string, title: string, options?: string[]) => {
    dialogs.push({ kind, title, options });
    const answer = answers.shift();
    return Promise.resolve(answer ? answer(title, options) : undefined);
  };
  const ui: SurfaceUi = {
    cwd: "/",
    notify: (message, level) => notes.push({ message, level }),
    paste: (t) => pasted.push(t),
    select: (title, options) => next("select", title, options),
    pick: (title, options) => next("pick", title, options),
    input: (title) => next("input", title),
  };
  return { ui, notes, dialogs, pasted };
}

/**
 * A response body the test sends by hand, chunk by chunk, as a speech service sends audio while it is still
 * producing it. `cancelled` turns true when the reader gives up (an aborted request).
 */
export function chunkedBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { cancelled: false, pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return {
    body,
    get cancelled() {
      return state.cancelled;
    },
    send: (bytes: Uint8Array) => controller.enqueue(bytes),
    end: () => controller.close(),
    fail: (err: Error) => controller.error(err),
  };
}

/** Bytes 0, 1, 2, ... of length `n`, so joined chunks can be compared with what was sent. */
export function pcmBytes(n: number, start = 0): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: n }, (_, i) => (start + i) % 256);
}

/** Resolves once `cond` holds, polling every 5 ms; fails after `ms`. */
export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}
