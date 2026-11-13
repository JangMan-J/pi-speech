// Held-out acceptance: assistant read-aloud, stop, replay.
import fs from 'node:fs';
import path from 'node:path';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = await setup();
try {
  const slow = path.join(ctx.work, 'slow-player');
  const slowLog = path.join(ctx.work, 'slow.log');
  fs.writeFileSync(slow, `#!/usr/bin/env bash\necho "start $$ $1" >> "${slowLog}"\ntrap 'echo "term $$" >> "${slowLog}"; exit 143' TERM INT\nsleep 6 & wait $!\necho "end $$" >> "${slowLog}"\n`, { mode: 0o755 });
  let s = await ctx.pi({ env: { PI_SPEECH_STREAM_PLAYER: slow } });

  let n = await command(s, '/speech --replay');
  check(errors(n).length > 0, 'replay with nothing to replay is an error', notes(n));

  await command(s, '/speech --read-aloud on');
  ctx.llm.script([{ text: 'First reply, long enough.' }]);
  await s.prompt('one', 60000);
  await sleep(1200);
  ctx.llm.script([{ text: 'Second reply interrupts.' }]);
  await s.prompt('two', 60000);
  await sleep(1500);
  const log = fs.existsSync(slowLog) ? fs.readFileSync(slowLog, 'utf8') : '';
  const starts = log.match(/^start (\d+)/gm) ?? [];
  const firstPid = /^start (\d+)/m.exec(log)?.[1];
  check(starts.length === 2 && new RegExp(`^term ${firstPid}$`, 'm').test(log), 'a new reply stops the previous read-aloud playback', log);

  ctx.or.failNext(1, 500, { error: { message: 'speech backend down', code: 500 } });
  const from = s.uiRequests.length;
  ctx.llm.script([{ text: 'This one fails.' }]);
  await s.prompt('three', 60000);
  await sleep(1200);
  const errs = s.uiRequests.slice(from).filter((u) => u.method === 'notify' && u.notifyType === 'error');
  check(errs.some((e) => /speech backend down|500/.test(e.message)), 'a read-aloud synthesis failure is notified as an error', errs.map((e) => e.message));
  ctx.llm.script([{ text: 'Recovered fine.' }]);
  await s.prompt('four', 60000);
  await sleep(1200);
  check(ctx.speechRequests().some((r) => r.body?.input === 'Recovered fine.'), 'read-aloud keeps working after a failure');

  ctx.llm.script([{ toolCalls: [{ name: 'speech_transcribe', arguments: { path: '/nonexistent/y.wav' } }] }, { text: '' }]);
  const before = ctx.speechRequests().length;
  await s.prompt('empty final', 60000);
  await sleep(1000);
  check(ctx.speechRequests().length === before, 'a reply without text is not spoken');
  await command(s, '/speech --stop', 300);
  await s.close();

  // replay after a restart uses the newest history file
  const okPlayer = ctx.player;
  s = await ctx.pi();
  const newest = ctx.history().filter((f) => /\.(wav|mp3)$/.test(f)).sort().at(-1);
  const plays = ctx.playerLog().length;
  n = await command(s, '/speech --replay', 800);
  const played = ctx.playerLog().slice(plays);
  check(played.length === 1 && ctx.played(-1)?.equals(ctx.savedAudio(newest)), 'after a restart replay plays the newest history message', [played, newest]);

  // player failure during read-aloud is notified
  const bad = path.join(ctx.work, 'bad-player');
  fs.writeFileSync(bad, '#!/usr/bin/env bash\necho "cannot open device" >&2\nexit 4\n', { mode: 0o755 });
  await s.close();
  s = await ctx.pi({ env: { PI_SPEECH_STREAM_PLAYER: bad } });
  await command(s, '/speech --read-aloud on');
  const f2 = s.uiRequests.length;
  ctx.llm.script([{ text: 'Player will fail.' }]);
  await s.prompt('five', 60000);
  await sleep(2000);
  const e2 = s.uiRequests.slice(f2).filter((u) => u.method === 'notify' && u.notifyType === 'error');
  check(e2.length > 0, 'a failed read-aloud playback is notified as an error', s.uiRequests.slice(f2).map((u) => u.message));
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
