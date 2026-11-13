// Shared setup for the pi-speech acceptance checks: fake services, isolated dirs, a fake Stream player.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeLlm } from './fake-llm.mjs';
import { startFakeOpenRouter } from './fake-openrouter.mjs';
import { startFakeXai } from './fake-xai.mjs';
import { startPi, writeAgentDir } from './pi-rpc.mjs';

export const ROOT = process.cwd();
export const EXT = path.join(ROOT, 'index.ts');
let failures = 0;
export function check(cond, name, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond || detail === undefined ? '' : `  [${typeof detail === 'string' ? detail : JSON.stringify(detail)}]`.slice(0, 900)}`);
  if (!cond) failures++;
}
export function finish() {
  console.log(failures ? `${failures} failed` : 'all passed');
  process.exit(failures ? 1 : 0);
}

export function wavBytes(seconds = 0.5, rate = 16000) {
  const n = Math.floor(seconds * rate), pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 300 * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
export function isWav(buf) {
  return buf.length > 44 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WAVE';
}

// xai: false (no xAI login), true (login ready, fake xAI service), or { voices, transcript } for the fake.
export async function setup({ catalog, mp3OnlyModels, env = {}, xai = false, msPerChar = 0, mismatchAt = 0 } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-speech-accept-'));
  const key = 'sk-or-v1-accept-' + crypto.randomBytes(12).toString('hex');
  // Every playback is a Stream: the fake player (PI_SPEECH_STREAM_PLAYER) logs where it keeps what it was fed,
  // and its arguments (`s16le <rate> <channels>`, `mp3` or `wav`), then keeps the Stream's bytes there.
  const player = path.join(work, 'fake-player');
  fs.mkdirSync(path.join(work, 'played'));
  fs.writeFileSync(player, `#!/usr/bin/env bash\nf="${work}/played/$(date +%s%N)-$$"\necho "$f" >> "${work}/player.log"\necho "$(date +%s%3N) $f" >> "${work}/player.times"\necho "$*" >> "${work}/player.args"\ncat > "$f"\nexit 0\n`, { mode: 0o755 });
  const or = await startFakeOpenRouter({ catalog, mp3OnlyModels, msPerChar, mismatchAt });
  const llm = await startFakeLlm();
  const agentDir = path.join(work, 'agent');
  writeAgentDir(agentDir, llm.url);
  const xaiKey = 'xai-accept-' + crypto.randomBytes(12).toString('hex');
  const fakeXai = await startFakeXai({ key: xaiKey, ...(typeof xai === 'object' ? xai : {}) });
  if (xai) fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ xai: { type: 'api_key', key: xaiKey } }));
  const speechDir = path.join(work, 'speech');
  const home = path.join(work, 'home');
  fs.mkdirSync(home);
  const fetchLog = path.join(work, 'fetch.log');
  const baseEnv = { FAKE_XAI_URL: fakeXai.url, OPENROUTER_API_KEY: key, PI_SPEECH_DIR: speechDir, PI_SPEECH_STREAM_PLAYER: player, PI_SPEECH_AUDIO_NULL: '1', HOME: home, SSH_CONNECTION: null, SSH_TTY: null, PI_SPEECH_LOCAL_MIC: null, ...env };
  const sessions = [];
  const ctx = {
    work, key, xaiKey, xai: fakeXai, player, or, llm, agentDir, speechDir, home, fetchLog,
    async pi({ env: e = {}, session = false, openrouterUrl } = {}) {
      const s = await startPi({ extension: EXT, agentDir, llm, openrouterUrl: openrouterUrl ?? or.url, env: { ...baseEnv, ...e },
        extraArgs: ['--no-builtin-tools'], fetchLog, session });
      sessions.push(s);
      return s;
    },
    playerLog() {
      const p = path.join(work, 'player.log');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
    },
    /** The arguments of every playback, in order: `s16le 24000 1`, `mp3`, `wav`. */
    playerArgs() {
      const p = path.join(work, 'player.args');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
    },
    /** The bytes the i-th playback was fed (negative: from the end). */
    played(i = -1) {
      const f = this.playerLog().at(i);
      return f && fs.existsSync(f) ? fs.readFileSync(f) : undefined;
    },
    /** The audio a saved message is played with: a WAV's samples (after its 44-byte header), an MP3 whole. */
    savedAudio(name, dir = speechDir) {
      const b = fs.readFileSync(path.isAbsolute(name) ? name : path.join(dir, name));
      return name.endsWith('.wav') ? b.subarray(44) : b;
    },
    /** Start times (ms since the epoch) of every playback, in order. */
    playerTimes() {
      const p = path.join(work, 'player.times');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => Number(l.split(' ')[0])) : [];
    },
    history(dir = speechDir) {
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    },
    speechRequests() { return or.requests.filter((r) => r.path.startsWith('/api/v1/audio/speech')); },
    async close() {
      for (const s of sessions) await s.close().catch(() => {});
      await or.close(); await llm.close(); await fakeXai.close();
    },
    cleanup() { fs.rmSync(work, { recursive: true, force: true }); },
  };
  return ctx;
}

// Run an extension command and collect the notifications it produced.
export async function command(s, text, settleMs = 400) {
  const from = s.uiRequests.length;
  await s.prompt(text, 60000);
  await new Promise((r) => setTimeout(r, settleMs));
  return s.uiRequests.slice(from).filter((u) => u.method === 'notify');
}
export const notes = (list) => list.map((n) => n.message ?? '').join('\n');
export const errors = (list) => list.filter((n) => n.notifyType === 'error');

// Ask the fake LLM to call one tool, then return the tool result text the LLM saw next.
export async function callTool(ctx, s, name, args) {
  const before = ctx.llm.requests.length;
  ctx.llm.script([{ toolCalls: [{ name, arguments: args }] }, { text: 'done' }]);
  await s.prompt(`please run ${name}`, 90000);
  const later = ctx.llm.requests.slice(before);
  const last = later[later.length - 1];
  const toolMsgs = (last?.messages ?? []).filter((m) => m.role === 'tool');
  const msg = toolMsgs[toolMsgs.length - 1];
  const content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content ?? '');
  return { content, requests: later };
}
