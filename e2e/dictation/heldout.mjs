// Held-out acceptance: Alt+Z microphone dictation.
import fs from 'node:fs';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';
import { editorEvents, recorderEnv, statusEvents, until } from '../lib/dict.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = await setup();
const rec = recorderEnv(ctx);
async function dictateOnce(s, gap = 300) {
  const from = s.uiRequests.length;
  await command(s, '/speech --dictate', gap);
  await command(s, '/speech --dictate', 300);
  await until(() => editorEvents(s, from).length > 0 || s.uiRequests.slice(from).some((u) => u.notifyType === 'error'), 8000);
  await sleep(300);
  return { from, errors: s.uiRequests.slice(from).filter((u) => u.method === 'notify' && u.notifyType === 'error'), edits: editorEvents(s, from) };
}
try {
  ctx.or.setTranscript('held out words');
  let s = await ctx.pi({ env: rec.env });
  await command(s, '/speech --set stt-model openai/whisper-1');
  let r = await dictateOnce(s);
  const treq = ctx.or.requests.filter((q) => q.path.startsWith('/api/v1/audio/transcriptions')).at(-1);
  check(treq?.body?.model === 'openai/whisper-1' && r.edits.some((e) => e.text?.includes('held out words')), 'dictation uses the newly saved transcription model', treq?.body?.model);
  const envFile = `${rec.fake}/recorder.env`;
  const envKeys = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split('\n') : null;
  check(envKeys && !envKeys.includes('OPENROUTER_API_KEY'), 'the recorder gets no OpenRouter key');
  const out = rec.starts().at(-1)?.split(' ')[2];
  check(out && !fs.existsSync(out), 'the temporary recording is deleted', out);
  check(ctx.history().length === 0, 'dictation never writes to the speech history', ctx.history());

  rec.mode('empty');
  r = await dictateOnce(s);
  check(r.errors.length > 0 && r.edits.length === 0, 'an empty recording is an error and inserts nothing', r.errors.map((e) => e.message));
  rec.mode('die');
  r = await dictateOnce(s, 1300);
  check(r.errors.some((e) => /stream error/.test(e.message)) && r.edits.length === 0, "a recorder crash is an error with the recorder's message", r.errors.map((e) => e.message));
  rec.mode('busy');
  const from = s.uiRequests.length;
  const n = await command(s, '/speech --dictate', 1500);
  check(errors(n).some((e) => /busy/.test(e.message)) && editorEvents(s, from).length === 0, 'a busy microphone is an error', notes(n));
  rec.mode('ok');

  ctx.or.failNext(1, 500, { error: { message: 'transcriber exploded', code: 500 } });
  r = await dictateOnce(s);
  check(r.errors.some((e) => /transcriber exploded|500/.test(e.message)) && r.edits.length === 0, 'a transcription failure is an error and inserts nothing', r.errors.map((e) => e.message));
  ctx.or.setTranscript('   ');
  r = await dictateOnce(s);
  check(r.errors.length > 0 && r.edits.length === 0, 'an empty transcript is an error and inserts nothing', r.errors.map((e) => e.message));
  ctx.or.setTranscript('  padded words  ');
  r = await dictateOnce(s);
  check(r.edits.some((e) => (e.text ?? '').includes('padded words') && !(e.text ?? '').includes('padded words  ')), 'the transcript is trimmed', r.edits);
  const st = statusEvents(s, 0).at(-1);
  check(st && !/REC|transcrib/i.test(st.statusText ?? ''), 'the indicator ends cleared');
  const all = JSON.stringify(s.events) + s.stderr;
  check(!all.includes(ctx.key), 'the key never appears in events');
  await s.close();

  // a quick double press: the second press stops once the recording has started
  s = await ctx.pi({ env: rec.env });
  ctx.or.setTranscript('double tap words');
  const fromQuick = s.uiRequests.length;
  await Promise.all([s.prompt('/speech --dictate', 60000), sleep(30).then(() => s.prompt('/speech --dictate', 60000))]);
  await until(() => editorEvents(s, fromQuick).length > 0, 8000);
  check(editorEvents(s, fromQuick).some((e) => (e.text ?? '').includes('double tap words')), 'a second press during the start window stops and transcribes', s.uiRequests.slice(fromQuick).map((u) => u.message ?? u.text ?? u.statusText));

  // a recorder that dies mid-recording is reported without another press
  rec.mode('die');
  const fromDie = s.uiRequests.length;
  await command(s, '/speech --dictate', 100);
  await until(() => s.uiRequests.slice(fromDie).some((u) => u.notifyType === 'error'), 6000);
  const dieErr = s.uiRequests.slice(fromDie).filter((u) => u.method === 'notify' && u.notifyType === 'error');
  check(dieErr.some((e) => /stream error/.test(e.message)), 'a recorder crash is reported at once', dieErr.map((e) => e.message));
  await sleep(300);
  const lastSt = statusEvents(s, fromDie).at(-1);
  check(lastSt && !/REC|transcrib/i.test(lastSt.statusText ?? ''), 'a crash clears the indicator', lastSt);
  rec.mode('ok');
  ctx.or.setTranscript('after the crash');
  const r2 = await dictateOnce(s);
  check(r2.edits.some((e) => (e.text ?? '').includes('after the crash')), 'dictation works again after a crash', r2.errors.map((e) => e.message));
  await s.close();

  const starts = rec.starts().length;
  s = await ctx.pi({ env: { ...rec.env, SSH_TTY: '/dev/pts/9' } });
  const t = await command(s, '/speech --dictate', 800);
  check(errors(t).some((e) => /bridge/i.test(e.message)) && rec.starts().length === starts, 'SSH_TTY alone also refuses the local microphone', notes(t));
  await s.close();
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
