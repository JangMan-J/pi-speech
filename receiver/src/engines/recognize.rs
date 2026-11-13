//! Speech to text with a detected model: 16 kHz mono `f32` samples in, text out.

use super::model::{Kind, Model};
use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineSenseVoiceModelConfig,
    OfflineTransducerModelConfig, OfflineWhisperModelConfig,
};
use std::path::Path;

/// The sample rate every supported model takes.
pub const SAMPLE_RATE: u32 = 16_000;
/// Whisper hears at most 30 s at a time; longer audio is cut into pieces no longer than this,
/// at the quietest moment of the last [`WHISPER_SEARCH`] seconds before it.
pub const WHISPER_MAX_SECONDS: f64 = 28.0;
pub const WHISPER_SEARCH: f64 = 8.0;
/// The window over which loudness is measured when looking for a cut.
const CUT_WINDOW_SECONDS: f64 = 0.05;

pub struct Recognizer {
    inner: OfflineRecognizer,
    kind: Kind,
}

fn path(p: &Path) -> Result<String, String> {
    p.to_str()
        .map(String::from)
        .ok_or_else(|| format!("the model path {} is not valid UTF-8", p.display()))
}

fn threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(4) as i32)
        .unwrap_or(1)
}

impl Recognizer {
    /// Load `model` (reads several hundred megabytes for the larger models).
    pub fn load(model: &Model) -> Result<Recognizer, String> {
        let mut config = OfflineRecognizerConfig::default();
        config.feat_config.sample_rate = SAMPLE_RATE as i32;
        let m = &mut config.model_config;
        m.num_threads = threads();
        m.provider = Some("cpu".into());
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
            Model::SenseVoice { model, tokens } => {
                m.sense_voice = OfflineSenseVoiceModelConfig {
                    model: Some(path(model)?),
                    language: Some("auto".into()),
                    use_itn: true,
                };
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
            inner,
            kind: model.kind(),
        })
    }

    pub fn kind(&self) -> Kind {
        self.kind
    }

    /// The text spoken in `samples` (mono, [`SAMPLE_RATE`]).
    pub fn transcribe(&self, samples: &[f32]) -> Result<String, String> {
        let pieces = match self.kind {
            Kind::Whisper => cuts(samples, SAMPLE_RATE, WHISPER_MAX_SECONDS, WHISPER_SEARCH),
            _ => std::iter::once(0..samples.len()).collect(),
        };
        let mut texts = Vec::new();
        for piece in pieces {
            let stream = self.inner.create_stream();
            stream.accept_waveform(SAMPLE_RATE as i32, &samples[piece]);
            self.inner.decode(&stream);
            let result = stream
                .get_result()
                .ok_or("the speech model returned no result")?;
            let text = result.text.trim();
            if !text.is_empty() {
                texts.push(text.to_string());
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
