import { describe, expect, it } from "vitest";
import { wrapPcmAsWav } from "../../src/engine/openrouter";
import { joinWav } from "../../src/engine/wav";

const pcm = (n: number, fill: number) => new Uint8Array(n).fill(fill);

/** A WAV with an extra chunk before `data`, as some services send. */
function wavWithList(data: Uint8Array): Buffer {
  const plain = Buffer.from(wrapPcmAsWav(data, 24000, 1));
  const list = Buffer.alloc(12);
  list.write("LIST", 0, "latin1");
  list.writeUInt32LE(4, 4);
  list.write("INFO", 8, "latin1");
  const out = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

describe("joining WAV pieces", () => {
  it("joins the data of the pieces under one header", () => {
    const joined = joinWav([
      wrapPcmAsWav(pcm(100, 1), 24000, 1),
      wavWithList(pcm(50, 2)),
      wrapPcmAsWav(pcm(6, 3), 24000, 1),
    ]);
    expect(joined).toBeDefined();
    const b = Buffer.from(joined as Uint8Array);
    expect(b.toString("latin1", 0, 4)).toBe("RIFF");
    expect(b.toString("latin1", 8, 16)).toBe("WAVEfmt ");
    expect(b.readUInt32LE(4)).toBe(b.length - 8);
    expect(b.readUInt32LE(24)).toBe(24000);
    expect(b.toString("latin1", 36, 40)).toBe("data");
    expect(b.readUInt32LE(40)).toBe(156);
    expect(b.length).toBe(44 + 156);
    expect([...b.subarray(44)]).toEqual([...pcm(100, 1), ...pcm(50, 2), ...pcm(6, 3)]);
  });

  it("uses the file's length when a piece's data length is unset", () => {
    const w = Buffer.from(wrapPcmAsWav(pcm(10, 7), 24000, 1));
    w.writeUInt32LE(0xffffffff, 40);
    const b = Buffer.from(joinWav([w, w]) as Uint8Array);
    expect(b.readUInt32LE(40)).toBe(20);
  });

  it("refuses pieces of different formats or that are not WAV", () => {
    expect(joinWav([wrapPcmAsWav(pcm(10, 1), 24000, 1), wrapPcmAsWav(pcm(10, 1), 16000, 1)])).toBeUndefined();
    expect(joinWav([wrapPcmAsWav(pcm(10, 1), 24000, 1), Buffer.from("ID3 not a wav file at all")])).toBeUndefined();
    expect(joinWav([])).toBeUndefined();
  });
});
