// Visible acceptance: the Pi side of the playback bridge, through real pi (RPC) and a real receiver.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editorEvents, recorderEnv, until } from '../lib/dict.mjs';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';
import { startReceiver } from '../lib/receiver.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rcv = await startReceiver();
const ctx = await setup({ env: { PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: rcv.token } });
try {
  let s = await ctx.pi();
  check(/Audio: local/.test(notes(await command(s, '/speech --status'))), 'the local route is selected at first');
  let n = await command(s, '/speech --bridge on');
  check(errors(n).length === 0, 'bridge on succeeds when the receiver answers', notes(n));
  check(/Audio: bridge/.test(notes(await command(s, '/speech --status'))), 'status shows the bridge route');

  n = await command(s, '/speech hello over the bridge', 1200);
  const starts = rcv.starts('player');
  const played = rcv.lastPlayed();
  const saved = ctx.history().map((f) => ctx.savedAudio(f));
  check(starts.length === 1 && played && saved.some((b) => b.equals(played)), 'the message plays on the receiver as a Stream, with the saved audio', [starts.length, ctx.history(), rcv.lastArgs()]);
  check(ctx.playerLog().length === 0, 'nothing plays on the Pi host');
  check(!/not played/i.test(notes(n)), 'the result does not claim a failure', notes(n));
  await s.close();

  s = await ctx.pi();
  check(/Audio: bridge/.test(notes(await command(s, '/speech --status'))), 'the bridge selection persists across a restart');
  rcv.mode('player', 'fail');
  const from = s.uiRequests.length;
  await command(s, '/speech this playback fails', 300);
  await sleep(2500);
  const errs = s.uiRequests.slice(from).filter((u) => u.method === 'notify' && u.notifyType === 'error');
  check(errs.length > 0, 'a failed playback on the receiver is notified as an error', s.uiRequests.slice(from).map((u) => u.message));
  rcv.mode('player', 'ok');

  await rcv.stop();
  const before = ctx.history().length;
  n = await command(s, '/speech receiver is down', 800);
  check(/not played/i.test(notes(n)) && /reach|receiver|connect/i.test(notes(n)), 'with the receiver down the result says it was not played and why', notes(n));
  check(ctx.playerLog().length === 0, 'with the receiver down nothing plays on the Pi host');
  check(ctx.history().length > before, 'the message is still saved in the history');

  n = await command(s, '/speech --bridge off');
  check(/Audio: local/.test(notes(await command(s, '/speech --status'))), 'bridge off selects the local route');
  await command(s, '/speech back to local', 800);
  check(ctx.playerLog().length === 1, 'with the local route the Pi host plays again', ctx.playerLog());
  await s.close();

  const rcv2 = await startReceiver();
  try {
    s = await ctx.pi({ env: { PI_SPEECH_BRIDGE_URL: rcv2.url, PI_SPEECH_BRIDGE_TOKEN: 'wrong-token-0000000000000000000000000' } });
    n = await command(s, '/speech --bridge on');
    check(errors(n).some((e) => /unauthori[sz]ed|401|token/i.test(e.message)), 'a wrong token is an error', notes(n));
    check(/Audio: local/.test(notes(await command(s, '/speech --status'))), 'a refused bridge leaves the route unchanged');
    await s.close();
  } finally {
    await rcv2.stop();
    rcv2.cleanup();
  }
} finally {
  await ctx.close();
  await rcv.stop();
  ctx.cleanup();
  rcv.cleanup();
}
// DIRECTION: Play audio on, Record audio on and Run models on, with Local sources, a receiver whose models are a
// stand-in, and a stand-in bundled binary on This machine. Each stand-in logs its runs and answers "<where> words".
const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-models-'));
function standIn(where) {
  const file = path.join(mdir, `models-${where}`);
  const log = path.join(mdir, `${where}.log`);
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const [, , cmd, sub] = process.argv;
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');
const out = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
if (cmd === 'models') {
  out({ id: 'kokoro', kind: 'speech', name: 'Kokoro', languages: ['en'], size: 1, downloaded: true, partial: 0, path: '/m/k' });
  out({ id: 'parakeet', kind: 'transcription', name: 'Parakeet', languages: ['en'], size: 1, downloaded: true, partial: 0, path: '/m/p' });
} else if (cmd === 'transcribe') {
  process.stdout.write('${where} words from ' + sub + '\\n');
} else if (cmd === 'speak') {
  if (process.argv.includes('--list-voices')) { out({ name: 'af_sol', number: 0 }); process.exit(0); }
  process.stdin.resume();
  process.stdin.on('end', () => {
    process.stderr.write(JSON.stringify({ event: 'format', rate: 24000, channels: 1 }) + '\\n');
    process.stdout.write(Buffer.alloc(9600, 3), () => process.stderr.write(JSON.stringify({ event: 'done' }) + '\\n'));
  });
}
`, { mode: 0o755 });
  return { file, runs: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}
const remote = standIn('remote');
const here = standIn('local');
process.env.PI_SPEECH_RECEIVER_MODELS = remote.file;
const rcv3 = await startReceiver();
delete process.env.PI_SPEECH_RECEIVER_MODELS;
const ctx3 = await setup({ env: { PI_SPEECH_BRIDGE_URL: rcv3.url, PI_SPEECH_BRIDGE_TOKEN: rcv3.token, PI_SPEECH_BINARY: here.file } });
const rec = recorderEnv(ctx3);
try {
  for (const [playOn, recordOn, modelsOn] of [['remote', 'remote', 'remote'], ['this', 'this', 'this'], ['remote', 'this', 'remote'], ['this', 'remote', 'this']]) {
    const at = `play ${playOn}, record ${recordOn}, models ${modelsOn}`;
    fs.mkdirSync(path.join(ctx3.agentDir, 'pi-speech'), { recursive: true });
    fs.writeFileSync(path.join(ctx3.agentDir, 'pi-speech', 'settings.json'), JSON.stringify({
      version: 1, bridge: 'on', speechSource: 'local', localSpeechModel: 'kokoro', transcriptionSource: 'local',
      localTranscriptionModel: 'parakeet', playOn, recordOn, modelsOn,
    }));
    const s = await ctx3.pi({ env: rec.env });
    const before = { remotePlays: rcv3.starts('player').length, localPlays: ctx3.playerLog().length, remote: remote.runs().length, here: here.runs().length, mics: rec.starts().length };
    let n = await command(s, '/speech Hello over the bridge.', 1500);
    check(errors(n).length === 0, `${at}: speaking works`, notes(n));
    const runner = modelsOn === 'remote' ? remote : here;
    check(runner.runs().slice(modelsOn === 'remote' ? before.remote : before.here).some((l) => l.startsWith('speak kokoro')), `${at}: the speech model runs on ${modelsOn === 'remote' ? 'the Remote machine' : 'This machine'}`, [remote.runs(), here.runs()]);
    const played = { remote: rcv3.starts('player').length - before.remotePlays, this: ctx3.playerLog().length - before.localPlays };
    check(played[playOn] === 1 && played[playOn === 'remote' ? 'this' : 'remote'] === 0, `${at}: it plays on ${playOn === 'remote' ? 'the Remote machine' : 'This machine'} only`, played);
    const from = s.uiRequests.length;
    await command(s, '/speech --dictate', 800);
    await command(s, '/speech --dictate', 300);
    await until(() => editorEvents(s, from).length > 0, 8000);
    const text = editorEvents(s, from)[0]?.text ?? '';
    check(text.includes(`${modelsOn === 'remote' ? 'remote' : 'local'} words from parakeet`), `${at}: dictation is transcribed where the models run`, text);
    check((rec.starts().length - before.mics === 1) === (recordOn === 'this'), `${at}: it records on ${recordOn === 'remote' ? 'the Remote machine' : 'This machine'}`, rec.starts());
    await s.close();
  }
} finally {
  await ctx3.close();
  await rcv3.stop();
  ctx3.cleanup();
  rcv3.cleanup();
  fs.rmSync(mdir, { recursive: true, force: true });
}
finish();
