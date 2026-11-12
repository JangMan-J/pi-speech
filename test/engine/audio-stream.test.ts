/** A speech response of any kind as a Stream, and a Stream that has fully arrived as one clip. */

import { describe, expect, it } from "vitest";
import { clipOf, streamFromBody } from "../../src/engine/audio-stream";
import { wrapPcmAsWav } from "../../src/engine/wav";
import { chunkedBody, pcmBytes } from "./fixtures";

const all = async (chunks: AsyncIterable<Uint8Array>) => {
  const got: Uint8Array[] = [];
  for await (const c of chunks) got.push(c);
  return Buffer.concat(got);
};

/** A 16-bit PCM WAV header whose sizes are left open, as a service that streams it writes. */
function openWavHead(rate: number, channels: number): Buffer {
  const h = Buffer.from(wrapPcmAsWav(new Uint8Array(0), rate, channels));
  h.writeUInt32LE(0xffffffff, 4);
  h.writeUInt32LE(0xffffffff, 40);
  return h;
}

describe("streamFromBody", () => {
  it("raw PCM: rate and channels from the content type, every byte handed over", async () => {
    const b = chunkedBody();
    const pending = streamFromBody(b.body, "audio/pcm;rate=16000;channels=2", "S");
    b.send(pcmBytes(20));
    const s = await pending;
    expect(s.format).toEqual({ codec: "pcm", rate: 16000, channels: 2 });
    b.send(pcmBytes(10, 20));
    b.end();
    expect(Array.from(await all(s.chunks))).toEqual(Array.from(pcmBytes(30)));
  });

  it("a 16-bit PCM WAV with open sizes, its header split across chunks: PCM after the header", async () => {
    const b = chunkedBody();
    const head = openWavHead(22050, 1);
    const pending = streamFromBody(b.body, "audio/wav", "S");
    b.send(head.subarray(0, 20));
    b.send(Buffer.concat([head.subarray(20), Buffer.from(pcmBytes(6))]));
    const s = await pending;
    expect(s.format).toEqual({ codec: "pcm", rate: 22050, channels: 1 });
    b.send(pcmBytes(4, 6));
    b.end();
    expect(Array.from(await all(s.chunks))).toEqual(Array.from(pcmBytes(10)));
  });

  it("a WAV told by its bytes whatever its content type", async () => {
    const wav = Buffer.concat([openWavHead(24000, 1), Buffer.from(pcmBytes(8))]);
    const s = await streamFromBody(new Response(wav).body, "application/octet-stream", "S");
    expect(s.format).toEqual({ codec: "pcm", rate: 24000, channels: 1 });
  });

  it("a WAV that is not 16-bit PCM is handed over whole, for a player that decodes it", async () => {
    const wav = Buffer.concat([openWavHead(24000, 1), Buffer.from(pcmBytes(8))]);
    wav.writeUInt16LE(3, 20); // IEEE float
    wav.writeUInt16LE(32, 34);
    const s = await streamFromBody(new Response(wav).body, "audio/wav", "S");
    expect(s.format).toEqual({ codec: "wav" });
    expect((await all(s.chunks)).equals(wav)).toBe(true);
  });

  it("MP3 by its bytes or its type", async () => {
    const frame = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect((await streamFromBody(new Response(frame).body, "", "S")).format).toEqual({ codec: "mp3" });
    const id3 = new TextEncoder().encode("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000");
    expect((await streamFromBody(new Response(id3).body, "", "S")).format).toEqual({ codec: "mp3" });
  });

  it("no audio, or audio of another kind, is an error naming the service", async () => {
    await expect(streamFromBody(new Response(new Uint8Array(0)).body, "audio/mpeg", "S")).rejects.toThrow(
      /S returned no audio/,
    );
    await expect(streamFromBody(new Response("<html>hello there</html>").body, "text/html", "S")).rejects.toThrow(
      /unexpected audio from S: text\/html/,
    );
  });
});

describe("clipOf", () => {
  it("PCM becomes one WAV; a trailing part of a frame is dropped", () => {
    const c = clipOf({ codec: "pcm", rate: 24000, channels: 1 }, Buffer.from(pcmBytes(11)), "S");
    expect(c.format).toBe("wav");
    const wav = Buffer.from(c.audio);
    expect(wav.readUInt32LE(40)).toBe(10);
    expect(Array.from(wav.subarray(44))).toEqual(Array.from(pcmBytes(10)));
  });

  it("MP3 is kept as sent; a WAV gets its sizes written", () => {
    const mp3 = Buffer.from([0xff, 0xfb, 1, 2]);
    expect(clipOf({ codec: "mp3" }, mp3, "S")).toEqual({ audio: mp3, format: "mp3" });
    const open = Buffer.concat([openWavHead(24000, 1), Buffer.from(pcmBytes(8))]);
    const wav = Buffer.from(clipOf({ codec: "wav" }, open, "S").audio);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });

  it("nothing at all is an error", () => {
    expect(() => clipOf({ codec: "pcm", rate: 24000, channels: 1 }, Buffer.alloc(1), "S")).toThrow(/no audio/);
    expect(() => clipOf({ codec: "mp3" }, Buffer.alloc(0), "S")).toThrow(/no audio/);
  });
});
