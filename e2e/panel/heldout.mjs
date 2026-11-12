// Held-out acceptance: the /speech settings panel, edge cases.
import fs from 'node:fs';
import { check, finish, setup } from '../lib/lib.mjs';
import { goTo, openPanelPi, readSettings, row, sleep } from '../lib/panel.mjs';
import { startReceiver } from '../lib/receiver.mjs';

const toRow = goTo;

// 0. idle shows no label
{
  const ctx = await setup();
  let t;
  try {
    t = await openPanelPi(ctx);
    await t.open();
    check(t.lines().some((l) => /^ Speech ─+$/.test(l)) && !t.lines().some((l) => /\bidle\b/i.test(l)), 'the header has no idle label', t.lines().slice(-16));
    await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}

// 1. the bridge is unreachable: the panel still opens and says so with a symbol and a word
{
  const ctx = await setup({ env: { PI_SPEECH_BRIDGE_URL: 'http://127.0.0.1:9', PI_SPEECH_BRIDGE_TOKEN: 'x'.repeat(40) } });
  let t;
  try {
    t = await openPanelPi(ctx, { env: { SSH_TTY: '/dev/pts/3', PI_SPEECH_BRIDGE_URL: 'http://127.0.0.1:9', PI_SPEECH_BRIDGE_TOKEN: 'x'.repeat(40) }, unset: ['SSH_CONNECTION', 'PI_SPEECH_LOCAL_MIC'] });
    await t.open();
    const a = row(t.lines(), 'Play audio on') ?? '';
    check(/✗/.test(a) && /unreachable/i.test(a), 'Play audio on says the receiver is unreachable with ✗ and the word', a);
    await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}

// 2. without an xAI login, xai is not in any list
{
  const ctx = await setup();
  let t;
  try {
    t = await openPanelPi(ctx);
    await t.open();
    await toRow(t, 'Transcription');
    await t.key('Enter');
    check(!t.lines().some((l) => /xAI Grok|^\W*xai\b/.test(l.trim())), 'xAI Grok is not offered without a login', t.lines().slice(-16));
    await t.key('Escape');
    await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}

// 3. typing on a model row opens the picker with that text; l sets a language override
{
  const ctx = await setup({ xai: true });
  let t;
  try {
    t = await openPanelPi(ctx);
    await t.open();
    await toRow(t, 'Speech model');
    t.type('kok'); await sleep(500);
    let lines = t.lines();
    check(lines.some((l) => /hexgrad\/kokoro-82m/.test(l)) && !lines.some((l) => /google\/gemini/.test(l)), 'typing on a model row opens a filtered picker', lines.slice(-14));
    await t.key('Escape');
    check(/google\/gemini-3\.8-flash-tts/.test(row(t.lines(), 'Speech model') ?? ''), 'Esc leaves the model unchanged', row(t.lines(), 'Speech model'));
    await toRow(t, 'Voice');
    t.type('l'); await sleep(500);
    check(t.lines().some((l) => /Find:/.test(l)) && !t.lines().some((l) => /language of/i.test(l)), 'typing l on the Voice row opens the picker with l as the filter', t.lines().slice(-12));
    await t.key('Escape');
    await t.key('F2'); await sleep(400);
    check(t.lines().some((l) => /language/i.test(l) && /tag|ja|auto/i.test(l)), 'F2 asks for a voice language', t.lines().slice(-8));
    t.type('ja'); await sleep(200);
    await t.key('Enter');
    await sleep(400);
    lines = t.lines();
    check(/ja/.test(row(lines, 'Voice') ?? '') && /set by you/i.test(row(lines, 'Voice') ?? ''), 'the Voice note shows the override as set by you', row(lines, 'Voice'));
    check(JSON.stringify(readSettings(ctx).languages).includes('"ja"'), 'the override is saved', readSettings(ctx).languages);
    await t.key('F2'); await sleep(300);
    t.type('auto'); await sleep(200);
    await t.key('Enter');
    check(!/set by you/i.test(row(t.lines(), 'Voice') ?? ''), 'auto removes the override', row(t.lines(), 'Voice'));
    await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}

// 4. Audio cycles through its modes with a reachable receiver; s and r keys
const rcv = await startReceiver();
{
  const ctx = await setup({ env: { PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: rcv.token } });
  let t;
  try {
    t = await openPanelPi(ctx, { env: { PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: rcv.token } });
    await t.open();
    await toRow(t, 'Play audio on');
    check(/auto/.test(row(t.lines(), 'Play audio on') ?? ''), 'Play audio on starts at auto');
    await t.key('Right'); await sleep(500);
    check(/bridge/.test(row(t.lines(), 'Play audio on') ?? '') && readSettings(ctx).bridge === 'on', 'Right moves Audio to bridge and saves it', [row(t.lines(), 'Play audio on'), readSettings(ctx).bridge]);
    await t.key('Right'); await sleep(300);
    check(/local/.test(row(t.lines(), 'Play audio on') ?? '') && readSettings(ctx).bridge === 'off', 'the next Right moves it to local', [row(t.lines(), 'Play audio on'), readSettings(ctx).bridge]);
    await t.key('Right'); await sleep(300);
    check(/auto/.test(row(t.lines(), 'Play audio on') ?? '') && readSettings(ctx).bridge === 'auto', 'then back to auto', [row(t.lines(), 'Play audio on'), readSettings(ctx).bridge]);
    await t.key('Escape');

    // speak something so there is a message to replay, then use the keys
    await t.open();
    await t.key('Enter'); t.type('replay me'); await sleep(200); await t.key('Enter'); await sleep(1500);
    const played = ctx.playerLog().length;
    await t.key('Escape'); // composer -> settings
    await t.key('Escape'); // settings -> closed
    await t.open();
    t.type('s'); await sleep(400);
    check(t.lines().some((l) => /Replay last/.test(l)), 's stops and leaves the panel open');
    t.type('r'); await sleep(1500);
    check(t.lines().some((l) => /Transcription/.test(l)) && ctx.playerLog().length === played + 1, 'r replays the last message and the panel stays open', [ctx.playerLog().length, played]);
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); await rcv.stop(); rcv.cleanup(); }
}

// 5. a very narrow terminal gets one honest line
{
  const ctx = await setup();
  let t;
  try {
    t = await openPanelPi(ctx, { cols: 38, rows: 24 });
    await sleep(3500);
    t.type('/speech'); await sleep(400); await t.key('Enter'); await sleep(1500);
    const lines = t.lines();
    check(lines.some((l) => /narrow/i.test(l)), 'below 40 columns the panel says the terminal is too narrow', lines.slice(0, 10));
    check(lines.every((l) => [...l].length <= 38), 'and nothing is wider than the terminal');
    await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}
finish();
