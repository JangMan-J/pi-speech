// Held-out acceptance: voice samples in the voice language.
import fs from 'node:fs';
import path from 'node:path';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';

const ES = ['hola', 'soy', 'es', 'el', 'la', 'de', 'voz', 'una', 'esta'];
const words = (t) => (t ?? '').toLowerCase().split(/[^\p{L}']+/u);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = await setup();
try {
  const tmp = path.join(ctx.work, 'tmp');
  fs.mkdirSync(tmp);
  const s = await ctx.pi({ env: { TMPDIR: tmp } });
  const last = () => ctx.speechRequests().at(-1)?.body ?? {};

  await command(s, '/speech --set tts-model google/gemini-3.8-flash-tts');
  let n = await command(s, '/speech --sample Puck', 800);
  check(/multilingual/i.test(notes(n)) && /english/i.test(notes(n)), 'a multilingual voice is labeled and the English fallback disclosed', notes(n));
  const ml = notes(await command(s, '/speech --languages'));
  check(/Puck.*multilingual/i.test(ml), 'languages labels Gemini voices multilingual', ml.split('\n')[0]);

  await command(s, '/speech --set tts-model microsoft/mai-voice-2.1');
  await command(s, '/speech --sample es-MX-Valeria:MAI-Voice-2.1', 800);
  check(words(last().input).some((w) => ES.includes(w)), 'a MAI es-MX voice samples in Spanish', last().input);

  await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
  await command(s, '/speech --language jf_alpha fr');
  await command(s, '/speech --set tts-model deepgram/aura-2');
  await command(s, '/speech --sample aura-2-ama-ja', 800);
  check(/[\u3040-\u30ff]/.test(last().input ?? ''), 'an override applies only to its own model and voice', last().input);
  const ov = notes(await command(s, '/speech --languages'));
  check(!/override/i.test(ov.split('\n').find((l) => l.includes('aura-2-ama-ja')) ?? ''), 'other voices show their evidence, not an override');
  await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
  const kl = notes(await command(s, '/speech --languages')).split('\n').find((l) => l.includes('jf_alpha')) ?? '';
  check(/\bfr\b/.test(kl) && /override/i.test(kl), 'languages shows an override as such', kl);
  await command(s, '/speech --set tts-model x-ai/grok-voice-tts-1.0');
  const gl = notes(await command(s, '/speech --languages')).split('\n').find((l) => l.includes('eve')) ?? '';
  check(/unknown/i.test(gl), 'an unknown voice is listed as unknown', gl);

  // rapid samples: a new sample stops the previous one
  const slow = path.join(ctx.work, 'slow-player');
  fs.writeFileSync(slow, `#!/usr/bin/env bash\necho "start $$" >> "${ctx.work}/slow.log"\ntrap 'echo "term $$" >> "${ctx.work}/slow.log"; exit 143' TERM INT\nsleep 5 & wait $!\necho "end $$" >> "${ctx.work}/slow.log"\n`, { mode: 0o755 });
  const s2 = await ctx.pi({ env: { PI_SPEECH_STREAM_PLAYER: slow, TMPDIR: tmp } });
  await command(s2, '/speech --sample ara', 200);
  await command(s2, '/speech --sample rex', 600);
  const log = fs.existsSync(path.join(ctx.work, 'slow.log')) ? fs.readFileSync(path.join(ctx.work, 'slow.log'), 'utf8') : '';
  const pids = [...log.matchAll(/^start (\d+)/gm)].map((m) => m[1]);
  const termed = new Set([...log.matchAll(/^term (\d+)/gm)].map((m) => m[1]));
  check(pids.length === 2 && termed.has(pids[0]) && !termed.has(pids[1]), 'a new sample stops the previous one', log);
  await s2.close();
  await s.close();
  await sleep(300);
  check(ctx.history().length === 0, 'no sample ever reached the history');
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
