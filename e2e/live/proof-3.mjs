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
// The Stream player keeps what it is fed (and its arguments), so the sample can be transcribed after it has finished.
const ctx = await liveSession({ key, player: 'f="$(dirname "$0")/played-$(date +%s%N)"; cat > "$f.part"; echo "$*" > "$f.args"; mv "$f.part" "$f.audio"' });
/** A Stream as played: raw 16-bit PCM is given a WAV header from the player's arguments. */
function playedAudio(file) {
  const audio = fs.readFileSync(file);
  const [codec, rate, channels] = fs.readFileSync(file.replace(/\.audio$/, '.args'), 'utf8').trim().split(/\s+/);
  if (codec !== 's16le') return { audio, format: codec };
  const h = Buffer.alloc(44);
  const ch = Number(channels), r = Number(rate);
  h.write('RIFF', 0); h.writeUInt32LE(36 + audio.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(r, 24);
  h.writeUInt32LE(r * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(audio.length, 40);
  return { audio: Buffer.concat([h, audio]), format: 'wav' };
}
try {
  const s = await ctx.pi();
  const set = await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
  check(errors(set).length === 0, 'the speech model is Kokoro', notes(set));
  const played = () => fs.readdirSync(ctx.work).filter((f) => f.startsWith('played-') && f.endsWith('.audio')).sort();

  for (const { voice, label, ok } of PAIRS) {
    const before = played().length;
    const n = await command(s, `/speech --sample ${voice}`, 500);
    check(errors(n).length === 0, `/speech --sample ${voice} succeeds`, notes(n));
    for (let i = 0; i < 50 && played().length === before; i++) await sleep(100);
    const files = played();
    check(files.length === before + 1, `the ${voice} sample reaches the player`, files);
    const file = files[files.length - 1];
    if (files.length === before || !file) continue;
    const { audio, format } = playedAudio(path.join(ctx.work, file));
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
