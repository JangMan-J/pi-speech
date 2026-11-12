// The /speech surface, single status, single settings file, one playback at a time, readable read-aloud, defaults.
import fs from 'node:fs';
import path from 'node:path';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = await setup();
const lastInput = () => ctx.speechRequests().at(-1)?.body?.input;
const statusOf = (s, from = 0) => s.uiRequests.slice(from).filter((u) => u.method === 'setStatus' && u.statusKey === 'pi-speech');
try {
  let s = await ctx.pi();
  const st = notes(await command(s, '/speech --status'));
  check(/Speech model: google\/gemini-3\.8-flash-tts/.test(st) && /Voice: Kore/.test(st) && /Transcription model: openai\/whisper-large-v3-turbo/.test(st), 'the defaults are Gemini 3.8 Flash TTS with Kore and Whisper large-v3-turbo', st);

  const llm0 = ctx.llm.requests.length;
  let n = await command(s, '/speech hello there friend', 800);
  check(lastInput() === 'hello there friend' && errors(n).length === 0, '/speech <text> speaks the text', [lastInput(), notes(n)]);
  check(ctx.llm.requests.length === llm0, '/speech <text> never starts a turn');
  check(ctx.history().filter((f) => f.endsWith('.wav')).length === 1, '/speech <text> saves the message in the history', ctx.history());
  await command(s, '/speech stop the presses', 800);
  check(lastInput() === 'stop the presses', 'words that look like actions are spoken', lastInput());
  await command(s, '/speech -- --dashes here', 800);
  check(lastInput() === '--dashes here', '/speech -- speaks text that starts with dashes', lastInput());
  n = await command(s, '/speech --frobnicate');
  check(errors(n).length > 0 && /--stop/.test(notes(n)), 'an unknown action is an error that shows the usage', notes(n));
  n = await command(s, '/speech --help');
  check(['--stop', '--replay', '--dictate', '--type', '--transcribe', '--bridge', '--set', '--sample', '--read-aloud', '--status'].every((a) => notes(n).includes(a)), '--help lists the actions', notes(n));

  // the menu, driven through RPC dialogs
  const WORDS = ['Speak', 'Stop', 'Replay', 'Dictate', 'Sample', 'Read-aloud', 'Audio', 'Speech model', 'Voice', 'Transcription model', 'Tools', 'Status'];
  s.onUi = (req) => (req.method === 'select' ? { value: req.options.find((o) => /^Status/.test(o)) } : { cancelled: true });
  let from = s.uiRequests.length;
  await command(s, '/speech', 1500);
  const sel = s.uiRequests.slice(from).find((u) => u.method === 'select');
  check(sel && WORDS.every((w) => sel.options.some((o) => o.startsWith(w))), '/speech opens a menu of actions and settings', sel?.options);
  check(/Speech model:/.test(notes(s.uiRequests.slice(from).filter((u) => u.method === 'notify'))), 'Status from the menu reports the status');
  s.onUi = (req) =>
    req.method === 'select' ? { value: req.options.find((o) => /^Speak/.test(o)) } : req.method === 'input' || req.method === 'editor' ? { value: 'words from the menu' } : { cancelled: true };
  await command(s, '/speech', 1500);
  check(lastInput() === 'words from the menu', 'Speak text… from the menu speaks the entered text', lastInput());
  s.onUi = () => ({ cancelled: true });
  const before = ctx.speechRequests().length;
  from = s.uiRequests.length;
  await command(s, '/speech', 800);
  check(ctx.speechRequests().length === before && errors(s.uiRequests.slice(from).filter((u) => u.method === 'notify')).length === 0, 'leaving the menu does nothing');

  // one settings file
  n = await command(s, '/speech --set voice Puck');
  const dir = path.join(ctx.agentDir, 'pi-speech');
  const file = path.join(dir, 'settings.json');
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  check(typeof saved.version === 'number' && JSON.stringify(saved).includes('Puck'), 'one versioned settings file holds the choices', saved);
  const jsons = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  check(jsons.length === 1, 'there is no other settings file', jsons);
  await s.close();

  // one playback at a time, with the single status
  const slow = path.join(ctx.work, 'slow-player');
  const log = path.join(ctx.work, 'slow.log');
  fs.writeFileSync(slow, `#!/usr/bin/env bash\necho "start $$" >> "${log}"\ntrap 'echo "term $$" >> "${log}"; exit 143' TERM INT\nsleep 6 & wait $!\n`, { mode: 0o755 });
  s = await ctx.pi({ env: { PI_SPEECH_PLAYER: slow } });
  from = s.uiRequests.length;
  await command(s, '/speech the first message plays for a while', 700);
  check(statusOf(s, from).some((e) => /speaking|▶/.test(e.statusText ?? '')), 'the status shows that speech is playing', statusOf(s, from));
  await command(s, '/speech the second message replaces it', 900);
  let text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const pids = [...text.matchAll(/^start (\d+)/gm)].map((m) => m[1]);
  check(pids.length === 2 && new RegExp(`^term ${pids[0]}$`, 'm').test(text), 'a new message replaces the one playing', text);
  await command(s, '/speech --stop', 900);
  text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  check(new RegExp(`^term ${pids[1]}$`, 'm').test(text), '--stop stops the playback', text);
  const lastStatus = statusOf(s, from).at(-1);
  check(lastStatus && !/speaking|▶/.test(lastStatus.statusText ?? ''), 'the status no longer shows speaking after stop', lastStatus);
  await s.close();

  // read-aloud speaks readable text
  s = await ctx.pi();
  await command(s, '/speech --read-aloud on');
  const md = '# Release notes\n\nSome **bold** text with a [useful link](https://example.com/page).\n\n```js\nconst x = 1;\n```\n\nThat is all.';
  ctx.llm.script([{ text: md }]);
  await s.prompt('notes please', 60000);
  await sleep(1500);
  const spoken = lastInput() ?? '';
  check(/Release notes/.test(spoken) && /Some bold text with a useful link/.test(spoken) && /That is all/.test(spoken), 'read-aloud keeps the words', spoken);
  check(!/```|const x|https?:|\*\*|#/.test(spoken), 'read-aloud drops markdown, code blocks, and URLs', spoken);
  const long = Array.from({ length: 70 }, (_, i) => `This is sentence number ${i + 1} of a very long reply.`).join(' ');
  from = s.uiRequests.length;
  const reqBefore = ctx.speechRequests().length;
  ctx.llm.script([{ text: long }]);
  await s.prompt('long please', 60000);
  await sleep(3000);
  // a long reply is spoken as several requests; together they hold the cut text
  const cut = ctx.speechRequests().slice(reqBefore).map((r) => r.body?.input).join(' ');
  check(cut.length > 500 && cut.length <= 2000 && cut.endsWith('.') && long.startsWith(cut), 'a long reply is cut at a sentence boundary within 2000 characters', cut.length);
  check(s.uiRequests.slice(from).some((u) => u.method === 'notify' && /cut|shorten|truncat|first/i.test(u.message ?? '')), 'the cut is announced');
  await s.close();
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
