//! Text to speech with a local voice model: which model a directory holds, its voices, and
//! audio generated sentence by sentence.
//!
//! - Kokoro: `model.onnx` (or `model.int8.onnx`), `voices.bin` and `tokens.txt`, with the
//!   lexicons (`lexicon-*.txt`) and, for Chinese, `dict/` and the `*-zh.fst` rules of
//!   sherpa-onnx's multi-lang exports.
//! - Kitten: the same three files as Kokoro, in a directory named `kitten-…` (as sherpa-onnx
//!   names every Kitten package), and a lexicon.
//! - Piper (and other VITS voices): one `<name>.onnx` and `tokens.txt`, and a lexicon.
//! - Supertonic: `duration_predictor`, `text_encoder`, `vector_estimator` and `vocoder` (each
//!   `.onnx` or `.int8.onnx`), `tts.json`, `unicode_indexer.bin` and `voice.bin`. It reads text
//!   itself (no lexicon), in the language it is told ([`SUPERTONIC_LANGUAGES`]).
//! - Pocket TTS: `lm_flow`, `lm_main`, `encoder`, `decoder` and `text_conditioner` (`.onnx` or
//!   `.int8.onnx`), `vocab.json` and `token_scores.json`; it speaks in the voice of a short
//!   reference clip, and its voices are the `.wav` files in `test_wavs/`, named by their stems.
//!
//! sherpa-onnx 2.0 no longer runs espeak-ng (`espeak-ng-data/` is ignored): words are spoken
//! through a lexicon. Piper and Kitten archives carry none, so such a voice uses `lexicon*.txt` in
//! its own directory, else the shared lexicon of its language beside it, in the parent directory
//! (the model cache): `lexicon-en-us.txt` from sherpa-onnx's `tts-models` release, the only one
//! published so far (English voices of other regions use it too, and Kitten, which is English).

use sherpa_onnx::{GenerationConfig, OfflineTts, OfflineTtsConfig, Wave};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;

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
    Kitten {
        model: PathBuf,
        voices: PathBuf,
        tokens: PathBuf,
        /// In the model's directory; [`detect`] looks beside it when there is none.
        lexicon: Option<PathBuf>,
    },
    Supertonic {
        duration_predictor: PathBuf,
        text_encoder: PathBuf,
        vector_estimator: PathBuf,
        vocoder: PathBuf,
        tts_json: PathBuf,
        unicode_indexer: PathBuf,
        /// The voices' styles, one per speaker.
        voice_style: PathBuf,
    },
    Pocket {
        lm_flow: PathBuf,
        lm_main: PathBuf,
        encoder: PathBuf,
        decoder: PathBuf,
        text_conditioner: PathBuf,
        vocab_json: PathBuf,
        token_scores_json: PathBuf,
        /// The voices: reference clips (WAV), in the order of their names. [`from_names`] leaves
        /// it empty; [`detect`] fills it from `test_wavs/`.
        references: Vec<PathBuf>,
    },
}

impl VoiceModel {
    pub fn family(&self) -> &'static str {
        match self {
            VoiceModel::Kokoro { .. } => "Kokoro",
            VoiceModel::Vits { .. } => "Piper (VITS)",
            VoiceModel::Kitten { .. } => "Kitten",
            VoiceModel::Supertonic { .. } => "Supertonic",
            VoiceModel::Pocket { .. } => "Pocket TTS",
        }
    }

    /// The languages the model is told to speak in (`--lang`), the default first; empty for a
    /// model that speaks the language of its voice.
    pub fn languages(&self) -> Vec<&'static str> {
        match self {
            VoiceModel::Supertonic { .. } => SUPERTONIC_LANGUAGES.split_whitespace().collect(),
            _ => Vec::new(),
        }
    }
}

const SUPPORTED: &str =
    "a Kokoro, Kitten, Piper, Supertonic or Pocket TTS voice model from sherpa-onnx";

/// The languages Supertonic 3 is told to read its text in, English (the default) first.
pub const SUPERTONIC_LANGUAGES: &str = "en ar bg cs da de el es et fi fr hi hr hu id it ja ko lt \
    lv nl pl pt ro ru sk sl sv tr uk vi";

/// The directory in a Pocket TTS model that holds its voices' reference clips.
pub const POCKET_VOICES_DIR: &str = "test_wavs";

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
    let wants_lexicon = match &mut found {
        VoiceModel::Vits {
            model,
            lexicon: lexicon @ None,
            ..
        } => {
            let stem = model.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            Some((shared_lexicons(stem), lexicon))
        }
        VoiceModel::Kitten {
            lexicon: lexicon @ None,
            ..
        } => Some((shared_lexicons(KITTEN_LOCALE), lexicon)),
        _ => None,
    };
    if let Some((names, lexicon)) = wants_lexicon {
        // A directory given as a bare name has the working directory as its parent.
        let parent = match dir.parent() {
            Some(p) if p.as_os_str().is_empty() => Path::new("."),
            p => p.unwrap_or(dir),
        };
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
    if let VoiceModel::Pocket { references, .. } = &mut found {
        *references = pocket_references(&dir.join(POCKET_VOICES_DIR));
        if references.is_empty() {
            return Err(format!(
                "the Pocket TTS model in {shown} has no voices: it speaks in the voice of a short \
                 reference clip, a .wav file in {}",
                dir.join(POCKET_VOICES_DIR).display()
            ));
        }
    }
    Ok(found)
}

/// The `.wav` files in `dir`, by name (none when it cannot be read).
fn pocket_references(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("wav"))
                && p.file_stem().and_then(|s| s.to_str()).is_some()
                && p.is_file()
        })
        .collect();
    out.sort();
    out
}

/// The locale of a Kitten voice, for its shared lexicon: Kitten speaks US English.
const KITTEN_LOCALE: &str = "en_US";

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
    // Supertonic and Pocket TTS have no tokens.txt; each is told by the models only it has.
    let family_files = |family: &str, onnx_stems: &[&str], others: &[&str]| {
        let mut found = Vec::new();
        let mut missing = Vec::new();
        for stem in onnx_stems {
            match onnx_file(files, stem) {
                Some(f) => found.push(p(f)),
                None => missing.push(format!("{stem}.onnx")),
            }
        }
        for n in others {
            if has(n) {
                found.push(p(n));
            } else {
                missing.push(n.to_string());
            }
        }
        if missing.is_empty() {
            Ok(found)
        } else {
            Err(format!(
                "it holds part of a {family} model; missing: {}",
                missing.join(", ")
            ))
        }
    };
    let any_onnx = |stems: &[&str]| stems.iter().any(|s| onnx_file(files, s).is_some());
    if any_onnx(&["duration_predictor", "text_encoder", "vector_estimator"])
        || has("unicode_indexer.bin")
    {
        let f = family_files(
            "Supertonic",
            &[
                "duration_predictor",
                "text_encoder",
                "vector_estimator",
                "vocoder",
            ],
            &["tts.json", "unicode_indexer.bin", "voice.bin"],
        )?;
        let [duration_predictor, text_encoder, vector_estimator, vocoder, tts_json, unicode_indexer, voice_style] =
            <[PathBuf; 7]>::try_from(f).expect("seven parts");
        return Ok(VoiceModel::Supertonic {
            duration_predictor,
            text_encoder,
            vector_estimator,
            vocoder,
            tts_json,
            unicode_indexer,
            voice_style,
        });
    }
    if any_onnx(&["lm_flow", "lm_main", "text_conditioner"]) {
        let f = family_files(
            "Pocket TTS",
            &[
                "lm_flow",
                "lm_main",
                "encoder",
                "decoder",
                "text_conditioner",
            ],
            &["vocab.json", "token_scores.json"],
        )?;
        let [lm_flow, lm_main, encoder, decoder, text_conditioner, vocab_json, token_scores_json] =
            <[PathBuf; 7]>::try_from(f).expect("seven parts");
        return Ok(VoiceModel::Pocket {
            lm_flow,
            lm_main,
            encoder,
            decoder,
            text_conditioner,
            vocab_json,
            token_scores_json,
            references: Vec::new(),
        });
    }
    if !has("tokens.txt") {
        return Err(format!("it has {} but no tokens.txt", onnx[0]));
    }
    // sherpa-onnx names every Kitten package kitten-…; its files are Kokoro's.
    let kitten = dir
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.to_ascii_lowercase().starts_with("kitten"));
    if has("voices.bin") && kitten {
        let model = ["model.int8.onnx", "model.onnx"]
            .into_iter()
            .find(|n| has(n))
            .ok_or("it has voices.bin (Kitten) but no model.onnx or model.int8.onnx")?;
        return Ok(VoiceModel::Kitten {
            model: p(model),
            voices: p("voices.bin"),
            tokens: p("tokens.txt"),
            lexicon: own_lexicon(files).map(p),
        });
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
    Ok(VoiceModel::Vits {
        model: p(file),
        tokens: p("tokens.txt"),
        lexicon: own_lexicon(files).map(p),
        name: name.to_string(),
    })
}

/// The model `<stem>.int8.onnx`, else `<stem>.onnx`, of `files`.
fn onnx_file<'a>(files: &'a [String], stem: &str) -> Option<&'a str> {
    [format!("{stem}.int8.onnx"), format!("{stem}.onnx")]
        .into_iter()
        .find_map(|n| files.iter().find(|f| **f == n))
        .map(String::as_str)
}

/// A voice's own lexicon among `files`: `lexicon.txt`, else the first `lexicon*.txt`.
fn own_lexicon(files: &[String]) -> Option<&str> {
    if files.iter().any(|f| f == "lexicon.txt") {
        return Some("lexicon.txt");
    }
    files
        .iter()
        .filter(|f| f.starts_with("lexicon") && f.ends_with(".txt"))
        .min()
        .map(String::as_str)
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

/// The speakers of Kitten (8), in sherpa-onnx's order (`expr-voice-2-m`, `expr-voice-2-f`, …,
/// `expr-voice-5-f`), by the names KittenML gives them.
const KITTEN: &str = "Jasper Bella Bruno Luna Hugo Rosie Leo Kiki";
/// The speakers of Supertonic (10), in sherpa-onnx's order (its `voice.bin` merges Supertone's
/// voice styles sorted by name).
const SUPERTONIC: &str = "F1 F2 F3 F4 F5 M1 M2 M3 M4 M5";

/// The names of a model's `count` speakers, by number. A Pocket TTS model's voices are its
/// reference clips, whatever `count` is.
pub fn voice_names(model: &VoiceModel, count: usize) -> Vec<String> {
    let count = count.max(1);
    let listed = |t: &'static str| Some(t.split_whitespace().collect::<Vec<_>>());
    let known = match model {
        VoiceModel::Kokoro { .. } => [KOKORO_V1_1, KOKORO_V1_0, KOKORO_V0_19]
            .into_iter()
            .map(|t| t.split_whitespace().collect::<Vec<_>>())
            .find(|names| names.len() == count),
        VoiceModel::Vits { name, .. } if count == 1 => Some(vec![name.as_str()]),
        VoiceModel::Vits { .. } => None,
        VoiceModel::Kitten { .. } => listed(KITTEN).filter(|n| n.len() == count),
        VoiceModel::Supertonic { .. } => listed(SUPERTONIC).filter(|n| n.len() == count),
        VoiceModel::Pocket { references, .. } => Some(
            references
                .iter()
                .filter_map(|r| r.file_stem().and_then(|s| s.to_str()))
                .collect(),
        ),
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
    /// A Pocket TTS model's reference clips, one per voice; empty for the others.
    references: Vec<PathBuf>,
    languages: Vec<&'static str>,
    family: &'static str,
    /// Whether sherpa-onnx hands the audio over sentence by sentence; else (Kitten, which hands
    /// over nothing until the end, and Supertonic, which hands over all of it at the end) the
    /// text is given to it one sentence at a time.
    streams: bool,
}

impl Synthesizer {
    /// Load `model`, where [`crate::engines::recognize::PROVIDER_ENV`] says (`cuda` on a build
    /// linked with the GPU libraries), else on the CPU; a model the GPU refuses runs on the CPU.
    pub fn load(model: &VoiceModel) -> Result<Synthesizer, String> {
        let wanted = crate::engines::recognize::provider();
        match Self::load_on(model, &wanted) {
            Err(_) if wanted != "cpu" => Self::load_on(model, "cpu"),
            r => r,
        }
    }

    fn load_on(model: &VoiceModel, provider: &str) -> Result<Synthesizer, String> {
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
        }
        let tts = OfflineTts::create(&config).ok_or_else(|| {
            format!(
                "cannot load the {} model (sherpa-onnx refused its files)",
                model.family()
            )
        })?;
        let voices = voice_names(model, tts.num_speakers().max(1) as usize);
        let references = match model {
            VoiceModel::Pocket { references, .. } => references.clone(),
            _ => Vec::new(),
        };
        Ok(Synthesizer {
            tts,
            voices,
            references,
            languages: model.languages(),
            family: model.family(),
            streams: !matches!(
                model,
                VoiceModel::Kitten { .. } | VoiceModel::Supertonic { .. }
            ),
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.tts.sample_rate().max(0) as u32
    }

    /// The voices' names, by number.
    pub fn voices(&self) -> &[String] {
        &self.voices
    }

    /// The languages the model is told to speak in, the default first (see
    /// [`VoiceModel::languages`]).
    pub fn languages(&self) -> &[&'static str] {
        &self.languages
    }

    /// Generate `text` with voice `sid` at `speed` (1 is normal), in `language` (one of
    /// [`Synthesizer::languages`]; `None` is the first), handing each sentence's samples (mono,
    /// [`Synthesizer::sample_rate`]) to `on_audio` as it is generated. `on_audio` returns false
    /// to stop. Text with no letter or digit makes no audio.
    pub fn generate(
        &self,
        text: &str,
        sid: i32,
        speed: f32,
        language: Option<&str>,
        on_audio: impl FnMut(&[f32]) -> bool + 'static,
    ) -> Result<(), String> {
        let mut config = GenerationConfig {
            sid,
            speed,
            ..Default::default()
        };
        if let Some(lang) = pick_language(&self.languages, language, self.family)? {
            config.extra = Some(HashMap::from([("lang".to_string(), lang.into())]));
        }
        if !self.references.is_empty() {
            // Pocket TTS: the voice is a reference clip, not a speaker number.
            let clip = usize::try_from(sid)
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
        }
        let text = text.replace('\0', " ");
        let pieces = sentences(&text);
        if pieces.is_empty() {
            // No letter or digit: nothing to say (Pocket TTS would make up 40 s of babble).
            return Ok(());
        }
        let pieces = if self.streams {
            vec![text.as_str()]
        } else {
            pieces
        };
        let on_audio = Rc::new(RefCell::new(on_audio));
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

/// `text` in sentences: each ends after `.`, `!`, `?` or `…` (and any closing quotes or
/// brackets) before a space, or at a line break. Pieces with no letter or digit are left out.
pub fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut chars = text.char_indices().peekable();
    let mut ended = false;
    while let Some((i, c)) = chars.next() {
        let next = chars.peek().map(|&(_, n)| n);
        if matches!(c, '.' | '!' | '?' | '…' | '。' | '！' | '？') {
            ended = true;
        } else if ended && !matches!(c, '"' | '\'' | ')' | ']' | '”' | '’' | '»') {
            ended = false;
        }
        let end = i + c.len_utf8();
        if c == '\n' || (ended && next.is_none_or(char::is_whitespace)) {
            out.push(&text[start..end]);
            start = end;
            ended = false;
        }
    }
    out.push(&text[start..]);
    out.into_iter()
        .map(str::trim)
        .filter(|s| s.chars().any(char::is_alphanumeric))
        .collect()
}

/// The language to tell a model that speaks `languages` (the default first): `wanted`, else
/// the default; `None` for a model told none, which takes no `wanted` either.
pub fn pick_language(
    languages: &[&'static str],
    wanted: Option<&str>,
    family: &str,
) -> Result<Option<&'static str>, String> {
    match wanted {
        None => Ok(languages.first().copied()),
        Some(w) if languages.is_empty() => Err(format!(
            "the {family} model is not told a language (it speaks its voice's); \
             leave out {w:?}"
        )),
        Some(w) => languages
            .iter()
            .find(|l| l.eq_ignore_ascii_case(w))
            .map(|l| Some(*l))
            .ok_or_else(|| {
                format!(
                    "the {family} model does not speak {w:?}; it speaks {}",
                    languages.join(", ")
                )
            }),
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
    fn kitten_is_kokoros_files_in_a_kitten_directory() {
        let files = names("LICENSE model.int8.onnx README.md tokens.txt voices.bin");
        let dirs = names("espeak-ng-data");
        let dir = Path::new("/m/kitten-nano-en-v0_8-int8");
        let got = from_names(dir, &files, &dirs).unwrap();
        assert_eq!(
            got,
            VoiceModel::Kitten {
                model: dir.join("model.int8.onnx"),
                voices: dir.join("voices.bin"),
                tokens: dir.join("tokens.txt"),
                lexicon: None,
            }
        );
        assert_eq!(got.family(), "Kitten");
        // The same files elsewhere are Kokoro's.
        let kokoro = from_names(Path::new("/m/kokoro-en-v0_19"), &files, &dirs).unwrap();
        assert!(matches!(kokoro, VoiceModel::Kokoro { .. }), "{kokoro:?}");
        let mini = from_names(
            Path::new("/m/Kitten-mini"),
            &names("model.onnx tokens.txt voices.bin lexicon.txt"),
            &[],
        )
        .unwrap();
        assert!(
            matches!(mini, VoiceModel::Kitten { ref model, lexicon: Some(ref l), .. }
                if model.ends_with("model.onnx") && l.ends_with("lexicon.txt")),
            "{mini:?}"
        );
        let e = from_names(dir, &names("x.onnx tokens.txt voices.bin"), &[]).unwrap_err();
        assert!(e.contains("voices.bin (Kitten) but no model.onnx"), "{e}");
    }

    #[test]
    fn a_kitten_voice_speaks_with_the_shared_english_lexicon() {
        let root = std::env::temp_dir().join(format!(
            "pisr-kitten-{}",
            crate::token::random_hex(6).unwrap()
        ));
        let dir = root.join("kitten-mini-en-v0_8");
        fs::create_dir_all(dir.join("espeak-ng-data")).unwrap();
        for n in ["model.onnx", "tokens.txt", "voices.bin"] {
            fs::write(dir.join(n), "x").unwrap();
        }
        let e = detect(&dir).unwrap_err();
        fs::write(root.join("lexicon-en-us.txt"), "hello || h").unwrap();
        let got = detect(&dir);
        fs::remove_dir_all(&root).unwrap();
        assert!(e.contains("has no lexicon"), "{e}");
        assert!(e.contains("put lexicon-en-us.txt"), "{e}");
        assert!(
            matches!(got, Ok(VoiceModel::Kitten { lexicon: Some(ref l), .. }) if l == &root.join("lexicon-en-us.txt")),
            "{got:?}"
        );
    }

    #[test]
    fn supertonic_is_told_by_its_four_models_and_needs_no_tokens() {
        let dir = Path::new("/m/sherpa-onnx-supertonic-3-tts-int8-2026-05-11");
        let all = "duration_predictor.int8.onnx LICENSE README.md text_encoder.int8.onnx tts.json \
                   unicode_indexer.bin vector_estimator.int8.onnx vocoder.int8.onnx voice.bin";
        let got = from_names(dir, &names(all), &[]).unwrap();
        assert_eq!(
            got,
            VoiceModel::Supertonic {
                duration_predictor: dir.join("duration_predictor.int8.onnx"),
                text_encoder: dir.join("text_encoder.int8.onnx"),
                vector_estimator: dir.join("vector_estimator.int8.onnx"),
                vocoder: dir.join("vocoder.int8.onnx"),
                tts_json: dir.join("tts.json"),
                unicode_indexer: dir.join("unicode_indexer.bin"),
                voice_style: dir.join("voice.bin"),
            }
        );
        assert_eq!(got.family(), "Supertonic");
        // The int8 model is preferred to the float one beside it.
        let both = format!("{all} vocoder.onnx");
        let got = from_names(dir, &names(&both), &[]).unwrap();
        assert!(
            matches!(got, VoiceModel::Supertonic { ref vocoder, .. } if vocoder == &dir.join("vocoder.int8.onnx"))
        );
        let e = from_names(
            dir,
            &names("duration_predictor.onnx text_encoder.onnx vocoder.onnx tts.json"),
            &[],
        )
        .unwrap_err();
        assert!(
            e.contains(
                "part of a Supertonic model; missing: vector_estimator.onnx, \
                 unicode_indexer.bin, voice.bin"
            ),
            "{e}"
        );
    }

    #[test]
    fn pocket_tts_is_told_by_its_language_models() {
        let dir = Path::new("/m/sherpa-onnx-pocket-tts-int8-2026-01-26");
        let got = from_names(
            dir,
            &names(
                "decoder.int8.onnx encoder.onnx LICENSE lm_flow.int8.onnx lm_main.int8.onnx \
                 README.md text_conditioner.onnx token_scores.json vocab.json",
            ),
            &names("test_wavs"),
        )
        .unwrap();
        assert_eq!(
            got,
            VoiceModel::Pocket {
                lm_flow: dir.join("lm_flow.int8.onnx"),
                lm_main: dir.join("lm_main.int8.onnx"),
                encoder: dir.join("encoder.onnx"),
                decoder: dir.join("decoder.int8.onnx"),
                text_conditioner: dir.join("text_conditioner.onnx"),
                vocab_json: dir.join("vocab.json"),
                token_scores_json: dir.join("token_scores.json"),
                references: Vec::new(),
            }
        );
        assert_eq!(got.family(), "Pocket TTS");
        let e = from_names(dir, &names("lm_main.onnx encoder.onnx vocab.json"), &[]).unwrap_err();
        assert!(
            e.contains(
                "part of a Pocket TTS model; missing: lm_flow.onnx, decoder.onnx, \
                 text_conditioner.onnx, token_scores.json"
            ),
            "{e}"
        );
        // A transducer's encoder and decoder are not Pocket TTS.
        let e = from_names(dir, &names("encoder.onnx decoder.onnx tokens.txt"), &[]).unwrap_err();
        assert!(e.contains("more than one model"), "{e}");
    }

    #[test]
    fn pocket_tts_voices_are_the_reference_clips_in_test_wavs() {
        let dir = std::env::temp_dir().join(format!(
            "pisr-pocket-{}",
            crate::token::random_hex(6).unwrap()
        ));
        let files = "decoder.onnx encoder.onnx lm_flow.onnx lm_main.onnx text_conditioner.onnx \
                     token_scores.json vocab.json";
        fs::create_dir_all(&dir).unwrap();
        for n in files.split_whitespace() {
            fs::write(dir.join(n), "x").unwrap();
        }
        let e = detect(&dir).unwrap_err();
        let wavs = dir.join(POCKET_VOICES_DIR);
        fs::create_dir_all(wavs.join("not-a-clip.wav")).unwrap();
        for n in ["loona.wav", "bria.WAV", "notes.txt"] {
            fs::write(wavs.join(n), "x").unwrap();
        }
        let got = detect(&dir);
        fs::remove_dir_all(&dir).unwrap();
        assert!(e.contains("has no voices"), "{e}");
        assert!(e.contains("test_wavs"), "{e}");
        let got = got.unwrap();
        assert!(
            matches!(got, VoiceModel::Pocket { ref references, .. }
                if references == &[wavs.join("bria.WAV"), wavs.join("loona.wav")]),
            "{got:?}"
        );
        // Named by their stems, whatever number of speakers the model reports.
        assert_eq!(voice_names(&got, 1), names("bria loona"));
        assert_eq!(voice_names(&got, 0), names("bria loona"));
    }

    #[test]
    fn kitten_and_supertonic_voices_are_named() {
        let kitten = from_names(
            Path::new("/m/kitten-nano-en-v0_8-int8"),
            &names("model.int8.onnx tokens.txt voices.bin"),
            &[],
        )
        .unwrap();
        assert_eq!(
            voice_names(&kitten, 8),
            names("Jasper Bella Bruno Luna Hugo Rosie Leo Kiki")
        );
        assert_eq!(voice_names(&kitten, 3), names("0 1 2"));
        let supertonic = from_names(
            Path::new("/m/s"),
            &names(
                "duration_predictor.onnx text_encoder.onnx vector_estimator.onnx vocoder.onnx \
                 tts.json unicode_indexer.bin voice.bin",
            ),
            &[],
        )
        .unwrap();
        assert_eq!(
            voice_names(&supertonic, 10),
            names("F1 F2 F3 F4 F5 M1 M2 M3 M4 M5")
        );
        assert_eq!(voice_names(&supertonic, 2), names("0 1"));
    }

    #[test]
    fn only_supertonic_is_told_a_language_english_by_default() {
        let languages: Vec<&str> = SUPERTONIC_LANGUAGES.split_whitespace().collect();
        assert_eq!(languages.len(), 31);
        assert_eq!(languages[0], "en");
        let mut sorted = languages.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 31);
        let l = &languages;
        assert_eq!(pick_language(l, None, "Supertonic"), Ok(Some("en")));
        assert_eq!(pick_language(l, Some("de"), "Supertonic"), Ok(Some("de")));
        assert_eq!(pick_language(l, Some("DE"), "Supertonic"), Ok(Some("de")));
        let e = pick_language(l, Some("no"), "Supertonic").unwrap_err();
        assert!(
            e.contains("does not speak \"no\"; it speaks en, ar,"),
            "{e}"
        );
        assert_eq!(pick_language(&[], None, "Kokoro"), Ok(None));
        let e = pick_language(&[], Some("de"), "Kitten").unwrap_err();
        assert!(e.contains("the Kitten model is not told a language"), "{e}");
        let kokoro = from_names(
            Path::new("/k"),
            &names("model.onnx voices.bin tokens.txt"),
            &[],
        )
        .unwrap();
        assert!(kokoro.languages().is_empty());
    }

    #[test]
    fn text_is_cut_into_sentences_for_the_models_that_do_not_stream() {
        assert_eq!(
            sentences("Hello there. How are you?  Fine!\"Quoted.\" Next… and 3.5 apples."),
            [
                "Hello there.",
                "How are you?",
                "Fine!\"Quoted.\"",
                "Next…",
                "and 3.5 apples."
            ]
        );
        assert_eq!(
            sentences("A line\nanother (one.) ... \n\n end"),
            ["A line", "another (one.)", "end"]
        );
        assert_eq!(sentences("No full stop"), ["No full stop"]);
        assert!(sentences(" ... \n !").is_empty());
    }

    #[test]
    fn samples_become_little_endian_16_bit() {
        assert_eq!(
            pcm16(&[0.0, 1.0, -1.0, 2.0]),
            [0, 0, 0xff, 0x7f, 0x01, 0x80, 0xff, 0x7f]
        );
    }
}
