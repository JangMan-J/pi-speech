// Visible acceptance: the /speech panel, redesign 01 layout. The main view holds only settings, under
// SPEAK (Alt+S), LISTEN (Alt+Z) and SETTINGS; models and voices show only their names (details in the pickers);
// Hotkeys runs every action and changes the keys of Speak and Dictate (leaving Hotkeys reloads Pi to bind them).
import path from 'node:path';
import { check, finish, ROOT, setup } from '../lib/lib.mjs';
import { openPanelPi, readSettings, sleep } from '../lib/panel.mjs';

/** The main view as agreed, with this suite's defaults, the first row selected. */
const MAIN = [
  'SPEAK (Alt+S)',
  '  ▸ Read aloud options   Off ›',
  '    Speech source        Provider',
  '    Speech model         google/gemini-3.8-flash-tts ›',
  '    Voice                Kore ›',
  'LISTEN (Alt+Z)',
  '    Transcription source Provider',
  '    Transcription model  openai/whisper-large-v3-turbo ›',
  '    Dictation language   auto',
  '    Dictation output     Pi ›',
  'SETTINGS',
  '    Hotkeys ›',
  '    Bridge connection ›',
];
const HOTKEYS = [
  '  ▸ Speak…             Alt+S',
  '    Dictate            Alt+Z',
  '    Replay last        r',
  '    History…           h',
  '    Stop               s',
  '    Transcribe file…   t',
];
const LABELS = ['Read aloud options', 'Speech source', 'Speech model', 'Voice', 'Transcription source', 'Transcription model', 'Dictation language', 'Dictation output', 'Hotkeys', 'Bridge connection'];

/** The dock: from its header line to its bottom rule, trailing spaces gone, the one-column margin removed. */
function dock(lines) {
  const start = lines.findIndex((l) => /^ ?Speak(?:er)? ─|^ ?Speech(?: › [^─]+)? ─/.test(l));
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
const hintOf = (d) => [...d].reverse().find((l) => /Esc/.test(l)) ?? '';
async function goTo(t, label) {
  for (let i = 0; i < 12 && !isSelected(dock(t.lines()), label); i++) await t.key('Down');
  return isSelected(dock(t.lines()), label);
}

const ctx = await setup({ xai: true });
let t;
try {
  // 1. the agreed layout at 80, 100 and 160 columns; nothing wider than the terminal
  for (const cols of [80, 100, 160]) {
    t = await openPanelPi(ctx, { cols, rows: 40 });
    await t.open();
    const lines = t.lines();
    const d = dock(lines);
    const w = Math.min(cols - 1, 96);
    check(d[0] === 'Speech ' + '─'.repeat(w - 7), `${cols} columns: the header is the title and the top rule`, d[0]);
    check(JSON.stringify(d.slice(1, 14)) === JSON.stringify(MAIN), `${cols} columns: the main view matches the agreed mockup`, d.slice(1, 14));
    check(lines.every((l) => [...l].length <= cols), `${cols} columns: no line is wider than the terminal`, lines.filter((l) => [...l].length > cols));
    check(!/\$|\/min|tags|langs|multilingual|voices/.test(d.join('\n')), `${cols} columns: no price, feature or language in the main view`);
    await t.key('Escape');
    t.close();
  }
  t = await openPanelPi(ctx, { cols: 100, rows: 40 });
  await t.open();
  let d = dock(t.lines());

  // 2. colour and emphasis (cells of the real screen)
  const title = t.find('Speech ─');
  const tc = t.cell(title.x, title.y);
  check(tc.bold === true && tc.fg !== 'default', 'the title is bold and in an accent colour', tc);
  const head = t.find('SPEAK (Alt+S)');
  check(t.cell(head.x, head.y).dim === true, 'the section headings are dim');
  const lab = t.find('Voice');
  check(t.cell(lab.x, lab.y).dim === true, 'labels are dim');
  const val = t.find('Kore');
  check(t.cell(val.x, val.y).dim !== true, 'values are not dim');
  const sel = t.find('Off');
  const sc = t.cell(sel.x, sel.y);
  check(sc.bold === true && sc.inverse === true, 'the selected row is reversed and bold across its value', sc);

  // 3. moving and changing in place
  await t.key('Up');
  check(isSelected(dock(t.lines()), 'Bridge connection'), 'Up from the first row wraps to the last');
  await t.key('Down');
  check(/Enter what is read and how/.test(hintOf(dock(t.lines()))), 'on Read aloud options the hint says Enter opens it', hintOf(dock(t.lines())));
  await t.key('Enter'); await sleep(200);
  d = dock(t.lines());
  check(/^Speech › Read aloud options ─+$/.test(d[0] ?? ''), 'Enter opens Read aloud options', d[0]);
  check(JSON.stringify(d.slice(1, 5)) === JSON.stringify([
    '  ▸ Read               Off',
    '    Summarized by      Same model ›',
    '    Length             Abridged ~30 s',
    '    Truncate at        Off',
  ]), 'it has Read, Summarized by, Length and Truncate at', d.slice(1, 5));
  check(d.some((l) => /Off: nothing is read aloud\./.test(l)), 'one line says what the highlighted row does', d.slice(-5));
  await t.key('Right');
  d = dock(t.lines());
  check(/Read\s+Summary$/.test(rowOf(d, 'Read') ?? '') && d.some((l) => /Reads the model's spoken summary of its reply\./.test(l)), 'Right cycles Read to Summary in place, and the line follows', d.slice(1, 8));
  await t.key('Down');
  check(dock(t.lines()).some((l) => /Same model, same reply\. No extra request\./.test(l)), 'on Summarized by the line says there is no extra request');
  await t.key('Down'); await t.key('Enter');
  d = dock(t.lines());
  check(/Length\s+Full ~60 s$/.test(rowOf(d, 'Length') ?? '') && d.some((l) => /Best effort: about 60 s\./.test(l)), 'Enter cycles Length; best effort, it says', d.slice(1, 8));
  await t.key('Down'); await t.key('Right', 2);
  d = dock(t.lines());
  check(/Truncate at\s+30 s$/.test(rowOf(d, 'Truncate at') ?? '') && d.some((l) => /Stops at 30 s, at a sentence end\./.test(l)), 'Truncate at cycles to 30 s and says where reading stops', d.slice(1, 8));
  check(readSettings(ctx).readAloud?.length === 'full' && readSettings(ctx).readAloud?.truncate === 30, 'Length and Truncate at are saved', readSettings(ctx).readAloud);
  await t.key('Left', 2); await t.key('Up'); await t.key('Left');
  await t.key('Escape');
  check(/Read aloud options\s+Summary ›$/.test(rowOf(dock(t.lines()), 'Read aloud options') ?? ''), 'Esc goes back; the row shows Summary');
  await t.key('Enter'); await t.key('Left'); await t.key('Escape');
  check(/Read aloud options\s+Off ›$/.test(rowOf(dock(t.lines()), 'Read aloud options') ?? ''), 'Read set back to Off');
  await goTo(t, 'Speech source');
  await t.key('Right');
  d = dock(t.lines());
  check(/Speech source\s+Provider$/.test(rowOf(d, 'Speech source') ?? '') && d.some((l) => /Provider is the only source so far/.test(l)), 'Speech source stays Provider and says it is the only one so far', d.slice(-6));

  // 4. the voice picker: the details live here, not in the main view
  check(await goTo(t, 'Voice'), 'the selection reaches Voice');
  await t.key('Enter'); await sleep(300);
  let lines = t.lines();
  check(lines.some((l) => /Speech › Voice/.test(l)) && lines.some((l) => /Find:.*\b\d+ voices/.test(l)), 'Enter on Voice opens the voice picker', lines.slice(-12));
  t.type('kore'); await sleep(400);
  check(t.lines().some((l) => /✓ Kore\b/.test(l)), 'the picker marks the current voice', t.lines().slice(-12));
  for (let i = 0; i < 4; i++) await t.key('Backspace');
  t.type('leda'); await sleep(400);
  await t.key('Enter'); await sleep(400);
  d = dock(t.lines());
  check(/Voice\s+Leda ›$/.test(rowOf(d, 'Voice') ?? '') && readSettings(ctx).voice === 'Leda', 'picking a voice saves it; the row shows only its name', [rowOf(d, 'Voice'), readSettings(ctx).voice]);

  // 5. the model picker: prices and features
  check(await goTo(t, 'Speech model'), 'the selection reaches Speech model');
  await t.key('Enter'); await sleep(300);
  lines = t.lines();
  check(lines.some((l) => /Find:/.test(l) && /sort price · show all/.test(l)), 'the model picker has its Find line with sort and show', lines.slice(-14));
  check(lines.filter((l) => /^\s*[▸✓\s]*[\w.-]+\/[\w.:-]+\s+~?\$[\d.]+\/min/.test(l)).length >= 6, 'prices and features appear in the model picker', lines.slice(-14));
  await t.key('Escape');
  check(await goTo(t, 'Transcription model'), 'the selection reaches Transcription model');
  await t.key('Enter'); await sleep(300);
  check(t.lines().some((l) => /Speech › Transcription model/.test(l)), 'the transcription picker is titled Transcription model');
  await t.key('Escape');

  // 6. Bridge connection: a submenu with the bridge mode
  check(await goTo(t, 'Bridge connection'), 'the selection reaches Bridge connection');
  await t.key('Enter'); await sleep(300);
  d = dock(t.lines());
  check(/^Speech › Bridge connection ─+$/.test(d[0] ?? ''), 'Enter opens Bridge connection', d[0]);
  check(/▸ Bridge\s+auto · on over SSH · plays on This machine$/.test(d[1] ?? ''), 'it shows the bridge mode and where audio plays', d[1]);
  await t.key('Right'); await sleep(1200);
  check(readSettings(ctx).bridge === 'on' || /unreachable|✗/.test(dock(t.lines()).join('\n')), 'Right cycles the mode (or says why it cannot)', dock(t.lines()).slice(0, 6));
  await t.key('Left'); await sleep(600);
  await t.key('Escape');
  check(isSelected(dock(t.lines()), 'Bridge connection'), 'Esc returns to the main view on its row');

  // 7. Hotkeys: every action, with its key, runnable
  await t.key('Up');
  await t.key('Enter'); await sleep(300);
  d = dock(t.lines());
  check(/^Speech › Hotkeys ─+$/.test(d[0] ?? ''), 'Enter on Hotkeys opens it', d[0]);
  check(JSON.stringify(d.slice(1, 7)) === JSON.stringify(HOTKEYS), 'Hotkeys lists the actions with their keys as agreed', d.slice(1, 7));
  check(hintOf(d).trim() === 'Enter run · k change key · Esc back', 'its hint names Enter, k and Esc', hintOf(d));
  // Speak…
  const n0 = ctx.speechRequests().length;
  await t.key('Enter');
  t.type('panel hello'); await sleep(200);
  check(/^Speak ─/.test(dock(t.lines())[0] ?? ''), 'Speak… opens the composer');
  await t.key('Enter');
  t.type('second panel message');
  await t.key('Enter'); await sleep(1500);
  const spoken = ctx.speechRequests().slice(n0).map((r) => r.body?.input);
  check(spoken.includes('panel hello') && spoken.includes('second panel message'), 'two Enters speak two messages', spoken);
  await t.key('Escape');
  check(/^Speech › Hotkeys/.test(dock(t.lines())[0] ?? ''), 'Esc returns to Hotkeys');
  // Replay last
  let played = ctx.playerLog().length;
  await t.key('Down', 2);
  await t.key('Enter'); await sleep(1500);
  check(ctx.playerLog().length === played + 1, 'Replay last plays the last message again', [ctx.playerLog().length, played]);
  // History…
  await t.key('Down');
  await t.key('Enter'); await sleep(400);
  lines = t.lines();
  check(lines.some((l) => /Speech › History/.test(l)) && lines.some((l) => /2 messages/.test(l)), 'History… opens the history with both messages', lines.slice(-10));
  played = ctx.playerLog().length;
  await t.key('Down'); await t.key('Enter'); await sleep(1500);
  check(ctx.playerLog().length === played + 1 && ctx.played(-1)?.equals(ctx.savedAudio(ctx.history().find((f) => /panel-hello/.test(f)))), 'Enter replays an earlier message from its file', ctx.playerLog().slice(-2));
  await t.key('Escape');
  check(/^Speech › Hotkeys/.test(dock(t.lines())[0] ?? ''), 'Esc from the history returns to Hotkeys');
  // Stop
  await t.key('Down');
  await t.key('Enter'); await sleep(500);
  check(dock(t.lines()).some((l) => /Stopped|Nothing was playing/.test(l)), 'Stop runs and says what it did', dock(t.lines()).slice(-5));
  // Transcribe file…
  ctx.or.setTranscript('words from a file');
  await t.key('Down');
  await t.key('Enter'); await sleep(300);
  d = dock(t.lines());
  const ti = d.findIndex((l) => /Transcribe file…/.test(l));
  check(ti > 0 && /Audio file/.test(d[ti + 1] ?? ''), 'Transcribe file… asks for the audio file under its row', d);
  t.type(path.join(ROOT, 'e2e/fixtures/quick-brown-fox.wav'));
  await t.key('Enter');
  check(await t.until((s) => /words from a file/.test(s) && !/Hotkeys/.test(s), 8000), 'the transcript goes into the editor and the dock closes', t.lines().slice(-8));
  t.close();

  // 8. Dictate from Hotkeys closes the panel and starts dictation
  t = await openPanelPi(ctx, { cols: 100, rows: 40 });
  await t.open();
  await goTo(t, 'Hotkeys');
  await t.key('Enter');
  await t.key('Down');
  await t.key('Enter'); await sleep(1200);
  lines = t.lines();
  check(!lines.some((l) => /Speech › Hotkeys/.test(l)) && lines.some((l) => /REC|microphone|record|Dictation/i.test(l)), 'Dictate closes the panel and starts dictation', lines.slice(-8));
  t.close();

  // 9. k changes the key of Speak: saved at once; leaving Hotkeys reloads Pi silently and binds it
  t = await openPanelPi(ctx, { cols: 100, rows: 40 });
  await t.open();
  await goTo(t, 'Hotkeys');
  await t.key('Enter');
  t.type('k'); await sleep(300);
  check(/▸ Speak…\s+press a key…/.test(dock(t.lines())[1] ?? ''), 'k waits for the new key', dock(t.lines())[1]);
  await t.key('alt+d'); await sleep(400);
  d = dock(t.lines());
  check(readSettings(ctx).hotkeys?.speak === 'alt+d', 'the new key is saved in the settings file', readSettings(ctx).hotkeys);
  check(/Speak…\s+Alt\+D$/.test(d[1] ?? ''), 'the row shows the new key, with nothing waiting beside it', d[1]);
  check(d.some((l) => /✓ Speak is Alt\+D$/.test(l)) && !d.some((l) => /reload/.test(l)), 'the status line confirms the key and mentions no /reload', d.slice(-5));
  await t.key('Escape'); await sleep(3000);
  lines = t.lines();
  // Pi's own reload prints its "Reloaded keybindings, extensions, …" status line; pi-speech adds no message.
  const reloaded = lines.some((l) => /Reloaded keybindings, extensions/.test(l));
  const ours = lines.filter((l) => /\/reload|Alt\+D|Speak is|Speech:/.test(l));
  check(dock(lines).length === 0 && reloaded && ours.length === 0, 'leaving Hotkeys closes the dock and reloads Pi without /reload typed, with no message of its own', [dock(lines), reloaded, ours]);
  await t.key('alt+d'); await sleep(600);
  check(/^Speak ─/.test(dock(t.lines())[0] ?? ''), 'Alt+D opens the speak composer at once', t.lines().slice(-8));
  await t.key('Escape'); await sleep(300);
  await t.key('alt+s'); await sleep(600);
  check(!/^Speak ─/.test(dock(t.lines())[0] ?? ''), 'and Alt+S no longer does', t.lines().slice(-8));
  t.type('/speech'); await sleep(400); await t.key('Enter'); await sleep(800);
  check(dock(t.lines()).includes('SPEAK (Alt+D)'), 'the SPEAK heading carries the new key', dock(t.lines()).slice(0, 3));
  await t.key('Escape');
  t.close();
} finally {
  try { t?.close(); } catch {}
  await ctx.close();
  ctx.cleanup();
}
finish();
