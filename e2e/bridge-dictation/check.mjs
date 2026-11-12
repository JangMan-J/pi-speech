// Integration: Alt+Z dictation records through the real receiver when the bridge is selected.
// Real pi (RPC) with only this extension, the real receiver with its fake recorder, fake OpenRouter.
import fs from 'node:fs';
import path from 'node:path';
import { editorEvents, recorderEnv, sha, statusEvents, until } from '../lib/dict.mjs';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';
import { startReceiver } from '../lib/receiver.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rcv = await startReceiver();
const ctx = await setup({ env: { PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: rcv.token } });
const local = recorderEnv(ctx); // the Pi host's own recorder: it must never start
const treqs = () => ctx.or.requests.filter((r) => r.path.startsWith('/api/v1/audio/transcriptions'));
const receiverRecording = () => {
  const p = path.join(rcv.fake, 'last-recording.wav');
  return fs.existsSync(p) ? fs.readFileSync(p) : undefined;
};

try {
  ctx.or.setTranscript('dictated through the bridge');
  let s = await ctx.pi({ env: local.env });
  let n = await command(s, '/speech --bridge on');
  check(errors(n).length === 0, 'bridge on succeeds', notes(n));
  check(/Audio: bridge/.test(notes(await command(s, '/speech --status'))), 'status shows the bridge route');

  const llmBefore = ctx.llm.requests.length;
  let from = s.uiRequests.length;
  n = await command(s, '/speech --dictate', 800);
  check(errors(n).length === 0, 'the first dictate starts without an error', notes(n));
  check(rcv.starts('recorder').length === 1, 'the receiver starts its recorder', rcv.log('recorder'));
  check(local.starts().length === 0, 'the local recorder is not started', local.starts());
  check(statusEvents(s, from).some((e) => /REC/.test(e.statusText ?? '')), 'a REC indicator is shown while recording', statusEvents(s, from));
  await sleep(300);
  n = await command(s, '/speech --dictate', 300);
  await until(() => editorEvents(s, from).length > 0, 10000);
  const ed = editorEvents(s, from);
  check(ed.length === 1 && (ed[0].text ?? '').includes('dictated through the bridge'), 'the transcript is inserted into the editor', ed);
  check(errors(n).length === 0, 'the second dictate has no error', notes(n));
  const audio = treqs().at(-1)?.body?.input_audio;
  const recorded = receiverRecording();
  check(audio?.format === 'wav' && recorded && audio?.data?.sha256 === sha(recorded), "the receiver's recording is what is transcribed", audio);
  check(rcv.log('recorder').some((l) => l === 'finished'), 'the receiver recorder finished its file', rcv.log('recorder'));
  const last = statusEvents(s, from).at(-1);
  check(last && !/REC|transcrib/i.test(last.statusText ?? ''), 'the indicator is cleared afterwards', last);
  check(ctx.llm.requests.length === llmBefore, 'dictation never submits the prompt');
  check(local.starts().length === 0, 'the local recorder is still not started', local.starts());
  await s.close();

  // A new session over SSH, as in real use: the saved bridge route records on the receiver.
  s = await ctx.pi({ env: { ...local.env, SSH_CONNECTION: '10.0.0.1 5000 10.0.0.2 22', SSH_TTY: '/dev/pts/9' } });
  check(/Audio: bridge/.test(notes(await command(s, '/speech --status'))), 'the bridge selection persists across a restart');
  from = s.uiRequests.length;
  n = await command(s, '/speech --dictate', 800);
  check(errors(n).length === 0 && rcv.starts('recorder').length === 2, 'over SSH with the bridge, dictation records on the receiver', [notes(n), rcv.starts('recorder').length]);
  await sleep(300);
  await command(s, '/speech --dictate', 300);
  await until(() => editorEvents(s, from).length > 0, 10000);
  check(editorEvents(s, from).length === 1, 'over SSH the transcript is inserted too', editorEvents(s, from));
  check(local.starts().length === 0, 'the local recorder never starts, even over SSH', local.starts());
  check(ctx.playerLog().length === 0, 'nothing plays on the Pi host');
  await s.close();
} finally {
  await ctx.close();
  await rcv.stop();
  ctx.cleanup();
  rcv.cleanup();
}
finish();
