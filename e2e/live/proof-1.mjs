// Live part of proof-1 (standalone speech): real OpenRouter through the extension in an isolated Pi.
import path from 'node:path';
import { check, ffprobeDuration, finish, needKey, TRANSCRIBE_MODEL } from './lib.mjs';
import { callTool, command, errors, liveSession, notes } from './session.mjs';

const key = needKey();
const fixture = path.join(import.meta.dirname, '..', 'fixtures', 'quick-brown-fox.wav');
const ctx = await liveSession({ key });
try {
  const s = await ctx.pi();

  const models = await command(s, '/speech --models', 3000);
  // /speech --models is one report: the speech list, a blank line, then the transcription list.
  const [tts = '', stt = ''] = notes(models).split(/\n\s*\n/);
  const lines = (t) => t.split('\n').filter(Boolean);
  const priced = (t) => lines(t).filter((l) => /\$[\d.]+\/min|\$0\b/.test(l));
  check(errors(models).length === 0, 'listing models succeeds', notes(models));
  check(lines(tts).length > 5 && priced(tts).length > 5, 'speech models load from the live catalog with price tags', [lines(tts).length, priced(tts).length]);
  check(lines(stt).length > 3 && priced(stt).length > 3, 'transcription models load from the live catalog with price tags', [lines(stt).length, priced(stt).length]);
  check(lines(tts).some((l) => l.startsWith('hexgrad/kokoro-82m ')), 'the speech list includes hexgrad/kokoro-82m', lines(tts).slice(0, 5));
  check(lines(stt).some((l) => l.startsWith(`${TRANSCRIBE_MODEL} `)), `the transcription list includes ${TRANSCRIBE_MODEL}`, lines(stt).slice(0, 5));
  check(!/not loaded/.test(notes(await command(s, '/speech --status'))), 'the status does not fall back to the built-in lists');

  const set1 = await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
  const set2 = await command(s, '/speech --set voice af_heart');
  const set3 = await command(s, `/speech --set stt-model ${TRANSCRIBE_MODEL}`);
  check(errors([...set1, ...set2, ...set3]).length === 0, '/speech --set accepts a cheap model and voice', notes([...set1, ...set2, ...set3]));
  const status = notes(await command(s, '/speech --status'));
  check(/Speech model: hexgrad\/kokoro-82m/.test(status) && /Voice: af_heart/.test(status), 'the settings are shown by /speech --status', status);

  const say = await command(s, '/speech Hello from the live proof.', 500);
  check(errors(say).length === 0, '/speech succeeds', notes(say));
  const files = ctx.history();
  const wav = files.find((f) => f.endsWith('.wav'));
  const mp3 = files.find((f) => f.endsWith('.mp3'));
  check(wav && mp3, '/speech saves a WAV and an MP3', files);
  if (wav) check(ffprobeDuration(path.join(ctx.speechDir, wav)) > 0, 'the WAV is playable (ffprobe duration > 0)', ffprobeDuration(path.join(ctx.speechDir, wav)));
  if (mp3) check(ffprobeDuration(path.join(ctx.speechDir, mp3)) > 0, 'the MP3 is playable (ffprobe duration > 0)');
  check(ctx.playerLog().length === 1 && ctx.playerLog()[0].endsWith('.wav'), 'the message is handed to the player as the WAV', ctx.playerLog());

  const t = await callTool(ctx, s, 'speech_transcribe', { path: fixture });
  const text = t.content.toLowerCase();
  check(['quick', 'brown', 'fox'].every((w) => text.includes(w)), 'speech_transcribe of quick-brown-fox.wav returns the spoken words', t.content.slice(0, 300));
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
