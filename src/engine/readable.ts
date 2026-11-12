/**
 * Readable read-aloud: an assistant reply as text worth hearing. Markdown formatting is removed, fenced code
 * blocks are skipped, links are read as their text, and bare URLs as their host. Plain text passes unchanged.
 */

/** Replies longer than this are cut at a sentence boundary. */
export const MAX_SPOKEN_CHARS = 2000;

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s*>\s?/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const ENDS_SENTENCE = /[.!?…:;。！？]["'”’)\]]*$/;

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function inline(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_m, url: string) => host(url))
    .replace(/https?:\/\/[^\s<>()]+/g, (url) => {
      const trail = /[.,;:!?'"”’]+$/.exec(url)?.[0] ?? "";
      return host(url.slice(0, url.length - trail.length)) + trail;
    })
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*(\S(?:.*?\S)?)\*\*/g, "$1")
    .replace(/(?<![\w_])__(\S(?:.*?\S)?)__(?![\w_])/g, "$1")
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    .replace(/(?<![\w_])_(\S(?:.*?\S)?)_(?![\w_])/g, "$1")
    .replace(/~~(\S(?:.*?\S)?)~~/g, "$1")
    .replace(/<\/?[A-Za-z][^>]*>/g, "");
}

/** The words of a markdown reply, as they should be spoken. */
export function speakable(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const raw of markdown.split(/\r?\n/)) {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || RULE.test(raw) || TABLE_SEPARATOR.test(raw)) continue;
    let line = raw;
    const heading = HEADING.exec(line);
    if (heading) {
      const text = inline(heading[1]);
      out.push(text && !ENDS_SENTENCE.test(text) ? `${text}.` : text);
      continue;
    }
    while (QUOTE.test(line)) line = line.replace(QUOTE, "");
    line = line.replace(LIST_MARKER, "");
    if (TABLE_ROW.test(line)) {
      line = line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(", ");
    }
    out.push(inline(line));
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text within `max` characters, cut at the last sentence end (else the last word end) when it is longer. */
export function cutForSpeech(text: string, max = MAX_SPOKEN_CHARS): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = 0;
  for (const m of text.matchAll(/[.!?…。！？]+["'”’)\]]*(?=\s|$)/g)) {
    const e = (m.index ?? 0) + m[0].length;
    if (e > max) break;
    end = e;
  }
  if (end < max / 4) {
    const space = text.lastIndexOf(" ", max);
    end = space > 0 ? space : max;
  }
  return { text: text.slice(0, end).trimEnd(), cut: true };
}

/** Text parts of the final assistant message in a run; "" when there is none. */
export function finalAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m?.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (!Array.isArray(m.content)) return "";
    return m.content
      .filter((p: { type?: string; text?: unknown }) => p?.type === "text" && typeof p.text === "string")
      .map((p: { text: string }) => p.text)
      .join("\n");
  }
  return "";
}
