---
type: glossary
created: 2026-11-12T13:39:07Z
created_by: claude-opus-5-5
created_session: 01a1cfe8-fb2e-76f9-8621-eae06c80679c
updated: 2026-11-13T10:18:02Z
updated_by: claude-opus-5-5
updated_session: 01a1cfe8-fb2e-76f9-8621-eae06c80679c
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
a download that plays once it is complete.
_Avoid_: streamed speech (for a Reading), progressive playback
_Confirmed_: 2026-11-12, Jang ("the same way Netflix does").

**Reading**:
One playback of a long text split into parts that are requested ahead and played one after another, so
the player counts as playing from the first part to the last.
_Example_: a 900-character answer read aloud in four parts, two requested at a time.
_Not_: a Stream (a Reading is about the text; where the output can, the whole Reading plays as one Stream).
_Avoid_: streamed speech, stream
_Confirmed_: 2026-11-12, Jang.

**Stray**:
A chat model's reading that does not say the text it was given, word for word: it paraphrases, adds,
or leaves out words. Told by comparing the model's own transcript with the text.
_Example_: asked to say "Turn left at the bridge", the model says "Sure! Turn left at the bridge."
_Confirmed_: 2026-11-12, Jang (a Stray stops playback by default).

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

## Unresolved

- **reading (lowercase)**: chat-audio code (`readingEvents`, `ReadingEvent`), the README and the Stray entry
  call a chat model's spoken version "a reading", which can be confused with a Reading.
- **piece / part / chunk**: the Reading entry says "parts" and the code "pieces" (`pieces.ts`, `reading.ts`)
  for the parts of a Reading's text, but the receiver's `read_pieces` and `protocol/bridge.md` also use
  "piece" and "part" for a chunk of an HTTP body.
- **Stream player**: the player that reads a Stream on its input (`PI_SPEECH_STREAM_PLAYER`,
  `PI_SPEECH_RECEIVER_STREAM_PLAYER`), as opposed to the file player. Capitalised in places, no entry.
- **Stream for a burst**: a maker that sends all its audio at the end goes through the Stream path but plays
  only once complete; is that a Stream (the Stream entry's _Not_ says a download that plays once complete is
  not)?
- **vouch**: the chat gate's word for words said so far being the start of the text (`whole`, `start`,
  `stray`).
