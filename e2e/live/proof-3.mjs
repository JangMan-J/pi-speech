// Live part of proof-3 (voice-language samples): non-English voice samples through /speech --sample, with real
// OpenRouter speech, transcribed back with real OpenRouter and no language hint.
import fs from 'node:fs';
import path from 'node:path';
import { check, finish, needKey, sleep, TRANSCRIBE_MODEL, transcribe } from './lib.mjs';
import { command, errors, liveSession, notes } from './session.mjs';

const KANA_OR_KANJI = /[\u3040-\u30ff\u4e00-\u9fff]/;
const FRENCH = ['bonjour', 'je', 'le', 'la', 'les', 'est', 'de', 'suis', 'voix', "c'est", 'salut', 'une', 'un', 'et', 'vous', 'nous', 'ma', 'mon', 'ceci', 'voici'];
const frenchWords = (t) => t.toLowerCase().split(/[^\p{L}']+/u).filter((w) => FRENCH.includes(w));
const PAIRS = [
  { voice: 'jf_alpha', label: 'Japanese', ok: (t) => KANA_OR_KANJI.test(t) },
  { voice: 'ff_siwis', label: 'French', ok: (t) => frenchWords(t).length > 0 },
];

const key = needKey();
// The player copies the file it is given, so the sample can be transcribed after the player has finished.
const ctx = await liveSession({ key, player: 'cp "$1" "$(dirname "$0")/played-$(date +%s%N).audio"' });
try {
  const s = await ctx.pi();
  const set = await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
  check(errors(set).length === 0, 'the speech model is Kokoro', notes(set));
  const played = () => fs.readdirSync(ctx.work).filter((f) => f.startsWith('played-')).sort();

  for (const { voice, label, ok } of PAIRS) {
    const before = played().length;
    const n = await command(s, `/speech --sample ${voice}`, 500);
    check(errors(n).length === 0, `/speech --sample ${voice} succeeds`, notes(n));
    for (let i = 0; i < 50 && played().length === before; i++) await sleep(100);
    const files = played();
    check(files.length === before + 1, `the ${voice} sample reaches the player`, files);
    const file = files[files.length - 1];
    if (files.length === before || !file) continue;
    const audio = fs.readFileSync(path.join(ctx.work, file));
    const format = audio.subarray(0, 4).toString() === 'RIFF' ? 'wav' : 'mp3';
    let text = '';
    try {
      text = await transcribe(key, audio, format, TRANSCRIBE_MODEL);
    } catch (err) {
      check(false, `the ${voice} sample can be transcribed`, String(err.message ?? err));
      continue;
    }
    console.log(`  ${voice} heard as: ${text.slice(0, 120)}`);
    check(ok(text), `the ${voice} sample is spoken in ${label} (transcribed without a language hint)`, text.slice(0, 200));
  }
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
