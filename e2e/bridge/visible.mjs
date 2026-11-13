// Visible acceptance: the Pi side of the playback bridge, through real pi (RPC) and a real receiver.
import fs from 'node:fs';
import path from 'node:path';
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
finish();
