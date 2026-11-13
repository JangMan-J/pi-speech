// Live part of proof-1 for xAI: the real xAI speech service through the extension in an isolated Pi, using the
// token of the user's own Pi xAI login. The token reaches only the child Pi's environment (XAI_API_KEY); it is
// never written to a file or printed.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { check, ffprobeDuration, finish, open } from './lib.mjs';
import { callTool, command, errors, liveSession, notes } from './session.mjs';

let token = '';
try {
  token = execFileSync('pi', ['auth', 'print-bearer-token', '--provider', 'xai'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
} catch { /* handled below */ }
if (!token) open('no xAI login: log in to xAI in Pi (pi auth login xai)');

const fixture = path.join(import.meta.dirname, '..', 'fixtures', 'quick-brown-fox.wav');
const ctx = await liveSession({ key: undefined, env: { XAI_API_KEY: token, OPENROUTER_API_KEY: null } });
const scrub = (t) => String(t).split(token).join('<xai-token>');
try {
  const s = await ctx.pi();
  const models = notes(await command(s, '/speech --models', 3000));
  check(models.split('\n').filter((l) => /^xai\b/.test(l.trim())).length === 2, 'xai is offered as a speech and a transcription model', scrub(models).slice(0, 300));
  const set = await command(s, '/speech --set tts-model xai');
  check(errors(set).length === 0, 'selecting xai succeeds', notes(set));
  const voices = notes(await command(s, '/speech --voices', 2000));
  check(voices.split('\n').filter(Boolean).length > 5, 'the voices come from the live xAI list', scrub(voices).slice(0, 200));
  await command(s, '/speech --set voice eve');
  await command(s, '/speech --set stt-model xai');

  const say = await command(s, '/speech Hello from the live xAI proof.', 500);
  check(errors(say).length === 0, '/speech through xai succeeds', scrub(notes(say)));
  const files = ctx.history();
  const wav = files.find((f) => f.endsWith('.wav'));
  check(wav && files.length === 1, 'xai speech is saved once, as a WAV', files);
  if (wav) check(ffprobeDuration(path.join(ctx.speechDir, wav)) > 0, 'the xai WAV is playable (ffprobe duration > 0)');
  check(ctx.playerLog().length === 1 && /^(s16le|wav|mp3)\b/.test(ctx.playerLog()[0]), 'the message is played as a Stream', ctx.playerLog());

  for (const lang of ['ja', 'fr']) {
    await command(s, `/speech --language eve ${lang}`);
    const n = await command(s, '/speech --sample eve', 1500);
    check(errors(n).length === 0, `a ${lang} sample through xai succeeds`, scrub(notes(n)));
  }
  check(ctx.history().length === files.length, 'samples stay out of the history');

  const t = await callTool(ctx, s, 'speech_transcribe', { path: fixture });
  const text = t.content.toLowerCase();
  check(['quick', 'brown', 'fox'].every((w) => text.includes(w)), 'xai transcription of quick-brown-fox.wav returns the spoken words', scrub(t.content).slice(0, 300));
  check(!JSON.stringify(s.events).includes(token), 'the xAI token never appears in the session events');
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
