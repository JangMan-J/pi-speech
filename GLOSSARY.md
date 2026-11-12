---
type: glossary
created: 2026-11-12T13:39:07Z
created_by: claude-opus-5-5
created_session: 01a1cfe8-fb2e-76f9-8621-eae06c80679c
updated: 2026-11-12T15:30:00Z
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
_Not_: a Reading; a download that plays once it is complete.
_Avoid_: streamed speech (for a Reading), progressive playback
_Confirmed_: 2026-11-12, Jang ("the same way Netflix does").

**Reading**:
One playback of a long text split into parts that are requested ahead and played one after another, so
the player counts as playing from the first part to the last.
_Example_: a 900-character answer read aloud in four parts, two requested at a time.
_Not_: a Stream (a Reading's parts may each be a Stream).
_Avoid_: streamed speech, stream
_Confirmed_: 2026-11-12, Jang.

**Stray**:
A chat model's reading that does not say the text it was given, word for word: it paraphrases, adds,
or leaves out words. Told by comparing the model's own transcript with the text.
_Example_: asked to say "Turn left at the bridge", the model says "Sure! Turn left at the bridge."
_Confirmed_: 2026-11-12, Jang (a Stray stops playback by default).

## Unresolved

- **piece / part**: the Reading entry says "parts"; the code says "pieces" (`pieces.ts`, `reading.ts`).
- **reading (lowercase)**: chat-audio code and the Stray entry call a chat model's spoken version "a
  reading", which can be confused with a Reading.
