// Held-out checks of the redesigned surface: migration, menu actions, flags.
import fs from 'node:fs';
import path from 'node:path';
import { check, command, errors, finish, notes, setup } from '../lib/lib.mjs';
import { startReceiver } from '../lib/receiver.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FR = ['bonjour', 'je', 'le', 'la', 'les', 'est', 'de', 'suis', 'voix', "c'est", 'salut'];
const ctx = await setup();
const lastInput = () => ctx.speechRequests().at(-1)?.body?.input;
try {
  // migration of the earlier settings files
  const dir = path.join(ctx.agentDir, 'pi-speech');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ttsModel: 'hexgrad/kokoro-82m', ttsVoice: 'jf_alpha', sttModel: 'openai/whisper-1', toolsEnabled: false }));
  fs.writeFileSync(path.join(dir, 'bridge.json'), '{"route":"local"}\n');
  fs.writeFileSync(path.join(dir, 'language-overrides.json'), JSON.stringify({ 'hexgrad/kokoro-82m': { jf_alpha: 'fr' } }));
  let s = await ctx.pi({ env: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22' } });
  const st = notes(await command(s, '/speech --status'));
  check(/Speech model: hexgrad\/kokoro-82m/.test(st) && /Voice: jf_alpha/.test(st) && /Transcription model: openai\/whisper-1/.test(st) && /Tools: off/.test(st), 'earlier settings are migrated', st);
  check(/Audio: local/.test(st) && !/auto/.test(st.split('\n').find((l) => l.startsWith('Audio:')) ?? ''), 'an earlier explicit local choice is migrated as off', st);
  await command(s, '/speech --sample jf_alpha', 800);
  check((lastInput() ?? '').toLowerCase().split(/[^\p{L}']+/u).some((w) => FR.includes(w)), 'earlier language overrides are migrated', lastInput());
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  check(files.length === 1 && typeof saved.version === 'number', 'after migration only the versioned settings file remains', files);
  await s.close();

  // flags and menu actions
  s = await ctx.pi();
  let n = await command(s, '/speech --');
  check(errors(n).length > 0, '/speech -- with nothing after it is an error', notes(n));
  n = await command(s, '/speech --read-aloud maybe');
  check(errors(n).length > 0, 'an invalid --read-aloud value is an error', notes(n));
  n = await command(s, '/speech --set nonsense 1');
  check(errors(n).length > 0 && /tts-model|voice/.test(notes(n)), 'an unknown setting is an error naming the settings', notes(n));
  await command(s, '/speech --set tts-model hexgrad/kokoro-82m');
  await command(s, '/speech --set voice af_heart');
  await command(s, '/speech replay me later', 600);
  const plays = ctx.playerLog().length;
  const reqs = ctx.speechRequests().length;
  n = await command(s, '/speech --replay', 800);
  check(ctx.playerLog().length === plays + 1 && ctx.speechRequests().length === reqs, '--replay plays the last message again without synthesis', notes(n));
  s.onUi = (req) => (req.method === 'select' ? { value: req.options.find((o) => /^Read-aloud/.test(o)) } : { cancelled: true });
  await command(s, '/speech', 1200);
  check(/Read-aloud: on/.test(notes(await command(s, '/speech --status'))), 'Read-aloud from the menu turns it on');
  s.onUi = () => ({ cancelled: true });
  await s.close();

  // the idle status shows the bridge when Pi runs over SSH
  const rcv = await startReceiver();
  try {
    s = await ctx.pi({ env: { SSH_CONNECTION: '10.0.0.1 1 10.0.0.2 22', PI_SPEECH_BRIDGE_URL: rcv.url, PI_SPEECH_BRIDGE_TOKEN: rcv.token } });
    await command(s, '/speech --bridge auto', 1200);
    const sts = s.uiRequests.filter((u) => u.method === 'setStatus' && u.statusKey === 'pi-speech');
    check(sts.some((e) => /bridge/.test(e.statusText ?? '')), 'the idle status names the bridge', sts.map((e) => e.statusText));
    await s.close();
  } finally {
    await rcv.stop();
    rcv.cleanup();
  }

  // the menu Stop action stops what plays
  const slow = path.join(ctx.work, 'slow-player');
  const log = path.join(ctx.work, 'slow.log');
  fs.writeFileSync(slow, `#!/usr/bin/env bash\necho "start $$" >> "${log}"\ntrap 'echo "term $$" >> "${log}"; exit 143' TERM INT\nsleep 6 & wait $!\n`, { mode: 0o755 });
  s = await ctx.pi({ env: { PI_SPEECH_PLAYER: slow } });
  await command(s, '/speech a message to stop from the menu', 700);
  s.onUi = (req) => (req.method === 'select' ? { value: req.options.find((o) => /^Stop/.test(o)) } : { cancelled: true });
  await command(s, '/speech', 1200);
  check(/^term/m.test(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''), 'Stop from the menu stops the playback');
  await s.close();
} finally {
  await ctx.close();
  ctx.cleanup();
}
finish();
