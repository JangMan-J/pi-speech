//! The model catalogue: the local speech models the binary can download, with the size and
//! SHA-256 of each archive. Nothing here touches the network.
//!
//! Tests replace the built-in catalogue with a JSON file named by `PI_SPEECH_MODELS_CATALOG`
//! (an array of entries in the shape `models list` prints, with `url`, `sha256` and `dir`);
//! only such a catalogue may use plain `http://` URLs.

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

/// The catalogue in use.
#[derive(Clone, Debug)]
pub struct Catalog {
    pub entries: Vec<Entry>,
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
                let entries = parse(&text)
                    .map_err(|e| format!("bad model catalogue {}: {e}", path.display()))?;
                Ok(Catalog {
                    entries,
                    allow_http: true,
                })
            }
            _ => Ok(Catalog::builtin()),
        }
    }

    pub fn builtin() -> Catalog {
        Catalog {
            entries: BUILTIN.iter().map(Builtin::entry).collect(),
            allow_http: false,
        }
    }

    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }
}

/// Entries from a catalogue file's JSON.
pub fn parse(text: &str) -> Result<Vec<Entry>, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let items = value.as_array().ok_or("not a JSON array")?;
    items
        .iter()
        .enumerate()
        .map(|(i, v)| entry(v).map_err(|e| format!("entry {i}: {e}")))
        .collect()
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
}

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
    },
    Builtin {
        id: "whisper-small",
        kind: Kind::Transcription,
        name: "Whisper small",
        languages: WHISPER_LANGUAGES,
        size: 639_387_718,
        path: "asr-models/sherpa-onnx-whisper-small.tar.bz2",
        sha256: "486a46afbb7ba798507190ffe02fea2dd726049af212e774537efac6afb210a6",
    },
    Builtin {
        id: "sense-voice-int8",
        kind: Kind::Transcription,
        name: "SenseVoice (int8)",
        languages: "zh en ja ko yue",
        size: 163_002_883,
        path: "asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
        sha256: "7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e",
    },
    Builtin {
        id: "kokoro-multi-lang-v1.1-int8",
        kind: Kind::Speech,
        name: "Kokoro multi-lang v1.1 (int8)",
        languages: "en zh",
        size: 147_052_523,
        path: "tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2",
        sha256: "259c9c8bc906d6078e4e0570421885dabb68b539c2f970fcbb890a58eeaf3e9c",
    },
    Builtin {
        id: "piper-en_US-lessac-medium",
        kind: Kind::Speech,
        name: "Piper lessac (US English)",
        languages: "en",
        size: 67_230_653,
        path: "tts-models/vits-piper-en_US-lessac-medium.tar.bz2",
        sha256: "9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e",
    },
    Builtin {
        id: "piper-en_GB-alba-medium",
        kind: Kind::Speech,
        name: "Piper alba (British English)",
        languages: "en",
        size: 67_212_349,
        path: "tts-models/vits-piper-en_GB-alba-medium.tar.bz2",
        sha256: "fcd45962906933eec4431d3688f7d74aaac8713c87c6717f91fd3b23463aa1a1",
    },
    Builtin {
        id: "piper-de_DE-thorsten-medium",
        kind: Kind::Speech,
        name: "Piper thorsten (German)",
        languages: "de",
        size: 67_214_254,
        path: "tts-models/vits-piper-de_DE-thorsten-medium.tar.bz2",
        sha256: "50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714",
    },
    Builtin {
        id: "piper-fr_FR-siwis-medium",
        kind: Kind::Speech,
        name: "Piper siwis (French)",
        languages: "fr",
        size: 67_207_459,
        path: "tts-models/vits-piper-fr_FR-siwis-medium.tar.bz2",
        sha256: "375909aa30842b3a4efa10b1beb1d761af792960ae6873b4d53889f96c66195b",
    },
    Builtin {
        id: "piper-es_ES-davefx-medium",
        kind: Kind::Speech,
        name: "Piper davefx (Spanish)",
        languages: "es",
        size: 67_184_952,
        path: "tts-models/vits-piper-es_ES-davefx-medium.tar.bz2",
        sha256: "a3f6beb54a9cb893279f72978a22f807a4d9fc9c7848157b524d5cc7b7f58b22",
    },
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
        assert_eq!(kinds(Kind::Speech), 6);
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
    }
}
