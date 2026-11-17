//! Phonon GGUF TTS backend (`ptts`).

use super::{pick_language, resample_speed, AudioSink, TtsBackend};
use std::path::Path;

pub(super) struct PhononBackend {
    synth: ptts::synth::Synth,
    voices: Vec<String>,
}

impl PhononBackend {
    pub(super) fn load(dir: &Path) -> Result<Self, String> {
        let quant = if dir.join("model.q8.gguf").is_file() {
            ptts::synth::Quant::Q80
        } else {
            ptts::synth::Quant::F32
        };
        let cp = ptts::checkpoint::Checkpoint::resolve(
            dir,
            ptts::checkpoint::ResolveOptions {
                quant,
                weights: None,
            },
        )
        .map_err(|e| format!("cannot load Phonon model: {e}"))?;
        let mut synth = cp
            .builder(ptts::preprocess::Lang::En)
            .device(ptts::synth::DeviceKind::Cpu)
            .build()
            .map_err(|e| format!("cannot build Phonon synthesizer: {e}"))?;
        cp.register_voices(&mut synth);
        let mut voices = synth.voices();
        voices.sort();
        if let Some(pos) = voices.iter().position(|n| n == "default") {
            let d = voices.remove(pos);
            voices.insert(0, d);
        }
        if voices.is_empty() {
            voices.push("default".to_string());
        }
        Ok(Self { synth, voices })
    }
}

impl TtsBackend for PhononBackend {
    fn sample_rate(&self) -> u32 {
        self.synth.sample_rate()
    }

    fn voices(&self) -> &[String] {
        &self.voices
    }

    fn languages(&self) -> &[&'static str] {
        &[]
    }

    fn generate(
        &self,
        text: &str,
        sid: i32,
        speed: f32,
        language: Option<&str>,
        on_audio: &AudioSink,
    ) -> Result<(), String> {
        let _ = pick_language(&[], language, "Phonon")?;
        let mut opts = ptts::synth::SpeechOptions::default();
        if let Some(voice) = usize::try_from(sid).ok().and_then(|i| self.voices.get(i)) {
            opts = opts.voice(voice.clone());
        }
        let stream = self
            .synth
            .stream_with(text, &opts)
            .map_err(|e| format!("Phonon speech failed: {e}"))?;
        for chunk in stream {
            let samples = chunk.map_err(|e| format!("Phonon speech failed: {e}"))?;
            let resampled = resample_speed(&samples, speed);
            if !(on_audio.borrow_mut())(&resampled) {
                break;
            }
        }
        Ok(())
    }
}
