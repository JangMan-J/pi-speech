// Dictation helpers: a fake recorder environment and a TUI driver through tui-test.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function recorderEnv(ctx) {
  const fake = path.join(ctx.work, 'fake');
  fs.mkdirSync(fake, { recursive: true });
  fs.chmodSync(path.join(HERE, 'fake-recorder'), 0o755);
  return {
    fake,
    env: { PI_SPEECH_RECORDER: path.join(HERE, 'fake-recorder'), FAKE_DIR: fake, SSH_CONNECTION: null, SSH_TTY: null, PI_SPEECH_LOCAL_MIC: null },
    mode: (m) => fs.writeFileSync(path.join(fake, 'recorder-mode'), m),
    starts: () => (fs.existsSync(path.join(fake, 'recorder.log')) ? fs.readFileSync(path.join(fake, 'recorder.log'), 'utf8') : '').split('\n').filter((l) => l.startsWith('start ')),
    lastRecording: () => fs.readFileSync(path.join(fake, 'last-recording.wav')),
  };
}

export const ui = (s, from = 0) => s.uiRequests.slice(from);
export const statusEvents = (s, from = 0) => ui(s, from).filter((u) => u.method === 'setStatus' && u.statusKey === 'pi-speech');
export const editorEvents = (s, from = 0) => ui(s, from).filter((u) => u.method === 'set_editor_text');
export async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(100); }
  return fn();
}

/** Run interactive pi under tui-test with only the extension, against the fake services. */
export function tui(ctx, rec, extraEnv = {}) {
  const session = 'pi-speech-accept-' + crypto.randomBytes(4).toString('hex');
  const env = { PI_CODING_AGENT_DIR: ctx.agentDir, PI_OFFLINE: '1', NODE_OPTIONS: `--import ${path.join(HERE, 'preload.mjs')}`,
    FAKE_OPENROUTER_URL: ctx.or.url, OPENROUTER_API_KEY: ctx.key, PI_SPEECH_DIR: ctx.speechDir, PI_SPEECH_PLAYER: ctx.player,
    PI_SPEECH_RECORDER: rec.env.PI_SPEECH_RECORDER, FAKE_DIR: rec.fake, ...extraEnv };
  const cwd = fs.mkdtempSync(path.join(ctx.work, 'tui-cwd-'));
  const tt = (...args) => execFileSync('tui-test', args, { encoding: 'utf8', timeout: 30000, env: { ...process.env, TUI_TEST_SESSION: session } });
  tt('run', '--cols', '110', '--rows', '30', '--cwd', cwd, 'env', '-u', 'SSH_CONNECTION', '-u', 'SSH_TTY', '-u', 'PI_SPEECH_LOCAL_MIC',
    ...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'pi', '--no-extensions', '-e', path.join(process.cwd(), 'index.ts'),
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--offline', '--no-mcp', '--no-session',
    '--provider', 'fake', '--model', 'fake-model');
  return {
    text: () => tt('text'),
    type: (t) => tt('type', t),
    key: (k) => tt('key', 'press', k),
    async waitText(pred, ms = 10000) { return until(() => pred(tt('text')), ms); },
    close: () => { try { tt('close'); } catch {} },
  };
}
