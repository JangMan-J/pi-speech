// A real Pi (RPC) with only this extension for the live proofs: isolated agent dir and HOME, the fake LLM only to
// script tool calls, no fetch rewrite (OpenRouter is the real service), and a player program of the caller's choosing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFakeLlm } from '../lib/fake-llm.mjs';
import { EXT } from '../lib/lib.mjs';
import { startPi, writeAgentDir } from '../lib/pi-rpc.mjs';

export { callTool, command, errors, notes } from '../lib/lib.mjs';

/** `player` is a script body run as `<player> <file>` with $1 the audio file (default: log the path). */
export async function liveSession({ key, env = {}, player } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-speech-live-'));
  const llm = await startFakeLlm();
  const agentDir = path.join(work, 'agent');
  writeAgentDir(agentDir, llm.url);
  const speechDir = path.join(work, 'speech');
  const home = path.join(work, 'home');
  fs.mkdirSync(home);
  const playerPath = path.join(work, 'fake-player');
  fs.writeFileSync(playerPath, `#!/usr/bin/env bash\n${player ?? 'echo "$*" >> "$(dirname "$0")/player.log"; cat > /dev/null'}\nexit 0\n`, { mode: 0o755 });
  const baseEnv = {
    OPENROUTER_API_KEY: key, PI_SPEECH_DIR: speechDir, HOME: home, SSH_CONNECTION: null, SSH_TTY: null,
    PI_SPEECH_BRIDGE_URL: null, PI_SPEECH_BRIDGE_TOKEN: null, PI_SPEECH_BRIDGE_TOKEN_FILE: null,
    PI_SPEECH_STREAM_PLAYER: playerPath, FAKE_OPENROUTER_URL: null, FAKE_FETCH_LOG: null, ...env,
  };
  const sessions = [];
  const ctx = {
    work, key, llm, agentDir, speechDir, home, player: playerPath,
    async pi(extra = {}) {
      const s = await startPi({ extension: EXT, agentDir, llm, env: { ...baseEnv, ...extra }, extraArgs: ['--no-builtin-tools'] });
      sessions.push(s);
      return s;
    },
    playerLog() {
      const p = path.join(work, 'player.log');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
    },
    history() { return fs.existsSync(speechDir) ? fs.readdirSync(speechDir).sort() : []; },
    async close() {
      for (const s of sessions) await s.close().catch(() => {});
      await llm.close();
    },
    cleanup() { fs.rmSync(work, { recursive: true, force: true }); },
  };
  return ctx;
}
