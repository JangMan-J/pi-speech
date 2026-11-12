/**
 * The WAV/MP3 history of spoken messages. Derived from pi-openrouter-multimodal (MIT).
 * Each message is kept as `<stem>.wav` and `<stem>.mp3`; only the newest HISTORY_KEEP messages stay.
 */

import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Messages kept, each as a .wav and an .mp3. */
export const HISTORY_KEEP = 10;

/** `$PI_SPEECH_DIR`, default `~/Music/pi-speech`. */
export function historyDir(env: Record<string, string | undefined>, home: string): string {
  return env.PI_SPEECH_DIR || join(home, "Music", "pi-speech");
}

/** Convert `from` into `to` (format from the extension); resolves false on failure. */
export type Converter = (from: string, to: string) => Promise<boolean>;

/** Convert with ffmpeg; false if ffmpeg is missing or fails. */
export const ffmpegConvert: Converter = (from, to) => {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", from];
  if (to.endsWith(".mp3")) args.push("-codec:a", "libmp3lame", "-q:a", "2");
  args.push(to);
  return new Promise((resolve) => execFile("ffmpeg", args, { timeout: 30000 }, (err) => resolve(!err)));
};

export interface SavedMessage {
  /** Files of this message that exist, the synthesized one first. */
  files: string[];
  wav?: string;
  mp3?: string;
  /** Set when the second format could not be produced. */
  conversionError?: string;
}

/** A spoken message of the history, for replaying it. */
export interface HistoryMessage {
  /** The file to play: the MP3 when there is one. */
  file: string;
  /** When it was spoken, as `10-31 10:12`. */
  time: string;
  /** The start of its text, as the file name keeps it (lower case, without punctuation). */
  title: string;
}

/** Stem time `2026-10-31_10-12-03-123`: fixed width, so names sort in spoken order. */
const STEM = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3})(?:_[a-z0-9-]*)?\.(wav|mp3)$/;

function timePart(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
}

export class History {
  /** Last stem time used, so stems strictly increase even within one millisecond. */
  private last = 0;

  constructor(
    readonly dir: string,
    private readonly convert: Converter = ffmpegConvert,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Save `audio` (in `format`) and its conversion to the other format, then prune old messages.
   * `onWritten` runs once the synthesized file exists, before the conversion (to start playback early).
   */
  async save(
    text: string,
    audio: Uint8Array,
    format: "wav" | "mp3",
    onWritten?: (file: string) => Promise<void> | void,
  ): Promise<SavedMessage> {
    mkdirSync(this.dir, { recursive: true });
    const stem = this.newStem(text);
    const primary = join(this.dir, `${stem}.${format}`);
    const otherFormat = format === "wav" ? "mp3" : "wav";
    const other = join(this.dir, `${stem}.${otherFormat}`);
    writeFileSync(primary, audio);
    await onWritten?.(primary);

    const saved: SavedMessage = { files: [primary], [format]: primary };
    if (await this.convert(primary, other)) {
      saved.files.push(other);
      saved[otherFormat] = other;
    } else {
      rmSync(other, { force: true });
      saved.conversionError = `could not convert to ${otherFormat.toUpperCase()} (is ffmpeg installed?)`;
    }
    this.prune();
    return saved;
  }

  private newStem(text: string): string {
    const taken = new Set(this.entries().map((e) => e.time));
    let t = Math.max(this.now().getTime(), this.last + 1);
    while (taken.has(timePart(t))) t++;
    this.last = t;
    const s = slug(text);
    return s ? `${timePart(t)}_${s}` : timePart(t);
  }

  private entries(): { file: string; time: string; stem: string }[] {
    let files: string[];
    try {
      files = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: { file: string; time: string; stem: string }[] = [];
    for (const file of files) {
      const m = STEM.exec(file);
      if (m) out.push({ file, time: m[1], stem: file.replace(/\.(wav|mp3)$/, "") });
    }
    return out;
  }

  /** The newest message file (its MP3 when there is one), or undefined when the history is empty. */
  newest(): string | undefined {
    const entries = this.entries();
    const stem = entries
      .map((e) => e.stem)
      .sort()
      .at(-1);
    if (!stem) return undefined;
    const files = entries.filter((e) => e.stem === stem).map((e) => e.file);
    return join(this.dir, files.find((f) => f.endsWith(".mp3")) ?? files[0]);
  }

  /** The messages of the history, the newest first. */
  list(): HistoryMessage[] {
    const entries = this.entries();
    const stems = [...new Set(entries.map((e) => e.stem))].sort().reverse();
    return stems.map((stem) => {
      const files = entries.filter((e) => e.stem === stem).map((e) => e.file);
      const t = /^\d{4}-(\d{2}-\d{2})_(\d{2})-(\d{2})/.exec(stem);
      const title = stem.slice(stem.indexOf("_", 11) + 1);
      return {
        file: join(this.dir, files.find((f) => f.endsWith(".mp3")) ?? files[0]),
        time: t ? `${t[1]} ${t[2]}:${t[3]}` : "",
        title: stem.indexOf("_", 11) === -1 ? "(no words)" : title.replace(/-/g, " "),
      };
    });
  }

  /** Delete every message except the newest HISTORY_KEEP (both of its files). */
  private prune(): void {
    const entries = this.entries();
    const stems = [...new Set(entries.map((e) => e.stem))].sort();
    const drop = new Set(stems.slice(0, -HISTORY_KEEP));
    for (const e of entries) if (drop.has(e.stem)) rmSync(join(this.dir, e.file), { force: true });
  }
}
