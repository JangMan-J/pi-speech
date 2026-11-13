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
        assert_eq!(kinds(Kind::Transcription), 3);
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
