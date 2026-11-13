/**
 * The history of spoken messages. Derived from pi-openrouter-multimodal (MIT).
 * Each message is kept once, as `<stem>.wav` or `<stem>.mp3` in the format it came in; only the newest
 * HISTORY_KEEP messages stay. A history from earlier versions, with both files per message, still reads.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Messages kept. */
export const HISTORY_KEEP = 10;

/** `$PI_SPEECH_DIR`, default `~/Music/pi-speech`. */
export function historyDir(env: Record<string, string | undefined>, home: string): string {
  return env.PI_SPEECH_DIR || join(home, "Music", "pi-speech");
}

export interface SavedMessage {
  /** The message's file. */
  files: [string];
}

/** A spoken message of the history, for replaying it. */
export interface HistoryMessage {
  /** The file to play (the MP3 of a message an earlier version saved twice). */
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
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Save `audio` (in `format`), then prune old messages. `onWritten` runs once the file exists. */
  async save(
    text: string,
    audio: Uint8Array,
    format: "wav" | "mp3",
    onWritten?: (file: string) => Promise<void> | void,
  ): Promise<SavedMessage> {
    mkdirSync(this.dir, { recursive: true });
    const stem = this.newStem(text);
    const file = join(this.dir, `${stem}.${format}`);
    writeFileSync(file, audio);
    await onWritten?.(file);
    this.prune();
    return { files: [file] };
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

  /** Delete every message except the newest HISTORY_KEEP (every file of each). */
  private prune(): void {
    const entries = this.entries();
    const stems = [...new Set(entries.map((e) => e.stem))].sort();
    const drop = new Set(stems.slice(0, -HISTORY_KEEP));
    for (const e of entries) if (drop.has(e.stem)) rmSync(join(this.dir, e.file), { force: true });
  }
}
