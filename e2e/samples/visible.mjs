// Visible acceptance: voice samples in the voice language.
import fs from 'node:fs';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';

const KANA = /[\u3040-\u30ff]/;
const FR = ['bonjour', 'je', 'le', 'la', 'les', 'est', 'de', 'suis', 'voix', "c'est", 'salut'];
const isFrench = (t) => t.toLowerCase().split(/[^\p{L}']+/u).some((w) => FR.includes(w));
const ctx = await setup();
try {
  let s = await ctx.pi();
  const lastSpeech = () => ctx.speechRequests().at(-1)?.body ?? {};

  await command(s, '/speech --set tts-model deepgram/aura-2');
  await command(s, '/speech --set voice aura-2-thalia-en');
  let n = await command(s, '/speech --sample aura-2-ama-ja', 800);
  check(errors(n).length === 0, 'sampling a Japanese voice succeeds', notes(n));
  check(lastSpeech().voice === 'aura-2-ama-ja' && KANA.test(lastSpeech().input ?? ''), 'a ja voice is sampled with Japanese text', lastSpeech());
  check(/\bja\b|japanese/i.test(notes(n)), 'the notification names the sample language', notes(n));
  check(ctx.history().length === 0, 'samples are not saved in the history', ctx.history());
  const played = ctx.playerLog();
  check(played.length === 1 && !played[0].startsWith(ctx.speechDir), 'the sample is played from outside the history', played);
  check(notes(await command(s, '/speech --status')).includes('Voice: aura-2-thalia-en'), 'sampling does not change the selected voice');

  n = await command(s, '/speech --sample', 800);
  check(lastSpeech().voice === 'aura-2-thalia-en' && !KANA.test(lastSpeech().input ?? ''), 'without a voice the current voice is sampled', lastSpeech());

  await command(s, '/speech --set tts-model x-ai/grok-voice-tts-1.0');
  n = await command(s, '/speech --sample eve', 800);
  check(/^[\x20-\x7e]+$/.test(lastSpeech().input ?? '') && /english/i.test(notes(n)), 'an unknown voice is sampled in English and the fallback is disclosed', [lastSpeech().input, notes(n)]);

  n = await command(s, '/speech --language eve fr');
  check(errors(n).length === 0, 'setting a language override succeeds', notes(n));
  await command(s, '/speech --sample eve', 800);
  check(isFrench(lastSpeech().input ?? ''), 'the override selects French sample text', lastSpeech().input);
  await s.close();
  s = await ctx.pi();
  await command(s, '/speech --sample eve', 800);
  check(isFrench(lastSpeech().input ?? ''), 'the override persists across a restart', lastSpeech().input);
  await command(s, '/speech --language eve auto');
  await command(s, '/speech --sample eve', 800);
  check(!isFrench(lastSpeech().input ?? ''), 'auto removes the override', lastSpeech().input);

  const before = ctx.speechRequests().length;
  n = await command(s, '/speech --language eve not-a-language!');
  check(errors(n).length > 0, 'an invalid language tag is an error', notes(n));
  n = await command(s, '/speech --language nobody fr');
  check(errors(n).length > 0 && /eve|ara/.test(notes(n)), 'an unknown voice is an error naming valid voices', notes(n));
  check(ctx.speechRequests().length === before, 'errors send nothing');

  await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
  const langs = notes(await command(s, '/speech --languages')).split('\n');
  const line = (v) => langs.find((l) => l.includes(v)) ?? '';
  check(/\bja\b/.test(line('jf_alpha')) && /\ben\b/.test(line('af_heart')), 'languages lists each voice with its language', [line('jf_alpha'), line('af_heart')]);
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
