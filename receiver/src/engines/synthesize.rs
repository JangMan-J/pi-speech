//! Text to speech with a local voice model: which model a directory holds, its voices, and
//! audio generated sentence by sentence.
//!
//! - Kokoro: `model.onnx` (or `model.int8.onnx`), `voices.bin` and `tokens.txt`, with the
//!   lexicons (`lexicon-*.txt`) and, for Chinese, `dict/` and the `*-zh.fst` rules of
//!   sherpa-onnx's multi-lang exports.
//! - Piper (and other VITS voices): one `<name>.onnx` and `tokens.txt`, and a lexicon.
//!
//! sherpa-onnx 2.0 no longer runs espeak-ng (`espeak-ng-data/` is ignored): words are spoken
//! through a lexicon. Piper archives carry none, so a Piper voice uses `lexicon*.txt` in its own
//! directory, else the shared lexicon of its language beside it, in the parent directory (the
//! model cache): `lexicon-en-us.txt` from sherpa-onnx's `tts-models` release, the only one
//! published so far (English voices of other regions use it too).

use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A voice model's files, as paths inside its directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VoiceModel {
    Kokoro {
        model: PathBuf,
        voices: PathBuf,
        tokens: PathBuf,
        /// English first (US before British), then the others.
        lexicons: Vec<PathBuf>,
        dict: Option<PathBuf>,
        /// Text normalisation rules (Chinese dates, phone numbers, numbers).
        fsts: Vec<PathBuf>,
    },
    Vits {
        model: PathBuf,
        tokens: PathBuf,
        /// In the voice's directory; [`detect`] looks beside it when there is none.
        lexicon: Option<PathBuf>,
        /// The voice's name, from the model's file name (`en_US-lessac-medium.onnx`: lessac).
        name: String,
    },
}

impl VoiceModel {
    pub fn family(&self) -> &'static str {
        match self {
            VoiceModel::Kokoro { .. } => "Kokoro",
            VoiceModel::Vits { .. } => "Piper (VITS)",
        }
    }
}

const SUPPORTED: &str = "a Kokoro or Piper voice model from sherpa-onnx";

/// The voice model in `dir`.
pub fn detect(dir: &Path) -> Result<VoiceModel, String> {
    let shown = dir.display();
    let meta = fs::metadata(dir).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => format!("no model directory at {shown}"),
        _ => format!("cannot read the model directory {shown}: {e}"),
    })?;
    if !meta.is_dir() {
        return Err(format!(
            "{shown} is not a model directory (it is not a directory)"
        ));
    }
    let entries =
        fs::read_dir(dir).map_err(|e| format!("cannot read the model directory {shown}: {e}"))?;
    let mut files = Vec::new();
    let mut dirs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read the model directory {shown}: {e}"))?;
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        match fs::metadata(entry.path()) {
            Ok(m) if m.is_file() => files.push(name),
            Ok(m) if m.is_dir() => dirs.push(name),
            _ => {}
        }
    }
    let mut found = from_names(dir, &files, &dirs)
        .map_err(|why| format!("unrecognised voice model directory {shown}: {why}"))?;
    if let VoiceModel::Vits {
        model,
        lexicon: lexicon @ None,
        ..
    } = &mut found
    {
        let stem = model.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let names = shared_lexicons(stem);
        let parent = dir.parent().unwrap_or(dir);
        *lexicon = names.iter().map(|n| parent.join(n)).find(|p| p.is_file());
        if lexicon.is_none() {
            return Err(format!(
                "the voice in {shown} has no lexicon, which sherpa-onnx needs to speak words; \
                 put {} (from {LEXICONS}) in {shown} or {}{}",
                names.first().map_or("a lexicon", |n| n.as_str()),
                parent.display(),
                if names.iter().any(|n| n == "lexicon-en-us.txt") {
                    ""
                } else {
                    "; sherpa-onnx publishes an English lexicon only so far"
                }
            ));
        }
    }
    Ok(found)
}

/// Where sherpa-onnx publishes its shared lexicons.
pub const LEXICONS: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/";

/// The shared lexicons a Piper voice (`en_GB-alba-medium`) can speak with, the best first:
/// its own language and region, then for English the US lexicon.
pub fn shared_lexicons(stem: &str) -> Vec<String> {
    let locale = stem.split('-').next().unwrap_or("");
    let tag = locale.replace('_', "-").to_ascii_lowercase();
    let mut out = Vec::new();
    if !tag.is_empty() {
        out.push(format!("lexicon-{tag}.txt"));
    }
    if tag == "en" || tag.starts_with("en-") {
        out.push("lexicon-en-us.txt".into());
    }
    out.dedup();
    out
}

/// Tell the voice model from the names of the files and directories in `dir` (nothing is read).
pub fn from_names(dir: &Path, files: &[String], dirs: &[String]) -> Result<VoiceModel, String> {
    let has = |n: &str| files.iter().any(|f| f == n);
    let has_dir = |n: &str| dirs.iter().any(|d| d == n);
    let p = |n: &str| dir.join(n);
    let mut onnx: Vec<&String> = files.iter().filter(|f| f.ends_with(".onnx")).collect();
    onnx.sort();
    if onnx.is_empty() {
        return Err(format!("it has no model file; expected {SUPPORTED}"));
    }
    if !has("tokens.txt") {
        return Err(format!("it has {} but no tokens.txt", onnx[0]));
    }
    if has("voices.bin") {
        let model = ["model.int8.onnx", "model.onnx"]
            .into_iter()
            .find(|n| has(n))
            .ok_or("it has voices.bin (Kokoro) but no model.onnx or model.int8.onnx")?;
        let mut lexicons: Vec<&String> = files
            .iter()
            .filter(|f| f.starts_with("lexicon") && f.ends_with(".txt"))
            .collect();
        let rank = |n: &str| match n {
            "lexicon-us-en.txt" => 0,
            "lexicon-gb-en.txt" => 1,
            _ => 2,
        };
        lexicons.sort_by_key(|n| (rank(n), n.to_string()));
        // One English lexicon: US English, else British.
        if lexicons.len() > 1 && rank(lexicons[0]) == 0 && rank(lexicons[1]) == 1 {
            lexicons.remove(1);
        }
        let fsts = ["date-zh.fst", "phone-zh.fst", "number-zh.fst"]
            .into_iter()
            .filter(|n| has(n))
            .map(p)
            .collect();
        return Ok(VoiceModel::Kokoro {
            model: p(model),
            voices: p("voices.bin"),
            tokens: p("tokens.txt"),
            lexicons: lexicons.into_iter().map(|n| p(n)).collect(),
            dict: has_dir("dict").then(|| p("dict")),
            fsts,
        });
    }
    if onnx.len() > 1 {
        let all: Vec<&str> = onnx.iter().map(|s| s.as_str()).collect();
        return Err(format!(
            "it holds more than one model ({}); put each voice in its own directory",
            all.join(", ")
        ));
    }
    let file = onnx[0];
    let stem = file.trim_end_matches(".onnx");
    // Piper's names are <language>-<voice>-<quality>.
    let parts: Vec<&str> = stem.split('-').collect();
    let name = if parts.len() == 3 { parts[1] } else { stem };
    let lexicon = if has("lexicon.txt") {
        Some("lexicon.txt")
    } else {
        files
            .iter()
            .filter(|f| f.starts_with("lexicon") && f.ends_with(".txt"))
            .min()
            .map(String::as_str)
    };
    Ok(VoiceModel::Vits {
        model: p(file),
        tokens: p("tokens.txt"),
        lexicon: lexicon.map(p),
        name: name.to_string(),
    })
}

/// The speakers of Kokoro multi-lang v1.1 (103), in sherpa-onnx's order.
const KOKORO_V1_1: &str = "af_maple af_sol bf_vale zf_001 zf_002 zf_003 zf_004 zf_005 zf_006 \
    zf_007 zf_008 zf_017 zf_018 zf_019 zf_021 zf_022 zf_023 zf_024 zf_026 zf_027 zf_028 zf_032 \
    zf_036 zf_038 zf_039 zf_040 zf_042 zf_043 zf_044 zf_046 zf_047 zf_048 zf_049 zf_051 zf_059 \
    zf_060 zf_067 zf_070 zf_071 zf_072 zf_073 zf_074 zf_075 zf_076 zf_077 zf_078 zf_079 zf_083 \
    zf_084 zf_085 zf_086 zf_087 zf_088 zf_090 zf_092 zf_093 zf_094 zf_099 zm_009 zm_010 zm_011 \
    zm_012 zm_013 zm_014 zm_015 zm_016 zm_020 zm_025 zm_029 zm_030 zm_031 zm_033 zm_034 zm_035 \
    zm_037 zm_041 zm_045 zm_050 zm_052 zm_053 zm_054 zm_055 zm_056 zm_057 zm_058 zm_061 zm_062 \
    zm_063 zm_064 zm_065 zm_066 zm_068 zm_069 zm_080 zm_081 zm_082 zm_089 zm_091 zm_095 zm_096 \
    zm_097 zm_098 zm_100";
/// The speakers of Kokoro multi-lang v1.0 (53).
const KOKORO_V1_0: &str = "af_alloy af_aoede af_bella af_heart af_jessica af_kore af_nicole \
    af_nova af_river af_sarah af_sky am_adam am_echo am_eric am_fenrir am_liam am_michael am_onyx \
    am_puck am_santa bf_alice bf_emma bf_isabella bf_lily bm_daniel bm_fable bm_george bm_lewis \
    ef_dora em_alex ff_siwis hf_alpha hf_beta hm_omega hm_psi if_sara im_nicola jf_alpha \
    jf_gongitsune jf_nezumi jf_tebukuro jm_kumo pf_dora pm_alex pm_santa zf_xiaobei zf_xiaoni \
    zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi zm_yunxia zm_yunyang";
/// The speakers of Kokoro en v0.19 (11).
const KOKORO_V0_19: &str =
    "af af_bella af_nicole af_sarah af_sky am_adam am_michael bf_emma bf_isabella bm_george bm_lewis";

/// The names of a model's `count` speakers, by number.
pub fn voice_names(model: &VoiceModel, count: usize) -> Vec<String> {
    let count = count.max(1);
    let known = match model {
        VoiceModel::Kokoro { .. } => [KOKORO_V1_1, KOKORO_V1_0, KOKORO_V0_19]
            .into_iter()
            .map(|t| t.split_whitespace().collect::<Vec<_>>())
            .find(|names| names.len() == count),
        VoiceModel::Vits { name, .. } if count == 1 => Some(vec![name.as_str()]),
        VoiceModel::Vits { .. } => None,
    };
    match known {
        Some(names) => names.into_iter().map(String::from).collect(),
        None => (0..count).map(|i| i.to_string()).collect(),
    }
}

/// The number of the voice `wanted` names: a name of `names`, or a number below their count.
pub fn voice_number(names: &[String], wanted: &str) -> Result<i32, String> {
    if let Some(i) = names.iter().position(|n| n == wanted) {
        return Ok(i as i32);
    }
    match wanted.parse::<usize>() {
        Ok(n) if n < names.len() => Ok(n as i32),
        _ => {
            let shown = if names.len() > 8 {
                format!(
                    "{} … (`speak <model> --list-voices` lists all {})",
                    names[..8].join(", "),
                    names.len()
                )
            } else {
                names.join(", ")
            };
            Err(format!(
                "no voice {wanted:?}; give a name or a number below {}: {shown}",
                names.len()
            ))
        }
    }
}

fn path(p: &Path) -> Result<String, String> {
    p.to_str()
        .map(String::from)
        .ok_or_else(|| format!("the model path {} is not valid UTF-8", p.display()))
}

fn paths(ps: &[PathBuf]) -> Result<Option<String>, String> {
    if ps.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        ps.iter()
            .map(|p| path(p))
            .collect::<Result<Vec<_>, _>>()?
            .join(","),
    ))
}

fn threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(4) as i32)
        .unwrap_or(1)
}

/// A loaded voice model.
pub struct Synthesizer {
    tts: OfflineTts,
    voices: Vec<String>,
}

impl Synthesizer {
    pub fn load(model: &VoiceModel) -> Result<Synthesizer, String> {
        let mut config = OfflineTtsConfig {
            // One sentence at a time: each comes out as soon as it is generated.
            max_num_sentences: 1,
            ..Default::default()
        };
        let m = &mut config.model;
        m.num_threads = threads();
        m.provider = Some("cpu".into());
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
        }
        let tts = OfflineTts::create(&config).ok_or_else(|| {
            format!(
                "cannot load the {} model (sherpa-onnx refused its files)",
                model.family()
            )
        })?;
        let voices = voice_names(model, tts.num_speakers().max(1) as usize);
        Ok(Synthesizer { tts, voices })
    }

    pub fn sample_rate(&self) -> u32 {
        self.tts.sample_rate().max(0) as u32
    }

    /// The voices' names, by number.
    pub fn voices(&self) -> &[String] {
        &self.voices
    }

    /// Generate `text` with voice `sid` at `speed` (1 is normal), handing each sentence's
    /// samples (mono, [`Synthesizer::sample_rate`]) to `on_audio` as it is generated.
    /// `on_audio` returns false to stop.
    pub fn generate(
        &self,
        text: &str,
        sid: i32,
        speed: f32,
        on_audio: impl FnMut(&[f32]) -> bool + 'static,
    ) -> Result<(), String> {
        let config = GenerationConfig {
            sid,
            speed,
            ..Default::default()
        };
        let mut on_audio = on_audio;
        let text = text.replace('\0', " ");
        self.tts
            .generate_with_config(
                &text,
                &config,
                Some(move |samples: &[f32], _progress: f32| on_audio(samples)),
            )
            .map(|_| ())
            .ok_or_else(|| "the voice model generated no audio".to_string())
    }
}

/// 16-bit little-endian PCM of `samples` (clipped to [-1, 1]).
pub fn pcm16(samples: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples.len() * 2);
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn kokoro_multi_lang_is_told_by_its_voices() {
        let dir = Path::new("/m/kokoro");
        let got = from_names(
            dir,
            &names(
                "date-zh.fst lexicon-gb-en.txt lexicon-us-en.txt lexicon-zh.txt LICENSE \
                 model.int8.onnx number-zh.fst phone-zh.fst README.md tokens.txt voices.bin",
            ),
            &names("dict espeak-ng-data"),
        )
        .unwrap();
        assert_eq!(
            got,
            VoiceModel::Kokoro {
                model: dir.join("model.int8.onnx"),
                voices: dir.join("voices.bin"),
                tokens: dir.join("tokens.txt"),
                lexicons: vec![dir.join("lexicon-us-en.txt"), dir.join("lexicon-zh.txt")],
                dict: Some(dir.join("dict")),
                fsts: ["date-zh.fst", "phone-zh.fst", "number-zh.fst"]
                    .map(|n| dir.join(n))
                    .to_vec(),
            }
        );
    }

    #[test]
    fn piper_is_one_onnx_file_named_by_its_voice() {
        let dir = Path::new("/m/piper");
        let got = from_names(
            dir,
            &names("en_US-lessac-medium.onnx en_US-lessac-medium.onnx.json tokens.txt MODEL_CARD"),
            &names("espeak-ng-data"),
        )
        .unwrap();
        assert_eq!(
            got,
            VoiceModel::Vits {
                model: dir.join("en_US-lessac-medium.onnx"),
                tokens: dir.join("tokens.txt"),
                lexicon: None,
                name: "lessac".into(),
            }
        );
        let with = from_names(dir, &names("a-b-c.onnx tokens.txt lexicon-en-us.txt"), &[]).unwrap();
        assert!(
            matches!(with, VoiceModel::Vits { lexicon: Some(ref l), .. } if l == &dir.join("lexicon-en-us.txt"))
        );
    }

    #[test]
    fn a_piper_voice_speaks_with_the_shared_lexicon_of_its_language() {
        assert_eq!(
            shared_lexicons("en_GB-alba-medium"),
            ["lexicon-en-gb.txt", "lexicon-en-us.txt"]
        );
        assert_eq!(
            shared_lexicons("en_US-lessac-medium"),
            ["lexicon-en-us.txt"]
        );
        assert_eq!(
            shared_lexicons("de_DE-thorsten-medium"),
            ["lexicon-de-de.txt"]
        );
    }

    #[test]
    fn a_piper_voice_without_a_lexicon_is_refused_or_finds_the_shared_one() {
        let root = std::env::temp_dir().join(format!(
            "pisr-voice-{}",
            crate::token::random_hex(6).unwrap()
        ));
        let dir = root.join("vits-piper-en_GB-alba-medium");
        fs::create_dir_all(&dir).unwrap();
        for n in ["en_GB-alba-medium.onnx", "tokens.txt"] {
            fs::write(dir.join(n), "x").unwrap();
        }
        let e = detect(&dir).unwrap_err();
        assert!(e.contains("has no lexicon"), "{e}");
        assert!(e.contains("put lexicon-en-gb.txt"), "{e}");
        assert!(e.contains(LEXICONS), "{e}");
        fs::write(root.join("lexicon-en-us.txt"), "hello || h").unwrap();
        let got = detect(&dir);
        let de = root.join("vits-piper-de_DE-thorsten-medium");
        fs::create_dir_all(&de).unwrap();
        for n in ["de_DE-thorsten-medium.onnx", "tokens.txt"] {
            fs::write(de.join(n), "x").unwrap();
        }
        let e_de = detect(&de).unwrap_err();
        fs::remove_dir_all(&root).unwrap();
        assert!(
            matches!(got, Ok(VoiceModel::Vits { lexicon: Some(ref l), .. }) if l == &root.join("lexicon-en-us.txt")),
            "{got:?}"
        );
        assert!(e_de.contains("an English lexicon only"), "{e_de}");
    }

    #[test]
    fn other_directories_are_refused_with_a_reason() {
        let dir = Path::new("/m");
        let e = from_names(dir, &names("README.md"), &[]).unwrap_err();
        assert!(e.contains("no model file"), "{e}");
        let e = from_names(dir, &names("a.onnx"), &[]).unwrap_err();
        assert!(e.contains("no tokens.txt"), "{e}");
        let e = from_names(dir, &names("a.onnx b.onnx tokens.txt"), &[]).unwrap_err();
        assert!(e.contains("more than one model"), "{e}");
        let e = from_names(dir, &names("x.onnx voices.bin tokens.txt"), &[]).unwrap_err();
        assert!(e.contains("no model.onnx"), "{e}");
        // A transcription model is not a voice.
        let e = from_names(
            dir,
            &names("encoder.onnx decoder.onnx joiner.onnx tokens.txt"),
            &[],
        )
        .unwrap_err();
        assert!(e.contains("more than one model"), "{e}");
    }

    #[test]
    fn a_missing_directory_is_named() {
        let e = detect(Path::new("/no/such/voice")).unwrap_err();
        assert_eq!(e, "no model directory at /no/such/voice");
    }

    #[test]
    fn voices_are_named_by_the_known_kokoro_lists_else_numbered() {
        let kokoro = from_names(
            Path::new("/k"),
            &names("model.onnx voices.bin tokens.txt"),
            &[],
        )
        .unwrap();
        let v = voice_names(&kokoro, 103);
        assert_eq!(v.len(), 103);
        assert_eq!((v[0].as_str(), v[2].as_str()), ("af_maple", "bf_vale"));
        assert_eq!(v[102], "zm_100");
        assert_eq!(voice_names(&kokoro, 53)[3], "af_heart");
        assert_eq!(voice_names(&kokoro, 11)[0], "af");
        assert_eq!(voice_names(&kokoro, 4), names("0 1 2 3"));
        let piper = from_names(
            Path::new("/p"),
            &names("de_DE-thorsten-medium.onnx tokens.txt"),
            &[],
        )
        .unwrap();
        assert_eq!(voice_names(&piper, 1), names("thorsten"));
        assert_eq!(voice_names(&piper, 0), names("thorsten"));
        assert_eq!(voice_names(&piper, 2), names("0 1"));
    }

    #[test]
    fn a_voice_is_a_name_or_a_number() {
        let v = names("af_maple af_sol bf_vale");
        assert_eq!(voice_number(&v, "bf_vale"), Ok(2));
        assert_eq!(voice_number(&v, "1"), Ok(1));
        let e = voice_number(&v, "3").unwrap_err();
        assert!(e.contains("below 3: af_maple, af_sol, bf_vale"), "{e}");
        assert!(voice_number(&v, "nobody").is_err());
        let many: Vec<String> = (0..20).map(|i| format!("v{i}")).collect();
        let e = voice_number(&many, "x").unwrap_err();
        assert!(e.contains("--list-voices` lists all 20"), "{e}");
    }

    #[test]
    fn samples_become_little_endian_16_bit() {
        assert_eq!(
            pcm16(&[0.0, 1.0, -1.0, 2.0]),
            [0, 0, 0xff, 0x7f, 0x01, 0x80, 0xff, 0x7f]
        );
    }
}
