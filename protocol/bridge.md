# Playback bridge protocol, version 1

The playback bridge connects pi-speech on the Pi host to `pi-speech-receiver` on the
playback machine (the user's local Linux computer with speakers and a microphone).
The receiver plays audio that Pi sends and, for Alt+Z dictation, records the local
microphone and returns the recording to Pi.

This file is the contract between the two sides. Both sides implement it exactly.

## Transport

- The receiver listens on loopback only. It refuses to start on any address that is
  not `127.0.0.1` or `::1`.
- When Pi runs on a remote host, the user forwards the receiver's port with SSH, for
  example `ssh -R 127.0.0.1:47613:127.0.0.1:47613 decent-spider`. Pi then reaches the
  receiver at `http://127.0.0.1:47613` on the remote host.
- HTTP/1.1, one request per connection is enough. JSON bodies are UTF-8.
- The whole request head (request line and headers) must arrive within 10 s of the
  connection opening; otherwise the receiver answers `408` if it can and closes the
  connection. Slow or idle clients never delay other clients' requests.
- Default port: `47613`.

## Authentication

- Every request, including `GET /v1/health`, carries `Authorization: Bearer <token>`.
- A missing or wrong token gets `401` with `{"error": "unauthorized"}` and has no
  other effect. The receiver compares tokens in constant time.
- The token is a random string of at least 32 characters. The receiver reads it from
  the file named by `--token-file`. With no `--token-file`, it uses
  `$XDG_CONFIG_HOME/pi-speech/receiver.token` (`~/.config/...` when the variable is
  unset); if that file does not exist, the receiver creates it with mode `0600` and a
  new random token. A `--token-file` that does not exist is an error. The receiver
  refuses to start if the token file is readable by group or others.
- The receiver never logs the token or request bodies.

## Errors

Every non-2xx response has the body `{"error": "<readable message>"}`.

| Status | Meaning                                                                                |
| ------ | -------------------------------------------------------------------------------------- |
| 400    | Malformed request, or a body shorter than its `Content-Length` (interrupted transfer). |
| 401    | Missing or wrong token.                                                                |
| 408    | The request head did not arrive within 10 s.                                           |
| 404    | Unknown endpoint, or unknown playback or recording id.                                 |
| 409    | A recording is already active, or a Stream's playback cannot take audio (see below).   |
| 413    | Body larger than the receiver's limit (default 64 MiB).                                |
| 415    | The body is not WAV or MP3.                                                            |
| 422    | The recording holds less than 0.1 s of audio.                                          |
| 503    | The player or the microphone is not available; the message says why.                   |

## Endpoints

### `GET /v1/health`

`200 {"protocol": 1, "name": "pi-speech-receiver", "version": "<semver>", "capabilities": ["play", "record", "stream"]}`

A receiver that lists `stream` has the two endpoints under "Playing a Stream". A client
checks for it before using them; an older receiver without it gets whole files only.

### `POST /v1/play`

Plays one audio file on the playback machine.

- Body: the raw audio bytes. `Content-Type` is `audio/wav` or `audio/mpeg`;
  `Content-Length` is required (a chunked body or a missing length gets `400`).
- Optional header `X-Pi-Speech-Kind: message | sample` (default `message`).
- The receiver checks the bytes (`RIFF....WAVE` for WAV; an `ID3` tag or an MPEG frame
  sync for MP3) and answers `415` when they do not match the declared `Content-Type`.
- The receiver writes the audio only into its own private temporary directory, under a
  name it generates, and deletes it when playback ends. No request names a path,
  a command, or a player argument.
- A new play request stops the playback in progress; that playback becomes
  `cancelled`.
- Response: `202 {"id": "<playback id>"}` once the player has started. If no player can
  start, `503`.

### Playing a Stream

A Stream is audio that plays while the rest of it is still arriving (speech the Pi host
receives from a provider in pieces). It takes two requests, because a client cannot read
a response before it has sent its whole request body: one starts the player and returns
its id, the other carries the audio.

#### `POST /v1/play/stream`

Starts a player that reads a Stream from its input, without any audio yet.

- Body: JSON `{"format": "pcm", "rate": <Hz>, "channels": 1 | 2}` for raw signed 16-bit
  little-endian PCM, or `{"format": "mp3"}` or `{"format": "wav"}` for a file of that
  format sent as it is produced. A rate outside 8000..=192000 or another format gets
  `400`.
- Optional header `X-Pi-Speech-Kind: message | sample` (default `message`).
- A new play request (of either kind) stops the playback in progress; that playback
  becomes `cancelled`.
- Response: `202 {"id": "<playback id>"}` once the player has started, in state
  `playing`. If no player for that format can start, `503`; the client then sends the
  audio as one file with `POST /v1/play` once it has all of it.
- A playback whose audio does not begin to arrive within 120 s of this answer is stopped
  and becomes `failed`.

#### `POST /v1/play/<id>/audio`

Carries the audio of a Stream started with `POST /v1/play/stream`.

- Body: the audio, sent as it arrives, with `Transfer-Encoding: chunked` (or with a
  `Content-Length` when the client has it all). The receiver writes each part to the
  player's input as it arrives and closes the input after the last.
- At most one audio request per playback; a second, or one for a playback that is no
  longer `playing`, gets `409`. Unknown ids get `404`.
- The total is bounded by the receiver's body limit (`413` after it, and the playback
  becomes `failed`).
- When the body breaks off before its end (the connection closes, a malformed chunk,
  more than 120 s without any byte), the receiver stops the player and the playback
  becomes `failed`.
- Response, once the body has ended: `200` with the playback's state as in
  `GET /v1/play/<id>`. The player may still be playing what it was given; the state
  turns `completed` when it exits with status 0.
- A stop or cancel during the upload stops the player at once; the receiver reads and
  drops the rest of the body and answers with state `cancelled`.

The playback is then like any other: `GET /v1/play/<id>`, `POST /v1/play/<id>/cancel`
and `POST /v1/stop` apply to it.

### `GET /v1/play/<id>`

`200 {"id": "...", "state": "playing" | "completed" | "failed" | "cancelled", "error": "<only when failed>"}`

- `completed` means the player exited with status 0. `failed` means it exited with
  another status or was killed by something other than the receiver.
- Optional query `?wait=<seconds>` (larger values count as 60; a non-number gets
  `400`): the receiver answers when the state leaves `playing` or when the time runs
  out, whichever is first.
- The receiver remembers at least the last 64 playbacks; older ids get `404`.

### `POST /v1/play/<id>/cancel` and `POST /v1/stop`

Stop that playback (or whatever plays now) and mark it `cancelled`.
`200 {"id": "...", "state": "cancelled"}`. A playback that had already ended keeps
its final state, and the answer reports that state. `POST /v1/stop` answers
`200 {"stopped": <number of playbacks stopped>}`.

### `POST /v1/record/start`

Starts recording the playback machine's microphone for one dictation.

- Response: `201 {"id": "<recording id>", "max_seconds": <limit>}`.
- `409` if a recording is already active.
- `503` if the recorder cannot start or exits within 500 ms (no microphone, a busy
  device, a missing recorder program). The message includes the end of the recorder's
  error output.
- The recording stops by itself after `max_seconds` (default 300). A recording that
  has ended (auto-stopped or failed) and that nobody collects within 60 s is deleted;
  later requests for it get `404`.

### `POST /v1/record/<id>/stop`

Stops the recording and returns it.

- Response: `200`, `Content-Type: audio/wav`, body: the recording (16 kHz or more,
  mono, 16-bit PCM WAV).
- `422` if it holds less than 0.1 s of audio; `503` if the recorder failed while it
  ran. In both cases the audio is deleted.
- After the response the receiver deletes the recording. A second stop gets `404`.

### `POST /v1/record/<id>/cancel`

Stops the recording and deletes it. `200 {"id": "...", "state": "cancelled"}`.

## Receiver command line

```
pi-speech-receiver [--listen 127.0.0.1:47613] [--token-file PATH]
```

- On start it prints exactly one line to stdout, `listening <address>:<port>`, with the
  port actually bound (so `--listen 127.0.0.1:0` works in tests).
- It stops cleanly on SIGINT and SIGTERM: playback and recording stop, temporary
  files are deleted.

## Player and recorder programs

The receiver runs local programs it finds itself. Requests never choose them.

By default it plays and records with its own built-in audio engine: it runs its own
executable again as a child, through these subcommands, on the system's default output
and input devices. No other program is needed.

- `pi-speech-receiver play <audio-file>` plays a WAV or MP3 file once.
- `pi-speech-receiver play s16le <rate> <channels>`, `play mp3` and `play wav` play a
  Stream from standard input as it arrives, and exit once the input has ended and been
  heard.
- `pi-speech-receiver record <output.wav>` records 24 kHz mono 16-bit PCM WAV, and
  finishes the file and exits when it receives SIGINT or its standard input ends (the
  receiver keeps that input open while it records).

Environment variables replace the built-in engine with other programs:

- `PI_SPEECH_RECEIVER_PLAYER` names a player, run as `<player> <audio-file>`, which
  plays the file once.
- `PI_SPEECH_RECEIVER_STREAM_PLAYER` names a Stream player, which reads a Stream from
  its standard input and exits once the input has ended and played. It is run as
  `<player> s16le <rate> <channels>` for PCM and `<player> mp3` or `<player> wav` for
  the others. When `PI_SPEECH_RECEIVER_PLAYER` is set and
  `PI_SPEECH_RECEIVER_STREAM_PLAYER` is not, no Stream player is used (`503`).
- `PI_SPEECH_RECEIVER_RECORDER` names a recorder, run as `<recorder> <output.wav>`,
  which records mono 16-bit PCM WAV to that path, and finishes the file and exits when
  it receives SIGINT.

A name without a `/` is looked up on `PATH`. To stop a player or recorder, built-in or
not, the receiver sends SIGINT, waits up to 2 s, then sends SIGKILL.
