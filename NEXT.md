# NEXT

Written 2026-11-12 at the end of a session on `decent-spider` (Pi over SSH), for whoever picks this up on
the user's laptop. Live state is in `git log`, `package.json` and the registry; this file holds what those
do not say.

## The goal

**Streaming audio playback.** When pi-speech speaks (read-aloud, `/speech <text>`, `speech_synthesize`),
sound starts as soon as the provider has produced the first audio and keeps playing while the rest arrives.
Today nothing plays until a whole clip (or the whole first piece of a long text) has been generated,
downloaded and handed to a player as a file.

The user's words: "what I want, primarily, is streaming audio playback", and "I have an xAI subscription,
if that'll do it". It was their answer to an offer of realtime dictation, so dictation over a realtime
protocol is not the goal.

How the user wants it handled:

- Build the thing asked for. Earlier in the session a request for the unsupported endpoint types was
  answered with something adjacent (direct vendor endpoints), and they had to ask whether the answer was no.
- "If you can't do it just say you can't. I'd prefer admission of inability."
- Say what a live measurement will cost before running it. The session spent about $1.20 of their
  OpenRouter credit on measurements without asking first.

## Why the work moved to the laptop

On `decent-spider` audio reaches the user through the playback bridge: the extension uploads a finished
file to `pi-speech-receiver` on the laptop. Streaming over that path needs a new receiver, which can only
be installed and heard on the laptop. With Pi on the laptop, playback is local and the bridge is not in
the way.

Open question for the user before designing: is local playback on the laptop enough, or must streaming
also work when Pi runs on `decent-spider`? The second needs the bridge change below.

## What is measured (2026-11-12, a 253-character text, about 15 s of audio)

- **xAI direct** (`POST https://api.x.ai/v1/tts`, the user's login in Pi): with `output_format.codec` `pcm`
  or `mp3` the body arrives progressively, first byte at 0.30 s, all of it at 1.0 s. With `wav`, which
  `src/engine/xai.ts` asks for (`OUTPUT_FORMAT`), it arrives in one burst at 1.2 s.
- **OpenRouter `/audio/speech`**: no server-sent events; `stream` and `stream_format` are ignored. The body
  is raw audio, chunked. Whether it arrives over time depends on the maker (one model each, first byte →
  last byte):
  - over time: `x-ai/grok-voice-tts-1.0` 0.4 → 1.4 s, `deepgram/aura-2` 0.4 → 7.1, `fish-audio` 0.5 → 5.6,
    `mistralai/voxtral-mini-tts` 0.7 → 3.2, `qwen` 1.5 → 3.2, `assemblyai` 0.7 → 2.1, `heygen` 0.4 → 1.3,
    `minimax` (MP3 only) 0.7 → 1.6
  - one burst when generation ends: `elevenlabs` 2.6 s, `google/gemini-*-tts` 3.3, `canopylabs/orpheus` 4.9,
    `bytedance-seed` 19, `hexgrad/kokoro` 0.4, `microsoft/mai-voice-2.1-flash` 1.0 to 1.4, `speechify` 0.4 to 0.9
- **OpenRouter `/chat/completions`** (`openai/gpt-audio`, `gpt-audio-mini`): real SSE, first audio at 0.57 s.
  `src/engine/chat-audio.ts` collects the whole reading first, because it checks the model's transcript
  against the text before anything plays. Streaming there needs that check done on the transcript as a
  prefix, stopping playback when it strays.
- The user's saved speech model was `microsoft/mai-voice-2.1` (voice `ko-KR-Haena:MAI-Voice-2.1`); the
  sampled Flash variant sends one burst. Streaming means selecting `xai`, or an OpenRouter maker from the
  first list.
- Long texts already start early: above 280 characters `src/engine/pieces.ts` and `stream.ts` split the text,
  ask for two pieces at a time, and play each as its own file once it is whole.

## What has to change

1. **Synthesis that yields audio as it arrives.** `SpeechProvider.synthesize` returns a finished
   `{ audio, format }`. xAI needs `codec: "pcm"`; OpenRouter needs the response body read as it comes
   (`response_format: "pcm"`, 24 kHz mono 16-bit).
2. **An output that plays a stream.** `AudioOutput.play(file, kind)` in `src/engine/audio.ts` takes a file,
   and `src/engine/local-output.ts` runs `<player> <file>`, which is also the contract of
   `PI_SPEECH_PLAYER`. A stream needs a player fed on stdin with raw PCM, for example
   `pacat --playback --format=s16le --rate=24000 --channels=1`, `pw-cat -p`, or
   `ffplay -f s16le -ar 24000 -ac 1 -nodisp -autoexit -i -`.
3. **The player's rules, kept.** One playback at a time, the claim ticket, stop and replace
   (`src/engine/player.ts`), a failure never falling back to another provider, and the message saved to
   the history as WAV once the stream has ended.
4. **The bridge, only if streaming must work with Pi on another host.** `protocol/bridge.md` version 1 has
   `POST /v1/play` require a `Content-Length` and refuse a chunked body; the receiver stores the file and
   then starts the player (`play` and `start_playback` in `receiver/src/server.rs`). Streaming needs a new
   capability in the protocol and the receiver. `AGENTS.md` says not to change `protocol/bridge.md`; the
   user was asked whether to lift that and chose to move to the laptop instead. Ask again before touching it.

Done when: with `xai` selected on the laptop, a text of a few sentences starts sounding while its response
is still arriving, stop works mid-stream, the message is in the history afterwards, `npm run check` passes,
and the user has confirmed it by ear. Time to first sound can be measured; whether it sounds right cannot.

## State of the repository

- Public at `github.com/JangMan-J/pi-speech`; `@jangmanj/pi-speech@0.1.0` is on npm, published by CI with
  provenance. A release is `npm version patch && git push --follow-tags`.
- Nothing for streaming is built.
- 0.1.0 holds this session's other work: the redesigned `/speech` panel, the dictation output command, chat
  models on OpenRouter (`src/engine/chat-audio.ts`), and OpenAI-compatible endpoints
  (`src/engine/endpoints.ts`).

Open items, none of them blocking the goal:

- Dependabot opened four pull requests; the dev-tools group one fails CI.
- `e2e/panel/visible.mjs` still asserts the panel layout from before the redesign and fails. `e2e/run core`
  has not been run since the chat models and endpoints went in.
- The direct endpoints were only tested against a local server. The Fireworks key in Pi is refused by
  Fireworks' audio hosts (plain `curl` gets the same 401), so no real vendor has been through them.

## Checks

- `npm run check` (typecheck, lint, 470 tests), `npm run smoke:pack`, and in `receiver/`:
  `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. CI runs all of them.
- `e2e/chat-models/live.test.ts` measures the chat models against live OpenRouter and costs about 15 US
  cents a run; `e2e/README.md` has the command.
