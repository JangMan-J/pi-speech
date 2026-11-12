// Visible acceptance: the /speech dock, third design (sections, model browser with sort and feature filter,
// history, file transcription, dictation language, the speak composer).
import path from 'node:path';
import { check, finish, ROOT, setup } from '../lib/lib.mjs';
import { col, goTo, openPanelPi, readSettings, row, selected, sleep } from '../lib/panel.mjs';

const SPEAK = ['Speak…', 'Replay last', 'History…', 'Stop'];
const LISTEN = ['Dictate', 'Transcribe file…'];
const SETTINGS = ['Speech model', 'Voice', 'Read replies aloud', 'Transcription', 'Dictation language', 'Play audio on', 'Agent tools'];
const ORDER = [...SPEAK, ...SETTINGS.slice(0, 3), ...LISTEN, ...SETTINGS.slice(3)];
const OPENS = ['Speech model', 'Voice', 'Transcription', 'Dictation language'];
const hintLine = (lines) => [...lines].reverse().find((l) => /Esc/.test(l)) ?? '';
const findLine = (lines) => lines.find((l) => /Find:/.test(l)) ?? '';
/** The model rows of a list: `vendor/model  price  features`. */
const modelRows = (lines) => lines.filter((l) => /^[\s▸✓]*[\w.-]+\/[\w.:-]+\s+~?\$/.test(l));
const ctx = await setup({ xai: true });
let t;
try {
  t = await openPanelPi(ctx);
  await t.open();
  let lines = t.lines();

  // 1. layout: a dock, three sections named in a gutter, actions on toolbars
  const dock = lines.slice(lines.findIndex((l) => /^\s*Speech ─/.test(l)));
  check(/^ Speech ─{60,}$/.test(dock[0] ?? ''), 'the header is the title and the top rule when nothing is happening (no idle label)', dock.slice(0, 3));
  const end = dock.findIndex((l, i) => i > 0 && /^ ─+$/.test(l));
  check(end > 0 && end <= 12, 'the whole dock takes at most 13 lines', end);
  check(!/[│╭╰]/.test(dock.slice(0, end + 1).join('\n')), 'it is not a box over the conversation');
  const at = ORDER.map((l) => lines.indexOf(row(lines, l)));
  check(at.every((i) => i >= 0) && at.every((v, i) => i === 0 || v >= at[i - 1]), 'the rows come in the documented order', at);
  check(/^ SPEAK /.test(row(lines, 'Speak…')) && /^ LISTEN /.test(row(lines, 'Dictate')) && /^ SYSTEM /.test(row(lines, 'Play audio on')), 'each section is named beside its first line', [row(lines, 'Speak…'), row(lines, 'Dictate')]);
  check(SPEAK.every((l) => row(lines, l) === row(lines, 'Speak…')) && LISTEN.every((l) => row(lines, l) === row(lines, 'Dictate')), 'the actions of a section share one toolbar line');
  check(/Speak… Alt\+S/.test(row(lines, 'Speak…')) && /Dictate Alt\+Z/.test(row(lines, 'Dictate')) && /Transcribe file… t/.test(row(lines, 'Dictate')), 'actions show their keys');
  check(selected(lines, 'Speak…'), 'the first action is selected with the marker ▸');
  const values = { 'Speech model': 'google/gemini-3.8-flash-tts', Voice: 'Kore', 'Read replies aloud': 'off', Transcription: 'openai/whisper-large-v3-turbo', 'Dictation language': 'auto', 'Play audio on': 'auto', 'Agent tools': 'on' };
  const cols = SETTINGS.map((l) => col(row(lines, l), values[l]));
  check(cols.every((c) => c > 0) && new Set(cols).size === 1, 'all setting values start in one column', cols);
  check(new Set(SETTINGS.map((l) => col(row(lines, l), l))).size === 1, 'all setting labels are aligned');
  const model = row(lines, 'Speech model') ?? '';
  check(/~\$0\.\d+\/min\s+tags · fast/.test(model), 'a model row shows the price, then what the model offers', model);
  check(OPENS.every((l) => /›\s*$/.test(row(lines, l) ?? '')), 'rows that open something end with ›', OPENS.map((l) => row(lines, l)));
  check(['Play audio on', 'Read replies aloud', 'Agent tools'].every((l) => !/›\s*$/.test(row(lines, l) ?? '')), 'toggle rows do not');

  // 2. colour and emphasis (cells of the real screen)
  const title = t.find('Speech ─');
  const tc = t.cell(title.x, title.y);
  check(tc.bold === true && tc.fg !== 'default', 'the title is bold and in an accent colour', tc);
  const lab = t.find('Voice');
  check(t.cell(lab.x, lab.y).dim === true, 'setting labels are dim');
  const val = t.find('Kore');
  check(t.cell(val.x, val.y).dim !== true, 'values are not dim');
  const sp = t.find('Speak…');
  check(t.cell(sp.x, sp.y).inverse === true, 'the selected action is a reversed cell', t.cell(sp.x, sp.y));
  await t.key('Down');
  const sel = t.find('google/gemini-3.8-flash-tts');
  const sc = t.cell(sel.x, sel.y);
  check(sc.bold === true && sc.inverse === true, 'the selected setting is reversed and bold across its value', sc);
  await t.key('Up');

  // 3. moving: ↑↓ by line, ←→ along a toolbar
  await t.key('Down', 8);
  check(selected(t.lines(), 'Agent tools'), 'Down x8 goes line by line to the last row');
  await t.key('Down');
  check(selected(t.lines(), 'Speak…'), 'Down from the last row wraps to the first');
  await t.key('Right');
  check(selected(t.lines(), 'Replay last'), 'Right moves along the toolbar');
  await t.key('Down', 4);
  check(selected(t.lines(), 'Transcribe file…'), 'the next toolbar is entered at the same column');
  await t.key('Left');
  check(selected(t.lines(), 'Dictate'), 'Left moves back');
  await t.key('Up', 5);
  check(selected(t.lines(), 'Agent tools'), 'Up from the first row wraps to the last');

  // 4. changing a value in place; hints follow the row
  let h = hintLine(t.lines());
  check(/←→/.test(h) && /on\/off/.test(h), 'on a toggle row the hint says ←→ toggles', h);
  await t.key('Right'); await sleep(300);
  check(/\boff\b/.test(row(t.lines(), 'Agent tools') ?? '') && readSettings(ctx).tools === false, 'Right turns Agent tools off and saves it', readSettings(ctx));
  await t.key('Left');
  check(/\bon\b/.test(row(t.lines(), 'Agent tools') ?? '') && readSettings(ctx).tools === true, 'Left turns it back on');
  await goTo(t, 'Read replies aloud');
  await t.key('Right');
  check(/\bon\b/.test(row(t.lines(), 'Read replies aloud') ?? ''), 'Right turns Read replies aloud on');
  await t.key('Left');
  await goTo(t, 'Play audio on');
  h = hintLine(t.lines());
  check(/auto/.test(h) && /bridge/.test(h) && /local/.test(h), 'on Play audio on the hint names the three choices', h);

  // 5. the voice list: typing is filtering, F2 is the language key, Tab samples
  check(await goTo(t, 'Voice'), 'the selection reaches Voice');
  await t.key('Enter');
  lines = t.lines();
  check(/Find:/.test(findLine(lines)) && /\d+ voices/.test(findLine(lines)), 'the list has a Find: field and counts the voices', findLine(lines));
  check(!/sort /.test(findLine(lines)), 'a voice list has no sort');
  check(lines.some((l) => /\bKore\b/.test(l) && /✓/.test(l)), 'the current voice is marked ✓');
  h = hintLine(lines);
  check(/Tab sample/.test(h) && /F2/.test(h) && /Esc/.test(h), 'the hint names Tab, F2 and Esc', h);
  t.type('leda'); await sleep(500);
  lines = t.lines();
  check(lines.some((l) => /\bLeda\b/.test(l)) && !lines.some((l) => /Language of/i.test(l)), 'typing leda filters the list (l is not a command key)', lines.slice(-14));
  check(/\b1 of \d+ voices/.test(findLine(lines)), 'the count follows the filter', findLine(lines));
  const before = ctx.speechRequests().length;
  await t.key('Tab'); await sleep(1200);
  check(ctx.speechRequests().slice(before).at(-1)?.body?.voice === 'Leda', 'Tab samples the highlighted voice');
  await t.key('Enter'); await sleep(400);
  check(/\bLeda\b/.test(row(t.lines(), 'Voice') ?? '') && readSettings(ctx).voice === 'Leda', 'Enter picks it and saves it', readSettings(ctx).voice);
  await t.key('F2'); await sleep(400);
  check(t.lines().some((l) => /Language of Leda/.test(l)), 'F2 on the Voice row asks for the voice language', t.lines().slice(-8));
  t.type('ja'); await sleep(200);
  await t.key('Enter'); await sleep(400);
  check(/ja · set by you/.test(row(t.lines(), 'Voice') ?? ''), 'the Voice note says the language was set by you', row(t.lines(), 'Voice'));

  // 6. the model browser: price, provider and features; filter by a feature; search
  check(await goTo(t, 'Speech model'), 'the selection reaches Speech model');
  await t.key('Enter'); await sleep(300);
  lines = t.lines();
  check(/^ Speech › Speech model ─+$/.test(lines.find((l) => /Speech › /.test(l)) ?? ''), 'the header says where we are', lines.find((l) => /Speech › /.test(l)));
  check(/sort price · show all\s+\d+ models$/.test(findLine(lines)), 'the Find line says the order, what is shown, and counts the models', findLine(lines));
  const total = Number(/(\d+) models$/.exec(findLine(lines))?.[1]);
  const priceOf = (l) => Number(/~?\$([\d.]+)/.exec(l)?.[1]);
  let rowsNow = modelRows(lines);
  check(rowsNow.length === 8 && rowsNow.every((l, i) => i === 0 || priceOf(l) >= priceOf(rowsNow[i - 1])), 'eight models show, cheapest first', rowsNow);
  check(rowsNow.some((l) => /tags/.test(l)) && rowsNow.some((l) => /\d+ voices/.test(l)), 'each model says what it offers', rowsNow);
  check(lines.some((l) => /1–8 of \d+ ↓$/.test(l) && /^ \S/.test(l)), 'under the list: the description of the highlighted model, and where the list is', lines.slice(-6));
  await t.key('Up');
  lines = t.lines();
  check(lines.some((l) => /▸/.test(l) && /xAI Grok/.test(l) && /price unknown/.test(l) && /xAI login/.test(l)), 'Up from the top wraps to the end, where xAI Grok (price unknown) is', lines.slice(-14));
  await t.key('Down');
  await t.key('Tab');
  lines = t.lines();
  rowsNow = modelRows(lines).map((l) => l.replace(/^[\s▸✓]*/, '').split('/')[0]);
  check(/sort provider · show all/.test(findLine(lines)), 'Tab orders the list by provider', findLine(lines));
  check(rowsNow.length === 8 && new Set(rowsNow).size < 8 && rowsNow.every((v, i) => i === 0 || rowsNow.indexOf(v) === i || rowsNow[i - 1] === v), 'models of one provider stand together', rowsNow);
  check(readSettings(ctx).modelSort === 'provider', 'the order is saved', readSettings(ctx));
  await t.key('Tab');
  lines = t.lines();
  const counts = modelRows(lines).map((l) => (l.replace(/\d+ voices?/, '').split(/\$\S*\s+/)[1] ?? '').split(' · ').filter((x) => x.trim()).length);
  check(/sort features/.test(findLine(lines)) && counts.every((c, i) => i === 0 || c <= counts[i - 1]), 'Tab again: the models that offer the most come first', counts);
  await t.key('shift+tab');
  lines = t.lines();
  rowsNow = modelRows(lines);
  const shown = Number(/(\d+) of \d+ models$/.exec(findLine(lines))?.[1]);
  check(/sort features · show tags/.test(findLine(lines)) && shown > 0 && shown < total, 'Shift+Tab shows only the models with inline tags, and counts them', findLine(lines));
  check(rowsNow.length > 0 && rowsNow.every((l) => /\btags\b/.test(l)), 'every model shown takes tags', rowsNow);
  t.type('eleven'); await sleep(400);
  rowsNow = modelRows(t.lines());
  check(rowsNow.length > 0 && rowsNow.every((l) => /elevenlabs\//.test(l) && /\btags\b/.test(l)), 'typing searches inside what is shown', rowsNow);
  h = hintLine(t.lines());
  check(/Tab sort/.test(h) && /Shift\+Tab show/.test(h) && /Esc back/.test(h), 'the hint names Tab, Shift+Tab and Esc', h);
  await t.key('Escape');
  check(selected(t.lines(), 'Speech model') && readSettings(ctx).speechModel === 'google/gemini-3.8-flash-tts', 'Esc returns to the dock and changes nothing');
  await goTo(t, 'Transcription');
  await t.key('Enter'); await sleep(300);
  lines = t.lines();
  check(/sort features · show all/.test(findLine(lines)) && modelRows(lines).some((l) => /timestamps|speakers|langs/.test(l)), 'the transcription list has the same order and its own features', [findLine(lines), ...modelRows(lines).slice(0, 3)]);
  await t.key('Tab', 3); // newest, name, price
  check(/sort price/.test(findLine(t.lines())) && readSettings(ctx).modelSort === undefined, 'three more Tabs return to price', findLine(t.lines()));
  await t.key('Escape');

  // 7. Speak… is a persistent composer; History… replays earlier messages
  check(await goTo(t, 'Speak…'), 'the selection reaches Speak…');
  const n0 = ctx.speechRequests().length;
  await t.key('Enter');
  t.type('panel hello'); await sleep(300);
  lines = t.lines();
  check(lines.some((l) => /^ Speak ─/.test(l)) && !lines.some((l) => /Transcription/.test(l)), 'Speak… opens a dedicated composer instead of the settings rows', lines.slice(-8));
  check(lines.some((l) => /panel hello/.test(l)), 'the typed message is visible in the composer');
  await t.key('Enter');
  t.type('second panel message');
  await t.key('Enter'); await sleep(1500);
  const spoken = ctx.speechRequests().slice(n0).map((r) => r.body?.input);
  check(spoken.includes('panel hello') && spoken.includes('second panel message'), 'two Enters speak two messages without reselecting Speak…', spoken);
  check(!t.lines().some((l) => /Transcription/.test(l)) && !t.lines().some((l) => /second panel message/.test(l)), 'the composer stays open and clears for the next message', t.lines().slice(-8));
  await t.key('Escape');
  let played = ctx.playerLog().length;
  t.type('r'); await sleep(1500);
  check(ctx.playerLog().length === played + 1 && t.lines().some((l) => /Transcription/.test(l)), 'Esc returns to the dock; r replays the last message and the dock stays', [ctx.playerLog().length, played]);
  t.type('h'); await sleep(400);
  lines = t.lines();
  check(/^ Speech › History ─/.test(lines.find((l) => /Speech › /.test(l)) ?? '') && /2 messages$/.test(findLine(lines)), 'h opens the history with both messages', lines.slice(-10));
  check(lines.findIndex((l) => /second panel message/.test(l)) < lines.findIndex((l) => /panel hello/.test(l)), 'the newest message comes first');
  played = ctx.playerLog().length;
  const requests = ctx.speechRequests().length;
  await t.key('Down'); await t.key('Enter'); await sleep(1500);
  check(ctx.playerLog().length === played + 1 && /panel-hello/.test(ctx.playerLog().at(-1)) && ctx.speechRequests().length === requests, 'Enter replays the earlier message from its file, without a new request', ctx.playerLog().slice(-2));
  check(t.lines().some((l) => /Speech › History/.test(l)), 'the history stays open for another');
  await t.key('Escape');

  // 8. Dictation language, and a file transcribed into the editor
  check(await goTo(t, 'Dictation language'), 'the selection reaches Dictation language');
  await t.key('Enter');
  check(t.lines().some((l) => /Spoken language/.test(l) && /ja or pt-BR, or auto/.test(l)), 'Enter asks for the spoken language under the row', t.lines().slice(-10));
  t.type('ja'); await t.key('Enter'); await sleep(400);
  check(/Dictation language\s+ja\b/.test(row(t.lines(), 'Dictation language') ?? '') && readSettings(ctx).dictationLanguage === 'ja', 'the language is shown and saved', row(t.lines(), 'Dictation language'));
  ctx.or.setTranscript('words from a file');
  const llm0 = ctx.llm.requests.length;
  t.type('t'); await sleep(300);
  check(t.lines().some((l) => /Audio file/.test(l)), 't asks for the audio file under the toolbar', t.lines().slice(-10));
  t.type(path.join(ROOT, 'e2e/fixtures/quick-brown-fox.wav'));
  await t.key('Enter');
  check(await t.until((s) => /words from a file/.test(s) && !/Transcription/.test(s), 8000), 'the transcript goes into the editor and the dock closes', t.lines().slice(-8));
  const treq = ctx.or.requests.filter((r) => r.path.startsWith('/api/v1/audio/transcriptions')).at(-1);
  check(treq?.body?.language === 'ja', 'the dictation language goes with the file', treq?.body?.language);
  check(ctx.llm.requests.length === llm0, 'nothing was sent to the agent');

  // 9. Alt+S opens the composer directly; Esc closes it
  const n1 = ctx.speechRequests().length;
  await t.key('alt+s'); await sleep(400);
  check(t.lines().some((l) => /^ Speak ─/.test(l)) && !t.lines().some((l) => /Transcription/.test(l)), 'Alt+S opens the composer without the settings rows', t.lines().slice(-6));
  check(/Esc close/.test(hintLine(t.lines())), 'its Esc closes', hintLine(t.lines()));
  t.type('hotkey message');
  await t.key('Enter'); await sleep(1200);
  check(ctx.speechRequests().slice(n1).some((r) => r.body?.input === 'hotkey message'), 'the Alt+S composer speaks the typed message');
  await t.key('Escape'); await sleep(300);
  check(!t.lines().some((l) => /^ Speak ─/.test(l)) && t.lines().some((l) => /words from a file/.test(l)), 'Esc closes it and the editor has its text back', t.lines().slice(-6));
  t.close();

  // 10. a narrow terminal: headings instead of the gutter, prices before features
  t = await openPanelPi(ctx, { cols: 60, rows: 30 });
  await t.open();
  lines = t.lines();
  check(ORDER.every((l) => row(lines, l)), 'at 60 columns every row is there');
  check(lines.every((l) => [...l].length <= 60), 'no line is wider than the terminal', lines.filter((l) => [...l].length > 60));
  check(['SPEAK', 'LISTEN', 'SYSTEM'].every((s) => lines.some((l) => l.trim() === s)), 'the sections are headings of their own');
  const m60 = row(lines, 'Speech model') ?? '';
  check(m60.includes('$') && !/tags/.test(m60), 'the model row keeps the price and drops the features', m60);
  await goTo(t, 'Speech model'); await t.key('Enter'); await sleep(300);
  lines = t.lines();
  check(modelRows(lines).length >= 3 && !modelRows(lines).some((l) => /voices/.test(l)), 'the list at 60 columns keeps the prices', lines.slice(-14));
  await t.key('Escape'); await t.key('Escape');
} finally {
  try { t?.close(); } catch {}
  await ctx.close();
  ctx.cleanup();
}
finish();
