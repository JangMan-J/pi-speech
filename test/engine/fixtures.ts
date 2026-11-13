/** Test fixtures: an engine with a fixed catalog, a recording fake output, and a fake OpenRouter fetch. */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
  /** Every playback in order, each a Stream; `file` is the saved message a replay reads. `end(i)` ends the i-th. */
  plays: Array<{ file?: string; kind: PlayKind; stream: FakeStreamPlay }>;
  /** The Streams of `plays`. */
  streams: FakeStreamPlay[];
  /** Playbacks stopped one by one. */
  cancelled: number;
  /** Calls of stop() for the whole output. */
  stops: number;
  end(i: number, o: PlayOutcome): void;
}

/** A fake output that plays every Stream, reading its chunks as they arrive. */
export function fakeOutput(name: string): FakeOutput {
  const endings: Array<(o: PlayOutcome) => void> = [];
  const out: FakeOutput = {
    name,
    plays: [],
    streams: [],
    cancelled: 0,
    stops: 0,
    end: (i, o) => endings[i](o),
    async playStream(stream: AudioStream, kind: PlayKind): Promise<PlayStart> {
      let end!: (o: PlayOutcome) => void;
      const done = new Promise<PlayOutcome>((r) => {
        end = r;
      });
      const play: FakeStreamPlay = { kind, format: stream.format, chunks: [], ended: false, finish: (o) => end(o) };
      void done.then((o) => {
        play.outcome = o;
      });
      out.streams.push(play);
      out.plays.push({ kind, stream: play, ...(stream.file ? { file: stream.file } : {}) });
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
    },
    async stop() {
      out.stops++;
    },
  };
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
  const local = fakeOutput("local");
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

/** A short silent 16 kHz mono WAV. */
export function wavFixture(samples = 1600): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + samples * 2, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([h, Buffer.alloc(samples * 2)]);
}

/** A stand-in binary is a script started as a program (shebang), which Windows cannot do. */
export const STAND_IN_BINARY = process.platform !== "win32";

/**
 * A stand-in for the receiver binary's `models`, `transcribe` and `speak` commands, in `dir`: two transcription
 * models (parakeet-v3 downloaded, whisper-small not) and one speech model (kokoro, not downloaded). Downloads and
 * deletes change what `models list` says; `transcribe` answers `local words from <id>` for a downloaded model.
 * `speak` of a downloaded model writes the format line at 24000 Hz, then 4800 bytes of PCM (value 1) per
 * sentence of its input, then done; with a text holding "hold" it stops after the first sentence's audio and
 * waits to be killed; `speak <id> --list-voices` names three voices (af_alloy, af_sol, bm_lewis), and `--voice` must
 * be one of them. Every call is appended to `calls.log` in `dir`; the text `speak` read to `speak.log`,
 * and its process id to `speak.pid`.
 */
export function fakeReceiver(dir: string): { path: string; log: string } {
  const path = join(dir, "fake-receiver");
  const log = join(dir, "calls.log");
  const state = join(dir, "downloaded.json");
  writeFileSync(state, JSON.stringify(["parakeet-v3"]));
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
const [, , cmd, sub, id] = process.argv;
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
const out = (v) => process.stdout.write(JSON.stringify(v) + "\\n");
const state = ${JSON.stringify(state)};
const have = JSON.parse(fs.readFileSync(state, "utf8"));
const CATALOG = [
  { id: "parakeet-v3", kind: "transcription", name: "Parakeet v3", languages: ["en", "de"], size: 640000000 },
  { id: "whisper-small", kind: "transcription", name: "Whisper small", languages: ["en"], size: 639387718 },
  { id: "kokoro", kind: "speech", name: "Kokoro", languages: ["en"], size: 100000000 },
];
if (cmd === "transcribe") {
  if (!have.includes(sub)) { process.stderr.write("pi-speech-receiver: " + sub + " is not downloaded\\n"); process.exit(1); }
  fs.readFileSync(id);
  process.stdout.write("local words from " + sub + "\\n");
  process.exit(0);
}
if (cmd === "speak") {
  fs.writeFileSync(${JSON.stringify(join(dir, "speak.pid"))}, String(process.pid));
  const ev = (v) => process.stderr.write(JSON.stringify(v) + "\\n");
  if (!have.includes(sub)) {
    ev({ event: "error", message: "the model " + sub + " is not downloaded; download it with \`pi-speech-receiver models download " + sub + "\`" });
    process.exit(1);
  }
  const VOICES = ["af_alloy", "af_sol", "bm_lewis"];
  if (process.argv.includes("--list-voices")) {
    VOICES.forEach((name, number) => out({ name, number }));
    process.exit(0);
  }
  const voice = process.argv[process.argv.indexOf("--voice") + 1];
  if (process.argv.includes("--voice") && !VOICES.includes(voice)) {
    ev({ event: "error", message: "unknown voice " + JSON.stringify(voice) + "; the voices are " + VOICES.join(", ") });
    process.exit(1);
  }
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (s) => { text += s; });
  process.stdin.on("end", () => {
    fs.appendFileSync(${JSON.stringify(join(dir, "speak.log"))}, JSON.stringify(text) + "\\n");
    process.stderr.write("a library warning, not JSON\\n");
    ev({ event: "format", rate: 24000, channels: 1 });
    const sentences = text.split(/(?<=[.!?])\\s+/).filter((x) => x.trim());
    process.stdout.write(Buffer.alloc(4800, 1), () => {
      if (text.includes("hold")) return setInterval(() => {}, 1000);
      for (let i = 1; i < sentences.length; i++) process.stdout.write(Buffer.alloc(4800, 1));
      process.stdout.end(() => { ev({ event: "done" }); process.exit(0); });
    });
  });
  return;
}
if (cmd === "models" && sub === "list") {
  for (const m of CATALOG) out({ ...m, downloaded: have.includes(m.id), partial: 0, path: "/cache/" + m.id });
  process.exit(0);
}
if (cmd === "models" && sub === "download") {
  const m = CATALOG.find((x) => x.id === id);
  for (const done of [0, m.size / 2, m.size]) out({ event: "progress", id, done, total: m.size });
  out({ event: "verifying", id });
  out({ event: "unpacking", id });
  fs.writeFileSync(state, JSON.stringify([...have, id]));
  out({ event: "done", id, path: "/cache/" + id });
  process.exit(0);
}
if (cmd === "models" && sub === "delete") {
  fs.writeFileSync(state, JSON.stringify(have.filter((x) => x !== id)));
  out({ event: "deleted", id, freed: 1234 });
  process.exit(0);
}
process.exit(2);
`,
  );
  chmodSync(path, 0o755);
  return { path, log };
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
