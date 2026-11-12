// Held-out acceptance: the Pi side of the playback bridge.
import fs from 'node:fs';
import path from 'node:path';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';
import { startReceiver } from '../lib/receiver.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.isFile()) out.push(p);
  }
  return out;
}
const rcv = await startReceiver();
const ctx = await setup({ mp3OnlyModels: ['minimax/speech-2.8-hd'], env: { PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: null } });
try {
  // token from ~/.config/pi-speech/bridge.token
  fs.mkdirSync(path.join(ctx.home, '.config', 'pi-speech'), { recursive: true });
  fs.writeFileSync(path.join(ctx.home, '.config', 'pi-speech', 'bridge.token'), rcv.token + '\n', { mode: 0o600 });
  let s = await ctx.pi({ session: true });
  let n = await command(s, '/speech --bridge on');
  check(errors(n).length === 0, 'the token is read from ~/.config/pi-speech/bridge.token', notes(n));
  const st = notes(await command(s, '/speech --bridge status'));
  check(st.includes(rcv.url) && /\d+\.\d+\.\d+/.test(st), 'bridge status names the URL and the receiver version', st);

  await command(s, '/speech --set tts-model minimax/speech-2.8-hd');
  await command(s, '/speech --set voice English_CalmWoman');
  await command(s, '/speech an mp3 message', 1200);
  const played = rcv.lastPlayed();
  const isMp3 = played && (played.subarray(0, 3).toString() === 'ID3' || (played[0] === 0xff && (played[1] & 0xe0) === 0xe0));
  const mp3 = ctx.history().find((f) => f.endsWith('.mp3'));
  check(isMp3 && mp3 && fs.readFileSync(path.join(ctx.speechDir, mp3)).equals(played), 'an MP3-only message reaches the receiver as its MP3', [isMp3, mp3]);
  await s.close();

  const hay = [JSON.stringify(s.events), s.stderr, rcv.output()];
  for (const f of [...walk(ctx.agentDir), ...walk(ctx.speechDir)]) { hay.push(f); hay.push(fs.readFileSync(f).toString('latin1')); }
  check(!hay.some((h) => h.includes(rcv.token)), 'the bridge token appears in no event, log, session, or file');

  // token file named by PI_SPEECH_BRIDGE_TOKEN_FILE
  const tf = path.join(ctx.work, 'tok');
  fs.writeFileSync(tf, rcv.token, { mode: 0o600 });
  fs.rmSync(path.join(ctx.home, '.config'), { recursive: true, force: true });
  s = await ctx.pi({ env: { PI_SPEECH_BRIDGE_TOKEN_FILE: tf } });
  n = await command(s, '/speech --bridge on');
  check(errors(n).length === 0, 'the token is read from PI_SPEECH_BRIDGE_TOKEN_FILE', notes(n));
  await s.close();

  // non-loopback URL is refused before any connection
  s = await ctx.pi({ env: { PI_SPEECH_BRIDGE_URL: 'http://192.0.2.1:47613', PI_SPEECH_BRIDGE_TOKEN_FILE: tf } });
  await command(s, '/speech --bridge off');
  const t0 = Date.now();
  n = await command(s, '/speech --bridge on');
  check(errors(n).some((e) => /loopback/i.test(e.message)) && Date.now() - t0 < 3000, 'a non-loopback bridge URL is refused', notes(n));
  const urls = fs.existsSync(ctx.fetchLog) ? fs.readFileSync(ctx.fetchLog, 'utf8') : '';
  check(!urls.includes('192.0.2.1'), 'no connection is attempted to a non-loopback URL');
  check(/Audio: local/.test(notes(await command(s, '/speech --status'))), 'the route stays local');
  await s.close();
} finally {
  await ctx.close();
  await rcv.stop();
  ctx.cleanup();
  rcv.cleanup();
}
finish();
