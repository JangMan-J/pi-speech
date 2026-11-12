// Live part of proof-5 (Alt+Z dictation): record 4 s from the user's microphone through the bridge client, transcribe it
// with live OpenRouter, and ask the user to confirm the transcript and the real Alt+Z session on this host.
import path from 'node:path';
import { createJiti } from 'jiti';
import { askYes, check, confirmedOrOpen, finish, hasTty, needKey, open, receiverHealth, recordOutcome, ROOT, sleep, TRANSCRIBE_MODEL, transcribe, treeHash, ttyAsk, ttyTell } from './lib.mjs';

const hash = treeHash(['index.ts', 'src/engine', 'src/pi', 'src/bridge', 'receiver/Cargo.toml', 'receiver/Cargo.lock', 'receiver/src', 'protocol', 'e2e/live']);
confirmedOrOpen('proof-5', hash);
if (!hasTty()) open('proof-5 needs an interactive terminal (/dev/tty)');
const key = needKey();
const health = await receiverHealth();
if (!health.ok) open(health.reason);
console.log(`receiver ${health.version} at ${health.url}`);

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { createBridgeAudio } = await jiti.import(path.join(ROOT, 'src', 'bridge', 'index.ts'));
const bridge = createBridgeAudio({ url: health.url, token: health.token });

ttyTell('\nproof-5: your microphone on the receiver machine will record for 4 seconds.');
ttyTell('Say: "pi speech dictation works"');
ttyAsk('Press Enter, then speak right away. ');
const recording = await bridge.input.start();
ttyTell('Recording... speak now (4 s)');
await sleep(4000);
let take;
try {
  take = await recording.stop();
} catch (err) {
  check(false, 'the receiver records and returns the audio', String(err?.message ?? err));
}
let transcript = '';
let heardOk = false;
let altZ = false;
if (take) {
  check(take.format === 'wav' && take.audio.subarray(0, 4).toString() === 'RIFF' && take.audio.length > 16000 * 2 * 2, 'the recording is a WAV of several seconds', [take.format, take.audio.length]);
  try {
    transcript = await transcribe(key, Buffer.from(take.audio), 'wav', TRANSCRIBE_MODEL);
  } catch (err) {
    check(false, 'the recording can be transcribed', String(err?.message ?? err));
  }
  if (transcript) {
    ttyTell(`\nTranscript: ${transcript.trim()}`);
    heardOk = askYes('Does the transcript match what you said ("pi speech dictation works")?');
    check(heardOk, 'the transcript matches what the user said', transcript.slice(0, 200));
    if (heardOk) {
      ttyTell('\nNow, in a real Pi session on this host: press Alt+Z, speak, press Alt+Z again. Over SSH the bridge is chosen automatically; the status line shows speech: bridge.');
      altZ = askYes('Did Alt+Z insert your words into the editor without sending them?');
      check(altZ, 'Alt+Z in a real Pi session inserted the words without sending');
    }
  } else if (take) {
    check(false, 'the transcript is not empty');
  }
}
recordOutcome('proof-5', { answers: { transcriptMatches: heardOk, altZInRealSession: altZ }, receiver: health.version, hash });
finish();
