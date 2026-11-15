//! Speech to text with a detected model: 16 kHz mono `f32` samples in, text out.

use super::model::{Kind, Model};
use sherpa_onnx::{
    OfflineCanaryModelConfig, OfflineCohereTranscribeModelConfig, OfflineDolphinModelConfig,
    OfflineMoonshineModelConfig, OfflineOmnilingualAsrCtcModelConfig, OfflineQwen3ASRModelConfig,
    OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig,
    OfflineTransducerModelConfig, OfflineWhisperModelConfig, OnlineRecognizer,
    OnlineRecognizerConfig, OnlineTransducerModelConfig,
};
use std::path::Path;

/// The sample rate every supported model takes.
pub const SAMPLE_RATE: u32 = 16_000;
/// Audio longer than a model hears at once ([`Kind::max_seconds`]) is cut at the quietest moment
/// of the last this many seconds before the limit.
pub const CUT_SEARCH: f64 = 8.0;
/// The languages Cohere Transcribe speaks; another (or none) is heard as English.
const COHERE_LANGUAGES: [&str; 14] = [
    "ar", "de", "el", "en", "es", "fr", "it", "ja", "ko", "nl", "pl", "pt", "vi", "zh",
];
/// The window over which loudness is measured when looking for a cut.
const CUT_WINDOW_SECONDS: f64 = 0.05;

pub struct Recognizer {
    inner: Inner,
    kind: Kind,
    language: Option<String>,
}

enum Inner {
    Offline(OfflineRecognizer),
    /// A streaming model, fed a whole recording at once.
    Online(OnlineRecognizer),
}

/// Silence before and after the speech: a streaming model misses the first words of a recording
/// that starts with them, and needs a moment after the last to finish it.
const STREAMING_LEAD_SECONDS: f32 = 0.5;
const STREAMING_TAIL_SECONDS: f32 = 0.6;

fn path(p: &Path) -> Result<String, String> {
    p.to_str()
        .map(String::from)
        .ok_or_else(|| format!("the model path {} is not valid UTF-8", p.display()))
}

/// Up to 8 threads: measured on a 32-thread CPU, 8 runs the larger models (Cohere, Qwen3) a third
/// faster than 4, and 16 no faster than 8.
/// The environment variable naming the ONNX Runtime provider models run on: `cpu` (the
/// default), or `cuda`, `coreml`, `directml` on a build that has it.
pub const PROVIDER_ENV: &str = "PI_SPEECH_PROVIDER";

fn provider() -> String {
    std::env::var(PROVIDER_ENV)
        .ok()
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "cpu".into())
}

fn threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8) as i32)
        .unwrap_or(1)
}

impl Recognizer {
    /// Load `model` (reads several hundred megabytes for the larger models). `language` (`de`) is
    /// the language spoken, for a model that must be told (Canary); the others detect it.
    ///
    /// It runs where [`PROVIDER_ENV`] says (`cuda` on a build linked with the GPU libraries),
    /// else on the CPU; a model the GPU provider refuses (Moonshine's `.ort` files) runs on the CPU.
    pub fn load(model: &Model, language: Option<&str>) -> Result<Recognizer, String> {
        let wanted = provider();
        match Self::load_on(model, language, &wanted) {
            Err(_) if wanted != "cpu" => Self::load_on(model, language, "cpu"),
            r => r,
        }
    }

    /// Whether `language` changes how `model` is loaded or run, so that a loaded model is kept
    /// per language.
    pub fn language_matters(kind: Kind) -> bool {
        matches!(kind, Kind::Canary | Kind::Cohere | Kind::Streaming)
    }

    fn load_on(
        model: &Model,
        language: Option<&str>,
        provider: &str,
    ) -> Result<Recognizer, String> {
        let language = language
            .map(|l| l.split(['-', '_']).next().unwrap_or(l).to_ascii_lowercase())
            .filter(|l| !l.is_empty() && l != "auto");
        if let Model::Streaming {
            encoder,
            decoder,
            joiner,
            tokens,
        } = model
        {
            let mut config = OnlineRecognizerConfig::default();
            config.feat_config.sample_rate = SAMPLE_RATE as i32;
            let m = &mut config.model_config;
            m.num_threads = threads();
            m.provider = Some(provider.into());
            m.transducer = OnlineTransducerModelConfig {
                encoder: Some(path(encoder)?),
                decoder: Some(path(decoder)?),
                joiner: Some(path(joiner)?),
            };
            m.tokens = Some(path(tokens)?);
            let inner = OnlineRecognizer::create(&config).ok_or_else(|| {
                format!(
                    "cannot load the {} model (sherpa-onnx refused its files)",
                    model.kind().name()
                )
            })?;
            return Ok(Recognizer {
                inner: Inner::Online(inner),
                kind: model.kind(),
                language,
            });
        }
        let mut config = OfflineRecognizerConfig::default();
        config.feat_config.sample_rate = SAMPLE_RATE as i32;
        let m = &mut config.model_config;
        m.num_threads = threads();
        m.provider = Some(provider.into());
        match model {
            Model::Transducer {
                encoder,
                decoder,
                joiner,
                tokens,
            } => {
                m.transducer = OfflineTransducerModelConfig {
                    encoder: Some(path(encoder)?),
                    decoder: Some(path(decoder)?),
                    joiner: Some(path(joiner)?),
                };
                m.tokens = Some(path(tokens)?);
            }
            Model::Whisper {
                encoder,
                decoder,
                tokens,
            } => {
                m.whisper = OfflineWhisperModelConfig {
                    encoder: Some(path(encoder)?),
                    decoder: Some(path(decoder)?),
                    // Empty: the language is detected from the audio.
                    language: Some(String::new()),
                    task: Some("transcribe".into()),
                    tail_paddings: -1,
                    ..Default::default()
                };
                m.tokens = Some(path(tokens)?);
            }
            Model::Canary {
                encoder,
                decoder,
                tokens,
            } => {
                // English when none is given; sherpa-onnx itself falls back from a language the
                // model does not offer (180M Flash: en es de fr; 1B v2: 25 European).
                let lang = language.clone().unwrap_or_else(|| "en".into());
                m.canary = OfflineCanaryModelConfig {
                    encoder: Some(path(encoder)?),
                    decoder: Some(path(decoder)?),
                    // The same language in and out: transcribed, not translated.
                    src_lang: Some(lang.clone()),
                    tgt_lang: Some(lang),
                    use_pnc: true,
                };
                m.tokens = Some(path(tokens)?);
            }
            Model::Cohere {
                encoder,
                decoder,
                tokens,
            } => {
                m.cohere_transcribe = OfflineCohereTranscribeModelConfig {
                    encoder: Some(path(encoder)?),
                    decoder: Some(path(decoder)?),
                    language: Some(
                        language
                            .clone()
                            .filter(|l| COHERE_LANGUAGES.contains(&l.as_str()))
                            .unwrap_or_else(|| "en".into()),
                    ),
                    use_punct: true,
                    use_itn: true,
                };
                m.tokens = Some(path(tokens)?);
            }
            Model::Moonshine {
                encoder,
                merged_decoder,
                tokens,
            } => {
                m.moonshine = OfflineMoonshineModelConfig {
                    encoder: Some(path(encoder)?),
                    merged_decoder: Some(path(merged_decoder)?),
                    ..Default::default()
                };
                m.tokens = Some(path(tokens)?);
            }
            Model::Qwen3 {
                conv_frontend,
                encoder,
                decoder,
                tokenizer,
            } => {
                m.qwen3_asr = OfflineQwen3ASRModelConfig {
                    conv_frontend: Some(path(conv_frontend)?),
                    encoder: Some(path(encoder)?),
                    decoder: Some(path(decoder)?),
                    tokenizer: Some(path(tokenizer)?),
                    ..Default::default()
                };
            }
            Model::Streaming { .. } => unreachable!("loaded by the online recogniser above"),
            Model::Single {
                kind,
                model,
                tokens,
            } => {
                let model = Some(path(model)?);
                match kind {
                    Kind::Dolphin => m.dolphin = OfflineDolphinModelConfig { model },
                    Kind::Omnilingual => {
                        m.omnilingual = OfflineOmnilingualAsrCtcModelConfig { model }
                    }
                    _ => {
                        m.sense_voice = OfflineSenseVoiceModelConfig {
                            model,
                            language: Some("auto".into()),
                            use_itn: true,
                        }
                    }
                }
                m.tokens = Some(path(tokens)?);
            }
        }
        let inner = OfflineRecognizer::create(&config).ok_or_else(|| {
            format!(
                "cannot load the {} model (sherpa-onnx refused its files)",
                model.kind().name()
            )
        })?;
        Ok(Recognizer {
            inner: Inner::Offline(inner),
            kind: model.kind(),
            language,
        })
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// The text spoken in `samples` (mono, [`SAMPLE_RATE`]).
    pub fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        let pieces = match self.kind.max_seconds() {
            Some(max) => cuts(samples, SAMPLE_RATE, max, CUT_SEARCH),
            None => std::iter::once(0..samples.len()).collect(),
        };
        let mut texts = Vec::new();
        for piece in pieces {
            let text = match &self.inner {
                Inner::Offline(r) => {
                    let stream = r.create_stream();
                    stream.accept_waveform(SAMPLE_RATE as i32, &samples[piece]);
                    r.decode(&stream);
                    stream
                        .get_result()
                        .ok_or("the speech model returned no result")?
                        .text
                }
                Inner::Online(r) => {
                    let stream = r.create_stream();
                    if let Some(l) = &self.language {
                        stream.set_option("language", l);
                    }
                    let silence = |s: f32| vec![0.0; (s * SAMPLE_RATE as f32) as usize];
                    stream.accept_waveform(SAMPLE_RATE as i32, &silence(STREAMING_LEAD_SECONDS));
                    stream.accept_waveform(SAMPLE_RATE as i32, &samples[piece]);
                    stream.accept_waveform(SAMPLE_RATE as i32, &silence(STREAMING_TAIL_SECONDS));
                    stream.input_finished();
                    while r.is_ready(&stream) {
                        r.decode(&stream);
                    }
                    r.get_result(&stream)
                        .ok_or("the speech model returned no result")?
                        .text
                }
            };
            // One space between words (a streaming model writes two between sentences; a
            // SentencePiece model may leave its word mark, ▁, in).
            let text = text
                .replace('\u{2581}', " ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            if !text.is_empty() {
                texts.push(text);
            }
        }
        Ok(texts.join(" "))
    }
}

/// Split `samples` into ranges of at most `max_seconds`, each cut at the quietest window in
/// the `search_seconds` before the limit.
pub fn cuts(
    samples: &[f32],
    rate: u32,
    max_seconds: f64,
    search_seconds: f64,
) -> Vec<std::ops::Range<usize>> {
    let max = (max_seconds * rate as f64) as usize;
    let search = ((search_seconds * rate as f64) as usize).min(max);
    let window = ((CUT_WINDOW_SECONDS * rate as f64) as usize).max(1);
    let mut out = Vec::new();
    let mut start = 0;
    while samples.len() - start > max {
        let end = start + max;
        let mut best = (f32::INFINITY, end);
        let mut at = end - search;
        while at + window <= end {
            let energy: f32 = samples[at..at + window].iter().map(|s| s * s).sum();
            if energy < best.0 {
                best = (energy, at + window / 2);
            }
            at += window / 2;
        }
        let cut = best.1.max(start + 1);
        out.push(start..cut);
        start = cut;
    }
    if start < samples.len() || out.is_empty() {
        out.push(start..samples.len());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_audio_is_one_piece() {
        let one = cuts(&[0.5; 100], 10, 28.0, 8.0);
        assert_eq!((one.len(), one[0].clone()), (1, 0..100));
        let none = cuts(&[], 10, 28.0, 8.0);
        assert_eq!((none.len(), none[0].clone()), (1, 0..0));
    }

    #[test]
    fn long_audio_is_cut_at_its_quiet_moments() {
        // 100 Hz for easy numbers: loud, with silence at 25-26 s and 50-51 s.
        let rate = 100;
        let mut s = vec![0.5f32; 70 * rate];
        s[25 * rate..26 * rate].fill(0.0);
        s[50 * rate..51 * rate].fill(0.0);
        let got = cuts(&s, rate as u32, 28.0, 8.0);
        assert_eq!(got.len(), 3, "{got:?}");
        assert!((25 * rate..26 * rate).contains(&got[0].end), "{got:?}");
        assert!((50 * rate..51 * rate).contains(&got[1].end), "{got:?}");
        assert_eq!(got[2].end, s.len());
        for r in &got {
            assert!(r.len() <= 28 * rate);
        }
        // Contiguous: nothing lost or heard twice.
        for w in got.windows(2) {
            assert_eq!(w[0].end, w[1].start);
        }
    }

    #[test]
    fn audio_without_a_quiet_moment_is_still_cut_within_the_limit() {
        let rate = 100;
        let s = vec![0.5f32; 60 * rate];
        let got = cuts(&s, rate as u32, 28.0, 8.0);
        assert!(
            got.iter().all(|r| r.len() <= 28 * rate && !r.is_empty()),
            "{got:?}"
        );
        assert_eq!(got.last().unwrap().end, s.len());
    }
}
