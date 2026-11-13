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

## Resume point (2026-11-13 ~12:55)

`portable-3` at `e837ecd` is pushed; local `main` equals it. Landed: several Pi clients per receiver plus
address pairing (`2036f9e`..`e837ecd`, rebased onto `1c46544`), full gate passed (npm check, cargo fmt/clippy/test
run 3 times, e2e all). Fixed while gating: the shared receiver lingered forever when its state directory was removed
(every ssh test leaked one; it now stops), test scripts are written by `cp` (a sibling test's fork made them "Text
file busy"), e2e panel expects `127.0.0.1:47613 · ssh forward` when nothing is set. Still for the user: by ear,
two Pi sessions speaking at once overlap.

Obligations moved to Director node-6dc34e1c71181838 (the old node's can no longer be updated).

Landed after it (2026-11-13 afternoon), CI green on Linux/macOS/Windows at `7cacec6`:
- protocol/bridge.md "Subcommand notes: models" (`lexicon` field, progress `file`); downloads of the same lexicon
  or model archive take turns under `<name>.lock` / `<dir>.lock` (removed at the end; dev/ino check on Unix).
- Release Linux binaries build on ubuntu-22.04 / 22.04-arm (glibc 2.35; unchecked until a release run). README
  release steps. local-input with a built binary: not reproduced (22/22, 671/671).
- CI fixes: surface local-voices test Unix only; transcribe stand-in strips macOS `wc -c` padding.
- Pairing over the session's own ssh connection (user's decision): on Linux/macOS a first session runs ssh as a
  ControlMaster on a private socket and uploads the token over it, so a new host key or password auth pairs.
  Windows and user-set multiplexing fall back to the pre-session `sftp -b`. See protocol/bridge.md "SSH sessions".
  Checked for real against a scratch user sshd on localhost: an unknown host key answered in the session, the token
  arrived mid-session, paired-hosts written, socket and receiver dirs removed, the second session did not pair.
  Password auth not checkable here (non-root sshd has no PAM).
- User decisions: by-ear overlap check skipped (tests cover it); Windows VM checks wanted (agent-jail was offline
  at 13:05; still to do, including the ControlMaster fallback on Windows).

### Earlier (2026-11-13 ~11:35)

`portable-3` at `1de6eea`. Landed then:

- 09 Direction (`dbb9df6`): DIRECTION rows Play audio on, Record audio on, Run models on; receiver model endpoints
  GET /v1/models, GET /v1/voices, POST /v1/transcribe, POST /v1/speak (one model run at a time, 409 otherwise).
  Full gate passed (npm run check, cargo fmt/clippy/test, every e2e suite).
- Read-aloud Length default Minimum ~15 s (`526d229`, `1de6eea`).

**(Landed at `e837ecd`; history follows.) 2026-11-13 resume: the leaf was lost; the Director rebased its 4 commits onto `0650c15` as branch `mc-rebase`
(worktree `/var/tmp/ps-mc/wt`) and is gating them.** Was: leaf node-c1c58883f416e441 "multi-client-pairing" (branch `jing/ra8608ded0857`, worktree
`/tmp/jing-stage/51bf5b3b33e9/ra8608ded0857`, based on `526d229`). Spec: obligation obl-00ea6c5704619d1b and below.
Its panel e2e may fail "Enter cycles Length" until it is rebased onto `1de6eea`. If it is lost to "lost contact",
its commits stay on its branch: gate and land them as 09 was.

e2e environment on decent-spider:
- `/tmp` is a tmpfs with a per-user quota that is nearly full (`Disk quota exceeded` in e2e). Run e2e with
  `TMPDIR=/var/tmp/<dir>` (main disk). Not under `$HOME`: `~/.agents/skills` makes Pi ask "Trust project folder?"
  for any cwd below it (the TUI suites now pass `--no-approve`, so this only matters for older checkouts).
- e2e/lib/receiver.mjs now builds into one cargo target dir per tree (a shared one handed one tree another tree's
  older receiver binary).

Several Pi clients per receiver plus address pairing (spec, also in obligation obl-00ea6c5704619d1b):
- Streams from different sessions may OVERLAP (the user may simulate a conversation): a client id header per Pi
  process; the receiver replaces only the same client's play, and the OS mixer blends the others.
- /v1/stop with the header stops only the caller's plays. Client stop()/shutdown cancel only their own ids.
- Recording stays single.
- Remote model runs from several clients queue instead of 409.
- One shared receiver per user (lock file and leases).
- Each ssh session forwards 47613 plus a spare port from 47614-47633. Pi tries 47613, then the range, caches the
  one that works and probes again after a failure.
- Make token creation atomic; lock paired-hosts.
- Pairing row = an input box for an address (the ssh forward's, or Tailscale/LAN; the receiver listens there only
  with --listen). Enter probes it; if needed, POST /v1/pair, the receiver prints a 6-digit code on its terminal
  (user's choice: terminal only), the user types it, and the token is returned and saved as bridge.token. Codes
  expire after about 2 min; attempts are limited. README: LAN traffic is unencrypted, Tailscale encrypts.
- Critical tests: one Pi's stop or exit leaves another's audio alone; two clients' Streams overlap and both
  complete; a disconnected Pi finds the next forward; closing the first of two ssh sessions keeps the second's
  audio; queued model runs.
- By ear: two sessions speaking at once overlap.

Lesson: watch leaves while waiting (jing_status of each child, not only mail); a leaf lost to "lost contact" leaves
its commits on its branch. The user is fixing that in Jing systematically.

## Thread `redesign` (active): `.pad/redesign/plan.md`, slices 01-10

The user's own words on the design are in `.pad/redesign/design-conversation.txt`; the agreed mockups are at the
end of slice 01's file.

Landed and pushed on `portable-3` (CI green on Linux, macOS, Windows at `575b27b`; the tip after it is unchecked):

- 01 panel layout; hotkey change reloads Pi silently when leaving Hotkeys.
- 02 Read aloud options (Off, Summary, Thinking, All; Summarized by; Length; Truncate at). The marked summary is
  removed by message_end replacement before it is stored (also true in Pi 1.5.2, checked in its dist).
- 03 engines (`transcribe`), 04 model downloads (`models list|download|delete`).
- 05 Speech source and Transcription source (Provider | Local); local transcription with no network request.
- 06 local speech: `pi-speech-receiver speak <id>` streams s16le PCM at the model rate (format line on stderr;
  Kokoro 24000 Hz, Piper 22050 Hz), sentence by sentence; Speech source Local speaks through it as a Stream.
  Follow-ups: English Piper voices download sherpa-onnx's lexicon-en-us.txt (6,305,773
  bytes, SHA-256 8b67ae54...ef73a) with them; de/fr/es Piper voices removed (sherpa-onnx 2.0 has no espeak-ng and
  no other lexicon exists; easy to undo); local voice picker (settings.localSpeechVoice). Measured on decent-spider
  under load: Kokoro first audio 4.7 s (1.6 s load + ~3 s first sentence), Piper 1.65 s.
- 07 every playback a Stream; `POST /v1/play` and `PI_SPEECH_PLAYER` gone.
- 08 non-panel: `pi-speech-receiver ssh [ssh-args] <host>` (pairs the token with `sftp -b` on first use, runs a
  receiver for the session, `-R 127.0.0.1:47613:...`, passes the exit code) and `pair <host>`; `probeBridge` in
  `src/bridge/client.ts`. Panel rows: Bridge, Remote machine (read-only, from PI_SPEECH_BRIDGE_URL), Pairing
  (`✓ Connected to <addr>:<port> · N ms` / `✗ Re-pair ›` explaining how to pair). README setup uses `ssh`.
- 10 platform packages: `npm/platforms.mjs`; optionalDependencies stamped at publish, not committed. First release
  needs a version bump (0.1.0 is on npm) and `npm run bootstrap:npm` once (5 trusted publishers, user's 2FA).
- Mac fixes: a real input giving only exact zeros is an error (checked on the Mac over ssh with the `575b27b`
  binary); `models download` help says it stops when stdin closes; test stand-ins use `#!${process.execPath}`
  (CI runs tests with node off PATH).
- macOS Option-key hint (user's decision: keep Alt+S/Alt+Z defaults): when the Option character of the bound key
  (Ω, ß) is typed into an empty editor on darwin, a one-time notice (settings.optionKeyHintShown) explains "Use
  Option as Meta key" and its cost to accented letters; the character is never swallowed. Skipped when Pi has no
  `ctx.ui.onTerminalInput`.

Not done (open obligations in Jing, also here):

- Local speech loose ends: protocol/bridge.md should document `models list`'s `lexicon` field and progress `file`;
  `src/engine/surface.ts` RPC menus "Sample a voice…"/"Voice language…" still list provider voices under Local.
- 08 pairing limits (for the user): `sftp -b` forces BatchMode, so a new host or password-only auth cannot pair
  (warning; connect once with plain ssh first, or pair over the session's ControlMaster). A second concurrent
  session's `-R 47613` fails with only an ssh warning: report it? Windows: SIGTERM not forwarded to ssh, untested.
- Slice 10: local-input.test.ts reportedly fails 3 tests when receiver/target/release holds a built binary
  (unreproduced since the stand-in fixes; check); Linux release binaries built on ubuntu-latest (glibc 2.39), consider
  ubuntu-22.04 for reach.
- Windows VM (agent-jail `~/vms/win11`): `transcribe`, `models`, `speak`, `ssh` never checked there.
- Listening check with Pi on `decent-spider` through the bridge with `pi-speech-receiver ssh` from the laptop.

## The Mac (`moms-macbook`, macOS 26.6 arm64; the user's mother's; user sits at it for sound tests)

Setup, no sudo: Node v26.13.1 in `~/.local/node` (PATH via `~/.zshenv`), Pi fork release `next-cda143063b13` in
`~/.local/share/pi-fork` with `~/.local/bin/pi`, source copied (rsync, not a clone) to `~/Projects/pi-speech` at
`5b2102e` (rsync again before testing), CI binary (`575b27b`) in `receiver/target/release` and `~/bracket/`,
`~/.pi/agent/settings.json` package `../../Projects/pi-speech`, logins copied from here (user's choice). Parakeet
v3 int8 downloaded there. pi-speech settings there: xAI speech (eve) and transcription; optionKeyHintShown was
reset (absent) so the hint can be tried again. Test scripts in `~/bracket/`: `pi-drive.mjs` (RPC commands with
pauses), `live.mjs <mode> <question>` (read-aloud check with OpenRouter DeepSeek chat, prints timings),
`ptytest.py` (Pi in a pty, sends Ω), `*.command` (open in Terminal).

Checked by ear with the user: speed/pitch bracket; models download with interrupt/resume; transcribe;
recording from Terminal; in Pi (xAI): speak, replay, a Reading, stop mid-sentence (cut at once, clean),
dictation with `/speech --dictate`; Read aloud Summary with the same model and Summarized by DeepSeek (paid
check approved, under $0.02): only the summary is read, absent from the transcript and the session file. Timing:
reply done 5.4 s, summary speech starts 14.2 s (extra request + xAI), the Abridged summary lasted ~30 s (user did
not answer whether Minimum ~15 s should be the default).

Mac testing ended 2026-11-13 (user: the primitives are confirmed; no more Mac tests). Never checked on a real Mac:
the Option+Z hint by a real keypress (the one try suspended Pi, probably Ctrl+Z; a pty test sending Ω shows the
notice and keeps Ω), local speech (Kokoro, Piper) by ear, local transcription inside Pi. The logins copied to the Mac are in a separate account the user made for this work; nothing to remove.

Learned there: macOS gives a process started over ssh no microphone (TCC); a Terminal.app first started by `open`
over ssh inherits `SSH_CONNECTION` (start it with `env -i ... open`); quitting Terminal with a busy window stalls
on a dialog (kill the processes instead); stock Terminal sends Ω/ß for Option+Z/S.

## Waiting on the user

- Merging PR #5; the first release (version bump, bootstrap:npm 2FA).

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
