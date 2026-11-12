// Build and run pi-speech-receiver for acceptance checks, with fake player and recorder programs.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Build receiver/ of the tree in `root` (shared, locked cargo target dir); returns the binary path. */
export function buildReceiver(root = process.cwd()) {
  const cache = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'speech-refactor');
  fs.mkdirSync(cache, { recursive: true });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'recv-bin-'));
  execFileSync('flock', [path.join(cache, 'receiver-build.lock'), 'bash', '-c',
    'export CARGO_TARGET_DIR="$1/receiver-target"; cd "$2/receiver" && cargo build --release --locked --quiet && cp "$CARGO_TARGET_DIR/release/pi-speech-receiver" "$3/"',
    '_', cache, root, out], { stdio: ['ignore', 2, 2] });
  return path.join(out, 'pi-speech-receiver');
}

export async function startReceiver({ bin = process.env.RECEIVER_BIN, fakes = process.env.RECEIVER_FAKES || HERE } = {}) {
  for (const f of ['fake-player', 'fake-recorder']) fs.chmodSync(path.join(fakes, f), 0o755);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recv-run-'));
  const fake = path.join(dir, 'fake');
  fs.mkdirSync(fake);
  const token = 'tok' + crypto.randomBytes(20).toString('hex');
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
  const child = spawn(bin, ['--listen', '127.0.0.1:0', '--token-file', tokenFile], {
    env: { ...process.env, PI_SPEECH_RECEIVER_PLAYER: path.join(fakes, 'fake-player'),
      PI_SPEECH_RECEIVER_RECORDER: path.join(fakes, 'fake-recorder'), FAKE_DIR: fake, XDG_CONFIG_HOME: path.join(dir, 'xdg') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (d) => { output += d; });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('receiver did not start: ' + output)), 15000);
    child.stdout.on('data', (d) => {
      buf += d; output += d;
      const m = /listening \S+:(\d+)/.exec(buf);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`receiver exited ${c}: ${output}`)); });
  });
  const exited = new Promise((r) => child.on('exit', r));
  const read = (who) => { const p = path.join(fake, `${who}.log`); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []; };
  return {
    url: `http://127.0.0.1:${port}`, port, token, fake, dir,
    mode(who, m) { fs.writeFileSync(path.join(fake, `${who}-mode`), m); },
    log: read,
    starts(who) { return read(who).filter((l) => l.startsWith('start ')); },
    lastPlayed() { const p = path.join(fake, 'last-played'); return fs.existsSync(p) ? fs.readFileSync(p) : undefined; },
    output: () => output,
    async stop() { if (child.exitCode === null) { child.kill('SIGTERM'); await exited; } },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
