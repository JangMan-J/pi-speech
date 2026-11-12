// Drives a real Pi in a pseudo-terminal (tui-test) with only this extension, against the fake services of `ctx`.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openPanelPi(ctx, { cols = 110, rows = 34, env: extra = {}, unset = ['SSH_CONNECTION', 'SSH_TTY', 'PI_SPEECH_LOCAL_MIC'] } = {}) {
  const session = 'pi-speech-panel-' + crypto.randomBytes(4).toString('hex');
  const env = {
    PI_CODING_AGENT_DIR: ctx.agentDir, PI_OFFLINE: '1', NODE_OPTIONS: `--import ${path.join(HERE, 'preload.mjs')}`,
    FAKE_OPENROUTER_URL: ctx.or.url, FAKE_XAI_URL: ctx.xai.url, OPENROUTER_API_KEY: ctx.key, PI_SPEECH_DIR: ctx.speechDir,
    PI_SPEECH_PLAYER: ctx.player, HOME: ctx.home, ...extra,
  };
  const cwd = fs.mkdtempSync(path.join(ctx.work, 'tui-cwd-'));
  const tt = (...args) => execFileSync('tui-test', args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, TUI_TEST_SESSION: session } });
  tt('run', '--cols', String(cols), '--rows', String(rows), '--cwd', cwd, 'env', ...unset.flatMap((k) => ['-u', k]),
    ...Object.entries(env).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`),
    'pi', '--no-extensions', '-e', path.join(process.cwd(), 'index.ts'),
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--offline', '--no-mcp', '--no-session',
    '--provider', 'fake', '--model', 'fake-model');
  let started = false;
  const term = {
    screen: () => tt('text'),
    lines: () => tt('text').split('\n'),
    type: (t) => tt('type', t),
    key: async (k, n = 1) => { for (let i = 0; i < n; i++) tt('key', 'press', k); await sleep(250); },
    async until(pred, ms = 8000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (pred(tt('text'))) return true; await sleep(150); }
      return pred(tt('text'));
    },
    async open() { if (!started) { await sleep(3500); started = true; } tt('type', '/speech'); await sleep(400); tt('key', 'press', 'Enter'); await term.until((t) => /Speech model/.test(t), 10000); },
    /** The attributes of one screen cell: {char, fg, bold, dim, inverse, ...}. */
    cell(x, y) { return JSON.parse(tt('cells', '--json', String(x), String(y), '1', '1')).data.cells[0]; },
    /** Position {x, y} of the first occurrence of `text` on the screen. */
    find(text) { const L = tt('text').split('\n'); const y = L.findIndex((l) => l.includes(text)); return y < 0 ? undefined : { x: L[y].indexOf(text), y }; },
    close: () => { try { tt('close'); } catch {} },
  };
  return term;
}

/** The screen line of the row `label`: a setting starts with it (after the section name and the marker); an action shares a toolbar line. */
export const row = (lines, label) =>
  lines.find((l) => l.replace(/^\s*(?:SPEAK|LISTEN|SYSTEM)?[\s▸>]*/, '').startsWith(label)) ?? lines.find((l) => l.includes(label));
/** Whether the row `label` is the selected one: the marker ▸ stands right before it. */
export const selected = (lines, label) => (row(lines, label) ?? '').includes('▸ ' + label);
/** Move the selection to the row `label`: ↓ to its line, then → along its toolbar. */
export async function goTo(t, label) {
  const onLine = () => /▸/.test(row(t.lines(), label) ?? '');
  for (let i = 0; i < 10 && !onLine(); i++) await t.key('Down');
  for (let i = 0; i < 4 && !selected(t.lines(), label); i++) await t.key('Right');
  return selected(t.lines(), label);
}
/** The column where `text` starts in `line`. */
export const col = (line, text) => (line ?? '').indexOf(text);
export const settingsFile = (ctx) => path.join(ctx.agentDir, 'pi-speech', 'settings.json');
export const readSettings = (ctx) => { try { return JSON.parse(fs.readFileSync(settingsFile(ctx), 'utf8')); } catch { return {}; } };
