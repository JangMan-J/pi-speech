# NEXT

Written 2026-11-12 on `agent-jail` (the laptop) at the end of the session that built streaming playback.
Live state is in `git log`, `package.json` and the registry; this file holds what those do not say. The
plan and its slices are in `.pad/streaming-playback/` (not committed); the terms are in `GLOSSARY.md`.

## Hosts

`agent-jail` is the laptop: speakers, PulseAudio, `pacat`/`pw-cat`/`ffplay`/`mpv`/`mpg123` installed. All
audio plays there. `decent-spider` is a VPS in a datacenter (no GPU, no sound); Pi there reaches the laptop
through the playback bridge (`pi-speech-receiver` on the laptop, over an SSH port forward). Audio, not text,
crosses the bridge; the Rust receiver stays (the user turned down a headless-Pi server as less robust).

## The goal, and where it stands

**Streaming audio playback** (a Stream, `GLOSSARY.md`): speech starts playing while the rest of it is still
arriving, from every provider whose audio can arrive in pieces, on the laptop and through the bridge.

Built and committed (`bdb4955`..`5f21dce`), `npm run check` and the receiver's fmt/clippy/test green, and
`e2e/run all` passes every suite but `panel`, which fails the same 22 checks it failed before this work:

1. xAI plays as a Stream on the Pi host. **Confirmed by ear** by the user (start and stop).
2. OpenRouter `/audio/speech`: every maker the same way (over time or one late burst); MP3 from models that
   refuse PCM streams through an MP3 player. Checked live on the free `fish-audio/s2.1-pro-free:free`.
3. OpenAI-compatible endpoints: WAV (sizes left open), raw PCM, MP3. Checked against a local server only.
4. Chat audio (`openai/gpt-audio*`): audio plays only once the transcript said after it is still the start
   of the text; a Stray stops playback, saves nothing, no second request. Measured live (one paid
   `gpt-audio-mini` reading, approved): the transcript leads the audio by 0.3 to 1.6 s of speech, so the
   check delays the first audio by 47 ms (first audio at about 1.0 s) and catches a Stray before it is heard.
5. A Reading (texts over 280 characters) plays as one Stream on one player, pieces requested two at a time.
   Checked live with xAI through a logging player (22 s of audio over 1 s, one player). **Confirmed by ear**
   by the user: "played perfectly", no gap between pieces.
6. The bridge: protocol capability `stream` (`protocol/bridge.md`, "Playing a Stream"), the client, and
   receiver 0.2.0. Checked live on the laptop: real receiver, real Pi with `--bridge on`, xAI.

Where a Stream cannot play (no player for it, only `PI_SPEECH_PLAYER` set, a receiver older than 0.2.0),
the clip plays as a file once it has arrived, with one warning; a long text then plays piece by piece as
files, and no piece is asked for twice.

## Open, for the user

- **By ear**: Pi on `decent-spider` through the bridge. The bridge was only run with Pi and the receiver both
  on the laptop; the SSH forward was not in the path.
- **Decide**: a message stopped after its audio has fully arrived (about 1 s for xAI, while it plays for
  ten) is still saved in the history. Kept that way for now, as a Reading already did.
- `GLOSSARY.md` lists unresolved terms (piece/part/chunk, lowercase reading, Stream player, a burst as a
  Stream, vouch).
- The receiver on the laptop must be rebuilt and restarted (0.2.0) for the bridge to stream.

## Other open items (not blocking)

- Dependabot opened four pull requests; the dev-tools group one fails CI.
- `e2e/panel/visible.mjs` still asserts the panel layout from before the redesign and fails.
- The direct endpoints were only tested against a local server; the Fireworks key in Pi is refused by
  Fireworks' audio hosts.

## Checks

- `npm run check` (typecheck, lint, tests), `npm run smoke:pack`, and in `receiver/`: `cargo fmt --check`,
  `cargo clippy --all-targets -- -D warnings`, `cargo test`. CI runs all of them.
- `e2e/run all` drives a real `pi --mode rpc` against fake servers and the real receiver; no cost.
- `e2e/chat-models/live.test.ts` costs about 15 US cents a run; `e2e/README.md` has the command.
