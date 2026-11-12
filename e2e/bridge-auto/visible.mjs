// Visible acceptance: the bridge is selected automatically when Pi runs over SSH.
import fs from 'node:fs';
import path from 'node:path';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';
import { editorEvents, until } from '../lib/dict.mjs';
import { startReceiver } from '../lib/receiver.mjs';

const SSH = { SSH_CONNECTION: '10.0.0.1 50000 10.0.0.2 22' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startNotes = async (s, ms = 4000) => { await sleep(ms); return s.uiRequests.filter((u) => u.method === 'notify'); };
const rcv = await startReceiver();
const ctx = await setup({ env: { PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: rcv.token } });
try {
  // over SSH with nothing saved: the bridge, announced
  let s = await ctx.pi({ env: SSH });
  await s.prompt('/speech --status', 60000).catch(() => {});
  const ann = await startNotes(s, 1500);
  check(ann.some((n) => /bridge/i.test(n.message ?? '') && /ssh/i.test(n.message ?? '') && n.notifyType !== 'error'), 'over SSH the automatic bridge is announced', ann.map((n) => n.message));
  let st = notes(await command(s, '/speech --status'));
  check(/Audio: bridge \(.*auto/.test(st), 'status shows the bridge chosen automatically', st);
  await command(s, '/speech automatic bridge message', 1200);
  check(rcv.starts('player').length === 1 && ctx.playerLog().length === 0, 'over SSH a message plays on the receiver without any toggle', [rcv.starts('player').length, ctx.playerLog()]);
  await s.close();

  // not over SSH: local, auto
  s = await ctx.pi();
  st = notes(await command(s, '/speech --status'));
  check(/Audio: local \(auto\)/.test(st), 'without SSH auto selects local', st);
  await command(s, '/speech local message', 800);
  check(ctx.playerLog().length === 1, 'without SSH the Pi host plays', ctx.playerLog());
  await s.close();

  // explicit off overrides auto across restarts; auto returns
  s = await ctx.pi({ env: SSH });
  await command(s, '/speech --bridge off');
  await s.close();
  s = await ctx.pi({ env: SSH });
  st = notes(await command(s, '/speech --status'));
  check(/Audio: local/.test(st) && !/auto/.test(st.split('\n').find((l) => l.startsWith('Audio:')) ?? ''), 'an explicit off holds over SSH after a restart', st);
  let n = await command(s, '/speech --bridge auto');
  st = notes(await command(s, '/speech --status'));
  check(errors(n).length === 0 && /Audio: bridge \(.*auto/.test(st), 'bridge auto returns to the automatic choice', [notes(n), st]);
  await s.close();

  // over SSH with the receiver down: a warning, and still never local
  const down = await setup({ env: { PI_SPEECH_BRIDGE_URL: 'http://127.0.0.1:9', PI_SPEECH_BRIDGE_TOKEN: rcv.token } });
  try {
    const d = await down.pi({ env: SSH });
    await d.prompt('/speech --status', 60000).catch(() => {});
    const w = await startNotes(d, 1500);
    check(w.some((x) => x.notifyType === 'warning' && /reach|connect|refused/i.test(x.message ?? '')), 'over SSH an unreachable receiver is a warning at startup', w.map((x) => x.message));
    const say = notes(await command(d, '/speech nobody hears this', 800));
    check(/not played/i.test(say) && down.playerLog().length === 0, 'over SSH with the receiver down nothing plays on the Pi host', [say, down.playerLog()]);
    await d.close();
  } finally {
    await down.close();
    down.cleanup();
  }

  // dictation over the automatic bridge records on the receiver, never locally
  const localRec = path.join(ctx.work, 'local-recorder');
  fs.writeFileSync(localRec, `#!/usr/bin/env bash\necho started >> "${ctx.work}/local-recorder.log"\nsleep 30\n`, { mode: 0o755 });
  ctx.or.setTranscript('words from the receiver mic');
  s = await ctx.pi({ env: { ...SSH, PI_SPEECH_RECORDER: localRec } });
  const from = s.uiRequests.length;
  await command(s, '/speech --dictate', 700);
  await command(s, '/speech --dictate', 300);
  await until(() => editorEvents(s, from).length > 0, 8000);
  check(editorEvents(s, from).some((e) => (e.text ?? '').includes('words from the receiver mic')), 'over SSH dictation records through the bridge and inserts the transcript', s.uiRequests.slice(from).map((u) => u.message ?? u.text));
  check(rcv.starts('recorder').length >= 1 && !fs.existsSync(path.join(ctx.work, 'local-recorder.log')), 'the local recorder is never started over SSH', rcv.starts('recorder'));
  await s.close();
} finally {
  await ctx.close();
  await rcv.stop();
  ctx.cleanup();
  rcv.cleanup();
}
finish();
