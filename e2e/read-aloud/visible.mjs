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
  await s.close();

  // Summary with the same model: the guideline asks for a marked summary; it is read, and neither shown nor kept
  s = await ctx.pi({ session: true });
  const spokenFrom = ctx.speechRequests().length;
  n = await command(s, '/speech --read-aloud summary');
  check(errors(n).length === 0 && /Read-aloud: summary/.test(notes(n)), 'read-aloud can be set to Summary', notes(n));
  const asked = ctx.llm.requests.length;
  ctx.llm.script([{ text: 'Here is the long answer with every detail.\n\n<spoken_summary>In short, it works.</spoken_summary>' }]);
  await s.prompt('summarize please', 60000);
  await sleep(1500);
  const sys = JSON.stringify(ctx.llm.requests[asked]?.messages ?? []);
  check(/pi-speech read-aloud: end every final reply/.test(sys) && /lorem ipsum/.test(sys), 'the request carries the read-aloud guideline with its lorem-ipsum length', sys.slice(0, 300));
  const said = ctx.speechRequests().slice(spokenFrom).map((r) => r.body?.input);
  check(JSON.stringify(said) === JSON.stringify(['In short, it works.']), 'only the marked summary is spoken', said);
  const sessionFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => f.endsWith('.jsonl')) : []);
  // The stored assistant messages (the stored system prompt names the markers in its guideline).
  const stored = sessionFiles(path.join(ctx.agentDir, 'sessions')).flatMap((f) => fs.readFileSync(f, 'utf8').split('\n'))
    .filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((e) => e.message?.role === 'assistant').map((e) => JSON.stringify(e.message.content)).join('\n');
  check(/every detail/.test(stored) && !/spoken_summary|In short, it works/.test(stored), 'the stored reply keeps the answer without the marked summary', stored.slice(-400));
  ctx.llm.script([{ text: 'Next.\n<spoken_summary>Next one.</spoken_summary>' }]);
  const asked2 = ctx.llm.requests.length;
  await s.prompt('and again', 60000);
  await sleep(1200);
  const history = JSON.stringify(ctx.llm.requests[asked2]?.messages ?? []);
  check(/every detail/.test(history) && !/In short, it works/.test(history), 'the next request sends the earlier reply without its summary', history.slice(-400));
  await s.close();

  // Summarized by another Pi model: one extra request to it with the reply; its answer is read
  const sf = path.join(ctx.agentDir, 'pi-speech', 'settings.json');
  fs.mkdirSync(path.dirname(sf), { recursive: true });
  const saved = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : { version: 1 };
  fs.writeFileSync(sf, JSON.stringify({ ...saved, version: 1, readAloud: { summarizer: 'fake/fake-model', length: 'minimum', truncate: 0 } }));
  s = await ctx.pi();
  await command(s, '/speech --read-aloud summary');
  const from2 = ctx.speechRequests().length;
  const asked3 = ctx.llm.requests.length;
  ctx.llm.script([{ text: 'A detailed reply about the build.' }, { text: 'The build is green.' }]);
  await s.prompt('status?', 60000);
  await sleep(2000);
  const extra = ctx.llm.requests.slice(asked3);
  const extraBody = JSON.stringify(extra[1]?.messages ?? []);
  check(extra.length === 2 && /A detailed reply about the build/.test(extraBody) && !/pi-speech read-aloud: end every/.test(JSON.stringify(extra[0]?.messages ?? [])), 'one extra request goes to the chosen model with the reply; the reply itself had no guideline', extra.map((r) => JSON.stringify(r.messages).slice(0, 200)));
  const said2 = ctx.speechRequests().slice(from2).map((r) => r.body?.input);
  check(JSON.stringify(said2) === JSON.stringify(['The build is green.']), "the other model's summary is spoken", said2);

  // Truncate at: reading stops at the last sentence end before the limit (15 s is 37 words)
  fs.writeFileSync(sf, JSON.stringify({ ...saved, version: 1, readAloud: { length: 'abridged', truncate: 15 } }));
  await s.close();
  s = await ctx.pi();
  await command(s, '/speech --read-aloud all');
  const from3 = ctx.speechRequests().length;
  const sentences = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} has exactly seven words.`);
  ctx.llm.script([{ text: sentences.join(' ') }]);
  await s.prompt('long', 60000);
  await sleep(1500);
  const said3 = ctx.speechRequests().slice(from3).map((r) => r.body?.input).join(' ');
  check(said3 === sentences.slice(0, 5).join(' '), 'Truncate at 15 s stops at the last sentence end before 15 s', said3);
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
