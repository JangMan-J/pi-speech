// Visible acceptance: assistant read-aloud, stop, replay.
import fs from 'node:fs';
import path from 'node:path';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = await setup();
try {
  let s = await ctx.pi();
  const inputs = () => ctx.speechRequests().map((r) => r.body?.input);

  ctx.llm.script([{ text: 'Hello there friend.' }]);
  await s.prompt('hi', 60000);
  await sleep(800);
  check(ctx.speechRequests().length === 0, 'read-aloud starts off');
  check(/Read-aloud: off/.test(notes(await command(s, '/speech --status'))), 'status shows read-aloud off');

  let n = await command(s, '/speech --read-aloud on');
  check(errors(n).length === 0 && /Read-aloud: on/.test(notes(await command(s, '/speech --status'))), 'read-aloud can be turned on');
  ctx.llm.script([{ text: 'The answer is forty two.' }]);
  await s.prompt('question', 60000);
  await sleep(1500);
  check(JSON.stringify(inputs()) === JSON.stringify(['The answer is forty two.']), 'a completed reply is spoken', inputs());
  check(ctx.history().filter((f) => f.endsWith('.wav')).length === 1, 'the spoken reply is saved in the history', ctx.history());
  check(ctx.playerLog().length === 1, 'the spoken reply is played', ctx.playerLog());

  ctx.llm.script([{ text: 'Checking now.', toolCalls: [{ name: 'speech_transcribe', arguments: { path: '/nonexistent/x.wav' } }] }, { text: 'Final words here.' }]);
  await s.prompt('use a tool', 60000);
  await sleep(1500);
  check(JSON.stringify(inputs().slice(1)) === JSON.stringify(['Final words here.']), 'only the final reply of a run is spoken', inputs());

  const requests = ctx.speechRequests().length;
  const plays = ctx.playerLog().length;
  n = await command(s, '/speech --replay', 800);
  check(errors(n).length === 0 && ctx.playerLog().length === plays + 1, 'replay plays the last message again', notes(n));
  check(ctx.speechRequests().length === requests, 'replay sends nothing to OpenRouter');
  const last = ctx.history().filter((f) => f.endsWith('.wav')).at(-1);
  check(last !== undefined && ctx.played(-1)?.equals(ctx.savedAudio(last)), 'replay feeds the saved file to the player as a Stream', [ctx.playerLog().at(-1), ctx.playerArgs().at(-1)]);

  await command(s, '/speech --read-aloud off');
  ctx.llm.script([{ text: 'Not spoken.' }]);
  await s.prompt('again', 60000);
  await sleep(800);
  check(!inputs().includes('Not spoken.'), 'read-aloud off stops speaking replies');
  await s.close();

  // stop
  const slow = path.join(ctx.work, 'slow-player');
  fs.writeFileSync(slow, `#!/usr/bin/env bash\necho "start $1" >> "${ctx.work}/slow.log"\ntrap 'echo "term" >> "${ctx.work}/slow.log"; exit 143' TERM INT\nsleep 8 & wait $!\n`, { mode: 0o755 });
  s = await ctx.pi({ env: { PI_SPEECH_STREAM_PLAYER: slow } });
  check(/Read-aloud: off/.test(notes(await command(s, '/speech --status'))), 'read-aloud is off again after a restart');
  await command(s, '/speech a long message', 500);
  n = await command(s, '/speech --stop', 800);
  const log = fs.existsSync(path.join(ctx.work, 'slow.log')) ? fs.readFileSync(path.join(ctx.work, 'slow.log'), 'utf8') : '';
  check(/term/.test(log) && errors(n).length === 0, 'stop stops the playback in progress', log);
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
