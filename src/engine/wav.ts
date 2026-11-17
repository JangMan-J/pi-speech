/**
 * Single RIFF/WAVE parser, joiner, and rate-aware slicer used by streaming audio, history, and live dictation.
 */

/** The chunks of a WAV file that matter here: the format and the audio data. */
interface WavChunks {
  /** Body of the `fmt ` chunk. */
  fmt: Buffer;
  /** The audio data. */
  data: Buffer;
}

export type WavHeader =
  /** The header is not complete yet. */
  | { state: "more" }
  /** 16-bit PCM: the samples start at `dataOffset`. */
  | { state: "pcm"; rate: number; channels: number; byteRate: number; dataOffset: number; dataLength: number }
  /** Another encoding or non-WAV bytes. */
  | { state: "other" };

/**
 * Inspect as much of a WAV header as has arrived; sizes may be left open (`0` or `0xFFFFFFFF`).
 * Returns `"more"` when the header is incomplete, `"pcm"` for 16-bit PCM, or `"other"` for another encoding.
 */
export function parseWavHeader(bytes: Uint8Array): WavHeader {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 12) return { state: "more" };
  if (b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") {
    return { state: "other" };
  }
  let fmt: { tag: number; channels: number; rate: number; byteRate: number; bits: number } | undefined;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = b.toString("latin1", pos, pos + 4);
    const declared = b.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "data") {
      if (!fmt) return { state: "other" };
      const pcm = (fmt.tag === 1 || fmt.tag === 0xfffe) && fmt.bits === 16;
      if (!pcm) return { state: "other" };
      const available = b.length - body;
      const dataLength = declared === 0 || declared > available ? available : declared;
      const byteRate = fmt.byteRate || fmt.rate * fmt.channels * 2;
      return { state: "pcm", rate: fmt.rate, channels: fmt.channels, byteRate, dataOffset: body, dataLength };
    }
    if (id === "fmt ") {
      if (body + 16 > b.length) return { state: "more" };
      fmt = {
        tag: b.readUInt16LE(body),
        channels: b.readUInt16LE(body + 2),
        rate: b.readUInt32LE(body + 4),
        byteRate: b.readUInt32LE(body + 8),
        bits: b.readUInt16LE(body + 14),
      };
    }
    pos = body + declared + (declared % 2);
  }
  return { state: "more" };
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

export interface WavPcmInfo {
  dataOffset: number;
  byteRate: number;
  blockAlign: number;
}

const DEFAULT_WAV_INFO: WavPcmInfo = { dataOffset: 44, byteRate: 48_000, blockAlign: 2 };

/** Data offset, byte rate, and sample-frame alignment of a 16-bit PCM WAV (falls back to 24 kHz mono). */
export function wavPcmInfo(wav: Uint8Array): WavPcmInfo {
  const h = parseWavHeader(wav);
  if (h.state === "pcm" && h.byteRate > 0 && h.channels > 0) {
    return { dataOffset: h.dataOffset, byteRate: h.byteRate, blockAlign: Math.max(2, h.channels * 2) };
  }
  return DEFAULT_WAV_INFO;
}

const alignDown = (n: number, align: number) => n - (n % align);

/** Build an in-memory WAV containing only the PCM slice from `startByte` to `endByte` (preserving header chunks). */
export function sliceWav(wav: Buffer, startByte: number, endByte = wav.length): Buffer {
  const { dataOffset, blockAlign } = wavPcmInfo(wav);
  const start = dataOffset + alignDown(Math.max(0, startByte - dataOffset), blockAlign);
  const end =
    dataOffset + alignDown(Math.max(start - dataOffset, Math.min(wav.length, endByte) - dataOffset), blockAlign);
  const pcm = wav.subarray(start, end);
  const out = Buffer.allocUnsafe(dataOffset + pcm.length);
  wav.copy(out, 0, 0, dataOffset);
  pcm.copy(out, dataOffset);
  if (dataOffset >= 8) {
    out.writeUInt32LE(dataOffset - 8 + pcm.length, 4);
    out.writeUInt32LE(pcm.length, dataOffset - 4);
  }
  return out;
}

/** Find the quietest 0.25 s boundary between `minSec` and `maxSec` past `fromByte` using the WAV's actual rate. */
export function quietSplitByte(wav: Buffer, fromByte: number, minSec = 8, maxSec = 13): number {
  const { dataOffset, byteRate, blockAlign } = wavPcmInfo(wav);
  const minBytes = alignDown(Math.round(minSec * byteRate), blockAlign);
  const maxBytes = alignDown(Math.round(maxSec * byteRate), blockAlign);
  const searchStart = Math.max(dataOffset, fromByte + minBytes);
  const searchEnd = Math.min(wav.length, fromByte + maxBytes);
  const winBytes = Math.max(blockAlign, alignDown(Math.round(byteRate * 0.25), blockAlign));
  const step = Math.max(blockAlign, alignDown(Math.round(byteRate * 0.05), blockAlign));
  if (searchEnd - searchStart <= winBytes)
    return dataOffset + alignDown(Math.max(0, searchEnd - dataOffset), blockAlign);
  let bestAt = searchStart;
  let bestEnergy = Number.POSITIVE_INFINITY;
  for (let off = searchStart; off + winBytes <= searchEnd; off += step) {
    let energy = 0;
    for (let i = off; i + 2 <= off + winBytes; i += 4) {
      energy += Math.abs(wav.readInt16LE(i));
    }
    if (energy < bestEnergy) {
      bestEnergy = energy;
      bestAt = off + Math.floor(winBytes / 2);
    }
  }
  return dataOffset + alignDown(Math.max(0, bestAt - dataOffset), blockAlign);
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
