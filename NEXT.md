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
- 04 model downloads (`212ba29`..`9ca0b29`, then a test fix): `models list|download|delete` with JSON lines,
  resumable, SHA-256 checked, atomic unpack; `src/engine/local-models.ts` wraps it. Linux and macOS green in CI at
  `9ca0b29`; Windows failed there on two tests only (a Unix path in a Linux-rule test, a shebang stand-in binary),
  fixed in the commit that carries this file. **First action: check that commit's CI run is green on Windows**
  (`gh run list --branch portable-3 --limit 1`).

In flight:
- 07 every playback a Stream: branch `jing/r92335acc521c`, worktree `/tmp/jing-stage/51bf5b3b33e9/r92335acc521c`
  (in /tmp: gone after a reboot, the branch stays). Tip `45a05fd` at the time of writing, 7 commits: binary
  resolver (`src/engine/binary.ts`), adaptive start buffer, replay and Reading as Streams, `POST /v1/play` and
  `PI_SPEECH_PLAYER` removed. The agent was still updating e2e suites, with uncommitted edits in the worktree,
  some in files it does not own (`e2e/panel`, `e2e/redesign`, `e2e/samples`, `e2e/xai`): review those against
  slice 01's panel suite. Its uncommitted edits at wrap-up are kept as branch `wip/07-stream-only-snapshot` (a stash commit on the tip). It had not reported. To finish: rebase the branch on `portable-3` (01 and 04 landed
  since; expect conflicts in `test/engine/chat-models.test.ts` and `endpoints.test.ts`, each a one-line change
  here), run every check below and `e2e/run all`, read the diff, then land and push.

Next, once 07 is in: 02 (read aloud options) and 05 (source switch) both touch `src/engine/panel.ts`, so give
them to one agent in order or split the files first; 08 (bridge connection) and 10 (platform packages) are
unblocked by 07; 06 needs 05; 09 needs 06 and 08. Add a CI smoke step `pi-speech-receiver models list` (suggested
by the 04 agent).

Not yet checked on real machines: `transcribe` and `models` in the Windows VM (agent-jail, `~/vms/win11`) and on
the Mac.

## Waiting on the user

- Changing the Speak or Dictate key, user's answer (2026-11-13): acceptable, but better: when the user leaves the
  Hotkeys screen after changing a key, the /speech command handler calls `await ctx.reload(); return;` (Pi's
  extension API, docs/extensions.md "ctx.reload()"), silently, with no message. Drop the `→ Alt+D after /reload`
  hint. Pi can't reload while the agent is running: in that case record the request and run it from
  `agent_settled`. Not built yet.
- The Mac is `moms-macbook` on Tailscale (`ssh moms-macbook`, user and key in `~/.ssh/config`). It was offline
  each time it was tried (04:20-05:30); when it is up, download the macOS artifact of the latest `portable-3` run
  (`gh run download`), copy it over and run the speed/pitch bracket there.
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
