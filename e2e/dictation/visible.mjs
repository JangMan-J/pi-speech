// Visible acceptance: Alt+Z microphone dictation.
import { check, command, errors, finish, notes, ROOT, setup } from '../lib/lib.mjs';
import { editorEvents, recorderEnv, sha, statusEvents, tui, until } from '../lib/dict.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = await setup();
const rec = recorderEnv(ctx);
try {
  ctx.or.setTranscript('dictated text here');
  let s = await ctx.pi({ env: rec.env });
  const llmBefore = ctx.llm.requests.length;
  let from = s.uiRequests.length;
  await command(s, '/speech --dictate ja', 600);
  check(rec.starts().length === 1, 'dictate starts the recorder', rec.starts());
  check(statusEvents(s, from).some((e) => /REC/.test(e.statusText ?? '')), 'a REC indicator is shown while recording', statusEvents(s, from));
  await sleep(300);
  await command(s, '/speech --dictate', 300);
  await until(() => editorEvents(s, from).length > 0, 8000);
  const ed = editorEvents(s, from);
  check(ed.length === 1 && (ed[0].text ?? '').includes('dictated text here'), 'the transcript is inserted into the editor', ed);
  const treq = ctx.or.requests.filter((r) => r.path.startsWith('/api/v1/audio/transcriptions')).at(-1);
  const audio = treq?.body?.input_audio;
  check(audio?.format === 'wav' && audio?.data?.sha256 === sha(rec.lastRecording()), 'the recording is transcribed as WAV', audio);
  check(treq?.body?.model === 'openai/whisper-large-v3-turbo', 'the saved transcription model is used', treq?.body?.model);
  check(treq?.body?.language === 'ja', 'the one-off dictation language reaches transcription', treq?.body?.language);
  const last = statusEvents(s, from).at(-1);
  check(last && !/REC|transcrib/i.test(last.statusText ?? ''), 'the indicator is cleared afterwards', last);
  check(ctx.llm.requests.length === llmBefore, 'dictation never submits the prompt');

  rec.mode('fail');
  from = s.uiRequests.length;
  const n = await command(s, '/speech --dictate', 1500);
  check(errors(n).some((e) => /no such audio device/.test(e.message)), "a missing microphone is an error with the recorder's message", notes(n));
  check(editorEvents(s, from).length === 0, 'a failure inserts nothing');
  const st = statusEvents(s, from).at(-1);
  check(!st || !/REC|transcrib/i.test(st.statusText ?? ''), 'a failure leaves no indicator', st);
  rec.mode('ok');
  await s.close();

  const starts = rec.starts().length;
  s = await ctx.pi({ env: { ...rec.env, SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22' } });
  const r = await command(s, '/speech --dictate', 800);
  check(errors(r).some((e) => /bridge/i.test(e.message)) && rec.starts().length === starts, 'over SSH the local route refuses to record and points to the bridge', notes(r));
  await s.close();
  s = await ctx.pi({ env: { ...rec.env, SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22', PI_SPEECH_LOCAL_MIC: '1' } });
  await command(s, '/speech --dictate', 600);
  check(rec.starts().length === starts + 1, 'PI_SPEECH_LOCAL_MIC=1 allows the local microphone over SSH');
  await command(s, '/speech --dictate', 1500);
  await s.close();

  // Direct editor commands through real Pi RPC: no agent turn, literal type, and file transcription.
  s = await ctx.pi({ env: rec.env });
  const llmDirect = ctx.llm.requests.length;
  from = s.uiRequests.length;
  await command(s, '/speech --type literal   text', 300);
  await until(() => editorEvents(s, from).length > 0, 3000);
  check(editorEvents(s, from).some((e) => (e.text ?? '').includes('literal   text')), '--type inserts literal text with its spaces', editorEvents(s, from));
  ctx.or.setTranscript('file transcript');
  from = s.uiRequests.length;
  await command(s, `/speech --transcribe ${ROOT}/e2e/fixtures/quick-brown-fox.wav pt`, 500);
  await until(() => editorEvents(s, from).length > 0, 3000);
  check(editorEvents(s, from).some((e) => (e.text ?? '').includes('file transcript')), '--transcribe inserts the file transcript', editorEvents(s, from));
  const fileReq = ctx.or.requests.filter((r) => r.path.startsWith('/api/v1/audio/transcriptions')).at(-1);
  check(fileReq?.body?.language === 'pt', '--transcribe forwards its one-off language', fileReq?.body);
  check(ctx.llm.requests.length === llmDirect, 'the direct editor commands never start an agent turn');
  ctx.or.setTranscript('dictated text here');
  await s.close();

  // the real TUI: Alt+Z twice inserts at the cursor without submitting
  const t = tui(ctx, rec);
  try {
    const llm0 = ctx.llm.requests.length;
    await t.waitText((x) => /fake-model/.test(x), 20000);
    t.type('existing ');
    t.key('alt+z');
    check(await t.waitText((x) => /REC/.test(x), 6000), 'Alt+Z shows the REC indicator in the TUI', t.text().split('\n').slice(-6).join(' | '));
    await sleep(500);
    t.key('alt+z');
    const ok = await t.waitText((x) => /existing dictated text here/.test(x), 12000);
    check(ok, 'the second Alt+Z inserts the transcript after the existing text', t.text().split('\n').slice(-8).join(' | '));
    check(await t.waitText((x) => !/REC/.test(x), 5000), 'the indicator disappears');
    await sleep(500);
    check(ctx.llm.requests.length === llm0, 'the TUI prompt is not submitted');
  } finally {
    t.close();
  }
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
