# pi-speech

Gives [Pi](https://github.com/earendil-works/pi-coding-agent) a voice and ears. Pi reads its work to you,
you talk back, and with the free local models both run on your own CPU, with no API key and nothing sent
over the network.

```bash
pi install npm:@jangmanj/pi-speech
```

`/speech` (or Alt+S) opens the panel. Alt+Z starts and stops dictation.

## Hear it think

Read aloud has three settings. **Off**. **Summarized** reads a short spoken summary when the reply is done.
**Streaming** summarizes the model's thinking while the turn is still running, so you hear what Pi is
working on, step by step, as it works. The summaries adapt to how fast the model thinks, are kept to a
length you choose (about 15, 30 or 60 seconds), and are written by a Pi model of your choice.

## Talk instead of type

Tap Alt+Z to start and stop, or turn on **push-to-talk**: hold a key while you speak and let go when
you're done. Push-to-talk needs a terminal that reports key releases: kitty, Ghostty, foot, Alacritty,
iTerm2, Rio, Windows Terminal 1.25 or later, or WezTerm with `enable_kitty_keyboard = true`. It works inside
Zellij, but not inside tmux. Then choose how your words arrive:

- **Typed**: words appear in the editor as you speak (with local transcription).
- **Filled**: the whole transcript goes in when you stop.
- **Submit word**: end with "submit", "send it" or a word of your own, and the prompt is sent.
- **Commands**: say "compact" on its own to run `/compact`, or map any phrase to any slash command.
- **Vocabulary**: fix words the model mishears (`pie` → `Pi`) and keep the casing of names (`Zellij`).

Put dictation and read aloud together and a Pi session runs hands-free: speak, say "send it", listen to
the answer.

## Free local models

Speech and transcription each switch between a provider and **Local**. Local models download from the
panel and run in a small native receiver that pi-speech fetches on first use. 38 transcription models and
40 voices are in the catalogue:

```
  Model                         Size   State           Languages  Tags
▶ phonon-31m-en ●              68 MB   downloaded      en
  orpheus-3b-q4               2.1 GB   downloaded      en         <tags>
  supertonic-3-int8           129 MB   downloaded      31 langs
  kokoro-multi-lang-v1.1      365 MB   not downloaded  en zh
  qwen3-tts-1.7b-q4           1.5 GB   not downloaded  10 langs

  Model                         Size   State           Languages
▶ parakeet-tdt-0.6b-v3-int8 ● 487 MB   downloaded      25 langs
  canary-1b-v2                3.4 GB   downloaded      25 langs
  cohere-transcribe-int8      1.7 GB   not downloaded  14 langs
  nemotron-3.5-asr-0.6b-int8  475 MB   not downloaded  36 langs
```

- **Transcription** on an ordinary CPU: Parakeet, Canary, Cohere, Nemotron, Qwen3-ASR, Whisper and
  Moonshine. Parakeet v3 writes out an 8-second sentence in about 0.7 s.
- **Speech**: Phonon streams 13 voices straight from the CPU, Supertonic 3 speaks 31 languages, Kokoro has
  103 voices. With an NVIDIA GPU, Orpheus 3B adds expressive speech with `<laugh>` and `<sigh>` tags,
  alongside Qwen3-TTS and ZONOS3. On Linux, pi-speech downloads its GPU build when you switch the Receiver to GPU.

## Over SSH

- **Pi on a server, sound on your laptop**: connect with `pi-speech-receiver ssh <server>` instead of
  `ssh <server>` (the receiver is on the [releases page](https://github.com/JangMan-J/pi-speech/releases)).
  Speech plays and dictation records on the laptop.
- **Models on another machine**: in `/speech`, Receivers, connect to any ssh host. pi-speech installs its
  receiver there and runs local models on that machine, while the audio stays with you. Playback,
  recording and models each choose This machine or Remote machine.

## Providers

Local models need no key. For cloud voices and transcription: OpenRouter (`OPENROUTER_API_KEY` or a Pi
login), an xAI login in Pi, OpenAI with an API key, Groq, Together, Mistral, DeepInfra, or any OpenAI-compatible server
(`/speech --endpoint <name> <url>`).

`/speech <text>` speaks text, and `/speech --help` lists every action. The agent also gets two tools,
`speech_synthesize` and `speech_transcribe`.

## License

MIT; see [LICENSE](LICENSE). The OpenRouter requests, the price rules, the API-key order, the searchable
picker, local playback and the WAV/MP3 history are derived from
[pi-openrouter-multimodal](https://github.com/dtmirizzi/pi-openrouter-multimodal) by DT Mirizzi, under the
MIT License.
