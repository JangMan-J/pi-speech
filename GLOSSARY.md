---
type: glossary
created: 2026-11-12T13:39:07Z
created_by: claude-opus-5-5
created_session: 01a1cfe8-fb2e-76f9-8621-eae06c80679c
updated: 2026-11-17T08:11:22Z
updated_by: claude-opus-5-5
updated_session: 01a1e88d-4b1d-77d3-994b-fd8183616b63
---

# pi-speech

A Pi extension that speaks text and transcribes speech, playing on the Pi host or, through the playback
bridge, on the user's playback machine.

## Language

**Stream**:
Audio that starts playing while the rest of it is still arriving, the way a video service plays a film
before the whole file is downloaded. The player is fed as the provider's response comes in.
_Example_: xAI sends PCM for a few sentences; the first sound plays at about 0.3 s while the response
goes on arriving until about 1 s.
_Not_: a Reading (that is how a long text is split; a Reading plays as one Stream where the output can);
a download saved whole before a player starts. A provider that sends all its audio in one burst at the end is
still played as a Stream: the player is fed as the audio arrives, and its first sound is only late.
_Avoid_: streamed speech (for a Reading), progressive playback
_Confirmed_: 2026-11-12, Jang ("the same way Netflix does").

**Reading**:
One playback of a long text split at sentence ends into pieces that are requested ahead and played one after
another, so the player counts as playing from the first piece to the last.
_Example_: a 900-character answer read aloud in four pieces, two requested at a time.
_Not_: a Stream (a Reading is about the text; where the output can, the whole Reading plays as one Stream);
a chat model's reading in lowercase (ordinary English for its spoken version of one text, as in
`readingEvents`); a piece of an HTTP body in the receiver (`read_pieces`), which is ordinary English.
_Avoid_: streamed speech, stream, part, chunk (for a piece of a Reading)
_Confirmed_: 2026-11-12, Jang.

**Stray**:
A chat model's spoken version of a text that does not say the text word for word: it paraphrases, adds,
or leaves out words. Told by comparing the words the model says it spoke with the text, as they arrive.
_Example_: asked to say "Turn left at the bridge", the model says "Sure! Turn left at the bridge."
_Confirmed_: 2026-11-12, Jang (a Stray stops playback by default).

**Stream player**:
A user-set program that plays a Stream from its standard input, run as `<player> s16le <rate> <channels>` (or
`<player> mp3`, `<player> wav`): `PI_SPEECH_STREAM_PLAYER` on This machine, `PI_SPEECH_RECEIVER_STREAM_PLAYER` in
the receiver. When it is unset, the receiver's built-in audio engine plays the Stream.
_Example_: `PI_SPEECH_STREAM_PLAYER=~/bin/my-player`, run as `my-player s16le 24000 1` for xAI's PCM.
_Not_: the built-in audio engine (`pi-speech-receiver play`); the fallback players used without the receiver
(pacat, pw-cat, ffplay, mpv, aplay, mpg123).
_Confirmed_: 2026-11-17, agent, read from the code when the user asked for the unresolved terms to be settled.

**Source**:
Where one direction, speech or transcription, comes from: Provider (a speech service over the network) or Local
(an on-device model run by the bundled `pi-speech-receiver` on This machine). Each direction has its own.
_Example_: Speech source Provider with x-ai/grok-voice-tts-1.0, Transcription source Local with whisper-small.
_Not_: the route (where audio plays or records, This machine or the Remote machine through the bridge).
_Avoid_: backend, engine (for the source)
_Confirmed_: 2026-11-13, slice 05 of the redesign (Speech source, Transcription source: Provider | Local).

**Spoken summary**:
What read-aloud reads in its Summary and Thinking modes instead of the whole reply: a short version of the reply
(Thinking: of the reasoning, then of the reply), written to be heard and aimed at a length (Minimum ~15 s,
Abridged ~30 s, Full ~60 s). The same model writes it at the end of its reply between `<spoken_summary>`
markers, and the block is taken out of the reply before it is shown or kept; or another Pi model writes it in
one extra request per reply.
_Example_: a 600-word answer about a failing build, read aloud as "The build failed because a test timed out;
I raised the timeout and it passes now."
_Not_: a cut reply (Truncate at, or the 2000-character cut, keeps the start of the text; a Spoken summary is new
text).
_Avoid_: TL;DR, abstract
_Confirmed_: 2026-11-13, slice 02 of the redesign (Read: Off | Summary | Thinking | All).

**This machine**:
The machine Pi runs on, as the /speech panel and messages name it.
_Example_: decent-spider when Pi runs there over SSH; the laptop when Pi runs on the laptop.
_Avoid_: local machine, Pi host (in the UI)
_Confirmed_: 2026-11-13, Jang.

**Remote machine**:
The machine at the other end of the playback bridge from This machine: where audio can play, record, or local
models run, chosen per direction.
_Example_: agent-jail, the laptop with speakers, while Pi runs on decent-spider.
_Not_: the Pi server as seen from the laptop (from Pi's side, the laptop is the Remote machine).
_Avoid_: other machine, playback machine
_Confirmed_: 2026-11-13, Jang ("use Remote machine rather than Other machine").
