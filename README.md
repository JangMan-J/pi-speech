<p align="center">
  <img src="assets/banner.png" alt="pi-speech — Push-to-talk · Hear it thinking · Voice over SSH" />
</p>

<p align="center">
  <strong>So...are you ready to talk?</strong>
</p>

```bash
pi install npm:@jangmanj/pi-speech
```

<p align="center">
  <img width="720" alt="pi-speech-promo" src="https://github.com/user-attachments/assets/8ce44098-9fac-4782-a154-4b647b4927d9" />
</p>

Talk to Pi hands-free with push-to-talk and local models, even over SSH, and hear a live spoken narration of the model's reasoning while a turn is still running. Press **Alt+S** (`/speech`) to open the panel, tap **Alt+Z** to toggle dictation, or bind a **push-to-talk** key (`Alt+Space`, `F1`–`F12`, `Alt+K`, and more).

## Dictation and push-to-talk

- **Push-to-talk or toggle**: Hold your PTT key like a walkie-talkie and release when you finish, or tap **Alt+Z** to start and stop.
- **Live typing or fill-on-stop**: Stream words straight into the editor as you speak with local models, or insert the full transcript when you stop.
- **Hands-free submit and commands**: End a prompt with `"send it"` or `"submit"` (or your own trigger phrase) to send immediately. Say `"compact"` on its own to run `/compact`, or map phrases to any slash command.
- **Custom vocabulary**: Fix recurring mishearings (`pie` → `Pi`) and keep exact casing for project terms and tools.
- **Live spectrum visualizer**: An optional theme-matched audio visualizer sits above the editor while recording or speaking.

## Voice over SSH and split machines

- **Pi on a server, audio on your laptop**: Connect with `pi-speech-receiver ssh <server>` (binaries are on the [releases page](https://github.com/JangMan-J/pi-speech/releases)). Pi stays on the remote host while your laptop handles the microphone and speakers, so dictation, push-to-talk, and read-aloud work over SSH without forwarding audio daemons.
- **Offload heavy models**: Pair a desktop or GPU host from `/speech` to run local models on another machine while keeping audio on your laptop.
- **Manage a forwarded receiver**: Open `/speech` → **Receivers** → **Remote receiver** → **Manage over SSH**. Enter the SSH host of the machine running the receiver, not the address of the forward. Then choose **Install / update** or **Start / restart**. Pi asks for SSH authentication and confirmation in the panel. This manages the Linux `pi-speech-receiver` systemd user service without changing the bridge address, pairing, or audio routes.

## Live mid-turn narration and spoken summaries

Instead of staring at a terminal while an agent spends a minute thinking and calling tools, let Pi talk you through what it is doing as it happens:

- **Streaming (mid-turn)**: Uses a separate Pi model to summarize and speak the active model's thoughts in real time mid-turn, pacing summary length to how fast the model thinks and crossfading cleanly when narration catches up.
- **Summarized (end-of-turn)**: Reads a concise spoken wrap-up once the reply finishes, skipping raw code blocks, markdown tables, and file paths. By default it runs in the same turn with no extra model calls and nothing extra left in your session, or you can pick another Pi model.

Combined with push-to-talk and `"send it"`, you can prompt Pi, step away from the keyboard, and follow the whole turn by ear.

## Free local models

Speech and transcription each switch independently between **Local** and cloud providers. Local models download right from `/speech` and run in a native receiver fetched automatically on first use, with no Python environments or manual setup.

- **Transcription (STT)**:
  - **Parakeet TDT 0.6B** (`v3` across 25 European languages, plus English `v2`, `Ultra`, `Redux`, and `110M`): sub-second sentence transcription on CPU with live typing.
  - **Nemotron 3.5 ASR 0.6B**: true-streaming transducer across 36 languages for live dictation.
  - **Whisper** (`large-v3`, `large-v3 turbo`, `distil-large-v3.5`, `medium`, `small`, `base`, `tiny`): 99-language coverage on CPU (`int8`) and GPU (`fp32`).
  - **Canary 1B v2 & 180M Flash**, **Qwen3-ASR 0.6B** (30 languages), **Cohere Transcribe** (14 languages), **SenseVoice**, **Omnilingual ASR v2** (1,600+ languages), **Dolphin**, and lightweight **Moonshine v2**.
- **Speech (TTS)**:
  - **Phonon 31M**: 13 natural English voices that stream straight from the CPU with low latency.
  - **Kokoro** (`v1.1` with 103 voices, `v1.0` across 8 languages): multi-speaker voices on CPU or GPU.
  - **Orpheus 3B**: 8 expressive GPU voices with inline vocal tags like `<laugh>`, `<chuckle>`, and `<sigh>`.
  - **Zonos 3 Mini** (44.1 kHz audio, 8 languages) and **Qwen3-TTS 1.7B** (10 languages) for GPU synthesis.
  - **Supertonic 3** (31 languages), **Pocket TTS**, **ZipVoice distill**, **Matcha-TTS**, **Kitten v0.8**, and **Piper** (including 904-speaker LibriTTS and 109-speaker VCTK packs).
- **NVIDIA GPU acceleration (Linux & Windows)**: Switch to the CUDA 12 or CUDA 13 GPU receiver right from `/speech` for full-precision transcription (`fp32`/`fp16`) and heavyweight expressive TTS models.

## Cloud providers and agent tools

Local models need no keys. When you want cloud voices or models, use OpenRouter, xAI, OpenAI, Groq, Together, Mistral, DeepInfra, or any OpenAI-compatible server.

The agent also gets `speech_synthesize` and `speech_transcribe` tools, so you can ask Pi directly to read text aloud or transcribe an audio file.

## License

MIT; see [LICENSE](LICENSE). OpenRouter integration, pricing, picker, playback, and audio history are derived from [pi-openrouter-multimodal](https://github.com/dtmirizzi/pi-openrouter-multimodal) by DT Mirizzi under the MIT License.

<p align="center">
  <img src="assets/icon.png" alt="pi-speech orb" width="56" />
</p>
