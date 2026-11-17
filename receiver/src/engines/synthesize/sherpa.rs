//! Sherpa-ONNX TTS backend (Kokoro, Kitten, Piper/VITS, Supertonic, Pocket TTS, Matcha-TTS, ZipVoice).

use super::{
    path, paths, pick_language, sentences, threads, voice_names, AudioSink, TtsBackend, VoiceModel,
};
use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, Wave};
use std::cell::Cell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::rc::Rc;

pub(super) struct SherpaBackend {
    tts: OfflineTts,
    references: Vec<(PathBuf, Option<String>)>,
    num_steps: Option<i32>,
    streams: bool,
    voices: Vec<String>,
    languages: Vec<&'static str>,
    family: &'static str,
}

impl SherpaBackend {
    pub(super) fn load(model: &VoiceModel, provider: &str) -> Result<Self, String> {
        let mut config = OfflineTtsConfig {
            // One sentence at a time: each comes out as soon as it is generated.
            max_num_sentences: 1,
            ..Default::default()
        };
        let m = &mut config.model;
        m.num_threads = threads();
        m.provider = Some(provider.into());
        let opt = |p: &Option<PathBuf>| p.as_deref().map(path).transpose();
        match model {
            VoiceModel::Kokoro {
                model,
                voices,
                tokens,
                lexicons,
                dict,
                fsts,
            } => {
                m.kokoro.model = Some(path(model)?);
                m.kokoro.voices = Some(path(voices)?);
                m.kokoro.tokens = Some(path(tokens)?);
                m.kokoro.lexicon = paths(lexicons)?;
                m.kokoro.dict_dir = opt(dict)?;
                config.rule_fsts = paths(fsts)?;
            }
            VoiceModel::Vits {
                model,
                tokens,
                lexicon,
                ..
            } => {
                m.vits.model = Some(path(model)?);
                m.vits.tokens = Some(path(tokens)?);
                m.vits.lexicon = opt(lexicon)?;
            }
            VoiceModel::Kitten {
                model,
                voices,
                tokens,
                lexicon,
            } => {
                m.kitten.model = Some(path(model)?);
                m.kitten.voices = Some(path(voices)?);
                m.kitten.tokens = Some(path(tokens)?);
                m.kitten.lexicon = opt(lexicon)?;
            }
            VoiceModel::Supertonic {
                duration_predictor,
                text_encoder,
                vector_estimator,
                vocoder,
                tts_json,
                unicode_indexer,
                voice_style,
            } => {
                let s = &mut m.supertonic;
                s.duration_predictor = Some(path(duration_predictor)?);
                s.text_encoder = Some(path(text_encoder)?);
                s.vector_estimator = Some(path(vector_estimator)?);
                s.vocoder = Some(path(vocoder)?);
                s.tts_json = Some(path(tts_json)?);
                s.unicode_indexer = Some(path(unicode_indexer)?);
                s.voice_style = Some(path(voice_style)?);
            }
            VoiceModel::Pocket {
                lm_flow,
                lm_main,
                encoder,
                decoder,
                text_conditioner,
                vocab_json,
                token_scores_json,
                ..
            } => {
                let p = &mut m.pocket;
                p.lm_flow = Some(path(lm_flow)?);
                p.lm_main = Some(path(lm_main)?);
                p.encoder = Some(path(encoder)?);
                p.decoder = Some(path(decoder)?);
                p.text_conditioner = Some(path(text_conditioner)?);
                p.vocab_json = Some(path(vocab_json)?);
                p.token_scores_json = Some(path(token_scores_json)?);
            }
            VoiceModel::Matcha {
                acoustic_model,
                vocoder,
                tokens,
                lexicons,
                dict,
                fsts,
            } => {
                let mc = &mut m.matcha;
                mc.acoustic_model = Some(path(acoustic_model)?);
                mc.vocoder = opt(vocoder)?;
                mc.tokens = Some(path(tokens)?);
                mc.lexicon = paths(lexicons)?;
                mc.dict_dir = opt(dict)?;
                mc.noise_scale = 0.667;
                mc.length_scale = 1.0;
                config.rule_fsts = paths(fsts)?;
            }
            VoiceModel::ZipVoice {
                encoder,
                decoder,
                vocoder,
                tokens,
                lexicons,
                ..
            } => {
                let z = &mut m.zipvoice;
                z.encoder = Some(path(encoder)?);
                z.decoder = Some(path(decoder)?);
                z.vocoder = opt(vocoder)?;
                z.tokens = Some(path(tokens)?);
                z.lexicon = paths(lexicons)?;
                z.feat_scale = 0.1;
                z.t_shift = 0.5;
                z.target_rms = 0.1;
                z.guidance_scale = 1.0;
            }
            VoiceModel::Phonon { .. }
            | VoiceModel::LlamaTts { .. }
            | VoiceModel::Orpheus { .. } => unreachable!("handled before Sherpa load"),
        }
        let tts = OfflineTts::create(&config).ok_or_else(|| {
            format!(
                "cannot load the {} model (sherpa-onnx refused its files)",
                model.family()
            )
        })?;
        let voices = voice_names(model, tts.num_speakers().max(1) as usize);
        let references = match model {
            VoiceModel::Pocket { references, .. } => {
                references.iter().map(|r| (r.clone(), None)).collect()
            }
            VoiceModel::ZipVoice { references, .. } => references
                .iter()
                .map(|(r, t)| (r.clone(), Some(t.clone())))
                .collect(),
            _ => Vec::new(),
        };
        let num_steps = matches!(model, VoiceModel::ZipVoice { .. }).then_some(4);
        Ok(Self {
            tts,
            references,
            num_steps,
            streams: !matches!(
                model,
                VoiceModel::Kitten { .. }
                    | VoiceModel::Supertonic { .. }
                    | VoiceModel::ZipVoice { .. }
            ),
            voices,
            languages: model.languages(),
            family: model.family(),
        })
    }
}

impl TtsBackend for SherpaBackend {
    fn sample_rate(&self) -> u32 {
        self.tts.sample_rate().max(0) as u32
    }

    fn voices(&self) -> &[String] {
        &self.voices
    }

    fn languages(&self) -> &[&'static str] {
        &self.languages
    }

    fn generate(
        &self,
        text: &str,
        sid: i32,
        speed: f32,
        language: Option<&str>,
        on_audio: &AudioSink,
    ) -> Result<(), String> {
        let mut config = GenerationConfig {
            sid,
            speed,
            ..Default::default()
        };
        if let Some(lang) = pick_language(&self.languages, language, self.family)? {
            config.extra = Some(HashMap::from([("lang".to_string(), lang.into())]));
        }
        if let Some(steps) = self.num_steps {
            config.num_steps = steps;
        }
        if !self.references.is_empty() {
            // Pocket TTS / ZipVoice: the voice is a reference clip, not a speaker number.
            let (clip, ref_text) = usize::try_from(sid)
                .ok()
                .and_then(|i| self.references.get(i))
                .ok_or_else(|| format!("no voice number {sid}"))?;
            let wave = Wave::read(&path(clip)?)
                .filter(|w| w.num_samples() > 0 && w.sample_rate() > 0)
                .ok_or_else(|| {
                    format!(
                        "cannot read the voice's reference clip {} (a WAV file)",
                        clip.display()
                    )
                })?;
            config.sid = 0;
            config.reference_audio = Some(wave.samples().to_vec());
            config.reference_sample_rate = wave.sample_rate();
            if let Some(rt) = ref_text {
                config.reference_text = Some(rt.clone());
                let mut extra = config.extra.unwrap_or_default();
                extra.insert("min_char_in_sentence".to_string(), serde_json::json!(10));
                config.extra = Some(extra);
            }
        }
        let pieces = if self.streams {
            vec![text]
        } else {
            sentences(text)
        };
        for piece in pieces {
            let called = Rc::new(Cell::new(false));
            let going = Rc::new(Cell::new(true));
            let (cb_audio, cb_called, cb_going) = (on_audio.clone(), called.clone(), going.clone());
            let audio = self
                .tts
                .generate_with_config(
                    piece,
                    &config,
                    Some(move |samples: &[f32], _progress: f32| {
                        cb_called.set(true);
                        let more = (cb_audio.borrow_mut())(samples);
                        cb_going.set(more);
                        more
                    }),
                )
                .ok_or_else(|| "the voice model generated no audio".to_string())?;
            // Kitten hands nothing to the callback: the audio comes at the end.
            if !called.get() && !(on_audio.borrow_mut())(audio.samples()) {
                break;
            }
            if !going.get() {
                break;
            }
        }
        Ok(())
    }
}
