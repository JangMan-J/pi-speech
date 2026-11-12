# End-to-end suites and proofs

`e2e/` holds the acceptance suites for pi-speech. They drive a real `pi --mode rpc` (and, for dictation, the real
TUI through `tui-test`) with only this extension loaded, against fake LLM and fake OpenRouter servers, and the real
`pi-speech-receiver` with fake player and recorder programs. The default `npm test` does not run them.

## Running the suites

```
e2e/run <suite>...        # from anywhere; it changes into the repository root
e2e/run all
```

Suites: `core`, `voice-language`, `receiver`, `receiver-hardening`, `samples`, `read-aloud`, `bridge`,
`dictation`, `bridge-dictation`. Each is its visible and held-out checks together. The runner installs node modules
(`npm ci`) when `node_modules/` is missing, builds the receiver when a suite needs it, prints every PASS/FAIL line, then
one `SUITE <name>: PASS|FAIL (n passed, m failed)` line per suite. It exits 0 only when every suite passed.

Needs on `PATH`: `node` (>= 20), `pi`, `cargo`, `flock`, `python3` (receiver suites), `tui-test` (dictation).
The suites run in a clean environment: the runner removes `PI_SPEECH_*`, `OPENROUTER_API_KEY`, `SSH_CONNECTION`, and
`SSH_TTY` first. The receiver is built into `${XDG_CACHE_HOME:-~/.cache}/speech-refactor/receiver-target`.

Layout: `lib/` holds the shared helpers (fake servers, `pi-rpc.mjs`, `receiver.mjs`, `dict.mjs`, fake player and
recorder, the model catalog); `<suite>/` holds the checks. `bridge-dictation` is the integration check for Alt+Z
over the bridge: with the real receiver and its fake recorder, `/speech dictate` records on the receiver, inserts the
transcript, and never starts the local recorder. Vitest-based suites (`voice-language`, `bridge`) run through
`e2e/vitest.config.ts`: `npx vitest run --root . --config e2e/vitest.config.ts e2e/<suite>/`.

## Live measurements

`e2e/chat-models/live.test.ts` asks every chat model on OpenRouter that takes or gives audio to transcribe and
to read, and reports what each did. No suite and no proof runs it: it costs about 15 US cents, takes a few
minutes, and its findings are about the models, not about this code.

```
PI_SPEECH_LIVE=1 npx vitest run --root . --config e2e/vitest.config.ts e2e/chat-models/
```

The key is `OPENROUTER_API_KEY`, else Pi's OpenRouter login. `PI_SPEECH_LIVE_OUT=<path>` also writes every
reply to `<path>.stt.json` and `<path>.tts.json`. Run it again before changing the prompts in
`src/engine/chat-audio.ts`; the numbers there, in `src/engine/pricing.ts` and in the README come from it.

## Proofs

```
scripts/proof-1   standalone speech            core, voice-language          + live OpenRouter
scripts/proof-2   remote-to-local playback     receiver, receiver-hardening, bridge   + live receiver, your ears
scripts/proof-3   voice-language samples       voice-language, samples       + live OpenRouter
scripts/proof-4   playback control, history    read-aloud, core, samples     (automated only)
scripts/proof-5   Alt+Z dictation              dictation, bridge-dictation   + live receiver, your microphone
scripts/check     runs all of them
```

Exit codes: `0` passes, `78` is OPEN (a live requirement is missing; the reason is printed), anything else fails.
Each proof runs its automated suites first; a failure there is a FAIL. The live parts use an isolated Pi agent
directory and HOME, only this extension, and the fake LLM only to script tool calls. They talk to the real OpenRouter.
A full live run costs well under one US cent (Kokoro speech, `openai/whisper-large-v3-turbo` transcription).

### Environment

| Variable | Meaning |
| --- | --- |
| `OPENROUTER_API_KEY` | OpenRouter key. Otherwise taken from Pi's OpenRouter login (`pi auth print-api-key` / `print-bearer-token --provider openrouter`). Never printed or stored. No key: proofs 1, 2, 3, 5 exit 78. |
| `PI_SPEECH_BRIDGE_URL` | Receiver URL, default `http://127.0.0.1:47613`. |
| `PI_SPEECH_BRIDGE_TOKEN`, `PI_SPEECH_BRIDGE_TOKEN_FILE` | The bridge token, or a file holding it. Default file `~/.config/pi-speech/bridge.token`. |
| `PI_SPEECH_PROOF_STT_MODEL` | Transcription model for the live proofs (default `openai/whisper-large-v3-turbo`). |
| `PI_SPEECH_PROOF_INTERACTIVE=1` | Ask the questions even when stdout is not a terminal (still needs `/dev/tty`). |
| `XDG_STATE_HOME` | Where confirmations are kept (default `~/.local/state`). |
| `XDG_CACHE_HOME` | Where the receiver build is cached (default `~/.cache`). |

### Proofs that need you (2 and 5)

Proof 2 needs a reachable receiver and a terminal (`/dev/tty`). Through the extension with `/speech bridge on` it
synthesizes one message with live OpenRouter and plays one Japanese Kokoro voice sample, waits until the receiver
reports each playback `completed`, then asks whether you heard both on your machine. Only `y` passes.

Proof 5 needs the same. It tells you to say "pi speech dictation works", records 4 s from your microphone through
`createBridgeAudio(...).input`, transcribes it with live OpenRouter, shows the transcript and asks whether it matches,
then asks whether Alt+Z in a real Pi session on this host (with `/speech bridge on`) inserted your words into the
editor without sending them. Only `y` to both passes.

With the receiver unreachable, or no terminal, they exit 78 and say why.

A proof that asked you writes `${XDG_STATE_HOME:-~/.local/state}/pi-speech/proofs/<proof>.json`: the time, your
answers, the receiver version, and a hash of the tracked files the proof depends on. A later run without a terminal
(for example `scripts/check`) passes the live part while that file exists and the hash still matches; after any
change to those files it exits 78 asking you to run the proof in a terminal. A run you answer `n` removes the file.

## The receiver on your machine

The receiver runs on your Linux computer (with the speakers and microphone), and Pi runs on `decent-spider`.

1. Build it: `cargo build --release` in `receiver/` (binary `receiver/target/release/pi-speech-receiver`), or copy
   that binary from another machine. It plays through the first available of `pw-play`, `paplay`, `mpv`, `ffplay`
   and records with `pw-record`, `parecord`, or `arecord`.
2. Start it: `pi-speech-receiver` (listens on `127.0.0.1:47613`). With no `--token-file` it creates
   `~/.config/pi-speech/receiver.token` (mode 0600) on first start. Use `--token-file PATH` for another file.
3. Forward its port to the Pi host from your machine:

   ```
   ssh -R 127.0.0.1:47613:127.0.0.1:47613 decent-spider
   ```

   Keep that session open; Pi then reaches the receiver at `http://127.0.0.1:47613` on decent-spider.
4. Copy the token to decent-spider, where the extension and the proofs read `~/.config/pi-speech/bridge.token`:

   ```
   ssh decent-spider 'mkdir -p ~/.config/pi-speech && chmod 700 ~/.config/pi-speech'
   scp ~/.config/pi-speech/receiver.token decent-spider:.config/pi-speech/bridge.token
   ssh decent-spider 'chmod 600 ~/.config/pi-speech/bridge.token'
   ```

   Or set `PI_SPEECH_BRIDGE_TOKEN` / `PI_SPEECH_BRIDGE_TOKEN_FILE` on decent-spider.
5. On decent-spider, in a terminal: `scripts/proof-2` and `scripts/proof-5`.

## The fixture

`fixtures/quick-brown-fox.wav` is "The quick brown fox jumps over the lazy dog." spoken by Kokoro (`hexgrad/kokoro-82m`,
voice `af_heart`) through live OpenRouter. `node e2e/fixtures/make-quick-brown-fox.mjs` regenerates it (one tiny request).
