// Live part of proof-2 (remote-to-local playback): through the extension with /speech --bridge on, one live message and
// one non-English voice sample play on the user's machine; the receiver must report each completed, and the user confirms.
import { askYes, check, confirmedOrOpen, finish, hasTty, needKey, open, receiverHealth, recordOutcome, sleep, startRecordingProxy, treeHash, ttyTell, waitPlayback } from './lib.mjs';
import { command, errors, liveSession, notes } from './session.mjs';

const hash = treeHash(['index.ts', 'src/engine', 'src/bridge', 'src/voice-language', 'receiver/Cargo.toml', 'receiver/Cargo.lock', 'receiver/src', 'protocol', 'e2e/live']);
confirmedOrOpen('proof-2', hash);
if (!hasTty()) open('proof-2 needs an interactive terminal (/dev/tty)');
const key = needKey();
const health = await receiverHealth();
if (!health.ok) open(health.reason);
console.log(`receiver ${health.version} at ${health.url}`);

const proxy = await startRecordingProxy(health.url);
const ctx = await liveSession({ key, env: { PI_SPEECH_BRIDGE_URL: proxy.url, PI_SPEECH_BRIDGE_TOKEN: health.token } });
let answer;
try {
  const s = await ctx.pi();
  const on = await command(s, '/speech --bridge on');
  check(errors(on).length === 0 && /Audio: bridge/.test(notes(await command(s, '/speech --status'))), '/speech --bridge on selects the bridge', notes(on));
  const set = [await command(s, '/speech --set tts-model hexgrad/kokoro-82m'), await command(s, '/speech --set voice af_heart')].flat();
  check(errors(set).length === 0, 'a cheap speech model and voice are set', notes(set));

  ttyTell('\nproof-2: listen on your machine. First an English message, then a Japanese voice sample.');
  const say = await command(s, '/speech This is the pi speech bridge proof. Can you hear this message?', 300);
  check(errors(say).length === 0, '/speech succeeds', notes(say));
  for (let i = 0; i < 100 && proxy.plays.length < 1; i++) await sleep(100);
  check(proxy.plays.length === 1 && proxy.plays[0].kind === 'message', 'the message was sent to the receiver to play', proxy.plays);
  const first = proxy.plays[0] && (await waitPlayback(health, proxy.plays[0].id));
  check(first?.state === 'completed', 'the receiver reports the message completed', first);

  const sample = await command(s, '/speech --sample jf_alpha', 300);
  check(errors(sample).length === 0, '/speech --sample jf_alpha succeeds', notes(sample));
  for (let i = 0; i < 100 && proxy.plays.length < 2; i++) await sleep(100);
  check(proxy.plays.length === 2 && proxy.plays[1].kind === 'sample', 'the Japanese sample was sent to the receiver to play', proxy.plays);
  const second = proxy.plays[1] && (await waitPlayback(health, proxy.plays[1].id));
  check(second?.state === 'completed', 'the receiver reports the sample completed', second);
  check(ctx.playerLog().length === 0, 'nothing played on the Pi host', ctx.playerLog());

  answer = askYes('Did you hear both the English message and the Japanese sample on your machine?');
  check(answer, 'the user heard both on their machine');
} finally {
  await ctx.close();
  ctx.cleanup();
  await proxy.close();
}
recordOutcome('proof-2', { answers: { heardMessageAndSample: answer === true }, receiver: health.version, hash });
finish();
