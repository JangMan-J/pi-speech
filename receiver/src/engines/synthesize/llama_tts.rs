//! Managed `llama-server` TTS backends (`ZONOS3`, `Qwen3-TTS`, and `Orpheus` + SNAC).

use super::{pick_language, resample_speed, threads, AudioSink, TtsBackend};
use crate::engines::llama::{LlamaServer, ORPHEUS_VOICES};
use crate::engines::snac::SnacDecoder;
use std::fs;
use std::path::Path;

pub(super) struct LlamaTtsBackend {
    server: LlamaServer,
    sample_rate: u32,
    voices: Vec<String>,
}

impl LlamaTtsBackend {
    pub(super) fn load(
        dir: &Path,
        gguf: &Path,
        mmproj: &Path,
        sample_rate: u32,
        family_name: &'static str,
    ) -> Result<Self, String> {
        let server = LlamaServer::start(gguf, Some(mmproj))?;
        let mut voices = server.voices();
        if !voices.is_empty() {
            let _ = fs::write(dir.join("voices.txt"), voices.join("\n"));
        } else if family_name == "ZONOS3" {
            voices = vec![
                "Savannah_en-American_F_1".into(),
                "Imogen_en-British_F_1".into(),
            ];
        } else {
            voices = vec!["default".into()];
        }
        Ok(Self {
            server,
            sample_rate,
            voices,
        })
    }
}

impl TtsBackend for LlamaTtsBackend {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
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
        let voice = usize::try_from(sid)
            .ok()
            .and_then(|i| self.voices.get(i))
            .map(String::as_str);
        self.server
            .speak_tts(text, voice, speed, language, &mut |_rate, samples| {
                (on_audio.borrow_mut())(samples)
            })
    }
}

pub(super) struct OrpheusBackend {
    server: LlamaServer,
    snac: SnacDecoder,
    voices: Vec<String>,
}

impl OrpheusBackend {
    pub(super) fn load(gguf: &Path, snac_path: &Path) -> Result<Self, String> {
        let snac = SnacDecoder::load(snac_path, threads())?;
        let server = LlamaServer::start(gguf, None)?;
        let voices = ORPHEUS_VOICES.iter().map(|&s| s.to_string()).collect();
        Ok(Self {
            server,
            snac,
            voices,
        })
    }
}

impl TtsBackend for OrpheusBackend {
    fn sample_rate(&self) -> u32 {
        24_000
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
        let _ = pick_language(&[], language, "Orpheus")?;
        let voice = usize::try_from(sid)
            .ok()
            .and_then(|i| self.voices.get(i))
            .map(String::as_str)
            .unwrap_or("tara");
        self.server
            .speak_orpheus(&self.snac, text, voice, &mut |samples| {
                let resampled = resample_speed(samples, speed);
                (on_audio.borrow_mut())(&resampled)
            })
    }
}
