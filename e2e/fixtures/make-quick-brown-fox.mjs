#!/usr/bin/env node
// Regenerates quick-brown-fox.wav with live OpenRouter text-to-speech (Kokoro, voice af_heart): about 45 characters.
// Needs OPENROUTER_API_KEY or a Pi login for OpenRouter. The key is never printed or stored.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needKey, synthesize } from '../live/lib.mjs';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'quick-brown-fox.wav');
const wav = await synthesize(needKey(), 'The quick brown fox jumps over the lazy dog.', 'hexgrad/kokoro-82m', 'af_heart');
fs.writeFileSync(out, wav);
console.log(`wrote ${out} (${wav.length} bytes)`);
