# Playback bridge protocol, version 1

The playback bridge connects pi-speech on the Pi host to `pi-speech-receiver` on the
playback machine (the user's local Linux computer with speakers and a microphone).
The receiver plays audio that Pi sends and, for Alt+Z dictation, records the local
microphone and returns the recording to Pi. Every playback is a Stream (`GLOSSARY.md`):
the audio is sent as it arrives, and a saved message is sent whole as a Stream.

This file is the contract between the two sides. Both sides implement it exactly.

## Transport

- The receiver listens on loopback only. It refuses to start on any address that is
  not `127.0.0.1` or `::1`.
- When Pi runs on a remote host, the receiver's port is forwarded there with SSH. The
  usual way is `pi-speech-receiver ssh <host>` on the user's computer (see "SSH
  sessions" below), which runs a receiver for that session and adds the forward. By
  hand: `ssh -R 127.0.0.1:47613:127.0.0.1:47613 decent-spider` with a receiver already
  running. Either way Pi reaches the receiver at `http://127.0.0.1:47613` on the remote
  host.
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

| Status | Meaning                                                                              |
| ------ | ------------------------------------------------------------------------------------ |
| 400    | Malformed request, or a body that breaks off (interrupted transfer).                 |
| 401    | Missing or wrong token.                                                              |
| 408    | The request head did not arrive within 10 s.                                         |
| 404    | Unknown endpoint, or unknown playback or recording id.                               |
| 409    | A recording or a model run is already active, or a Stream cannot take audio.         |
| 413    | Body larger than the receiver's limit (default 64 MiB).                              |
| 415    | `POST /v1/transcribe` with audio that is not WAV or MP3.                             |
| 422    | The recording holds less than 0.1 s of audio, or a model run failed (see below).     |
| 503    | The player or the microphone is not available; the message says why.                 |

## Endpoints

### `GET /v1/health`

`200 {"protocol": 1, "name": "pi-speech-receiver", "version": "<semver>", "capabilities": ["play", "record", "stream", "models"]}`

A receiver that lists `stream` has the two endpoints under "Playing a Stream", the only
way to play. A client checks for it: a receiver without it is too old, and the client
says to update it rather than play any other way. A receiver that lists `models` has the
endpoints under "Running local models".

### Playing a Stream

A Stream is audio that plays while the rest of it is still arriving (speech the Pi host
receives from a provider in pieces). Audio that is already whole (a saved message, or a
provider that sends one file at the end) is sent the same way, as one late part. It
takes two requests, because a client cannot read a response before it has sent its
whole request body: one starts the player and returns its id, the other carries the
audio.

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
  `playing`. If no player for that format can start, `503`; the playback then fails
  with that message.
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

### Running local models

The receiver runs local models (see "Subcommand notes: speak" and `transcribe`) for the
client, so that a Pi on another host can use the models and CPU of the receiver's machine.
Each endpoint runs the receiver's own executable (or the program named by
`PI_SPEECH_RECEIVER_MODELS`) as `models list`, `speak <id> ...` or `transcribe <id> <file>`.
A model id has only letters, digits, `.`, `_` and `-`, and does not start with `-` or `.`;
anything else gets `400`. A failed run gets `422` with the model's own message (for example a
model that is not downloaded, naming `pi-speech-receiver models download <id>`).

One transcription or speech runs at a time: another `POST /v1/transcribe` or `POST /v1/speak`
while one runs gets `409`. Listing models and voices is not a run.

#### `GET /v1/models`

`200 {"models": [...]}`: the objects `pi-speech-receiver models list` prints, one per model.

#### `GET /v1/voices?model=<id>`

`200 {"voices": [{"name": "af_maple", "number": 0}, ...]}`: the voices of a downloaded speech model.

#### `POST /v1/transcribe?model=<id>`

- Body: a WAV or MP3 file, with `Content-Type: audio/wav` or `audio/mpeg` (else `415`), at most
  the body limit (`413`). The receiver keeps it in its private directory while the model runs
  and deletes it after.
- Response: `200 {"text": "<transcript>"}`.

#### `POST /v1/speak`

- Body: JSON `{"model": "<id>", "text": "...", "voice": "<name or number>", "speed": <0.25..4>}`
  (`voice` and `speed` optional), at most 1 MiB.
- Response, once the model has loaded: `200`, `Transfer-Encoding: chunked`, headers
  `X-Pi-Speech-Format: pcm`, `X-Pi-Speech-Rate: <Hz>`, `X-Pi-Speech-Channels: 1`; body: raw
  signed 16-bit little-endian PCM, sent as it is generated. The body ends with the last chunk
  only when the speech is complete; a run that fails midway closes the connection without it.
  A failure before any audio is `422`.
- A client that closes the connection stops the run (noticed when the next audio is written).

## Receiver command line

```
pi-speech-receiver [--listen 127.0.0.1:47613] [--token-file PATH]
```

- On start it prints exactly one line to stdout, `listening <address>:<port>`, with the
  port actually bound (so `--listen 127.0.0.1:0` works in tests).
- It stops cleanly on SIGINT and SIGTERM: playback and recording stop, temporary
  files are deleted.

### Subcommand notes: `speak`

```
pi-speech-receiver speak <model-dir>|<model-id> [--voice <name-or-number>] [--speed <x>]
pi-speech-receiver speak <model-dir>|<model-id> --list-voices
```

Local speech (Kokoro, Piper) on the machine that runs the binary; not an HTTP endpoint.

- Input: the whole text on stdin, read to its end before synthesis starts.
- stdout: raw signed 16-bit little-endian mono PCM at the model's own rate (Kokoro 24000 Hz,
  Piper 22050 Hz; not resampled), written sentence by sentence as sherpa-onnx generates it.
  Nothing else is written to stdout.
- stderr: JSON lines `{"event": ...}`, in order: `{"event":"format","rate":<Hz>,"channels":1}`
  before the first byte of audio, then exactly one of `{"event":"done"}` (exit 0, all audio
  written), `{"event":"error","message":"..."}` (exit 1; may come without a format line when the
  model cannot be found or loaded, the voice is unknown, or the text is empty) or
  `{"event":"stopped"}` (exit 1). The model's libraries may write other lines (warnings), which
  are not JSON objects with an `event` and are to be skipped.
- A catalogue id names a downloaded speech model; one not downloaded is an error naming
  `pi-speech-receiver models download <id>`.
- SIGINT, SIGTERM, or the reader closing stdout stop it at once (`stopped`), even
  mid-sentence.
- `--voice`: a voice name or number (default 0). `--speed`: 0.25 to 4, 1 normal.
- `--list-voices`: `{"name":"af_maple","number":0}` lines on stdout, one per voice.
- Usage errors print the usage on stderr and exit 2.
- A Piper voice needs a lexicon (sherpa-onnx 2.0 no longer runs espeak-ng): `lexicon*.txt` in
  its directory, else the shared `lexicon-<lang>-<region>.txt` (for English voices
  `lexicon-en-us.txt`) in the model cache beside it.

## SSH sessions

```
pi-speech-receiver ssh [ssh-args...] <host> [command...]
pi-speech-receiver pair [ssh-args...] <host>
```

`ssh` runs the user's own `ssh` (found on `PATH`) with the bridge for that session only:

1. **Pairing**, on the first connection to a host: the local token file (made if missing,
   as above) is uploaded to the remote host as `.config/pi-speech/bridge.token` under the
   directory `sftp` starts in (the user's home, on Windows OpenSSH too), where the
   extension reads it. The upload is `sftp -b -` with this batch, so it needs no
   particular remote shell:

   ```
   -mkdir .config
   -mkdir .config/pi-speech
   -chmod 700 .config/pi-speech
   -chmod 600 .config/pi-speech/bridge.token
   put '<local token file>' .config/pi-speech/bridge.token
   -chmod 600 .config/pi-speech/bridge.token
   ```

   A pairing is remembered in `paired-hosts` next to the local token file, one line
   `<token fingerprint><TAB><host key>` per host. The host key is the destination as
   given, with ` -l <user>` and ` -p <port>` when those options were given; the
   fingerprint is the first 8 bytes of the token's SHA-256 in hex, so a new token pairs
   every host again. A failed pairing is reported (with the end of `sftp`'s error
   output) and the session goes on without it; the next session tries again. `pair`
   uploads the token whether or not the host was paired and exits non-zero when it fails.
2. **Receiver**: a receiver starts on `127.0.0.1:0` with the local token.
3. **Session**: `ssh -R 127.0.0.1:47613:127.0.0.1:<port> <ssh-args...> <host> [command...]`,
   the user's arguments unchanged after the added forward, with the terminal as it is.
4. **End**: when `ssh` exits, the receiver stops and its files are deleted, and
   `pi-speech-receiver` exits with `ssh`'s status (128 + the signal when a signal ended
   it). Ctrl+C is left to `ssh`; a SIGTERM is passed on to it.

The ssh arguments are read as OpenSSH's `ssh` reads them: options until the destination
(flags may be clustered, `-p22` and `-p 22` alike), options again after it, and from the
first word that is not an option (or after `--`) the remote command. The options that
take a value are `-B -b -c -D -E -e -F -I -i -J -L -l -m -O -o -P -p -Q -R -S -W -w`; any
letter that is neither one of these nor an `ssh` flag is an error.

`sftp` reaches the host the same way as `ssh`, with the options that shape the
connection: `-4 -6 -C -q -v -c -F -i -J` as they are; `-p` as `-P`; `-l` as `-o User=`;
`-b`, `-B`, `-I`, `-m`, `-S`, `-P` as `-o BindAddress=`, `BindInterface=`, `PKCS11Provider=`,
`MACs=`, `ControlPath=`, `Tag=`; `-K`/`-k` as the GSSAPI options; and `-o` options except
those of the session (forwardings, `RemoteCommand`, `RequestTTY`, `LocalCommand`,
`ForkAfterAuthentication`, `SessionType`, `StdinNull`, tunnels, X11 and agent
forwarding, `EscapeChar`). `-o RemoteCommand=none -o RequestTTY=no` come first, because
either from the user's configuration breaks `sftp`. An `ssh://` destination becomes
`sftp://`, and an IPv6 address is put in brackets. Because `sftp -b` runs in batch mode,
pairing needs key or agent authentication and a host key already known.

Arguments that open no session (no destination, `-V`, `-G`, `-Q`, `-O`, `-W`) run `ssh`
unchanged, without pairing or a receiver. `-f` (and `-o ForkAfterAuthentication=yes`) is
refused: `ssh` would exit at once and take the receiver with it.

## Player and recorder programs

The receiver runs local programs it finds itself. Requests never choose them.

By default it plays and records with its own built-in audio engine: it runs its own
executable again as a child, through these subcommands, on the system's default output
and input devices. No other program is needed.

- `pi-speech-receiver play <audio-file>` plays a WAV or MP3 file once (a command-line
  convenience; the receiver itself only plays Streams).
- `pi-speech-receiver play s16le <rate> <channels>`, `play mp3` and `play wav` play a
  Stream from standard input as it arrives, and exit once the input has ended and been
  heard.
- `pi-speech-receiver record <output.wav>` records 24 kHz mono 16-bit PCM WAV, and
  finishes the file and exits when it receives SIGINT or its standard input ends (the
  receiver keeps that input open while it records).

Environment variables replace the built-in engine with other programs:

- `PI_SPEECH_RECEIVER_STREAM_PLAYER` names a Stream player, which reads a Stream from
  its standard input and exits once the input has ended and played. It is run as
  `<player> s16le <rate> <channels>` for PCM and `<player> mp3` or `<player> wav` for
  the others.
- `PI_SPEECH_RECEIVER_MODELS` names a program run for the model endpoints instead of the
  receiver itself, with the same arguments (`models list`, `speak ...`, `transcribe ...`).
- `PI_SPEECH_RECEIVER_RECORDER` names a recorder, run as `<recorder> <output.wav>`,
  which records mono 16-bit PCM WAV to that path, and finishes the file and exits when
  it receives SIGINT.

The same executable is the extension's bundled binary on This machine: pi-speech plays
and records there through `play` and `record` too (`src/engine/binary.ts`).

A name without a `/` is looked up on `PATH`. To stop a player or recorder, built-in or
not, the receiver sends SIGINT, waits up to 2 s, then sends SIGKILL.
