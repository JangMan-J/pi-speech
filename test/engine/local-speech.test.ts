import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LocalSpeechError,
  LocalSpeechProvider,
  listVoices,
  speakArgs,
  speakLocal,
} from "../../src/engine/local-speech";
import { STAND_IN_BINARY, until } from "./fixtures";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-speech-speak-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A stand-in for `speak`, steered by its model id: "ok" speaks two chunks 300 ms apart; "missing" fails before
 * any audio; "midway" fails after the first chunk; "hold" waits to be killed after the first chunk; "noise" exits
 * 3 with a plain line on standard error. It records its arguments, its input and its process id.
 */
function fakeSpeak(): string {
  const p = join(dir, "fake-speak");
  const log = join(dir, "log.json");
  const modelsLog = join(dir, "models.log");
  const pid = join(dir, "pid");
  writeFileSync(
    p,
    `#!${process.execPath}
const fs = require("node:fs");
const [, , cmd, id, ...rest] = process.argv;
fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
const ev = (v) => process.stderr.write(JSON.stringify(v) + "\\n");
if (cmd === "models" && id === "list") {
  fs.appendFileSync(${JSON.stringify(modelsLog)}, "list\\n");
  for (const m of [
    { id: "supertonic-3-int8", kind: "speech", languages: ["en", "de", "fr"] },
    { id: "kokoro-multi-lang-v1.1", kind: "speech", languages: ["en", "zh"] },
    { id: "piper-en_US-lessac-medium", kind: "speech", languages: ["en"] },
  ]) process.stdout.write(JSON.stringify(m) + "\\n");
  process.exit(0);
}
if (cmd !== "speak") process.exit(2);
if (id === "--serve") {
  // The running worker: framed answers (kind byte, length, body); model "ok" speaks [1,2,3,4] then [5,6].
  const frame = (kind, body) => {
    const head = Buffer.alloc(5);
    head.write(kind, 0, "latin1");
    head.writeUInt32LE(body.length, 1);
    process.stdout.write(Buffer.concat([head, body]));
  };
  const json = (v) => frame("J", Buffer.from(JSON.stringify(v)));
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const r = JSON.parse(line);
    if (r.cancel !== undefined) return;
    fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: [cmd, r.model], text: r.text, request: r,
      provider: process.env.PI_SPEECH_PROVIDER ?? null, pid: process.pid }));
    if (r.model === "missing") return json({ id: r.id, event: "error", message: "the model missing is not downloaded" });
    json({ id: r.id, event: "format", rate: 22050, channels: 1 });
    frame("A", Buffer.from([1, 2, 3, 4]));
    setTimeout(() => { frame("A", Buffer.from([5, 6])); json({ id: r.id, event: "done" }); }, 50);
  });
  return;
}
if (id === "missing") { ev({ event: "error", message: "the model missing is not downloaded; download it with \`pi-speech-receiver models download missing\`" }); process.exit(1); }
if (id === "noise") { process.stderr.write("pi-speech-receiver: something odd\\n"); process.exit(3); }
if (rest.includes("--list-voices")) {
  for (const [number, name] of ["af_maple", "bf_vale"].entries()) process.stdout.write(JSON.stringify({ name, number }) + "\\n");
  process.stdout.write("not a voice\\n");
  process.exit(0);
}
let text = "";
process.stdin.on("data", (d) => { text += d; });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: [cmd, id, ...rest], text }));
  process.stderr.write("WARNING: some library line\\n");
  ev({ event: "format", rate: 22050, channels: 1 });
  process.stdout.write(Buffer.from([1, 2, 3, 4]), () => {
    if (id === "hold") return setInterval(() => {}, 1000);
    if (id === "midway") { ev({ event: "error", message: "the voice model generated no audio" }); process.exit(1); }
    setTimeout(() => {
      process.stdout.write(Buffer.from([5, 6]));
      process.stdout.end(() => { ev({ event: "done" }); process.exit(0); });
    }, 300);
  });
});
`,
  );
  chmodSync(p, 0o755);
  return p;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("speakArgs", () => {
  it("passes a voice and a speed other than 1 only when given", () => {
    expect(speakArgs("kokoro")).toEqual(["speak", "kokoro"]);
    expect(speakArgs("kokoro", { voice: "" })).toEqual(["speak", "kokoro"]);
    expect(speakArgs("kokoro", { voice: "af_sol", speed: 1.5 })).toEqual([
      "speak",
      "kokoro",
      "--voice",
      "af_sol",
      "--speed",
      "1.5",
    ]);
    expect(speakArgs("piper", { speed: 1 })).toEqual(["speak", "piper"]);
  });
});

describe.skipIf(!STAND_IN_BINARY)("speakLocal", () => {
  it("is a pcm Stream at the reported rate whose first audio comes before the rest is generated", async () => {
    const bin = fakeSpeak();
    const t0 = Date.now();
    const stream = await speakLocal(bin, "ok", "Hello there. Second sentence.", { voice: "af_sol" });
    expect(stream.format).toEqual({ codec: "pcm", rate: 22050, channels: 1 });
    const got: Array<{ at: number; bytes: number[] }> = [];
    for await (const c of stream.chunks) got.push({ at: Date.now() - t0, bytes: [...c] });
    expect(got.flatMap((g) => g.bytes)).toEqual([1, 2, 3, 4, 5, 6]);
    // The first chunk came while the binary was still generating (it waits 300 ms before the second).
    expect(got.at(-1)!.at - got[0].at).toBeGreaterThanOrEqual(200);
    const log = JSON.parse(readFileSync(join(dir, "log.json"), "utf8"));
    expect(log).toEqual({ args: ["speak", "ok", "--voice", "af_sol"], text: "Hello there. Second sentence." });
  });

  it("fails with the binary's message before any audio", async () => {
    const bin = fakeSpeak();
    await expect(speakLocal(bin, "missing", "Hi.")).rejects.toThrow(
      "the model missing is not downloaded; download it with `pi-speech-receiver models download missing`",
    );
    await expect(speakLocal(bin, "noise", "Hi.")).rejects.toThrow(new LocalSpeechError("something odd"));
    await expect(speakLocal(join(dir, "no-such-binary"), "ok", "Hi.")).rejects.toThrow(/cannot run/);
  });

  it("throws the binary's message while the chunks are read when it fails midway", async () => {
    const stream = await speakLocal(fakeSpeak(), "midway", "Hi.");
    const read: number[] = [];
    await expect(
      (async () => {
        for await (const c of stream.chunks) read.push(...c);
      })(),
    ).rejects.toThrow("the voice model generated no audio");
    expect(read).toEqual([1, 2, 3, 4]);
  });

  it("aborting kills the binary at once", async () => {
    const bin = fakeSpeak();
    const ac = new AbortController();
    const stream = await speakLocal(bin, "hold", "Hi.", { signal: ac.signal });
    const it = stream.chunks[Symbol.asyncIterator]();
    expect([...((await it.next()).value as Uint8Array)]).toEqual([1, 2, 3, 4]);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    expect(alive(pid)).toBe(true);
    ac.abort();
    await expect(it.next()).rejects.toThrow();
    await until(() => !alive(pid));
  });

  it("leaving the chunks before their end kills the binary", async () => {
    const stream = await speakLocal(fakeSpeak(), "hold", "Hi.");
    for await (const _ of stream.chunks) break;
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await until(() => !alive(pid));
  });

  it("an aborted request starts nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(speakLocal(fakeSpeak(), "ok", "Hi.", { signal: ac.signal })).rejects.toThrow();
    expect(existsSync(join(dir, "pid"))).toBe(false);
  });
});

describe.skipIf(!STAND_IN_BINARY)("LocalSpeechProvider", () => {
  it("synthesizes a whole WAV and needs no credential", async () => {
    const bin = fakeSpeak();
    const provider = new LocalSpeechProvider(() => bin);
    await provider.ensureCredential();
    const audio = await provider.synthesize({ text: "Hi.", model: "ok", voice: "", language: "auto" });
    expect(audio.format).toBe("wav");
    const wav = Buffer.from(audio.audio);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(24)).toBe(22050);
    expect([...wav.subarray(44)]).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(provider.transcribe()).rejects.toThrow(/does not transcribe/);
  });

  it("speaks through one running worker, with the language of the text when one is named", async () => {
    const bin = fakeSpeak();
    const provider = new LocalSpeechProvider(() => bin);
    const request = () => JSON.parse(readFileSync(join(dir, "log.json"), "utf8")).request;
    await provider.synthesize({ text: "Hallo.", model: "supertonic-3-int8", voice: "M2", language: "de" });
    expect(request()).toMatchObject({ model: "supertonic-3-int8", text: "Hallo.", voice: "M2", lang: "de" });
    const pid = readFileSync(join(dir, "pid"), "utf8");
    await provider.synthesize({ text: "Hi.", model: "ok", voice: "", language: "auto" });
    expect(request().lang).toBeUndefined();
    expect(readFileSync(join(dir, "pid"), "utf8")).toBe(pid);
    await expect(provider.synthesize({ text: "Hi.", model: "missing", voice: "", language: "auto" })).rejects.toThrow(
      /not downloaded/,
    );
    provider.close();
  });

  it("omits languages for voice-language families and unsupported Supertonic languages, and caches the catalogue", async () => {
    const bin = fakeSpeak();
    const provider = new LocalSpeechProvider(() => bin);
    const request = () => JSON.parse(readFileSync(join(dir, "log.json"), "utf8")).request;
    await provider.synthesize({ text: "Hi.", model: "kokoro-multi-lang-v1.1", voice: "", language: "en" });
    expect(request().lang).toBeUndefined();
    await provider.synthesize({ text: "Hi.", model: "piper-en_US-lessac-medium", voice: "", language: "en" });
    expect(request().lang).toBeUndefined();
    await provider.synthesize({ text: "Hi.", model: "supertonic-3-int8", voice: "", language: "zh" });
    expect(request().lang).toBeUndefined();
    expect(readFileSync(join(dir, "models.log"), "utf8").trim().split("\n")).toHaveLength(1);
    provider.close();
  });

  it("restarts the worker when closed after switching receiver binaries", async () => {
    const binA = fakeSpeak();
    const binB = fakeSpeak();
    let active = binA;
    const provider = new LocalSpeechProvider(
      () => active,
      () => process.env,
      () => undefined,
      async () => active,
    );
    const logged = () => JSON.parse(readFileSync(join(dir, "log.json"), "utf8"));
    await provider.synthesize({ text: "Hi.", model: "ok", voice: "", language: "auto" });
    const first = logged();
    active = binB;
    provider.close();
    await provider.synthesize({ text: "Hi.", model: "ok", voice: "", language: "auto" });
    expect(logged().pid).not.toBe(first.pid);
    provider.close();
  });

  it("lists a model's voices from speak --list-voices, and says why it cannot", async () => {
    const bin = fakeSpeak();
    expect(await listVoices(bin, "ok")).toEqual([
      { name: "af_maple", number: 0 },
      { name: "bf_vale", number: 1 },
    ]);
    expect(await new LocalSpeechProvider(() => bin).voices("ok")).toHaveLength(2);
    await expect(listVoices(bin, "missing")).rejects.toThrow(
      new LocalSpeechError(
        "the model missing is not downloaded; download it with `pi-speech-receiver models download missing`",
      ),
    );
    await expect(listVoices(bin, "noise")).rejects.toThrow("something odd");
  });

  it("says why there is no binary", async () => {
    const provider = new LocalSpeechProvider(() => {
      throw new Error("the bundled pi-speech-receiver is not installed");
    });
    await expect(provider.synthesizeStream({ text: "Hi.", model: "ok", voice: "", language: "auto" })).rejects.toThrow(
      /not installed/,
    );
  });
});
