/** The chunks of a WAV file that matter here: the format and the audio data. */
interface WavChunks {
  /** Body of the `fmt ` chunk. */
  fmt: Buffer;
  /** The audio data. */
  data: Buffer;
}

/** The format and data of a RIFF/WAVE file, or undefined when it is not one. */
function readWav(bytes: Uint8Array): WavChunks | undefined {
  const wav = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (wav.length < 12 || wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") {
    return undefined;
  }
  let fmt: Buffer | undefined;
  let pos = 12;
  while (pos + 8 <= wav.length) {
    const id = wav.toString("latin1", pos, pos + 4);
    const declared = wav.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt " && body + 16 <= wav.length)
      fmt = wav.subarray(body, body + Math.min(declared, wav.length - body));
    if (id === "data") {
      if (!fmt) return undefined;
      const available = wav.length - body;
      // A recorder killed before it could finish the header leaves 0 or 0xFFFFFFFF; trust the file size then.
      const bytes = declared === 0 || declared > available ? available : declared;
      return { fmt, data: wav.subarray(body, body + bytes) };
    }
    pos = body + declared + (declared % 2);
  }
  return undefined;
}

/** The format (the `fmt ` chunk) of a WAV file, or undefined when it is not one; equal formats can be joined. */
export function wavFormat(bytes: Uint8Array): Buffer | undefined {
  return readWav(bytes)?.fmt;
}

/** Length in seconds of the audio in a WAV file, or undefined when it is not a readable PCM WAV. */
export function wavSeconds(wav: Buffer): number | undefined {
  const w = readWav(wav);
  const byteRate = w ? w.fmt.readUInt32LE(8) : 0;
  return w && byteRate > 0 ? w.data.length / byteRate : undefined;
}

/**
 * One WAV file holding the audio of `pieces` in order, under one header; undefined when a piece is not a
 * WAV file or the pieces' formats differ.
 */
export function joinWav(pieces: readonly Uint8Array[]): Uint8Array | undefined {
  const parts = pieces.map(readWav);
  const first = parts[0];
  if (!first || parts.some((p) => !p?.fmt.equals(first.fmt))) return undefined;
  const data = Buffer.concat(parts.map((p) => (p as WavChunks).data));
  const head = Buffer.alloc(20);
  head.write("RIFF", 0, "latin1");
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(first.fmt.length, 16);
  const dataHead = Buffer.alloc(8);
  dataHead.write("data", 0, "latin1");
  dataHead.writeUInt32LE(data.length, 4);
  // Chunks of odd length are followed by one pad byte.
  const pad = (n: number) => Buffer.alloc(n % 2);
  const out = Buffer.concat([head, first.fmt, pad(first.fmt.length), dataHead, data, pad(data.length)]);
  out.writeUInt32LE(out.length - 8, 4);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Prepend a 44-byte WAV header to headerless 16-bit little-endian PCM. */
export function wrapPcmAsWav(pcm: Uint8Array, sampleRate: number, channels: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVEfmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true); // byte rate
  v.setUint16(32, channels * 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}
