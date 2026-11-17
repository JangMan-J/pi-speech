//! The model catalogue: the local speech models the binary can download, with the size and
//! SHA-256 of each archive. Nothing here touches the network.
//!
//! Tests replace the built-in catalogue with a JSON file named by `PI_SPEECH_MODELS_CATALOG`
//! (an array of entries in the shape `models list` prints, with `url`, `sha256` and `dir`);
//! only such a catalogue may use plain `http://` URLs. An entry there may name a lexicon its voice
//! needs: `"lexicon":{"url","size","sha256"}`.
//!
//! A Piper or Kitten voice speaks through a lexicon (sherpa-onnx 2.0 has no espeak-ng), which its
//! archive does not carry: such an entry names the shared lexicon, a file in the cache root that
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

/// Whether a local transcription model is fast enough for live typing into Pi's editor.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LiveCapable {
    Always,
    Gpu,
    Never,
}

impl LiveCapable {
    pub fn as_str(self) -> &'static str {
        match self {
            LiveCapable::Always => "always",
            LiveCapable::Gpu => "gpu",
            LiveCapable::Never => "never",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "always" => Some(LiveCapable::Always),
            "gpu" => Some(LiveCapable::Gpu),
            "never" => Some(LiveCapable::Never),
            _ => None,
        }
    }
}

/// How a local model handles the spoken-language setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LanguageMode {
    Selectable,
    Auto,
    Fixed,
}

impl LanguageMode {
    pub fn as_str(self) -> &'static str {
        match self {
            LanguageMode::Selectable => "selectable",
            LanguageMode::Auto => "auto",
            LanguageMode::Fixed => "fixed",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "selectable" => Some(LanguageMode::Selectable),
            "auto" => Some(LanguageMode::Auto),
            "fixed" => Some(LanguageMode::Fixed),
            _ => None,
        }
    }
}

/// Declarative capability, grouping, and ranking metadata emitted by `models list`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EntryMeta {
    pub runtime: Option<String>,
    pub group: Option<String>,
    pub speakers: Option<u32>,
    pub live_capable: Option<LiveCapable>,
    pub language_mode: Option<LanguageMode>,
    pub tags: Option<String>,
    pub cpu_rank: Option<u16>,
    pub gpu_rank: Option<u16>,
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
    /// A model published as separate files (a Hugging Face repository) instead of one archive:
    /// each is fetched and checked on its own into the model's directory, and `url`, `sha256`
    /// say nothing (`size` is their sum). Empty for an archive.
    pub files: Vec<ModelFile>,
    /// Shared files (`lexicon`, `vocoder`) fetched into the cache root alongside this model.
    pub shared: Vec<Lexicon>,
    /// Capability, grouping, and ranking metadata for clients.
    pub meta: EntryMeta,
}

/// One file of a model published as separate files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelFile {
    /// Its path in the model's directory (`encoder.onnx`, `tokenizer/vocab.json`).
    pub name: String,
    pub url: String,
    pub size: u64,
    /// SHA-256, lowercase hex.
    pub sha256: String,
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
        let entries: Vec<Entry> = BUILTIN
            .iter()
            .map(Builtin::entry)
            .chain(BUILTIN_FILES.iter().map(BuiltinFiles::entry))
            .collect();
        let lexicons: Lexicons = entries
            .iter()
            .flat_map(|e| e.shared.iter().map(|l| (e.id.clone(), l.clone())))
            .collect();
        Catalog {
            entries,
            lexicons,
            allow_http: false,
        }
    }

    pub fn get(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|e| e.id == id)
    }

    /// All shared files (`lexicon`, `vocoder`) `entry` needs in the cache root.
    pub fn shared<'a>(&'a self, entry: &'a Entry) -> Vec<&'a Lexicon> {
        if !entry.shared.is_empty() {
            return entry.shared.iter().collect();
        }
        self.lexicons
            .iter()
            .filter(|(id, _)| *id == entry.id)
            .map(|(_, l)| l)
            .collect()
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
        let mut e = entry(v).map_err(|e| format!("entry {i}: {e}"))?;
        if let Some(l) = v.get("lexicon") {
            let l = lexicon(l).map_err(|e| format!("entry {i}: lexicon: {e}"))?;
            lexicons.push((e.id.clone(), l.clone()));
            e.shared.push(l);
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
    let files = match v.get("files") {
        None => Vec::new(),
        Some(f) => f
            .as_array()
            .ok_or("files must be an array")?
            .iter()
            .map(model_file)
            .collect::<Result<Vec<_>, _>>()?,
    };
    let opt_str = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
    let opt_u16 = |k: &str| {
        v.get(k)
            .and_then(Value::as_u64)
            .and_then(|n| u16::try_from(n).ok())
    };
    let opt_u32 = |k: &str| {
        v.get(k)
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };
    let meta = EntryMeta {
        runtime: opt_str("runtime"),
        group: opt_str("group"),
        speakers: opt_u32("speakers"),
        live_capable: opt_str("live_capable")
            .as_deref()
            .and_then(LiveCapable::parse),
        language_mode: opt_str("language_mode")
            .as_deref()
            .and_then(LanguageMode::parse),
        tags: opt_str("tags"),
        cpu_rank: opt_u16("cpu_rank"),
        gpu_rank: opt_u16("gpu_rank"),
    };
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
        sha256: if files.is_empty() {
            s("sha256")?.to_ascii_lowercase()
        } else {
            String::new()
        },
        dir,
        files,
        shared: Vec::new(),
        meta,
    })
}

fn model_file(v: &Value) -> Result<ModelFile, String> {
    let s = |k: &str| {
        v.get(k)
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| format!("files: {k} must be a string"))
    };
    let name = s("name")?;
    if !plain_relative(&name) {
        return Err(format!(
            "files: name must be a plain relative path, got {name:?}"
        ));
    }
    Ok(ModelFile {
        name,
        url: s("url")?,
        size: v
            .get("size")
            .and_then(Value::as_u64)
            .ok_or("files: size must be a number")?,
        sha256: s("sha256")?.to_ascii_lowercase(),
    })
}

/// A path that stays inside the model's directory: parts that are neither empty, `.`, `..`,
/// nor start with a dot; `/` between them.
pub fn plain_relative(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('\\')
        && name
            .split('/')
            .all(|p| !p.is_empty() && !p.starts_with('.'))
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
    /// The lexicon the voice needs (a Piper or Kitten voice).
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

/// sherpa-onnx's English lexicon, the one its English Piper, Kitten, Matcha and ZipVoice voices speak through.
const LEXICON_EN_US: BuiltinLexicon = BuiltinLexicon {
    path: "tts-models/lexicon-en-us.txt",
    size: 6_305_773,
    sha256: "8b67ae549a465eee78f92ecb74644ad90c3c58ce65f19c68baf85878a10ef73a",
};

/// Shared 22 kHz Vocos vocoder for Matcha-TTS models.
const VOCOS_22KHZ: BuiltinLexicon = BuiltinLexicon {
    path: "vocoder-models/vocos-22khz-univ.onnx",
    size: 53_884_024,
    sha256: "0574a135aa1db2de6e181050db2ec528496cacd4a4701fc5d7faf9f9804c0081",
};

/// Shared 24 kHz Vocos vocoder for ZipVoice models.
const VOCOS_24KHZ: BuiltinLexicon = BuiltinLexicon {
    path: "vocoder-models/vocos_24khz.onnx",
    size: 54_157_409,
    sha256: "bcb3b970e384161c4d634f0bb9e999ff1c471b34c9bc0b1049a5014065ed3cc0",
};

const RELEASES: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/";

const SPEECH_CPU_ORDER: &[&str] = &[
    "phonon-31m-en",
    "kokoro-multi-lang-v1.1",
    "kokoro-multi-lang-v1.0",
    "kokoro-en-v0.19",
    "pocket-tts",
    "pocket-tts-int8",
    "piper-en",
    "matcha-icefall-en_US-ljspeech",
    "matcha-icefall-zh-en",
    "supertonic-3-int8",
    "kitten-mini-en-v0.8",
    "kitten-micro-en-v0.8",
    "kitten-nano-en-v0.8-fp32",
    "kitten-nano-en-v0.8-int8",
    "zipvoice-distill-int8",
    "zipvoice-distill-fp32",
    "kokoro-multi-lang-v1.1-int8",
    "kokoro-multi-lang-v1.0-int8",
    "kokoro-en-v0.19-int8",
    "zonos3-mini-q8",
    "orpheus-3b-q4",
    "orpheus-3b-q8",
    "qwen3-tts-1.7b-q4",
    "qwen3-tts-1.7b-q8",
];

const SPEECH_GPU_ORDER: &[&str] = &[
    "orpheus-3b-q4",
    "orpheus-3b-q8",
    "zonos3-mini-q8",
    "qwen3-tts-1.7b-q8",
    "qwen3-tts-1.7b-q4",
    "phonon-31m-en",
    "kokoro-multi-lang-v1.1",
    "kokoro-multi-lang-v1.0",
    "kokoro-en-v0.19",
    "zipvoice-distill-fp32",
    "pocket-tts",
    "matcha-icefall-en_US-ljspeech",
    "matcha-icefall-zh-en",
    "piper-en",
    "supertonic-3-int8",
    "kitten-mini-en-v0.8",
    "kitten-micro-en-v0.8",
    "kitten-nano-en-v0.8-fp32",
    "kitten-nano-en-v0.8-int8",
    "pocket-tts-int8",
    "zipvoice-distill-int8",
    "kokoro-multi-lang-v1.1-int8",
    "kokoro-multi-lang-v1.0-int8",
    "kokoro-en-v0.19-int8",
];

const STT_CPU_ORDER: &[&str] = &[
    "parakeet-tdt-0.6b-v3-int8",
    "parakeet-tdt-0.6b-ultra-int8",
    "sense-voice-int8",
    "whisper-turbo",
    "whisper-large-v3-int8",
    "parakeet-tdt-0.6b-redux-int8",
    "parakeet-tdt-0.6b-v2-int8",
    "whisper-medium-int8",
    "whisper-medium.en-int8",
    "whisper-small",
    "moonshine-tiny-en-v2",
    "moonshine-base-en-v2",
    "cohere-transcribe-int8",
    "qwen3-asr-0.6b-int8",
    "canary-180m-flash-int8",
    "omnilingual-1b-v2-int8",
    "omnilingual-300m-v2-int8",
    "parakeet-tdt-110m-en-int8",
    "dolphin-base-int8",
    "nemotron-3.5-asr-0.6b-int8",
    "whisper-distil-large-v3.5",
    "whisper-tiny.en",
    "whisper-base.en",
    "moonshine-base-es-v2",
    "moonshine-base-zh-v2",
    "moonshine-base-ja-v2",
    "moonshine-tiny-ko-v2",
    "moonshine-base-ar-v2",
    "moonshine-base-uk-v2",
    "moonshine-base-vi-v2",
    "parakeet-tdt-0.6b-v3-fp32",
    "nemotron-3.5-asr-0.6b-fp32",
    "canary-1b-v2",
    "parakeet-tdt-0.6b-v2-fp16",
    "canary-180m-flash-fp32",
    "whisper-turbo-fp32",
    "whisper-medium-fp32",
    "whisper-large-v3-fp32",
];

const STT_GPU_ORDER: &[&str] = &[
    "parakeet-tdt-0.6b-v3-fp32",
    "whisper-large-v3-fp32",
    "whisper-turbo-fp32",
    "nemotron-3.5-asr-0.6b-fp32",
    "canary-1b-v2",
    "parakeet-tdt-0.6b-v2-fp16",
    "whisper-medium-fp32",
    "canary-180m-flash-fp32",
    "parakeet-tdt-0.6b-ultra-int8",
    "parakeet-tdt-0.6b-v3-int8",
    "whisper-large-v3-int8",
    "whisper-turbo",
    "cohere-transcribe-int8",
    "qwen3-asr-0.6b-int8",
    "omnilingual-1b-v2-int8",
    "sense-voice-int8",
    "parakeet-tdt-0.6b-redux-int8",
    "parakeet-tdt-0.6b-v2-int8",
    "whisper-medium-int8",
    "whisper-medium.en-int8",
    "whisper-small",
    "moonshine-tiny-en-v2",
    "moonshine-base-en-v2",
    "omnilingual-300m-v2-int8",
    "canary-180m-flash-int8",
    "nemotron-3.5-asr-0.6b-int8",
    "parakeet-tdt-110m-en-int8",
    "dolphin-base-int8",
    "whisper-distil-large-v3.5",
    "whisper-tiny.en",
    "whisper-base.en",
    "moonshine-base-es-v2",
    "moonshine-base-zh-v2",
    "moonshine-base-ja-v2",
    "moonshine-tiny-ko-v2",
    "moonshine-base-ar-v2",
    "moonshine-base-uk-v2",
    "moonshine-base-vi-v2",
];

fn rank_in(order: &[&str], id: &str) -> u16 {
    order.iter().position(|&x| x == id).unwrap_or(order.len()) as u16
}

fn builtin_shared(id: &str, lexicon: Option<&'static BuiltinLexicon>) -> Vec<Lexicon> {
    let mut out: Vec<Lexicon> = lexicon.into_iter().map(BuiltinLexicon::lexicon).collect();
    if id.starts_with("matcha-") {
        out.push(VOCOS_22KHZ.lexicon());
    } else if id.starts_with("zipvoice-") {
        out.push(VOCOS_24KHZ.lexicon());
    }
    out
}

fn builtin_meta(id: &str, kind: Kind, languages: &[String]) -> EntryMeta {
    match kind {
        Kind::Speech => {
            let group = id.starts_with("piper-").then(|| "piper-en".to_string());
            let rank_id = if group.is_some() { "piper-en" } else { id };
            let speakers = match id {
                "piper-en_US-libritts-high" => Some(904),
                "piper-en_GB-vctk-medium" => Some(109),
                "piper-en_GB-aru-medium" => Some(12),
                "piper-en_GB-semaine-medium" => Some(4),
                _ => None,
            };
            let runtime = (id.starts_with("zonos3-")
                || id.starts_with("qwen3-tts-")
                || id.starts_with("orpheus-"))
            .then(|| "llama".to_string());
            let language_mode = id
                .starts_with("supertonic")
                .then_some(LanguageMode::Selectable);
            let tags = id.starts_with("orpheus-3b-").then(|| "<tags>".to_string());
            EntryMeta {
                runtime,
                group,
                speakers,
                live_capable: None,
                language_mode,
                tags,
                cpu_rank: Some(rank_in(SPEECH_CPU_ORDER, rank_id)),
                gpu_rank: Some(rank_in(SPEECH_GPU_ORDER, rank_id)),
            }
        }
        Kind::Transcription => {
            let live_capable = if id.starts_with("nemotron-3.5-asr-")
                || id.starts_with("parakeet-")
                || id.starts_with("sense-voice-")
                || id.starts_with("moonshine-")
                || id.starts_with("canary-180m-")
                || id.starts_with("dolphin-")
                || id.starts_with("whisper-tiny")
                || id.starts_with("whisper-base")
                || id.starts_with("whisper-small")
                || id.starts_with("whisper-distil-")
            {
                LiveCapable::Always
            } else if id.starts_with("whisper-turbo") {
                LiveCapable::Gpu
            } else {
                LiveCapable::Never
            };
            let language_mode = if id.starts_with("canary-")
                || id.starts_with("cohere-")
                || id.starts_with("nemotron-")
            {
                LanguageMode::Selectable
            } else if id.starts_with("moonshine-")
                || id.ends_with(".en")
                || id.contains(".en-")
                || id.contains("-en-")
                || id.starts_with("parakeet-tdt-0.6b-v2")
                || id == "whisper-distil-large-v3.5"
                || (languages.len() == 1 && languages[0] != "mul" && !id.starts_with("whisper-"))
            {
                LanguageMode::Fixed
            } else {
                LanguageMode::Auto
            };
            EntryMeta {
                runtime: None,
                group: None,
                speakers: None,
                live_capable: Some(live_capable),
                language_mode: Some(language_mode),
                tags: None,
                cpu_rank: Some(rank_in(STT_CPU_ORDER, id)),
                gpu_rank: Some(rank_in(STT_GPU_ORDER, id)),
            }
        }
    }
}

impl Builtin {
    fn entry(&self) -> Entry {
        let archive = self.path.rsplit('/').next().unwrap_or(self.path);
        let languages: Vec<String> = self
            .languages
            .split_whitespace()
            .map(String::from)
            .collect();
        let meta = builtin_meta(self.id, self.kind, &languages);
        Entry {
            id: self.id.into(),
            kind: self.kind,
            name: self.name.into(),
            languages,
            size: self.size,
            url: format!("{RELEASES}{}", self.path),
            sha256: self.sha256.into(),
            dir: archive.trim_end_matches(".tar.bz2").into(),
            files: Vec::new(),
            shared: builtin_shared(self.id, self.lexicon),
            meta,
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

/// A built-in model published as separate files in a Hugging Face repository, at a fixed commit.
struct BuiltinFiles {
    id: &'static str,
    kind: Kind,
    name: &'static str,
    languages: &'static str,
    /// `owner/name` on huggingface.co.
    repo: &'static str,
    /// The commit the files are taken from (so that they cannot change under their checksums).
    revision: &'static str,
    /// The model's directory name in the cache.
    dir: &'static str,
    /// Each file: its name in the repository (and the directory), size, SHA-256.
    files: &'static [(&'static str, u64, &'static str)],
    /// Additional files from another Hugging Face repository (at a fixed commit):
    /// `(local_name, full_url, size, sha256)`.
    extra_files: &'static [(&'static str, &'static str, u64, &'static str)],
}

impl BuiltinFiles {
    fn entry(&self) -> Entry {
        let base = format!(
            "https://huggingface.co/{}/resolve/{}",
            self.repo, self.revision
        );
        let mut files: Vec<ModelFile> = self
            .files
            .iter()
            .map(|&(name, size, sha256)| ModelFile {
                name: name.into(),
                url: format!("{base}/{name}"),
                size,
                sha256: sha256.into(),
            })
            .collect();
        for &(name, url, size, sha256) in self.extra_files {
            files.push(ModelFile {
                name: name.into(),
                url: url.into(),
                size,
                sha256: sha256.into(),
            });
        }
        let languages: Vec<String> = self
            .languages
            .split_whitespace()
            .map(String::from)
            .collect();
        let meta = builtin_meta(self.id, self.kind, &languages);
        Entry {
            id: self.id.into(),
            kind: self.kind,
            name: self.name.into(),
            languages,
            size: files.iter().map(|f| f.size).sum(),
            url: format!(
                "https://huggingface.co/{}/tree/{}",
                self.repo, self.revision
            ),
            sha256: String::new(),
            dir: self.dir.into(),
            files,
            shared: Vec::new(),
            meta,
        }
    }
}

/// Full-precision models, for a GPU (`gpu`): an NVIDIA GPU runs them many times faster than the
/// CPU runs the int8 ones (Parakeet v3 fp32: 0.06 s for 8 s of speech, warm, on an RTX 4090
/// Laptop; int8 on 8 CPU threads 0.8 s). On the CPU they run, slower than the int8 ones.
const BUILTIN_FILES: &[BuiltinFiles] = &[
    BuiltinFiles {
        id: "parakeet-tdt-0.6b-v3-fp32",
        kind: Kind::Transcription,
        name: "Parakeet TDT 0.6b v3 (fp32, for GPU)",
        languages: PARAKEET_LANGUAGES,
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3",
        revision: "5fcc0122fe87e8365e339e467af90c67b746218f",
        dir: "hf-sherpa-onnx-nemo-parakeet-tdt-0.6b-v3",
        files: &[
            (
                "README.md",
                4905,
                "701a3375e3fe77308d280c673d34146162d2f1602b44f97d99086e3f537a1119",
            ),
            (
                "decoder.onnx",
                47_233_744,
                "caed31af1bb08edcc09a01a1c3cbb4d4eb5bfdb9c4e5f307012f84bbf5dbfdbc",
            ),
            (
                "encoder.onnx",
                41_838_346,
                "36b758364dfddce472b9a9f75bf6049bbd35c886d7927e3eda80d4ceb3348512",
            ),
            (
                "encoder.weights",
                2_435_420_160,
                "3af3f51af5f2d01dbbf5af47d42c7962a2c205f11004254bb4f2b979862f39a8",
            ),
            (
                "joiner.onnx",
                25_286_331,
                "0f294e5ba9021a3d80e492de94abe4c116f0afce78452c7debb5dd07690d0340",
            ),
            (
                "tokens.txt",
                93_939,
                "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "nemotron-3.5-asr-0.6b-fp32",
        kind: Kind::Transcription,
        name: "Nemotron 3.5 ASR 0.6b (fp32, for GPU)",
        languages: NEMOTRON_LANGUAGES,
        repo: "csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-2026-06-11",
        revision: "2072aba9fb2d6ee6202b69e441761599ab7520b8",
        dir: "hf-sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-2026-06-11",
        files: &[
            (
                "README.md",
                214,
                "4cec75ccd38f289f3bd39055bd7033bfcbaa145d38b85b31e3943b8f03ae86f1",
            ),
            (
                "decoder.onnx",
                59_764_944,
                "f9c59ee6fa130bc2ba349dbcbba7c74a4a960a98d4196295ba4e8e5d6bde6b68",
            ),
            (
                "encoder.data",
                2_454_405_120,
                "7584f85df76bc9ae6fbdfa53aa8d97b07a842525d1c501d536d77fd9e4f57ac7",
            ),
            (
                "encoder.onnx",
                42_247_484,
                "f1e540e03cb2cc57f5c0f6416b893768cfda23e756bfc0a2c4d502a1350325af",
            ),
            (
                "joiner.onnx",
                37_824_291,
                "a6bd74c0a31cbde0da0368c1e29d171752108c7ad1231630e079a7d97ceee6f0",
            ),
            (
                "tokens.txt",
                131_440,
                "729cc103155bafa785f9cd45746cd41cabe97eab7182fc04d594129587958f8a",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "canary-1b-v2",
        kind: Kind::Transcription,
        name: "Canary 1B v2 (fp16 for GPU, int8 for CPU; set the language)",
        languages: PARAKEET_LANGUAGES,
        repo: "Sarphix/canary-1b-v2-sherpa-onnx-int8",
        revision: "7d513cd4f39f6c7dc75c13a284b5e345b37f6198",
        dir: "hf-canary-1b-v2-sherpa-onnx",
        files: &[
            (
                "README.md",
                7788,
                "567ba1823832eca53aa8824dab7845b97216df775464c2e628c98c227320b552",
            ),
            (
                "decoder.fp16.onnx",
                338_252_012,
                "4edc4237dee4822e7f42b4ea81f5e46b706ca9869d16c37f1581d6c4e5d2ead9",
            ),
            (
                "decoder.int8.onnx",
                558_682_707,
                "e68d839a8939a0c1d55d03fd5c6e6d3f113cfc97038027ffe566b8e3a4be2cd8",
            ),
            (
                "encoder.fp16.onnx",
                1_644_472_275,
                "8505ac066a56480a63cad2ef9fc2f67022e43f202998bbb5819c956bdec0db72",
            ),
            (
                "encoder.int8.onnx",
                857_602_351,
                "0d8f349aaa015d47c81d88c4ba3a5461c19bc09ebb72bf4c61698eec9f09e968",
            ),
            (
                "tokens.txt",
                224_406,
                "399db68418b655f50275779cfe425c55a5ef6dda12cf38375d709566927ef513",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "phonon-31m-en",
        kind: Kind::Speech,
        name: "Phonon 31M (English, 13 voices, fast CPU streaming)",
        languages: "en",
        repo: "gradium/phonon-31m-en",
        revision: "92741c5b07d085ff840e26fea8ce43110b87852f",
        dir: "hf-phonon-31m-en",
        files: &[
            (
                "config.json",
                4634,
                "b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85",
            ),
            (
                "tokenizer.json",
                277_967,
                "691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936",
            ),
            (
                "model.q8.gguf",
                64_512_352,
                "a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae",
            ),
            (
                "default-voice.safetensors",
                256_136,
                "dc537478eaadc1a5257fcda2e3501ab81e14c111a5d95a5838f350db2afd0f1a",
            ),
        ],
        extra_files: &[
            (
                "voices/Zoey.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/NbpkqMVS3CJeq2j8.safetensors",
                256_136,
                "97c7f8c253413574406ab80dd23f49c3ebb2517163b00a9bf86b9c4cf43e7e23",
            ),
            (
                "voices/Juniper.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/NIWIOv5vTi5eRMj8.safetensors",
                256_136,
                "444378eb06b7c492b86e8fc7d13e4db1a3c0cf3e68891a960bf6f0a41a13ef35",
            ),
            (
                "voices/Everly.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/vjFyp2BcCyTlUmYb.safetensors",
                256_136,
                "958ea94da14f46dd48c7f64adac11ed2ad2aa45f7ccd165dfebab5272664402e",
            ),
            (
                "voices/Harper.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/4SZHfMpw-p46Ywgs.safetensors",
                256_136,
                "6b3da6e2d796a20c51af892c482bd6509fb88267a221aff83c870843dee2a123",
            ),
            (
                "voices/Easton.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/LMDIYE0Oa377Qh6Z.safetensors",
                256_136,
                "45c582673cb20edb04ddcca2b5a8865ddfb0a82599efadb269021e87d20fbdd4",
            ),
            (
                "voices/Micah.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/40QrMVgAxFiUnP9f.safetensors",
                256_136,
                "0de1098d1051686a138d068e83ff09deb5053328bc74ec9541a1fdb90bfc24da",
            ),
            (
                "voices/Miles.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/d9XCyhjo4JhkHF1d.safetensors",
                256_136,
                "eab20e4f159b48cfbc01b1885804e24f681f80e7a64f909182763a4e3361bee8",
            ),
            (
                "voices/Maeve.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/6PWnV0Nq4wu7RVBT.safetensors",
                256_136,
                "56494ee67d533ad227ff0dfd0b1c13ff5aa91f1ad6e596e66c2986ba3005e844",
            ),
            (
                "voices/Freya.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/GgfEkEJtxZR7gnpy.safetensors",
                256_136,
                "eb3cd47418349e618408c16bea7153988b3ad04b41a6033039dd474a9a4dcd23",
            ),
            (
                "voices/Pippa.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/uem82D50GRv2Dwma.safetensors",
                256_136,
                "d41a8f01d6e33450f1ce062d332914da10beee99e585dab531750706f187c48a",
            ),
            (
                "voices/Alfie.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/X6NceqF285Gr04gb.safetensors",
                256_136,
                "4de75497fff3030168e8aa6dca23ffeb332b1bc8c25d0bf3507ceadac953ae9c",
            ),
            (
                "voices/Hugh.safetensors",
                "https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/YyKcxPG7iIgS3jsK.safetensors",
                256_136,
                "3169d74b47a54d1eb15e4c243f56393abe9fe90c7e1c308ecf96ee67618b152a",
            ),
        ],
    },
    BuiltinFiles {
        id: "zonos3-mini-q8",
        kind: Kind::Speech,
        name: "ZONOS3 Mini (Q8, GPU, 44.1 kHz, 8 langs)",
        languages: "en fr de es it pt ja zh",
        repo: "ggml-org/ZONOS3-Mini-GGUF",
        revision: "2e7bc4126a2343787298e1a297a3d1c4a13165aa",
        dir: "hf-zonos3-mini-q8",
        files: &[
            (
                "ZONOS3-Mini-Q8_0.gguf",
                854_726_208,
                "60568efc88e2f9231f4f5c061e246421f575986642d72ab9ae68f77d6cf76be4",
            ),
            (
                "mmproj-ZONOS3-Mini-F32.gguf",
                1_142_502_880,
                "aeeb92325b4b6927bef656390b78e1246148065f947d8b59c2663557a809414d",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "qwen3-tts-1.7b-q8",
        kind: Kind::Speech,
        name: "Qwen3-TTS 1.7B (Q8, GPU, 10 langs)",
        languages: "zh en de it pt es ja ko fr ru",
        repo: "ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF",
        revision: "ca27d74bc954b73dadab5b71ca265d87fc861a7c",
        dir: "hf-qwen3-tts-1.7b-q8",
        files: &[
            (
                "Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf",
                1_847_874_400,
                "ac7931aeb2e7aad1a6ed6602d353a5679c9d096b18ce8204ac730a8408d572e1",
            ),
            (
                "mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf",
                446_422_912,
                "6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "qwen3-tts-1.7b-q4",
        kind: Kind::Speech,
        name: "Qwen3-TTS 1.7B (Q4_K_M, GPU, 10 langs)",
        languages: "zh en de it pt es ja ko fr ru",
        repo: "ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF",
        revision: "ca27d74bc954b73dadab5b71ca265d87fc861a7c",
        dir: "hf-qwen3-tts-1.7b-q4",
        files: &[
            (
                "Qwen3-TTS-12Hz-1.7B-Base-Q4_K_M.gguf",
                1_035_965_280,
                "8d18c94acb2addd042f97da63c98be144eafa76d0d9495177eab65130cf85129",
            ),
            (
                "mmproj-Qwen3-TTS-12Hz-1.7B-Base-Q8_0.gguf",
                446_422_912,
                "6fd65188839bcd6ecc91b277ad471e22a0edfada4699a0fe82f1165c18cfcce2",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "orpheus-3b-q4",
        kind: Kind::Speech,
        name: "Orpheus 3B (Q4_K_M, GPU, 8 expressive voices)",
        languages: "en",
        repo: "unsloth/orpheus-3b-0.1-ft-GGUF",
        revision: "e2b00302c46af8205f521f60016600aa25a068e6",
        dir: "hf-orpheus-3b-q4",
        files: &[
            (
                "orpheus-3b-0.1-ft-Q4_K_M.gguf",
                2_092_569_120,
                "4e94a925593c8fc1c20ee50e5b0e4bf915ea106a0bda3b917ff69b02559f7ab9",
            ),
        ],
        extra_files: &[
            (
                "snac_24khz.onnx",
                "https://huggingface.co/onnx-community/snac_24khz-ONNX/resolve/f317cdff7efb7b2a63148c9e68bbb0320fe629a1/onnx/decoder_model.onnx",
                52_600_822,
                "9e2991fce96c3b49c508304e656052f4f6b860fe8432164fcd976eee195fd4f0",
            ),
        ],
    },
    BuiltinFiles {
        id: "orpheus-3b-q8",
        kind: Kind::Speech,
        name: "Orpheus 3B (Q8_0, GPU, 8 expressive voices)",
        languages: "en",
        repo: "unsloth/orpheus-3b-0.1-ft-GGUF",
        revision: "e2b00302c46af8205f521f60016600aa25a068e6",
        dir: "hf-orpheus-3b-q8",
        files: &[
            (
                "orpheus-3b-0.1-ft-Q8_0.gguf",
                3_516_431_616,
                "9a01ea76b66dd66d08a0952ed72932f0ecce59db3d5c9b1a33621ff7200ba531",
            ),
        ],
        extra_files: &[
            (
                "snac_24khz.onnx",
                "https://huggingface.co/onnx-community/snac_24khz-ONNX/resolve/f317cdff7efb7b2a63148c9e68bbb0320fe629a1/onnx/decoder_model.onnx",
                52_600_822,
                "9e2991fce96c3b49c508304e656052f4f6b860fe8432164fcd976eee195fd4f0",
            ),
        ],
    },
    BuiltinFiles {
        id: "whisper-large-v3-int8",
        kind: Kind::Transcription,
        name: "Whisper large-v3 (int8, 99 langs)",
        languages: WHISPER_LANGUAGES,
        repo: "csukuangfj/sherpa-onnx-whisper-large-v3",
        revision: "2a6507094dd6020d939d78e3f1834a1d06267fca",
        dir: "hf-whisper-large-v3-int8",
        files: &[
            (
                "large-v3-encoder.int8.onnx",
                766_671_985,
                "d531cf17248acc43e8c09b472a0877055e770877857a5332fc1304b36534ec85",
            ),
            (
                "large-v3-decoder.int8.onnx",
                1_008_265_203,
                "ebc6bfd88e162a46cb3edee8a7e727e1dcbc65cabecb19e2573695e4d495e1af",
            ),
            (
                "large-v3-tokens.txt",
                816_730,
                "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "whisper-large-v3-fp32",
        kind: Kind::Transcription,
        name: "Whisper large-v3 (fp32, for GPU, 99 langs)",
        languages: WHISPER_LANGUAGES,
        repo: "csukuangfj/sherpa-onnx-whisper-large-v3",
        revision: "2a6507094dd6020d939d78e3f1834a1d06267fca",
        dir: "hf-whisper-large-v3-fp32",
        files: &[
            (
                "large-v3-encoder.onnx",
                762_135,
                "a55051fb0570a1a1c1d05b57988b949bf029fee2bd218245250720353076b756",
            ),
            (
                "large-v3-encoder.weights",
                2_967_470_080,
                "23ed0376b33fd0e2b9de5043ca2830ce5cdb0219ef18f79ced25987fe38e1cb4",
            ),
            (
                "large-v3-decoder.onnx",
                2_835_288,
                "fc6e718cd7863e5d7330fb581347cb397dee756a0ed2063990f37ca20a4ad666",
            ),
            (
                "large-v3-decoder.weights",
                3_206_492_160,
                "b66bdf300b57c68ef7b31b2e4038fcd1377a105928af1ef621afd4dce7aa6b49",
            ),
            (
                "large-v3-tokens.txt",
                816_730,
                "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "whisper-turbo-fp32",
        kind: Kind::Transcription,
        name: "Whisper large-v3 turbo (fp32, for GPU, 99 langs)",
        languages: WHISPER_LANGUAGES,
        repo: "csukuangfj/sherpa-onnx-whisper-turbo",
        revision: "2ca6ff69fc878651b770880507669577ac41c2ff",
        dir: "hf-whisper-turbo-fp32",
        files: &[
            (
                "turbo-encoder.onnx",
                735_920,
                "1b960f278564fb8bbacd544d4f85f4dd6d8a64d3aa89543d8f2c4021c926f976",
            ),
            (
                "turbo-encoder.weights",
                2_600_325_120,
                "746f879ecf066450ab0cdecc05383380b85157270ff6c0a9fb7cfdd917036e12",
            ),
            (
                "turbo-decoder.onnx",
                636_209_532,
                "b24db5d90fa230c5eaa6b823d74862ced9e0d1dc3e01ec46601968e8db0e09ec",
            ),
            (
                "turbo-tokens.txt",
                816_730,
                "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "whisper-medium-int8",
        kind: Kind::Transcription,
        name: "Whisper medium (int8, 99 langs)",
        languages: WHISPER_LANGUAGES,
        repo: "csukuangfj/sherpa-onnx-whisper-medium",
        revision: "8c31d28503847560985df21f90e14f0c736e075e",
        dir: "hf-whisper-medium-int8",
        files: &[
            (
                "medium-encoder.int8.onnx",
                374_196_283,
                "1c54582b4d829de0089f6cb63bbbdb3bf7555398bacaf855fbecf1a84dfd193e",
            ),
            (
                "medium-decoder.int8.onnx",
                571_059_257,
                "595d00a338a365a7bfa0ca7f296cabc639583bef770ab6130df90f49a6412747",
            ),
            (
                "medium-tokens.txt",
                816_730,
                "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "whisper-medium-fp32",
        kind: Kind::Transcription,
        name: "Whisper medium (fp32, for GPU, 99 langs)",
        languages: WHISPER_LANGUAGES,
        repo: "csukuangfj/sherpa-onnx-whisper-medium",
        revision: "8c31d28503847560985df21f90e14f0c736e075e",
        dir: "hf-whisper-medium-fp32",
        files: &[
            (
                "medium-encoder.onnx",
                1_430_791_931,
                "352c45af645ce03ef83dbb68f63e5cea13baa5537e5feb13bc88a5976df6a4fd",
            ),
            (
                "medium-decoder.onnx",
                1_627_278_264,
                "c3c7b60335a3564f265162846d2a815b3f020674daeab66107b58618077dd547",
            ),
            (
                "medium-tokens.txt",
                816_730,
                "b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "whisper-medium.en-int8",
        kind: Kind::Transcription,
        name: "Whisper medium (int8, English)",
        languages: "en",
        repo: "csukuangfj/sherpa-onnx-whisper-medium.en",
        revision: "251ab4521f354490e8f2c206fbd0b7f3f6b0a7ec",
        dir: "hf-whisper-medium-en-int8",
        files: &[
            (
                "medium.en-encoder.int8.onnx",
                374_196_283,
                "5a8e3a36619e0b67db9320eef3152db59d4b440f5ce0212d2c162a61b750bf80",
            ),
            (
                "medium.en-decoder.int8.onnx",
                571_055_161,
                "7303be339ed4e51f4ffb7ae84f3803b10cf8e67e1dcf8a98cb4d843f0dea0141",
            ),
            (
                "medium.en-tokens.txt",
                835_554,
                "306cd27f03c1a714eca7108e03d66b7dc042abe8c258b44c199a7ed9838dd930",
            ),
        ],
        extra_files: &[],
    },
    BuiltinFiles {
        id: "parakeet-tdt-0.6b-ultra-int8",
        kind: Kind::Transcription,
        name: "Parakeet TDT 0.6b Ultra (int8, English)",
        languages: "en",
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-ultra-int8",
        revision: "402e1190ce85b9793118ee223db21fb0d12f52db",
        dir: "hf-parakeet-tdt-0.6b-ultra-int8",
        files: &[
            (
                "encoder.int8.onnx",
                652_282_345,
                "b43072e1b721f18a3df03fcfeb763ff7c4debdf29843598a3aba2f703e2780a3",
            ),
            (
                "decoder.int8.onnx",
                11_845_274,
                "1fab98fe6c12aded87d2da66272cc9e148d0a0044ce3850a12fe56302ec4a922",
            ),
            (
                "joiner.int8.onnx",
                6_355_277,
                "8a71aaccfdba3d451775507a889afd2257d2e754463fd81095a8c8f290f924c2",
            ),
            (
                "tokens.txt",
                93_939,
                "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
            ),
        ],
        extra_files: &[],
    },
];

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
        id: "omnilingual-1b-v2-int8",
        kind: Kind::Transcription,
        name: "Omnilingual ASR 1B v2 (int8, 1600 langs)",
        languages: "mul",
        size: 787_296_506,
        path: "asr-models/sherpa-onnx-omnilingual-asr-1600-languages-1B-ctc-v2-int8-2026-02-05.tar.bz2",
        sha256: "f4deae6e6cbf4ca785b89eaa3836156581208bf977ea2e6d7ae84d7efcfc3a40",
        lexicon: None,
    },
    Builtin {
        id: "parakeet-tdt-0.6b-v2-fp16",
        kind: Kind::Transcription,
        name: "Parakeet TDT 0.6b v2, English (fp16, for GPU)",
        languages: "en",
        size: 1_120_982_957,
        path: "asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-fp16.tar.bz2",
        sha256: "37f67a1a6c942dae27d345ee395fbd19e25ee48996faf70fca25779026054cf0",
        lexicon: None,
    },
    Builtin {
        id: "canary-180m-flash-fp32",
        kind: Kind::Transcription,
        name: "Canary 180M Flash (fp32, for GPU; set the language)",
        languages: "en es de fr",
        size: 717_064_890,
        path: "asr-models/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr.tar.bz2",
        sha256: "0b4a0a2630d6dccbf15ffc14ff2b6b446872bfdf7509d0ad602fe78bd8efc29d",
        lexicon: None,
    },
    // Kokoro's fp32 build is the faster one, on the CPU as well: two sentences in 4.1 s on 8 CPU
    // threads (0.7 s on an RTX 4090 Laptop), against 11.6 s for the int8 one (no faster on a GPU).
    Builtin {
        id: "kokoro-multi-lang-v1.1",
        kind: Kind::Speech,
        name: "Kokoro multi-lang v1.1",
        languages: "en zh",
        size: 364_855_331,
        path: "tts-models/kokoro-multi-lang-v1_1.tar.bz2",
        sha256: "b78e1ac42b852e839cceaafbe88f66806bf5860992d1d7b9a3f2ad1198427aed",
        lexicon: None,
    },
    Builtin {
        id: "kokoro-multi-lang-v1.1-int8",
        kind: Kind::Speech,
        name: "Kokoro multi-lang v1.1 (int8: smaller, slower)",
        languages: "en zh",
        size: 147_052_523,
        path: "tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2",
        sha256: "259c9c8bc906d6078e4e0570421885dabb68b539c2f970fcbb890a58eeaf3e9c",
        lexicon: None,
    },
    Builtin {
        id: "kokoro-multi-lang-v1.0",
        kind: Kind::Speech,
        name: "Kokoro multi-lang v1.0 (53 voices, 8 langs)",
        languages: "en es fr hi it ja pt zh",
        size: 349_886_476,
        path: "tts-models/kokoro-multi-lang-v1_0.tar.bz2",
        sha256: "60703707bc05ccd48d60e1eb723f38b07d6e474795a0b6a588d7220400e0f7a4",
        lexicon: None,
    },
    Builtin {
        id: "kokoro-multi-lang-v1.0-int8",
        kind: Kind::Speech,
        name: "Kokoro multi-lang v1.0 (int8: 53 voices, 8 langs)",
        languages: "en es fr hi it ja pt zh",
        size: 132_353_410,
        path: "tts-models/kokoro-int8-multi-lang-v1_0.tar.bz2",
        sha256: "72c347230107ef8a31098ec4d468a605244beef5f1ed00db97efa13518800653",
        lexicon: None,
    },
    Builtin {
        id: "kokoro-en-v0.19",
        kind: Kind::Speech,
        name: "Kokoro English v0.19 (11 voices)",
        languages: "en",
        size: 319_625_534,
        path: "tts-models/kokoro-en-v0_19.tar.bz2",
        sha256: "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7",
        lexicon: None,
    },
    Builtin {
        id: "kokoro-en-v0.19-int8",
        kind: Kind::Speech,
        name: "Kokoro English v0.19 (int8: 11 voices)",
        languages: "en",
        size: 103_248_205,
        path: "tts-models/kokoro-int8-en-v0_19.tar.bz2",
        sha256: "c9f0dd393615805b0bab050c340834d5e684e732aec91c0e860cd30e982c08bd",
        lexicon: None,
    },
    Builtin {
        id: "matcha-icefall-en_US-ljspeech",
        kind: Kind::Speech,
        name: "Matcha-TTS LJSpeech (US English)",
        languages: "en",
        size: 76_764_067,
        path: "tts-models/matcha-icefall-en_US-ljspeech.tar.bz2",
        sha256: "cff849fee69d7d3b22e0b0267aa6b863e32d05039a1eca963765a314a73450c0",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "matcha-icefall-zh-en",
        kind: Kind::Speech,
        name: "Matcha-TTS Chinese+English",
        languages: "zh en",
        size: 79_033_838,
        path: "tts-models/matcha-icefall-zh-en.tar.bz2",
        sha256: "271b804af570400d3bcdcb53bf6e53cc9f75180ee763b9f13eb5eaf2b0d086ef",
        lexicon: None,
    },
    Builtin {
        id: "zipvoice-distill-int8",
        kind: Kind::Speech,
        name: "ZipVoice distill (int8, flow-matching)",
        languages: "zh en",
        size: 109_162_785,
        path: "tts-models/sherpa-onnx-zipvoice-distill-int8-zh-en-emilia.tar.bz2",
        sha256: "77219c8b40f4ee8d73a7f902305ff6c1128ef9b54461c41b4ca6ed890b6c2803",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "zipvoice-distill-fp32",
        kind: Kind::Speech,
        name: "ZipVoice distill (fp32, flow-matching)",
        languages: "zh en",
        size: 477_800_463,
        path: "tts-models/sherpa-onnx-zipvoice-distill-fp32-zh-en-emilia.tar.bz2",
        sha256: "3b6729d03bf4ba64deeec113048bdbbe55dbc30580b609be76342e0099fd23a8",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_US-lessac-high",
        kind: Kind::Speech,
        name: "Piper lessac high (US English)",
        languages: "en",
        size: 115_545_841,
        path: "tts-models/vits-piper-en_US-lessac-high.tar.bz2",
        sha256: "8619d204c7005866fe4f420181dfa79622af6a6222389f0b0818d2af31e0db0e",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_US-ryan-high",
        kind: Kind::Speech,
        name: "Piper ryan high (US English male)",
        languages: "en",
        size: 115_630_708,
        path: "tts-models/vits-piper-en_US-ryan-high.tar.bz2",
        sha256: "6a71edf4d308b9cb2eaeadc8d1f3c6bf96120ecb7fe52c29a2b6e139c59760ed",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_GB-cori-high",
        kind: Kind::Speech,
        name: "Piper cori high (British English)",
        languages: "en",
        size: 115_574_061,
        path: "tts-models/vits-piper-en_GB-cori-high.tar.bz2",
        sha256: "42922f07738fcde2e49eed4e959635692f73b933de35a6b7c1010162ff566292",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_US-libritts-high",
        kind: Kind::Speech,
        name: "Piper LibriTTS high (904 US speakers)",
        languages: "en",
        size: 131_033_598,
        path: "tts-models/vits-piper-en_US-libritts-high.tar.bz2",
        sha256: "d9d35056703fd38ed38e95c202a50f603fefdc8a92a7b6332c4f1a41616eac72",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_GB-vctk-medium",
        kind: Kind::Speech,
        name: "Piper VCTK (109 British speakers)",
        languages: "en",
        size: 80_488_085,
        path: "tts-models/vits-piper-en_GB-vctk-medium.tar.bz2",
        sha256: "abafd35bdab0a72a3c6b947228ae3cccdf3624db83313c77d1abb5cbc75e1f64",
        lexicon: Some(&LEXICON_EN_US),
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
    Builtin {
        id: "piper-en_US-kristin-medium",
        kind: Kind::Speech,
        name: "Piper kristin (US English)",
        languages: "en",
        size: 67_259_230,
        path: "tts-models/vits-piper-en_US-kristin-medium.tar.bz2",
        sha256: "c2206f572df2956c50b1ae3367eebce3853c663e890cba8048cd62b1e4dbe6c7",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_US-amy-medium",
        kind: Kind::Speech,
        name: "Piper amy (US English)",
        languages: "en",
        size: 67_223_746,
        path: "tts-models/vits-piper-en_US-amy-medium.tar.bz2",
        sha256: "9a5d1fc497f85e8022b785bff5f8105203b1e33099ee6265203efc70b0cb0264",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_US-john-medium",
        kind: Kind::Speech,
        name: "Piper john (US English male)",
        languages: "en",
        size: 67_249_181,
        path: "tts-models/vits-piper-en_US-john-medium.tar.bz2",
        sha256: "d90362cfa48e429d3096f644785184446145b6e38216f2eaf4c0601b8aad5a36",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_US-bryce-medium",
        kind: Kind::Speech,
        name: "Piper bryce (US English male)",
        languages: "en",
        size: 67_278_133,
        path: "tts-models/vits-piper-en_US-bryce-medium.tar.bz2",
        sha256: "f35bb77ddecdf229798e850d1c77ded839d4179879be8b90da5f82e7beb538f2",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_US-norman-medium",
        kind: Kind::Speech,
        name: "Piper norman (US English male)",
        languages: "en",
        size: 67_203_672,
        path: "tts-models/vits-piper-en_US-norman-medium.tar.bz2",
        sha256: "1f32065d480abe9abc7c7f91442125d0b34c1cc065d1e600466cac408eabf3b8",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_GB-alan-medium",
        kind: Kind::Speech,
        name: "Piper alan (British English male)",
        languages: "en",
        size: 67_220_121,
        path: "tts-models/vits-piper-en_GB-alan-medium.tar.bz2",
        sha256: "a48d4017da0f77668b27bed63fe6e04dd64c6397e1fadad4f460efb0ef7c9012",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_GB-jenny_dioco-medium",
        kind: Kind::Speech,
        name: "Piper jenny (British English)",
        languages: "en",
        size: 67_225_842,
        path: "tts-models/vits-piper-en_GB-jenny_dioco-medium.tar.bz2",
        sha256: "a0888024569bafbefc05a4b48ddf8419d8dbbf3205f4af37cf7c6f1a87cc20c5",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_GB-northern_english_male-medium",
        kind: Kind::Speech,
        name: "Piper northern male (British English)",
        languages: "en",
        size: 67_210_490,
        path: "tts-models/vits-piper-en_GB-northern_english_male-medium.tar.bz2",
        sha256: "2bb2c1e709f58c11f17c693b3b38f500e110e7f54f2651774ec48b8d41f12c55",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_GB-semaine-medium",
        kind: Kind::Speech,
        name: "Piper semaine (4 expressive British voices)",
        languages: "en",
        size: 80_241_918,
        path: "tts-models/vits-piper-en_GB-semaine-medium.tar.bz2",
        sha256: "b2a1e39062fce8f7fb14b7fa5fb93d89c58e3af2245270387f408099f5a2da9f",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "piper-en_GB-aru-medium",
        kind: Kind::Speech,
        name: "Piper aru (12 British speakers)",
        languages: "en",
        size: 80_309_222,
        path: "tts-models/vits-piper-en_GB-aru-medium.tar.bz2",
        sha256: "15b6e7a545d899167a688a054b95730ec8cdfd35d27d00bab1dc5234c4a451a0",
        lexicon: Some(&LEXICON_EN_US),
    },
    // German, French and Spanish Piper voices (thorsten, siwis, davefx) are left out for now:
    // sherpa-onnx 2.0 has no espeak-ng, so a Piper voice speaks only through a lexicon, and
    // sherpa-onnx publishes an English one only. A lexicon for their language (`lexicon-de-de.txt`
    // and so on, named by `synthesize::shared_lexicons`), or a phonemizer in the receiver, would
    // bring them back: e.g. `tts-models/vits-piper-de_DE-thorsten-medium.tar.bz2`, 67_214_254
    // bytes, SHA-256 50487d9c95fdf2191f31d2588569381063ba1591dcd4c7d4bdd30f12b2191714.
    // Kitten speaks through the same English lexicon as Piper (its archives carry none).
    Builtin {
        id: "kitten-nano-en-v0.8-fp32",
        kind: Kind::Speech,
        name: "Kitten nano v0.8 (fp32)",
        languages: "en",
        size: 63_815_222,
        path: "tts-models/kitten-nano-en-v0_8-fp32.tar.bz2",
        sha256: "16092117bfe591ddcd58d078e1454603b8e1caea46f85653b2c2efae76bd883e",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "kitten-nano-en-v0.8-int8",
        kind: Kind::Speech,
        name: "Kitten nano v0.8 (int8)",
        languages: "en",
        size: 31_220_690,
        path: "tts-models/kitten-nano-en-v0_8-int8.tar.bz2",
        sha256: "6fa5be852612ce761094ba74ee6123b4fc4acfefa79bf64dc63acae4a83af2fd",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "kitten-micro-en-v0.8",
        kind: Kind::Speech,
        name: "Kitten micro v0.8",
        languages: "en",
        size: 44_423_643,
        path: "tts-models/kitten-micro-en-v0_8.tar.bz2",
        sha256: "85faaea7511ca9d1d2f251fed0a4553bdf0d1ee046102fa60ddd8046c751f76f",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "kitten-mini-en-v0.8",
        kind: Kind::Speech,
        name: "Kitten mini v0.8",
        languages: "en",
        size: 67_547_594,
        path: "tts-models/kitten-mini-en-v0_8.tar.bz2",
        sha256: "518f9b130320f690d5b5476df77bde4215fca67773cda16710318e5081234b9d",
        lexicon: Some(&LEXICON_EN_US),
    },
    Builtin {
        id: "supertonic-3-int8",
        kind: Kind::Speech,
        name: "Supertonic 3 (int8)",
        languages: crate::engines::synthesize::SUPERTONIC_LANGUAGES,
        size: 128_774_318,
        path: "tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2",
        sha256: "82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427",
        lexicon: None,
    },
    Builtin {
        id: "pocket-tts",
        kind: Kind::Speech,
        name: "Pocket TTS (fp32)",
        languages: "en",
        size: 168_148_625,
        path: "tts-models/sherpa-onnx-pocket-tts-2026-01-26.tar.bz2",
        sha256: "61422a478ef09d9b2c067261fb822e11786e0c86842c76d8633b7069968be7b5",
        lexicon: None,
    },
    Builtin {
        id: "pocket-tts-int8",
        kind: Kind::Speech,
        name: "Pocket TTS (int8)",
        languages: "en",
        size: 98_336_520,
        path: "tts-models/sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2",
        sha256: "2f3b88823cbbb9bf0b2477ec8ae7b3fec417b3a87b6bb5f256dba66f2ad967cb",
        lexicon: None,
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
        let hex = |h: &str| {
            h.len() == 64
                && h.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        };
        for e in &c.entries {
            assert!(e.size > 1_000_000);
            assert!(!e.languages.is_empty(), "{}", e.id);
            if e.files.is_empty() {
                // An archive of sherpa-onnx's releases.
                let releases = "https://github.com/k2-fsa/sherpa-onnx/releases/download/";
                let tag = e
                    .url
                    .strip_prefix(releases)
                    .unwrap_or_else(|| panic!("{}", e.url));
                assert!(
                    tag.starts_with("asr-models/") || tag.starts_with("tts-models/"),
                    "{}",
                    e.url
                );
                assert!(hex(&e.sha256), "{}", e.id);
                assert_eq!(format!("{}.tar.bz2", e.dir), e.archive_name());
            } else {
                // Separate files of a Hugging Face repository, at a fixed commit.
                assert_eq!(
                    e.size,
                    e.files.iter().map(|f| f.size).sum::<u64>(),
                    "{}",
                    e.id
                );
                for f in &e.files {
                    assert!(plain_relative(&f.name), "{}", f.name);
                    assert!(f.url.starts_with("https://huggingface.co/"), "{}", f.url);
                    assert!(
                        f.url.contains("/resolve/")
                            && (f.url.ends_with(&f.name)
                                || f.url.ends_with(".safetensors")
                                || f.url.ends_with(".onnx"))
                    );
                    let rev = f
                        .url
                        .split("/resolve/")
                        .nth(1)
                        .unwrap()
                        .split('/')
                        .next()
                        .unwrap();
                    assert_eq!(rev.len(), 40, "a commit, not a branch: {}", f.url);
                    assert!(hex(&f.sha256), "{} {}", e.id, f.name);
                }
            }
        }
        let kinds = |k| c.entries.iter().filter(|e| e.kind == k).count();
        assert_eq!(kinds(Kind::Transcription), 38);
        assert_eq!(kinds(Kind::Speech), 40);
        // Every English Piper, Kitten, Matcha-en and ZipVoice voice names the English lexicon;
        // Matcha and ZipVoice also name their shared vocoder.
        for e in c.entries.iter().filter(|e| e.kind == Kind::Speech) {
            let shared = c.shared(e);
            if e.id.starts_with("piper-")
                || e.id.starts_with("kitten-")
                || e.id == "matcha-icefall-en_US-ljspeech"
            {
                assert!(
                    e.id.starts_with("piper-en_")
                        || e.id.starts_with("kitten-")
                        || e.id == "matcha-icefall-en_US-ljspeech",
                    "{}",
                    e.id
                );
                assert_eq!(e.languages, ["en"], "{}", e.id);
                let l = shared
                    .iter()
                    .find(|s| s.name == "lexicon-en-us.txt")
                    .unwrap();
                assert_eq!(
                    l.url,
                    "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/lexicon-en-us.txt"
                );
                assert_eq!(l.size, 6_305_773);
                assert_eq!(l.sha256.len(), 64);
            }
            if e.id.starts_with("matcha-") {
                assert!(shared.iter().any(|s| s.name == "vocos-22khz-univ.onnx"));
            } else if e.id.starts_with("zipvoice-") {
                assert!(shared.iter().any(|s| s.name == "vocos_24khz.onnx"));
                assert!(shared.iter().any(|s| s.name == "lexicon-en-us.txt"));
            } else if !(e.id.starts_with("piper-") || e.id.starts_with("kitten-")) {
                assert!(shared.is_empty(), "{}", e.id);
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
        // The new voices unpack to the directories their archives are named by.
        for (id, dir) in [
            ("kitten-nano-en-v0.8-int8", "kitten-nano-en-v0_8-int8"),
            ("kitten-micro-en-v0.8", "kitten-micro-en-v0_8"),
            ("kitten-mini-en-v0.8", "kitten-mini-en-v0_8"),
            (
                "supertonic-3-int8",
                "sherpa-onnx-supertonic-3-tts-int8-2026-05-11",
            ),
            ("pocket-tts-int8", "sherpa-onnx-pocket-tts-int8-2026-01-26"),
        ] {
            assert_eq!(c.get(id).unwrap().dir, dir);
        }
        assert_eq!(c.get("supertonic-3-int8").unwrap().languages.len(), 31);
        for e in &c.entries {
            assert!(e.meta.cpu_rank.is_some(), "missing cpu_rank on {}", e.id);
            assert!(e.meta.gpu_rank.is_some(), "missing gpu_rank on {}", e.id);
            if e.kind == Kind::Transcription {
                assert!(
                    e.meta.live_capable.is_some(),
                    "missing live_capable on {}",
                    e.id
                );
                assert!(
                    e.meta.language_mode.is_some(),
                    "missing language_mode on {}",
                    e.id
                );
            }
        }
        assert_eq!(
            c.get("orpheus-3b-q4").unwrap().meta.tags.as_deref(),
            Some("<tags>")
        );
        assert_eq!(
            c.get("orpheus-3b-q4").unwrap().meta.runtime.as_deref(),
            Some("llama")
        );
        assert_eq!(
            c.get("supertonic-3-int8").unwrap().meta.language_mode,
            Some(LanguageMode::Selectable)
        );
        assert_eq!(
            c.get("piper-en_US-libritts-high")
                .unwrap()
                .meta
                .group
                .as_deref(),
            Some("piper-en")
        );
        assert_eq!(
            c.get("piper-en_US-libritts-high").unwrap().meta.speakers,
            Some(904)
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
