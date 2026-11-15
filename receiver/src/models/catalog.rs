//! The model catalogue: the local speech models the binary can download, with the size and
//! SHA-256 of each archive. Nothing here touches the network.
//!
//! Tests replace the built-in catalogue with a JSON file named by `PI_SPEECH_MODELS_CATALOG`
//! (an array of entries in the shape `models list` prints, with `url`, `sha256` and `dir`);
//! only such a catalogue may use plain `http://` URLs. An entry there may name a lexicon its voice
//! needs: `"lexicon":{"url","size","sha256"}`.
//!
//! A Piper voice speaks through a lexicon (sherpa-onnx 2.0 has no espeak-ng), which its archive
//! does not carry: such an entry names the shared lexicon, a file in the cache root that
//! `models download` fetches with the voice.

use serde_json::Value;
use std::path::Path;

/// The environment variable naming a catalogue file that replaces the built-in one (tests).
pub const CATALOG_ENV: &str = "PI_SPEECH_MODELS_CATALOG";

/// What a model does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Speech to text.
    Transcription,
    /// Text to speech.
    Speech,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Transcription => "transcription",
            Kind::Speech => "speech",
        }
    }

    fn parse(s: &str) -> Option<Kind> {
        match s {
            "transcription" => Some(Kind::Transcription),
            "speech" => Some(Kind::Speech),
            _ => None,
        }
    }
}

/// One downloadable model.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub id: String,
    pub kind: Kind,
    pub name: String,
    /// ISO 639-1 codes (639-3 where there is none).
    pub languages: Vec<String>,
    /// The archive's size in bytes.
    pub size: u64,
    pub url: String,
    /// The archive's SHA-256, lowercase hex.
    pub sha256: String,
    /// The directory the archive unpacks to, and the model's directory name in the cache.
    pub dir: String,
}

impl Entry {
    /// The archive's file name, the last part of its URL.
    pub fn archive_name(&self) -> &str {
        self.url.rsplit('/').next().unwrap_or(&self.url)
    }
}

/// A lexicon a voice needs: one file, shared by the voices that name it, kept in the cache root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Lexicon {
    /// The file's name in the cache root, the last part of its URL.
    pub name: String,
    pub url: String,
    /// The file's size in bytes.
    pub size: u64,
    /// The file's SHA-256, lowercase hex.
    pub sha256: String,
}

/// The catalogue in use.
#[derive(Clone, Debug)]
pub struct Catalog {
    pub entries: Vec<Entry>,
    /// The lexicon each voice needs, by entry id (only voices that need one).
    pub lexicons: Lexicons,
    /// Whether plain `http://` URLs may be fetched (only a test catalogue's).
    pub allow_http: bool,
}

impl Catalog {
    /// The built-in catalogue, or the file `PI_SPEECH_MODELS_CATALOG` names.
    pub fn load() -> Result<Catalog, String> {
        match std::env::var_os(CATALOG_ENV) {
            Some(p) if !p.is_empty() => {
                let path = Path::new(&p);
                let text = std::fs::read_to_string(path).map_err(|e| {
                    format!("cannot read the model catalogue {}: {e}", path.display())
                })?;
                let (entries, lexicons) = parse_with_lexicons(&text)
                    .map_err(|e| format!("bad model catalogue {}: {e}", path.display()))?;
                Ok(Catalog {
                    entries,
                    lexicons,
                    allow_http: true,
                })
            }
            _ => Ok(Catalog::builtin()),
        }
    }

    pub fn builtin() -> Catalog {
        Catalog {
            entries: BUILTIN.iter().map(Builtin::entry).collect(),
            lexicons: BUILTIN
                .iter()
                .filter_map(|b| Some((b.id.to_string(), b.lexicon?.lexicon())))
                .collect(),
            allow_http: false,
        }
    }

    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// The lexicon `entry` needs, if any.
    pub fn lexicon(&self, entry: &Entry) -> Option<&Lexicon> {
        self.lexicons
            .iter()
            .find(|(id, _)| *id == entry.id)
            .map(|(_, l)| l)
    }
}

/// Entries from a catalogue file's JSON.
pub fn parse(text: &str) -> Result<Vec<Entry>, String> {
    parse_with_lexicons(text).map(|(entries, _)| entries)
}

/// The lexicon each voice needs, by entry id.
pub type Lexicons = Vec<(String, Lexicon)>;

/// Entries from a catalogue file's JSON, with the lexicons they name.
pub fn parse_with_lexicons(text: &str) -> Result<(Vec<Entry>, Lexicons), String> {
    let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let items = value.as_array().ok_or("not a JSON array")?;
    let mut entries = Vec::new();
    let mut lexicons = Vec::new();
    for (i, v) in items.iter().enumerate() {
        let e = entry(v).map_err(|e| format!("entry {i}: {e}"))?;
        if let Some(l) = v.get("lexicon") {
            let l = lexicon(l).map_err(|e| format!("entry {i}: lexicon: {e}"))?;
            lexicons.push((e.id.clone(), l));
        }
        entries.push(e);
    }
    Ok((entries, lexicons))
}

fn lexicon(v: &Value) -> Result<Lexicon, String> {
    let s = |k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| format!("{k} must be a string"))
    };
    let url = s("url")?;
    let name = url.rsplit('/').next().unwrap_or("").to_string();
    if name.is_empty() || name.starts_with('.') || name.contains('\\') {
        return Err(format!(
            "the URL must end in a plain file name, got {url:?}"
        ));
    }
    Ok(Lexicon {
        name,
        size: v
            .get("size")
            .and_then(Value::as_u64)
            .ok_or("size must be a number")?,
        sha256: s("sha256")?.to_ascii_lowercase(),
        url,
    })
}

fn entry(v: &Value) -> Result<Entry, String> {
    let s = |k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| format!("{k} must be a string"))
    };
    let kind = s("kind")?;
    let languages = v
        .get("languages")
        .and_then(Value::as_array)
        .ok_or("languages must be an array")?
        .iter()
        .map(|l| {
            l.as_str()
                .map(String::from)
                .ok_or("languages must be strings")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let dir = s("dir")?;
    if dir.is_empty() || dir.starts_with('.') || dir.contains(['/', '\\']) {
        return Err(format!("dir must be a plain directory name, got {dir:?}"));
    }
    Ok(Entry {
        id: s("id")?,
        kind: Kind::parse(&kind).ok_or_else(|| format!("unknown kind {kind:?}"))?,
        name: s("name")?,
        languages,
        size: v
            .get("size")
            .and_then(Value::as_u64)
            .ok_or("size must be a number")?,
        url: s("url")?,
        sha256: s("sha256")?.to_ascii_lowercase(),
        dir,
    })
}

struct Builtin {
    id: &'static str,
    kind: Kind,
    name: &'static str,
    languages: &'static str,
    size: u64,
    /// After `releases/download/`.
    path: &'static str,
    sha256: &'static str,
    /// The lexicon the voice needs (a Piper voice).
    lexicon: Option<&'static BuiltinLexicon>,
}

struct BuiltinLexicon {
    /// After `releases/download/`.
    path: &'static str,
    size: u64,
    sha256: &'static str,
}

impl BuiltinLexicon {
    fn lexicon(&self) -> Lexicon {
        Lexicon {
            name: self.path.rsplit('/').next().unwrap_or(self.path).into(),
            url: format!("{RELEASES}{}", self.path),
            size: self.size,
            sha256: self.sha256.into(),
        }
    }
}

/// sherpa-onnx's English lexicon, the one its English Piper voices speak through.
const LEXICON_EN_US: BuiltinLexicon = BuiltinLexicon {
    path: "tts-models/lexicon-en-us.txt",
    size: 6_305_773,
    sha256: "8b67ae549a465eee78f92ecb74644ad90c3c58ce65f19c68baf85878a10ef73a",
};

const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/";

impl Builtin {
    fn entry(&self) -> Entry {
        let archive = self.path.rsplit('/').next().unwrap_or(self.path);
        Entry {
            id: self.id.into(),
            kind: self.kind,
            name: self.name.into(),
            languages: self
                .languages
                .split_whitespace()
                .map(String::from)
                .collect(),
            size: self.size,
            url: format!("{RELEASES}{}", self.path),
            sha256: self.sha256.into(),
            dir: archive.trim_end_matches(".tar.bz2").into(),
        }
    }
}

/// Parakeet TDT 0.6b v3's 25 European languages.
const PARAKEET_LANGUAGES: &str =
    "bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro sk sl es sv ru uk";
/// The 99 languages Whisper (before large-v3) was trained on.
const WHISPER_LANGUAGES: &str = "en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he \
    uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu \
    is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk \
    nn mt sa lb my bo tl mg as tt haw ln ha ba jw su";

/// Nemotron 3.5 ASR's languages (40 locales).
const NEMOTRON_LANGUAGES: &str =
    "en es fr it pt nl de tr ru ar hi ja ko vi uk pl sv cs nb da bg fi \
    hr sk zh hu ro et el lt lv mt sl he th nn";
/// Qwen3-ASR's 30 languages (and 22 Chinese dialects, under zh and yue).
const QWEN3_LANGUAGES: &str = "zh en yue ar de fr es pt id it ko ru th vi ja tr hi ms nl sv da fi \
    pl cs fil fa el hu mk ro";
/// Cohere Transcribe's 14 languages.
const COHERE_LANGUAGES: &str = "ar de el en es fr it ja ko nl pl pt vi zh";
/// Dolphin's 40 Eastern languages (and 22 Chinese dialects, under zh and yue); not English.
const DOLPHIN_LANGUAGES: &str =
    "zh ja th ru ko id vi yue hi ur ms uz ar fa bn ta te ug gu my tl kk \
    or ne mn km jv lo si fil ps pa kab ba ks tg su mr ky az";

const BUILTIN: &[Builtin] = &[
    Builtin {
        id: "parakeet-tdt-0.6b-v3-int8",
        kind: Kind::Transcription,
        name: "Parakeet TDT 0.6b v3 (int8)",
        languages: PARAKEET_LANGUAGES,
        size: 487_211_443,
        path: "asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
        sha256: "1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9",
        lexicon: None,
    },
    Builtin {
        id: "whisper-small",
        kind: Kind::Transcription,
        name: "Whisper small",
        languages: WHISPER_LANGUAGES,
        size: 639_387_718,
        path: "asr-models/sherpa-onnx-whisper-small.tar.bz2",
        sha256: "486a46afbb7ba798507190ffe02fea2dd726049af212e774537efac6afb210a6",
        lexicon: None,
    },
    Builtin {
        id: "sense-voice-int8",
        kind: Kind::Transcription,
        name: "SenseVoice (int8)",
        languages: "zh en ja ko yue",
        size: 163_002_883,
        path: "asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
        sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
        lexicon: None,
    },
    Builtin {
        id: "whisper-tiny.en",
        kind: Kind::Transcription,
        name: "Whisper tiny (English)",
        languages: "en",
        size: 118_071_777,
        path: "asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2",
        sha256: "2bd6cf965c8bb3e068ef9fa2191387ee63a9dfa2a4e37582a8109641c20005dd",
        lexicon: None,
    },
    Builtin {
        id: "whisper-base.en",
        kind: Kind::Transcription,
        name: "Whisper base (English)",
        languages: "en",
        size: 208_576_005,
        path: "asr-models/sherpa-onnx-whisper-base.en.tar.bz2",
        sha256: "475bc7052ce299c007f6d5d5407ba8601f819a2867f6eecee510ed17df581542",
        lexicon: None,
    },
    Builtin {
        id: "whisper-turbo",
        kind: Kind::Transcription,
        name: "Whisper large-v3 turbo",
        languages: WHISPER_LANGUAGES,
        size: 563_790_207,
        path: "asr-models/sherpa-onnx-whisper-turbo.tar.bz2",
        sha256: "b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22",
        lexicon: None,
    },
    Builtin {
        id: "whisper-distil-large-v3.5",
        kind: Kind::Transcription,
        name: "Distil-Whisper large-v3.5 (English)",
        languages: "en",
        size: 528_659_059,
        path: "asr-models/sherpa-onnx-whisper-distil-large-v3.5.tar.bz2",
        sha256: "ec874c7346d24ef8063e05430ede616d66d80a410360283099d0bdf659187b1d",
        lexicon: None,
    },
    Builtin {
        id: "moonshine-tiny-en-v2",
        kind: Kind::Transcription,
        name: "Moonshine v2 tiny, English",
        languages: "en",
        size: 29_858_559,
        path: "asr-models/sherpa-onnx-moonshine-tiny-en-quantized-2026-02-27.tar.bz2",
        sha256: "9ec31b342d8fa3240c3b81b8f82e1cf7e3ac467c93ca5a999b741d5887164f8d",
        lexicon: None,
    },
    Builtin {
        id: "moonshine-base-en-v2",
        kind: Kind::Transcription,
        name: "Moonshine v2 base, English",
        languages: "en",
        size: 111_266_225,
        path: "asr-models/sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2",
        sha256: "43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891",
        lexicon: None,
    },
    Builtin {
        id: "moonshine-base-es-v2",
        kind: Kind::Transcription,
        name: "Moonshine v2 base, Spanish",
        languages: "es",
        size: 50_846_902,
        path: "asr-models/sherpa-onnx-moonshine-base-es-quantized-2026-02-27.tar.bz2",
        sha256: "850c3dcc5dfccc8b1feb10bb221b11d6039b6f5c626241729f46863771016383",
        lexicon: None,
    },
    Builtin {
        id: "moonshine-base-zh-v2",
        kind: Kind::Transcription,
        name: "Moonshine v2 base, Chinese",
        languages: "zh",
        size: 99_905_420,
        path: "asr-models/sherpa-onnx-moonshine-base-zh-quantized-2026-02-27.tar.bz2",
        sha256: "6495d4240f66bcdd2bbbbfefaa687c463150d467854001270934e88940b733c1",
        lexicon: None,
    },
    Builtin {
        id: "moonshine-base-ja-v2",
        kind: Kind::Transcription,
        name: "Moonshine v2 base, Japanese",
        languages: "ja",
        size: 104_162_109,
        path: "asr-models/sherpa-onnx-moonshine-base-ja-quantized-2026-02-27.tar.bz2",
        sha256: "c66eb87d229a52d43bbe3b7c52a1d23f6208c0fd7c2e81802ecbda83b192798a",
        lexicon: None,
    },
    Builtin {
        id: "moonshine-tiny-ko-v2",
        kind: Kind::Transcription,
        name: "Moonshine v2 tiny, Korean",
        languages: "ko",
        size: 49_153_415,
        path: "asr-models/sherpa-onnx-moonshine-tiny-ko-quantized-2026-02-27.tar.bz2",
        sha256: "d3b6c5390a7859c9ef20ff4f20b0766fcbad1dc06c0f509fe4840a3a302112dc",
        lexicon: None,
    },
    Builtin {
        id: "moonshine-base-ar-v2",
        kind: Kind::Transcription,
        name: "Moonshine v2 base, Arabic",
        languages: "ar",
        size: 119_143_068,
        path: "asr-models/sherpa-onnx-moonshine-base-ar-quantized-2026-02-27.tar.bz2",
        sha256: "4d3f16fe354d8536d3323d3eaf4c12fafb1976b5dc0a12862ab25934da94285b",
        lexicon: None,
    },
    Builtin {
        id: "moonshine-base-uk-v2",
        kind: Kind::Transcription,
        name: "Moonshine v2 base, Ukrainian",
        languages: "uk",
        size: 111_037_143,
        path: "asr-models/sherpa-onnx-moonshine-base-uk-quantized-2026-02-27.tar.bz2",
        sha256: "d8489b159afabf4cfb734002ae8a5361781ff8a381fa18d284d32d1eeb1c0376",
        lexicon: None,
    },
    Builtin {
        id: "moonshine-base-vi-v2",
        kind: Kind::Transcription,
        name: "Moonshine v2 base, Vietnamese",
        languages: "vi",
        size: 106_719_129,
        path: "asr-models/sherpa-onnx-moonshine-base-vi-quantized-2026-02-27.tar.bz2",
        sha256: "97b53f5fb75a2a9dd6327440a34f45fc06c927ed2fa7217e5ebe54058e269416",
        lexicon: None,
    },
    Builtin {
        id: "parakeet-tdt-0.6b-v2-int8",
        kind: Kind::Transcription,
        name: "Parakeet TDT 0.6b v2, English (int8)",
        languages: "en",
        size: 482_440_461,
        path: "asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
        sha256: "6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714",
        lexicon: None,
    },
    Builtin {
        id: "parakeet-tdt-0.6b-redux-int8",
        kind: Kind::Transcription,
        name: "Parakeet TDT 0.6b Redux (int8)",
        languages: PARAKEET_LANGUAGES,
        size: 327_703_955,
        path: "asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-redux-int8.tar.bz2",
        sha256: "6f76c0ff70de59cc4f23fa046a7449e6d7448ac6473496e923b2a65afe4dba32",
        lexicon: None,
    },
    Builtin {
        id: "parakeet-tdt-110m-en-int8",
        kind: Kind::Transcription,
        name: "Parakeet TDT 110m, English (int8)",
        languages: "en",
        size: 108_035_095,
        path: "asr-models/sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8.tar.bz2",
        sha256: "f628312e9fdf8686374cb01a69425c41732529d540860311f16f37cbc32cfe9b",
        lexicon: None,
    },
    Builtin {
        id: "canary-180m-flash-int8",
        kind: Kind::Transcription,
        name: "Canary 180M Flash (int8; set the language)",
        languages: "en es de fr",
        size: 153_692_328,
        path: "asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8.tar.bz2",
        sha256: "7a38ed8b13f014ad632b09ff8d22e0c6f1359dd046af9235d281dfae841b9ab9",
        lexicon: None,
    },
    Builtin {
        id: "nemotron-3.5-asr-0.6b-int8",
        kind: Kind::Transcription,
        name: "Nemotron 3.5 ASR 0.6b (int8)",
        languages: NEMOTRON_LANGUAGES,
        size: 475_271_763,
        path: "asr-models/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11.tar.bz2",
        sha256: "c6bf5e0df765f9d5b43bc9e0536d4b4b3e7d40bdf5ecf13e45f134c51c05ae3a",
        lexicon: None,
    },
    Builtin {
        id: "qwen3-asr-0.6b-int8",
        kind: Kind::Transcription,
        name: "Qwen3-ASR 0.6B (int8)",
        languages: QWEN3_LANGUAGES,
        size: 878_702_423,
        path: "asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2",
        sha256: "393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96",
        lexicon: None,
    },
    Builtin {
        id: "cohere-transcribe-int8",
        kind: Kind::Transcription,
        name: "Cohere Transcribe (int8)",
        languages: COHERE_LANGUAGES,
        size: 1_699_791_751,
        path: "asr-models/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01.tar.bz2",
        sha256: "bd582588d50685a795dcd2807ab77e11361b8312d96c53884682def45ab4206d",
        lexicon: None,
    },
    Builtin {
        id: "dolphin-base-int8",
        kind: Kind::Transcription,
        name: "Dolphin base (int8)",
        languages: DOLPHIN_LANGUAGES,
        size: 80_671_385,
        path: "asr-models/sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02.tar.bz2",
        sha256: "6f23da2303c3c2e5fa6445c450fa2a7133cd57e3da070ae5f97ab9e0dfbb4a54",
        lexicon: None,
    },
    Builtin {
        id: "omnilingual-300m-v2-int8",
        kind: Kind::Transcription,
        name: "Omnilingual ASR 300M v2 (int8)",
        languages: "mul",
        size: 292_313_120,
        path: "asr-models/sherpa-onnx-omnilingual-asr-1600-languages-300M-ctc-v2-int8-2026-02-05.tar.bz2",
        sha256: "951b32409aade32bd525310bb39e9666773ba3fc611a39e817f620936d76c631",
        lexicon: None,
    },
    Builtin {
        id: "kokoro-multi-lang-v1.1-int8",
        kind: Kind::Speech,
        name: "Kokoro multi-lang v1.1 (int8)",
        languages: "en zh",
        size: 147_052_523,
        path: "tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2",
        sha256: "259c9c8bc906d6078e4e0570421885dabb68b539c2f970fcbb890a58eeaf3e9c",
        lexicon: None,
    },
    Builtin {
        id: "piper-en_US-lessac-medium",
        kind: Kind::Speech,
        name: "Piper lessac (US English)",
        languages: "en",
        size: 67_230_653,
        path: "tts-models/vits-piper-en_US-lessac-medium.tar.bz2",
        sha256: "9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_GB-alba-medium",
        kind: Kind::Speech,
        name: "Piper alba (British English)",
        languages: "en",
        size: 67_212_349,
        path: "tts-models/vits-piper-en_GB-alba-medium.tar.bz2",
        sha256: "fcd45962906933eec4431d3688f7d74aaac8713c87c6717f91fd3b23463aa1a1",
        lexicon: Some(&LEXICON_EN_US),
    },
    // German, French and Spanish Piper voices (thorsten, siwis, davefx) are left out for now:
    // sherpa-onnx 2.0 has no espeak-ng, so a Piper voice speaks only through a lexicon, and
    // sherpa-onnx publishes an English one only. A lexicon for their language (`lexicon-de-de.txt`
    // and so on, named by `synthesize::shared_lexicons`), or a phonemizer in the receiver, would
    // bring them back: e.g. `tts-models/vits-piper-de_DE-thorsten-medium.tar.bz2`, 67_214_254
    // bytes, SHA-256 50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714.
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_builtin_catalogue_is_https_with_checksums_and_unique_ids() {
        let c = Catalog::builtin();
        assert!(!c.allow_http);
        let mut ids: Vec<_> = c.entries.iter().map(|e| e.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), c.entries.len());
        for e in &c.entries {
            assert!(
                e.url.starts_with(
                    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
                ) || e.url.starts_with(
                    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/"
                ),
                "{}",
                e.url
            );
            assert_eq!(e.sha256.len(), 64, "{}", e.id);
            assert!(e
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
            assert!(e.size > 1_000_000 && !e.languages.is_empty());
            assert_eq!(format!("{}.tar.bz2", e.dir), e.archive_name());
        }
        let kinds = |k| c.entries.iter().filter(|e| e.kind == k).count();
        assert_eq!(kinds(Kind::Transcription), 25);
        assert_eq!(kinds(Kind::Speech), 3);
        // Every Piper voice names the English lexicon; Kokoro carries its own.
        for e in c.entries.iter().filter(|e| e.kind == Kind::Speech) {
            let lexicon = c.lexicon(e);
            if e.id.starts_with("piper-") {
                assert!(e.id.starts_with("piper-en_"), "{}", e.id);
                let l = lexicon.unwrap();
                assert_eq!(l.name, "lexicon-en-us.txt");
                assert_eq!(
                    l.url,
                    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/lexicon-en-us.txt"
                );
                assert_eq!(l.size, 6_305_773);
                assert_eq!(l.sha256.len(), 64);
            } else {
                assert!(lexicon.is_none(), "{}", e.id);
            }
        }
        // The directories earlier versions unpacked by hand are found as downloaded.
        assert_eq!(
            c.get("parakeet-tdt-0.6b-v3-int8").unwrap().dir,
            "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
        );
        assert_eq!(
            c.get("whisper-small").unwrap().dir,
            "sherpa-onnx-whisper-small"
        );
    }

    #[test]
    fn a_catalogue_file_is_parsed_and_checked() {
        let good = r#"[{"id":"t","kind":"speech","name":"T","languages":["en"],"size":3,
            "url":"http://127.0.0.1:1/t.tar.bz2","sha256":"AB","dir":"t"}]"#;
        let e = &parse(good).unwrap()[0];
        assert_eq!((e.id.as_str(), e.kind, e.size), ("t", Kind::Speech, 3));
        assert_eq!(e.sha256, "ab");
        assert!(parse("{}").is_err());
        assert!(parse(&good.replace("speech", "music"))
            .unwrap_err()
            .contains("kind"));
        let escape = good.replace(r#""dir":"t""#, r#""dir":"../t""#);
        assert!(parse(&escape).unwrap_err().contains("dir"));
        let (_, none) = parse_with_lexicons(good).unwrap();
        assert!(none.is_empty());
        let with = good.replace(
            r#""dir":"t""#,
            r#""dir":"t","lexicon":{"url":"http://127.0.0.1:1/lex.txt","size":5,"sha256":"CD"}"#,
        );
        let (_, lexicons) = parse_with_lexicons(&with).unwrap();
        assert_eq!(
            lexicons,
            vec![(
                "t".to_string(),
                Lexicon {
                    name: "lex.txt".into(),
                    url: "http://127.0.0.1:1/lex.txt".into(),
                    size: 5,
                    sha256: "cd".into(),
                }
            )]
        );
        let bad = with.replace("lex.txt", "");
        assert!(parse_with_lexicons(&bad).unwrap_err().contains("lexicon"));
    }
}
