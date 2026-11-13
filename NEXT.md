# NEXT

Handoff written 2026-11-13 on `decent-spider` (Pi runs here now; the laptop is `agent-jail`, reachable with
`ssh agent-jail`). Read this, then `GLOSSARY.md`, then the pad of the thread you take up (`.pad/<thread>/`,
gitignored, on this machine and on agent-jail). `VECTORS/` is retired: write no new vectors; handoff state lives here.

## Where the code is

- Branch `portable-3` (checked out), draft PR #5 against GitHub `main` (`7b04463`); nothing is released (npm has
  0.1.0). Merging PR #5 is the user's call. The local branch `main` is only the agents' landing branch and equals
  `portable-3`; never push it. **A pushed `v*` tag publishes to npm**: push only with
  `git push origin HEAD:refs/heads/portable-3`, never tags.
- Done before the redesign and confirmed by ear: streaming playback, the receiver's own audio engine, one history
  file per message, Linux/macOS/Windows builds.

## Thread `redesign` (active): `.pad/redesign/plan.md`, slices 01-10

The user's own words on the design are in `.pad/redesign/design-conversation.txt`; the agreed mockups are at the
end of slice 01's file.

Done, on `portable-3`:

- 03 engines (`c830099`..`2e433b0`): `pi-speech-receiver transcribe <model-dir|id> <audio>` with sherpa-onnx 2.0.1
  linked statically. CI green on all three systems at `2e433b0`, transcribing a real recording with Parakeet v3
  int8. Release binary then: Linux 37 MiB, macOS 26 MiB, Windows 20 MiB; no VCRUNTIME140 import on Windows.
- 01 panel layout (`7059efe`..`376f9c7`): SPEAK (Alt+S), LISTEN (Alt+Z), SETTINGS with Hotkeys and Bridge
  connection; names only in the main view. CI green at `376f9c7`; `e2e/run panel` passes (82 checks).
- 04 model downloads (`212ba29`..`9ca0b29`): `models list|download|delete` with JSON lines, resumable, SHA-256
  checked, atomic unpack; `src/engine/local-models.ts` wraps it.
- Hotkey reload (`7af6308`..`599fbb7`): leaving Hotkeys after a changed key closes the panel and reloads Pi
  silently (after `agent_settled` if the agent runs). Pi prints its own "Reloaded ..." line; pi-speech adds none.
- 07 every playback a Stream (`0a6d17a`..`b52ac75`): bundled-binary resolver, adaptive start buffer, replay and
  Reading as Streams; `POST /v1/play`, `PI_SPEECH_PLAYER` and `PI_SPEECH_RECEIVER_PLAYER` gone. `e2e/run all`
  passed; CI green on all three systems at `b52ac75`.
- Mac fixes (`db4b7f3`..`aa5e864`): a real input giving only exact zeros (macOS microphone denied) is an error;
  `models download` documents that it stops when stdin closes; the start-window recorder test uses a sh stand-in.
- 10 platform packages (`71e0da7`..`8b36ac9`): `npm/platforms.mjs` generates `@jangmanj/pi-speech-<os>-<cpu>`
  for linux-x64, linux-arm64, darwin-arm64, darwin-x64, win32-x64; publish.yml builds them on native runners and
  publishes them before the main package. The optionalDependencies are NOT committed in package.json (npm ci
  fails while a version is not on npm); publish stamps them in and checks them. First release needs a version
  bump (0.1.0 is on npm) and `npm run bootstrap:npm` once (5 more trusted publishers, user's 2FA).

Checked on the Mac (`moms-macbook`, macOS 26.6 arm64, 2026-11-13, CI artifact of `b52ac75`), by ear with the user:
speed/pitch bracket right (clips that say their own setting); `models list`, download with interrupt and resume,
`transcribe` word-for-word in 1-2 s; recording from Terminal; inside Pi (xAI): speak, replay, a Reading, stop
mid-sentence (cut at once). Dictation with `/speech --dictate` works (by ear and text); the Alt+Z hotkey does not reach Pi in stock Terminal (below). Mac setup, no sudo: Node in `~/.local/node`, Pi
fork release `next-cda143063b13` in `~/.local/share/pi-fork`, source in `~/Projects/pi-speech` (copied, not a
clone), `~/.pi/agent/settings.json` package `../../Projects/pi-speech`, logins copied from here. Learned there:

- macOS gives a process started over ssh no microphone (TCC, no prompt): record from a Terminal window.
- A Terminal.app first started by `open` over ssh inherits `SSH_CONNECTION`, so Pi in it thinks it runs over SSH:
  start it with `env -i HOME=$HOME USER=$USER PATH=/usr/bin:/bin open -a Terminal x.command`.
- Option+Z in stock Terminal types `Ω`: Alt hotkeys need "Use Option as Meta key" (Settings > Profiles >
  Keyboard). README must say so; maybe detect `Ω`/`ß` in the editor and hint.
- Run one sound test at a time and announce it; never open test windows that overlap (the user was confused once).
- Still to check there: the exact-zero microphone error, with a binary from CI at or after `aa5e864`, over ssh.

In flight (Jing leaves, started 2026-11-13 ~07:15):

- 02 then 05 (read aloud options, source switch), one agent, branch `jing/r30c4fb135bf7`.
- 08 non-panel part: `pi-speech-receiver ssh|pair` and the connection probe in `src/bridge/client.ts`, branch
  `jing/rf1d59dee0297`. The Bridge connection panel rows come after 05 (they share `panel.ts`).

Next: 08's panel rows; 06 needs 05; 09 needs 06 and 08. `transcribe` and `models` in the Windows VM (agent-jail,
`~/vms/win11`) not yet checked.

## Waiting on the user

- Whether a message stopped after its audio fully arrived is still saved (it is now).
- Listening check with Pi on `decent-spider` through the bridge (never done; receiver on the laptop must be 0.3.0).

## Test rigs (on agent-jail)

- `~/Projects/pi-speech/.proto/portable-probe/`: `bracket.py <binary>` (same clip at 1.00/0.75/1.25/1.00x), `capture.sh`,
  `rectest.py`, `measure.py`.
- `~/vms/win11/`: Windows 11 LTSC eval VM. `run.sh install|wav|listen|none`, SSH `-i vm_key -p 22622 pi@127.0.0.1`,
  `kit/`, `analyze.py audio.wav [skip_s]`.
- Models for the real-recording tests are on decent-spider in `~/.cache/pi-speech/models/` (Parakeet v3 int8,
  Whisper small): `PI_SPEECH_TEST_MODELS=~/.cache/pi-speech/models cargo test --release --test transcribe`.

## Rules learned the hard way

- Never let a test reach a real audio device: export `PI_SPEECH_AUDIO_NULL=1` for receiver tests.
- Never put a write and something that depends on it in one parallel tool batch: they race.
- `pgrep -f <pattern>` matches its own shell; check processes with `ps -eo comm`.
- Quote the cost before any paid live check; the user approves. xAI is included in the user's plan.
- On Windows: PowerShell 5.1 pipes text (binary stdin via `cmd /c ... <`); .NET uses its own current directory.
- Agents under Jing: the first worktrees were cut from a stale local `main`; keep local `main` equal to
  `portable-3` before delegating. An agent that asks for a file outside its lease is shut down with nothing
  kept, and two agents were lost to a contact timeout: say in the brief never to ask for more files, and to commit
  often.
- Tests that start a script as a program (shebang) or use Unix absolute paths fail on Windows: skip or gate them.

## Checks

`npm run check`; in `receiver/` with `PI_SPEECH_AUDIO_NULL=1`: `cargo fmt --check`, `cargo clippy --all-targets
-- -D warnings`, `cargo test`; `e2e/run all`.
