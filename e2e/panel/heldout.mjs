// Held-out acceptance: the /speech panel (redesign 01 layout), edge cases.
import { check, finish, setup } from '../lib/lib.mjs';
import { openPanelPi, readSettings, sleep } from '../lib/panel.mjs';
import { startReceiver } from '../lib/receiver.mjs';

/** The dock: from its header line to its bottom rule, trailing spaces gone, the one-column margin removed. */
function dock(lines) {
  const start = lines.findIndex((l) => /^ ?Speak ─|^ ?Speech(?: › [^─]+)? ─/.test(l));
  if (start < 0) return [];
  const out = [];
  for (let i = start; i < lines.length; i++) {
    out.push(lines[i].trimEnd());
    if (i > start && /^ ?─+$/.test(lines[i].trimEnd())) break;
  }
  const margin = out[0].startsWith(' ') ? 1 : 0;
  return out.map((l) => l.slice(margin));
}
const rowOf = (d, label) => d.find((l) => l.replace(/^[\s▸]+/, '').startsWith(label));
const isSelected = (d, label) => (rowOf(d, label) ?? '').includes('▸ ' + label);
async function goTo(t, label) {
  for (let i = 0; i < 12 && !isSelected(dock(t.lines()), label); i++) await t.key('Down');
  return isSelected(dock(t.lines()), label);
}

// 0. idle shows no label
{
  const ctx = await setup();
  let t;
  try {
    t = await openPanelPi(ctx);
    await t.open();
    const d = dock(t.lines());
    check(/^Speech ─+$/.test(d[0] ?? '') && !t.lines().some((l) => /\bidle\b/i.test(l)), 'the header has no idle label', d.slice(0, 3));
    await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}

// 1. over SSH the receiver is unreachable: the panel still opens; Bridge connection says so with a symbol and a word
{
  const env = { PI_SPEECH_BRIDGE_URL: 'http://127.0.0.1:9', PI_SPEECH_BRIDGE_TOKEN: 'x'.repeat(40) };
  const ctx = await setup({ env });
  let t;
  try {
    t = await openPanelPi(ctx, { env: { ...env, SSH_TTY: '/dev/pts/3' }, unset: ['SSH_CONNECTION', 'PI_SPEECH_LOCAL_MIC'] });
    await t.open();
    check(dock(t.lines()).includes('SPEAK (Alt+S)'), 'the panel opens with the receiver unreachable');
    await goTo(t, 'Bridge connection');
    await t.key('Enter'); await sleep(1500);
    const b = rowOf(dock(t.lines()), 'Bridge') ?? '';
    check(/Remote machine/.test(b) && /✗/.test(b) && /unreachable/i.test(b), 'Bridge says audio goes to the Remote machine, whose receiver is unreachable, with ✗', b);
    await t.key('Escape'); await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}

// 2. without an xAI login, xai is not in any list
{
  const ctx = await setup();
  let t;
  try {
    t = await openPanelPi(ctx);
    await t.open();
    await goTo(t, 'Transcription model');
    await t.key('Enter'); await sleep(300);
    check(!t.lines().some((l) => /xAI Grok|^\W*xai\b/.test(l.trim())), 'xAI Grok is not offered without a login', t.lines().slice(-16));
    await t.key('Escape'); await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}

// 3. typing on a model row opens the picker with that text; F2 sets a voice language, shown in the picker only
{
  const ctx = await setup({ xai: true });
  let t;
  try {
    t = await openPanelPi(ctx);
    await t.open();
    await goTo(t, 'Speech model');
    t.type('kok'); await sleep(500);
    let lines = t.lines();
    check(lines.some((l) => /hexgrad\/kokoro-82m/.test(l)) && !lines.some((l) => /google\/gemini/.test(l)), 'typing on a model row opens a filtered picker', lines.slice(-14));
    await t.key('Escape');
    check(/Speech model\s+google\/gemini-3\.8-flash-tts ›$/.test(rowOf(dock(t.lines()), 'Speech model') ?? ''), 'Esc leaves the model unchanged', rowOf(dock(t.lines()), 'Speech model'));
    await goTo(t, 'Voice');
    await t.key('F2'); await sleep(400);
    check(t.lines().some((l) => /Language of Kore/.test(l)), 'F2 on Voice asks for the voice language', t.lines().slice(-8));
    t.type('ja'); await sleep(200);
    await t.key('Enter'); await sleep(400);
    lines = dock(t.lines());
    check(/Voice\s+Kore ›$/.test(rowOf(lines, 'Voice') ?? ''), 'the Voice row still shows only the name', rowOf(lines, 'Voice'));
    check(JSON.stringify(readSettings(ctx).languages).includes('"ja"'), 'the override is saved', readSettings(ctx).languages);
    t.type('kore'); await sleep(400);
    check(t.lines().some((l) => /✓ Kore\b/.test(l) && /ja · set by you/.test(l)), 'the voice picker shows the language as set by you', t.lines().slice(-12));
    await t.key('Escape');
    await t.key('F2'); await sleep(300);
    t.type('auto'); await sleep(200);
    await t.key('Enter'); await sleep(300);
    check(!JSON.stringify(readSettings(ctx).languages ?? {}).includes('"ja"'), 'auto removes the override', readSettings(ctx).languages);
    await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}

// 4. the bridge mode cycles with a reachable receiver; s and r work in the main view
const rcv = await startReceiver();
{
  const env = { PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: rcv.token };
  const ctx = await setup({ env });
  let t;
  try {
    t = await openPanelPi(ctx, { env });
    await t.open();
    await goTo(t, 'Bridge connection');
    await t.key('Enter'); await sleep(300);
    const b = () => rowOf(dock(t.lines()), 'Bridge') ?? '';
    check(/Bridge\s+auto/.test(b()), 'Bridge starts at auto', b());
    await sleep(600);
    const pairing = rowOf(dock(t.lines()), 'Pairing') ?? '';
    check(/Pairing\s+✓ Connected to 127\.0\.0\.1:\d+ · \d+ ms( ›)?$/.test(pairing), 'Pairing says the receiver is connected, where and how fast', pairing);
    await t.key('Right'); await sleep(800);
    check(/Bridge\s+on · plays on the Remote machine · ✓/.test(b()) && readSettings(ctx).bridge === 'on', 'Right moves it to on, saves it, and shows the receiver', [b(), readSettings(ctx).bridge]);
    await t.key('Right'); await sleep(400);
    check(/Bridge\s+off · plays on This machine$/.test(b()) && readSettings(ctx).bridge === 'off', 'the next Right moves it to off', [b(), readSettings(ctx).bridge]);
    await t.key('Right'); await sleep(400);
    check(/Bridge\s+auto/.test(b()) && readSettings(ctx).bridge === 'auto', 'then back to auto', [b(), readSettings(ctx).bridge]);
    await t.key('Escape');
    await t.key('alt+s'); await sleep(400);
    t.type('replay me'); await sleep(200); await t.key('Enter'); await sleep(1500);
    const played = ctx.playerLog().length;
    await t.key('Escape'); await sleep(200);
    t.type('s'); await sleep(400);
    check(dock(t.lines()).includes('SETTINGS'), 's stops and leaves the panel open');
    t.type('r'); await sleep(1500);
    check(dock(t.lines()).includes('SETTINGS') && ctx.playerLog().length === played + 1, 'r replays the last message and the panel stays open', [ctx.playerLog().length, played]);
    await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); await rcv.stop(); rcv.cleanup(); }
}

// 5. a key that cannot be a hotkey is refused; a changed key survives a restart of Pi
{
  const ctx = await setup();
  let t;
  try {
    t = await openPanelPi(ctx);
    await t.open();
    await goTo(t, 'Hotkeys');
    await t.key('Enter');
    await t.key('Down');
    t.type('k'); await sleep(200);
    t.type('x'); await sleep(300);
    check(dock(t.lines()).some((l) => /✗ x cannot be a hotkey: use Alt with a letter or a digit/.test(l)), 'a key without Alt is refused', dock(t.lines()).slice(-5));
    t.type('k'); await sleep(200);
    await t.key('alt+s'); await sleep(300);
    check(dock(t.lines()).some((l) => /✗ Alt\+S is already the key of Speak/.test(l)), 'the key of the other action is refused', dock(t.lines()).slice(-5));
    t.type('k'); await sleep(200);
    await t.key('Escape'); await sleep(200);
    check(/Dictate\s+Alt\+Z$/.test(rowOf(dock(t.lines()), 'Dictate') ?? '') && readSettings(ctx).hotkeys === undefined, 'Esc cancels; nothing is saved', [rowOf(dock(t.lines()), 'Dictate'), readSettings(ctx).hotkeys]);
    t.type('k'); await sleep(200);
    await t.key('alt+x'); await sleep(300);
    check(readSettings(ctx).hotkeys?.dictate === 'alt+x', 'Alt+X is saved for Dictate', readSettings(ctx).hotkeys);
    await t.key('Escape'); await t.key('Escape');
    t.close();
    t = await openPanelPi(ctx);
    await t.open();
    check(dock(t.lines()).includes('LISTEN (Alt+X)'), 'after a restart of Pi the LISTEN heading carries Alt+X', dock(t.lines()).slice(0, 8));
    await goTo(t, 'Hotkeys');
    await t.key('Enter');
    check(/Dictate\s+Alt\+X$/.test(rowOf(dock(t.lines()), 'Dictate') ?? ''), 'and Hotkeys shows it bound, with nothing waiting', rowOf(dock(t.lines()), 'Dictate'));
    await t.key('Escape'); await t.key('Escape');
  } finally { try { t?.close(); } catch {} await ctx.close(); ctx.cleanup(); }
}

// 6. a very narrow terminal gets one honest line
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
