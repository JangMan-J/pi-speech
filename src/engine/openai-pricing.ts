/**
 * Live pricing for the direct OpenAI endpoint (`https://api.openai.com/v1`), parsed from OpenAI's
 * published markdown pricing page (`https://developers.openai.com/api/docs/pricing.md`).
 */

import { chatPriceTag, perMinute } from "./pricing";

export const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface OpenAiPriceTable {
  tts: Record<string, string>;
  stt: Record<string, string>;
}

const dollar = (cell: string | undefined): number | undefined => {
  const m = /\$\s*(\d+(?:\.\d+)?)/.exec(cell ?? "");
  return m ? Number(m[1]) : undefined;
};

/** Parse the Realtime & Audio and Transcription tables from OpenAI's `pricing.md`. */
export function parseOpenAiPricing(markdown: string): OpenAiPriceTable {
  const tts: Record<string, string> = {};
  const stt: Record<string, string> = {};

  interface AudioRates {
    textIn?: number;
    textOut?: number;
    audioIn?: number;
    audioOut?: number;
  }
  const audio: Record<string, AudioRates> = {};

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    const cols = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cols.length < 4) continue;
    const [col0, col1, col2, col3, col4] = cols;
    if (!col0 || col0 === "Model" || /^[-:\s]+$/.test(col0)) continue;
    const id = col0.toLowerCase();

    // Transcription table: | Model | Use case | Input | Output | Estimated cost |
    if (col4 && /\/\s*minute/i.test(col4)) {
      const rate = dollar(col4);
      if (rate !== undefined && rate >= 0) {
        const key = id === "whisper" ? "whisper-1" : id;
        stt[key] = perMinute(rate, false);
      }
      continue;
    }

    // Per-character TTS rows in Realtime & Audio: | tts-1 | Text | $15.00 / 1M characters | - | - |
    if (col1.toLowerCase() === "text" && /\/\s*1m\s*characters/i.test(col2)) {
      const perM = dollar(col2);
      if (perM !== undefined && perM >= 0) {
        // 800 chars/min (same spoken speech rate as pricing.ts).
        tts[id] = perMinute((perM / 1_000_000) * 800, true);
      }
      continue;
    }

    // Modality rows: | Model | Modality (Audio|Text) | Input | Output | Cached input |
    const mod = col1.toLowerCase();
    if (mod === "audio" || mod === "text") {
      if (!audio[id]) audio[id] = {};
      const entry = audio[id];
      const inRate = dollar(col2);
      const outRate = dollar(col3);
      if (mod === "audio") {
        if (inRate !== undefined) entry.audioIn = inRate / 1_000_000;
        if (outRate !== undefined) entry.audioOut = outRate / 1_000_000;
      } else {
        if (inRate !== undefined) entry.textIn = inRate / 1_000_000;
        if (outRate !== undefined) entry.textOut = outRate / 1_000_000;
      }
    }
  }

  for (const [id, r] of Object.entries(audio)) {
    if (r.audioOut !== undefined) {
      // Dedicated TTS models (e.g. gpt-4o-mini-tts) only publish output audio + input text rates.
      const p = chatPriceTag(
        {
          prompt: String(r.textIn ?? 0),
          completion: String(r.textOut ?? 0),
          audio: r.audioIn !== undefined ? String(r.audioIn) : undefined,
          audio_output: String(r.audioOut),
        },
        "tts",
        `openai/${id}`,
      );
      if (p) tts[id] = p;
    }
    if (r.audioIn !== undefined && !stt[id]) {
      const p = chatPriceTag(
        {
          prompt: String(r.textIn ?? 0),
          completion: String(r.textOut ?? 0),
          audio: String(r.audioIn),
          audio_output: r.audioOut !== undefined ? String(r.audioOut) : undefined,
        },
        "stt",
        `openai/${id}`,
      );
      if (p) stt[id] = p;
    }
  }

  return { tts, stt };
}

/** Look up an OpenAI model price by exact id or dated-snapshot prefix (e.g. `gpt-4o-mini-tts-2025-12-15`). */
export function lookupOpenAiPrice(
  table: OpenAiPriceTable | undefined,
  kind: "tts" | "stt",
  modelId: string,
): string | undefined {
  if (!table) return undefined;
  const map = table[kind];
  const key = modelId.toLowerCase();
  if (map[key]) return map[key];
  const base = key.replace(/-\d{4}-\d{2}-\d{2}$|-\d{4}$/, "");
  if (map[base]) return map[base];
  // Match longest known family name prefix (`gpt-4o-transcribe-2025-03-20` -> `gpt-4o-transcribe`).
  let best: string | undefined;
  for (const k of Object.keys(map)) {
    if (key.startsWith(`${k}-`) && (!best || k.length > best.length)) best = k;
  }
  return best ? map[best] : undefined;
}

/** Per-instance cache for OpenAI's live pricing table (avoids module-global mutable state). */
export class OpenAiPricingCache {
  private cached?: { fetchedAt: number; table: OpenAiPriceTable };
  private inflight?: Promise<OpenAiPriceTable | undefined>;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async fetch(fetchImpl: typeof fetch = globalThis.fetch): Promise<OpenAiPriceTable | undefined> {
    if (this.cached && this.now() - this.cached.fetchedAt < CACHE_TTL_MS) return this.cached.table;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await fetchImpl(OPENAI_PRICING_URL, { signal: AbortSignal.timeout(4000) });
        if (!res.ok) return undefined;
        const table = parseOpenAiPricing(await res.text());
        this.cached = { fetchedAt: this.now(), table };
        return table;
      } catch {
        return undefined;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}

export async function fetchOpenAiPricing(
  fetchImpl: typeof fetch = globalThis.fetch,
  cache: OpenAiPricingCache = new OpenAiPricingCache(),
): Promise<OpenAiPriceTable | undefined> {
  return cache.fetch(fetchImpl);
}
