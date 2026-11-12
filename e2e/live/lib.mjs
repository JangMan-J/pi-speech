// Helpers for the live parts of scripts/proof-*: key lookup, receiver access, terminal questions, confirmations.
// Exit codes follow scripts/check: 0 passes, 78 is OPEN (a live requirement is missing), anything else fails.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const OPEN = 78;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Stop with exit 78 and say why. */
export function open(reason) {
  console.log(`OPEN ${reason}`);
  process.exit(OPEN);
}

let failures = 0;
export function check(cond, name, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || detail === undefined ? '' : `  [${typeof detail === 'string' ? detail : JSON.stringify(detail)}]`.slice(0, 900)}`);
  if (!cond) failures++;
}
export const failureCount = () => failures;
export function finish() {
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
}

/** OpenRouter key: OPENROUTER_API_KEY, else Pi's login on this host. Never printed or written anywhere. */
export function openrouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  for (const sub of ['print-api-key', 'print-bearer-token']) {
    const r = spawnSync('pi', ['auth', sub, '--provider', 'openrouter'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    const key = r.status === 0 ? r.stdout.trim() : '';
    if (key) return key;
  }
  return undefined;
}
export function needKey() {
  const key = openrouterKey();
  if (!key) open('no OpenRouter key: set OPENROUTER_API_KEY or log in to OpenRouter in Pi (pi auth print-api-key --provider openrouter)');
  return key;
}

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';

/** Synthesize with live OpenRouter; returns a WAV (PCM wrapped) or MP3 buffer. */
export async function synthesize(key, text, model, voice) {
  const res = await fetch(`${OPENROUTER_API}/audio/speech`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: text, voice, response_format: 'pcm' }),
  });
  if (!res.ok) throw new Error(`speech HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || '';
  const rate = Number(/rate=(\d+)/.exec(type)?.[1] ?? 24000);
  const channels = Number(/channels=(\d+)/.exec(type)?.[1] ?? 1);
  return wavFromPcm(pcm, rate, channels);
}

export function wavFromPcm(pcm, rate, channels = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Transcribe with live OpenRouter (no language hint unless given). */
export async function transcribe(key, audio, format, model, language) {
  const res = await fetch(`${OPENROUTER_API}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input_audio: { data: audio.toString('base64'), format }, ...(language ? { language } : {}) }),
  });
  if (!res.ok) throw new Error(`transcription HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return typeof data.text === 'string' ? data.text : '';
}

export const TRANSCRIBE_MODEL = process.env.PI_SPEECH_PROOF_STT_MODEL || 'openai/whisper-large-v3-turbo';
export const TTS_MODEL = 'hexgrad/kokoro-82m';

export function ffprobeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const d = Number.parseFloat(r.stdout);
  return r.status === 0 && Number.isFinite(d) ? d : 0;
}

// ── receiver ────────────────────────────────────────────────────────────────────────────────────

export const bridgeUrl = () => (process.env.PI_SPEECH_BRIDGE_URL || 'http://127.0.0.1:47613').replace(/\/$/, '');

/** The bridge token from PI_SPEECH_BRIDGE_TOKEN, PI_SPEECH_BRIDGE_TOKEN_FILE, or ~/.config/pi-speech/bridge.token. */
export function bridgeToken() {
  if (process.env.PI_SPEECH_BRIDGE_TOKEN) return process.env.PI_SPEECH_BRIDGE_TOKEN.trim();
  const file = process.env.PI_SPEECH_BRIDGE_TOKEN_FILE || path.join(os.homedir(), '.config', 'pi-speech', 'bridge.token');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return undefined; }
}

/** Asks /v1/health; returns { ok, version, url, token } or { ok: false, reason }. */
export async function receiverHealth() {
  const url = bridgeUrl();
  const token = bridgeToken();
  if (!token) return { ok: false, reason: 'no bridge token (set PI_SPEECH_BRIDGE_TOKEN, PI_SPEECH_BRIDGE_TOKEN_FILE, or create ~/.config/pi-speech/bridge.token)' };
  try {
    const res = await fetch(`${url}/v1/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (res.status === 401) return { ok: false, reason: `the receiver at ${url} refused the token (401)` };
    if (!res.ok) return { ok: false, reason: `the receiver at ${url} answered ${res.status}` };
    const j = await res.json();
    if (j?.name !== 'pi-speech-receiver') return { ok: false, reason: `${url} is not a pi-speech-receiver` };
    return { ok: true, version: String(j.version), url, token };
  } catch (err) {
    return { ok: false, reason: `the receiver at ${url} is not reachable (${err?.cause?.code ?? err?.message ?? err})` };
  }
}

// ── terminal ────────────────────────────────────────────────────────────────────────────────────

export function hasTty() {
  try { fs.closeSync(fs.openSync('/dev/tty', 'r+')); return true; } catch { return false; }
}

/** Show `text` on /dev/tty and read one line from it. */
export function ttyAsk(text) {
  const fd = fs.openSync('/dev/tty', 'r+');
  try {
    fs.writeSync(fd, `${text}`);
    const buf = Buffer.alloc(1);
    let line = '';
    for (;;) {
      const n = fs.readSync(fd, buf, 0, 1, null);
      if (n === 0 || buf[0] === 10) break;
      line += String.fromCharCode(buf[0]);
    }
    return line.trim();
  } finally { fs.closeSync(fd); }
}
export function ttyTell(text) {
  const fd = fs.openSync('/dev/tty', 'r+');
  try { fs.writeSync(fd, `${text}\n`); } finally { fs.closeSync(fd); }
}
export const askYes = (q) => ttyAsk(`${q} [y/N] `).toLowerCase() === 'y';

// ── confirmations ───────────────────────────────────────────────────────────────────────────────

export const confirmationFile = (proof) =>
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'pi-speech', 'proofs', `${proof}.json`);

/** SHA-256 over the contents of the tracked files (git ls-files) under `paths`, in name order. */
export function treeHash(paths) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...paths], { cwd: ROOT, encoding: 'utf8' });
  const files = r.stdout.split('\0').filter(Boolean).sort();
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(f); h.update('\0');
    try { h.update(fs.readFileSync(path.join(ROOT, f))); } catch {}
    h.update('\0');
  }
  return h.digest('hex');
}

export function saveConfirmation(proof, data) {
  const file = confirmationFile(proof);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...data }, null, 2)}\n`);
  return file;
}

/** A saved confirmation whose hash still matches, or undefined. */
export function loadConfirmation(proof, hash) {
  try {
    const c = JSON.parse(fs.readFileSync(confirmationFile(proof), 'utf8'));
    return c.hash === hash && c.passed === true ? c : undefined;
  } catch { return undefined; }
}

/**
 * A proof that needs the user's answers runs them only in a terminal (a /dev/tty and a terminal on stdout, or
 * PI_SPEECH_PROOF_INTERACTIVE=1 with a /dev/tty). Otherwise it passes on a saved confirmation whose hash still
 * matches, or exits 78 asking for a run in a terminal.
 */
export const interactive = () => hasTty() && (Boolean(process.stdout.isTTY) || process.env.PI_SPEECH_PROOF_INTERACTIVE === '1');

export function confirmedOrOpen(proof, hash) {
  if (interactive()) return;
  const c = loadConfirmation(proof, hash);
  if (c) {
    console.log(`PASS live part confirmed on ${c.time} (receiver ${c.receiver ?? 'unknown'}); the files it depends on are unchanged`);
    process.exit(0);
  }
  const stale = fs.existsSync(confirmationFile(proof));
  open(`${proof} needs your answers${stale ? ' (the saved confirmation is out of date: the files it depends on changed, or it failed)' : ''}: run scripts/${proof} in a terminal`);
}

// ── a recording proxy in front of the receiver ──────────────────────────────────────────────────

/** Forwards every request to the receiver unchanged and remembers each `POST /v1/play` (its id and kind). */
export async function startRecordingProxy(upstream) {
  const plays = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const headers = { ...req.headers };
    for (const h of ['host', 'connection', 'content-length', 'transfer-encoding']) delete headers[h];
    try {
      const up = await fetch(upstream + req.url, { method: req.method, headers, body: body.length ? body : undefined });
      const out = Buffer.from(await up.arrayBuffer());
      if (req.method === 'POST' && req.url === '/v1/play' && up.status === 202) {
        try { plays.push({ id: JSON.parse(out.toString()).id, kind: req.headers['x-pi-speech-kind'] ?? 'message' }); } catch {}
      }
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
      res.end(out);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, plays, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}

/** Wait until the receiver reports playback `id` settled; returns its state ("completed", "failed", ...). */
export async function waitPlayback(h, id, seconds = 60) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const res = await fetch(`${h.url}/v1/play/${id}?wait=10`, { headers: { Authorization: `Bearer ${h.token}` }, signal: AbortSignal.timeout(20000) });
    const j = await res.json();
    if (j.state !== 'playing' || Date.now() > end) return j;
  }
}

/** Record the outcome of an interactive proof: a clean run saves the confirmation, anything else removes a stale one. */
export function recordOutcome(proof, { answers, receiver, hash }) {
  if (failures === 0) {
    console.log(`confirmation saved: ${saveConfirmation(proof, { passed: true, answers, receiver, hash })}`);
  } else {
    fs.rmSync(confirmationFile(proof), { force: true });
  }
}
