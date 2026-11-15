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
    /// Libraries the models run with: a GPU runtime (sherpa-onnx's CUDA bundle, with ONNX
    /// Runtime's CUDA provider), listed only by a build that can use it ([`GPU_RUNTIMES`]).
    Runtime,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Transcription => "transcription",
            Kind::Speech => "speech",
            Kind::Runtime => "runtime",
        }
    }

    fn parse(s: &str) -> Option<Kind> {
        match s {
            "transcription" => Some(Kind::Transcription),
            "speech" => Some(Kind::Speech),
            "runtime" => Some(Kind::Runtime),
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
    /// A model published as separate files (a Hugging Face repository) instead of one archive:
    /// each is fetched and checked on its own into the model's directory, and `url`, `sha256`
    /// say nothing (`size` is their sum). Empty for an archive.
    pub files: Vec<ModelFile>,
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
        Catalog {
            entries: BUILTIN
                .iter()
                .chain(GPU_RUNTIMES.iter())
                .map(Builtin::entry)
                .chain(BUILTIN_FILES.iter().map(BuiltinFiles::entry))
                .collect(),
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
    let files = match v.get("files") {
        None => Vec::new(),
        Some(f) => f
            .as_array()
            .ok_or("files must be an array")?
            .iter()
            .map(model_file)
            .collect::<Result<Vec<_>, _>>()?,
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

/// sherpa-onnx's English lexicon, the one its English Piper voices and Kitten speak through.
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
            files: Vec::new(),
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
}

impl BuiltinFiles {
    fn entry(&self) -> Entry {
        let base = format!(
            "https://huggingface.co/{}/resolve/{}",
            self.repo, self.revision
        );
        Entry {
            id: self.id.into(),
            kind: self.kind,
            name: self.name.into(),
            languages: self
                .languages
                .split_whitespace()
                .map(String::from)
                .collect(),
            size: self.files.iter().map(|f| f.1).sum(),
            url: format!(
                "https://huggingface.co/{}/tree/{}",
                self.repo, self.revision
            ),
            sha256: String::new(),
            dir: self.dir.into(),
            files: self
                .files
                .iter()
                .map(|&(name, size, sha256)| ModelFile {
                    name: name.into(),
                    url: format!("{base}/{name}"),
                    size,
                    sha256: sha256.into(),
                })
                .collect(),
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
    },
];

/// sherpa-onnx's CUDA bundles, of the sherpa-onnx version this binary links: their `lib/` holds
/// ONNX Runtime with its CUDA provider. A GPU run puts that directory first on the library path
/// (the provider loads only from beside ONNX Runtime). Only a Linux x64 build linked against
/// the shared libraries can use them; others list none. Which one fits is the CUDA the system
/// has (`pi-speech-receiver gpu`).
#[cfg(all(target_os = "linux", target_arch = "x86_64", feature = "shared"))]
const GPU_RUNTIMES: &[Builtin] = &[
    Builtin {
        id: "gpu-runtime-cuda13",
        kind: Kind::Runtime,
        name: "GPU runtime (NVIDIA CUDA 13, cuDNN 9)",
        languages: "",
        size: 254_696_132,
        path:
            "v2.0.1/sherpa-onnx-v2.0.1-cuda-13.x-cudnn-9.x-onnxruntime1.28.2-linux-x64-gpu.tar.bz2",
        sha256: "40ca5c7730a349258f23e9a7bf5c3cbf69f13c498cc50387e8f9f06924a554f8",
        lexicon: None,
    },
    Builtin {
        id: "gpu-runtime-cuda12",
        kind: Kind::Runtime,
        name: "GPU runtime (NVIDIA CUDA 12, cuDNN 9)",
        languages: "",
        size: 393_636_488,
        path:
            "v2.0.1/sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-onnxruntime1.28.2-linux-x64-gpu.tar.bz2",
        sha256: "2aa541a65c1e7d921a053283419b70b30c1f6ae0a0f52f64b947ebe88c5f2a77",
        lexicon: None,
    },
];
#[cfg(not(all(target_os = "linux", target_arch = "x86_64", feature = "shared")))]
const GPU_RUNTIMES: &[Builtin] = &[];

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
    // Kitten speaks through the same English lexicon as Piper (its archives carry none).
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
            assert_eq!(e.languages.is_empty(), e.kind == Kind::Runtime, "{}", e.id);
            if e.files.is_empty() {
                // An archive of sherpa-onnx's releases.
                let releases = "https://github.com/k2-fsa/sherpa-onnx/releases/download/";
                let tag = e
                    .url
                    .strip_prefix(releases)
                    .unwrap_or_else(|| panic!("{}", e.url));
                assert!(
                    tag.starts_with("asr-models/")
                        || tag.starts_with("tts-models/")
                        || (e.kind == Kind::Runtime && tag.starts_with("v2.0.1/")),
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
                    assert!(f.url.contains("/resolve/") && f.url.ends_with(&f.name));
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
        assert_eq!(kinds(Kind::Transcription), 30);
        assert_eq!(kinds(Kind::Speech), 9);
        // Every Piper and Kitten voice names the English lexicon; Kokoro carries its own, and
        // Supertonic and Pocket TTS need none.
        for e in c.entries.iter().filter(|e| e.kind == Kind::Speech) {
            let lexicon = c.lexicon(e);
            if e.id.starts_with("piper-") || e.id.starts_with("kitten-") {
                assert!(
                    e.id.starts_with("piper-en_") || e.id.starts_with("kitten-"),
                    "{}",
                    e.id
                );
                assert_eq!(e.languages, ["en"], "{}", e.id);
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
