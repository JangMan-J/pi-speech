# NEXT

Handoff written 2026-11-13 on `agent-jail` (the laptop), at the end of a long session. Read this, then the latest
vector of the thread you take up (`VECTORS/<thread>/`, newest file), then its pad (`.pad/<thread>/`, gitignored,
on this machine only). Terms: `GLOSSARY.md`.

## Where the code is

- Branch `portable-3` (checked out), draft PR #5 against `main`; CI green on Linux, macOS, Windows at `57aa205`
  (later commits are vectors and notes). GitHub `main` is still `7b04463`; nothing is released (npm has 0.1.0).
  Merging PR #5 is the user's call. Tags: only `v0.1.0`. **A pushed `v*` tag publishes to npm**: push only with
  `git push origin HEAD:refs/heads/portable-3`, never tags.
- Done and confirmed by ear: streaming playback (every provider, Readings as one Stream, the bridge), the
  receiver's own audio engine (no outside audio programs), one history file per message (no ffmpeg), Linux/macOS/
  Windows builds (Windows checked for real in a VM, which found and fixed a missing-C-runtime bug).

## Threads

- `redesign` (active, nothing built): `.pad/redesign/plan.md`, slices 01-10. The user designed the new /speech panel
  in this session; the slice files hold every agreed detail (mockups, wording, Read aloud options, Source switch,
  Bridge connection and Direction, lorem-ipsum length anchor). Start 01 (panel layout), 03 (sherpa-onnx engines;
  full brief in its slice file) and 07 (every playback a Stream) in parallel.
- `portable-package`: slices 01a-03 done; 04-06 moved into `redesign` (07, 08, 10).
- `streaming-playback`: built; open items below.

## Waiting on the user

- MacBook Air being set up with Tailscale: needs its address and username, then copy the macOS CI artifact
  (`gh run download` from the latest `portable-3` run) and run the speed/pitch bracket there.
- Whether a message stopped after its audio fully arrived is still saved (it is now).
- Listening check with Pi on `decent-spider` through the bridge (never done; receiver on the laptop must be 0.3.0).

## Test rigs (on this machine)

- `.proto/portable-probe/`: `bracket.py <binary>` (same clip at 1.00/0.75/1.25/1.00x, announced; by ear and
  measured), `capture.sh`, `rectest.py`, `measure.py` (speed and pitch from a speaker capture).
- `~/vms/win11/`: Windows 11 LTSC eval VM. `run.sh install|wav|listen|none`, SSH `-i vm_key -p 22622 pi@127.0.0.1`,
  `kit/` (vm-bracket.ps1, vm-record.ps1), `analyze.py audio.wav [skip_s]`.

## Rules learned the hard way

- Never let a test reach a real audio device: export `PI_SPEECH_AUDIO_NULL=1` for receiver tests (an unknown value
  now fails instead of falling back; a test once played a loud tone and scared the user).
- Never put a write and something that depends on it in one parallel tool batch: they race (happened four times).
- `pgrep -f <pattern>` matches its own shell; check processes with `ps -eo comm`.
- Quote the cost before any paid live check; the user approves. xAI is included in the user's plan.
- On Windows: PowerShell 5.1 pipes text (binary stdin via `cmd /c ... <`); .NET uses its own current directory.

## Checks

`npm run check`; in `receiver/` with `PI_SPEECH_AUDIO_NULL=1`: `cargo fmt --check`, `cargo clippy --all-targets
-- -D warnings`, `cargo test`; `e2e/run all` (the `panel` suite fails as before: stale, replaced by redesign 01).
