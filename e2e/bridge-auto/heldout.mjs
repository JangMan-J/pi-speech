// Held-out acceptance: automatic bridge selection details and review fixes.
import fs from 'node:fs';
import path from 'node:path';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';
import { startReceiver } from '../lib/receiver.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rcv = await startReceiver();
const ctx = await setup({ env: { PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: rcv.token } });
const audioLine = async (s) => notes(await command(s, '/speech --status')).split('\n').find((l) => l.startsWith('Audio:')) ?? '';
try {
  const dataDir = path.join(ctx.agentDir, 'pi-speech');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'bridge.json'), '{"route":"bridge"}\n');
  let s = await ctx.pi();
  let a = await audioLine(s);
  check(/^Audio: bridge/.test(a) && !/auto/.test(a), 'a saved bridge choice from the previous version counts as on', a);
  await s.close();
  fs.writeFileSync(path.join(dataDir, 'bridge.json'), '{"route":"local"}\n');
  s = await ctx.pi({ env: { SSH_TTY: '/dev/pts/3' } });
  a = await audioLine(s);
  check(/^Audio: local/.test(a) && !/auto/.test(a), 'a saved local choice from the previous version counts as off', a);
  fs.rmSync(path.join(dataDir, 'bridge.json'), { force: true });
  await s.close();
  fs.rmSync(path.join(dataDir, 'settings.json'), { force: true }); // forget the saved choice: step 3 starts from the default

  s = await ctx.pi({ env: { SSH_TTY: '/dev/pts/3' } });
  a = await audioLine(s);
  check(/^Audio: bridge \(.*auto/.test(a), 'SSH_TTY alone also selects the bridge automatically', a);
  const st = notes(await command(s, '/speech --bridge status'));
  check(/auto/i.test(st) && /ssh/i.test(st) && st.includes(rcv.url) && /0\.1\.0|\d+\.\d+\.\d+/.test(st), 'bridge status names the mode, the reason, the URL and the receiver', st);
  const announcements = s.uiRequests.filter((u) => u.method === 'notify' && /ssh/i.test(u.message ?? '') && /bridge/i.test(u.message ?? '') && u.notifyType !== 'error');
  await command(s, '/speech --status');
  const again = s.uiRequests.filter((u) => u.method === 'notify' && /ssh/i.test(u.message ?? '') && /bridge/i.test(u.message ?? '') && u.notifyType !== 'error' && !/^Audio:|Bridge URL/m.test(u.message ?? ''));
  check(announcements.length >= 1 && again.length <= 1, 'the automatic choice is announced once', again.map((x) => x.message));
  check(!JSON.stringify(s.events).includes(rcv.token), 'the token never appears in events');
  await s.close();

  s = await ctx.pi({ env: { SSH_CONNECTION: '' } });
  check(/^Audio: local \(auto\)/.test(await audioLine(s)), 'an empty SSH_CONNECTION is not remote');
  await s.close();

  // a short token is refused readably
  s = await ctx.pi({ env: { PI_SPEECH_BRIDGE_TOKEN: 'short-token' } });
  let n = await command(s, '/speech --bridge on');
  check(errors(n).some((e) => /32|short|token/i.test(e.message)), 'a token shorter than 32 characters is refused', notes(n));
  await s.close();

  // a sample with the receiver gone reports notPlayed instead of failing
  s = await ctx.pi({ env: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' } });
  await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
  rcv.mode('player', 'long');
  await command(s, '/speech --sample af_heart', 800);
  await rcv.stop();
  n = await command(s, '/speech --sample jf_alpha', 1500);
  check(errors(n).length === 0 && /not played/i.test(notes(n)), 'a sample with the receiver gone says it was not played', notes(n));
  check(ctx.playerLog().length === 0, 'and nothing plays on the Pi host');
  await s.close();
} finally {
  await ctx.close();
  await rcv.stop();
  ctx.cleanup();
  rcv.cleanup();
}
finish();
