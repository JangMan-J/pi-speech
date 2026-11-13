//! Which speech model a directory holds, told from its files alone (a download may be renamed).
//!
//! - Parakeet and other transducers: `encoder`, `decoder` and `joiner` `.onnx` files and `tokens.txt`.
//! - Whisper: `<name>-encoder.onnx`, `<name>-decoder.onnx` and `<name>-tokens.txt` (sherpa-onnx's
//!   Whisper exports carry the size as the prefix, as `small-encoder.onnx`).
//! - SenseVoice: `model.onnx` and `tokens.txt` whose tokens include SenseVoice's `<|withitn|>`.
//!
//! Where both a full-precision and an `.int8.onnx` file exist, the int8 one is used: it is
//! smaller and faster on a CPU.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The model families the binary runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Transducer,
    Whisper,
    SenseVoice,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Transducer => "transducer (Parakeet)",
            Kind::Whisper => "Whisper",
            Kind::SenseVoice => "SenseVoice",
        }
    }
}

/// A model's files, as paths inside its directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Model {
    Transducer {
        encoder: PathBuf,
        decoder: PathBuf,
        joiner: PathBuf,
        tokens: PathBuf,
    },
    Whisper {
        encoder: PathBuf,
        decoder: PathBuf,
        tokens: PathBuf,
    },
    SenseVoice {
        model: PathBuf,
        tokens: PathBuf,
    },
}

impl Model {
    pub fn kind(&self) -> Kind {
        match self {
            Model::Transducer { .. } => Kind::Transducer,
            Model::Whisper { .. } => Kind::Whisper,
            Model::SenseVoice { .. } => Kind::SenseVoice,
        }
    }
}

const SUPPORTED: &str = "a Parakeet (transducer), Whisper or SenseVoice model from sherpa-onnx";
/// A token only SenseVoice's vocabulary has (inverse text normalisation on).
const SENSE_VOICE_TOKEN: &str = "<|withitn|>";

/// The model in `dir`.
pub fn detect(dir: &Path) -> Result<Model, String> {
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
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read the model directory {shown}: {e}"))?;
        // Following links: a model directory may link to files elsewhere.
        if fs::metadata(entry.path()).is_ok_and(|m| m.is_file()) {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
    }
    let read_tokens = |name: &str| fs::read_to_string(dir.join(name)).ok();
    let found = from_names(&names, read_tokens)
        .map_err(|why| format!("unrecognised model directory {shown}: {why}"))?;
    Ok(found.into_model(dir))
}

/// What `from_names` found: file names, not yet paths.
#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    Transducer {
        encoder: String,
        decoder: String,
        joiner: String,
        tokens: String,
    },
    Whisper {
        encoder: String,
        decoder: String,
        tokens: String,
    },
    SenseVoice {
        model: String,
        tokens: String,
    },
}

impl Found {
    fn into_model(self, dir: &Path) -> Model {
        let p = |n: String| dir.join(n);
        match self {
            Found::Transducer {
                encoder,
                decoder,
                joiner,
                tokens,
            } => Model::Transducer {
                encoder: p(encoder),
                decoder: p(decoder),
                joiner: p(joiner),
                tokens: p(tokens),
            },
            Found::Whisper {
                encoder,
                decoder,
                tokens,
            } => Model::Whisper {
                encoder: p(encoder),
                decoder: p(decoder),
                tokens: p(tokens),
            },
            Found::SenseVoice { model, tokens } => Model::SenseVoice {
                model: p(model),
                tokens: p(tokens),
            },
        }
    }
}

/// One `.onnx` file playing `role`: its name and the prefix before the role (`small-`).
#[derive(Debug)]
struct Part {
    name: String,
    prefix: String,
}

/// The `.onnx` file for `role` (`encoder`, `model`...), the int8 one first. Its stem is the
/// role, or ends in `-role` or `_role`.
fn part(names: &[String], role: &str) -> Result<Option<Part>, String> {
    let mut full = Vec::new();
    let mut int8 = Vec::new();
    for name in names {
        let Some(stem) = name.strip_suffix(".onnx") else {
            continue;
        };
        let (stem, quantised) = match stem.strip_suffix(".int8") {
            Some(s) => (s, true),
            None => (stem, false),
        };
        let Some(prefix) = stem.strip_suffix(role) else {
            continue;
        };
        if !(prefix.is_empty() || prefix.ends_with('-') || prefix.ends_with('_')) {
            continue;
        }
        let p = Part {
            name: name.clone(),
            prefix: prefix.to_string(),
        };
        if quantised {
            int8.push(p)
        } else {
            full.push(p)
        }
    }
    let mut pick = if int8.is_empty() { full } else { int8 };
    match pick.len() {
        0 => Ok(None),
        1 => Ok(pick.pop()),
        _ => {
            let mut all: Vec<&str> = pick.iter().map(|p| p.name.as_str()).collect();
            all.sort();
            Err(format!(
                "it holds more than one {role} ({}); put each model in its own directory",
                all.join(", ")
            ))
        }
    }
}

fn has(names: &[String], name: &str) -> bool {
    names.iter().any(|n| n == name)
}

/// Tell the model from the names of the files in its directory. `read_tokens` reads a file
/// of tokens by name (`None` when it cannot be read).
pub fn from_names(
    names: &[String],
    read_tokens: impl Fn(&str) -> Option<String>,
) -> Result<Found, String> {
    let encoder = part(names, "encoder")?;
    let decoder = part(names, "decoder")?;
    let joiner = part(names, "joiner")?;
    match (encoder, decoder, joiner) {
        (Some(e), Some(d), Some(j)) => {
            if !has(names, "tokens.txt") {
                return Err(
                    "it has a transducer's encoder, decoder and joiner but no tokens.txt".into(),
                );
            }
            Ok(Found::Transducer {
                encoder: e.name,
                decoder: d.name,
                joiner: j.name,
                tokens: "tokens.txt".into(),
            })
        }
        (Some(e), Some(d), None) => {
            let tokens = format!("{}tokens.txt", e.prefix);
            if e.prefix.is_empty() || d.prefix != e.prefix {
                return Err(format!(
                    "it has an encoder and a decoder ({}, {}) but no joiner, and they are not named as a Whisper model's (<name>-encoder.onnx, <name>-decoder.onnx); expected {SUPPORTED}",
                    e.name, d.name
                ));
            }
            if !has(names, &tokens) {
                return Err(format!(
                    "it has a Whisper encoder and decoder but no {tokens}"
                ));
            }
            Ok(Found::Whisper {
                encoder: e.name,
                decoder: d.name,
                tokens,
            })
        }
        (None, None, None) => {
            let model = part(names, "model")?.filter(|p| p.prefix.is_empty());
            let Some(model) = model else {
                return Err(format!("it has no model files; expected {SUPPORTED}"));
            };
            if !has(names, "tokens.txt") {
                return Err(format!("it has {} but no tokens.txt", model.name));
            }
            match read_tokens("tokens.txt") {
                None => Err("cannot read its tokens.txt".into()),
                Some(t) if t.contains(SENSE_VOICE_TOKEN) => Ok(Found::SenseVoice {
                    model: model.name,
                    tokens: "tokens.txt".into(),
                }),
                Some(_) => Err(format!(
                    "it has {} and tokens.txt, but the tokens are not SenseVoice's; expected {SUPPORTED}",
                    model.name
                )),
            }
        }
        (e, d, j) => {
            let missing: Vec<&str> = [("encoder", &e), ("decoder", &d)]
                .into_iter()
                .filter(|(_, p)| p.is_none())
                .map(|(r, _)| r)
                .collect();
            let have = if j.is_some() {
                "a joiner"
            } else {
                "an encoder or a decoder"
            };
            Err(format!(
                "it has {have} but no {}; expected {SUPPORTED}",
                missing.join(" or ")
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    fn no_tokens(_: &str) -> Option<String> {
        None
    }

    fn sense_voice_tokens(_: &str) -> Option<String> {
        Some("<unk> 0\n<|withitn|> 25016\n".into())
    }

    #[test]
    fn parakeet_is_a_transducer() {
        let got = from_names(
            &names("decoder.int8.onnx encoder.int8.onnx joiner.int8.onnx README.md tokens.txt"),
            no_tokens,
        );
        assert_eq!(
            got,
            Ok(Found::Transducer {
                encoder: "encoder.int8.onnx".into(),
                decoder: "decoder.int8.onnx".into(),
                joiner: "joiner.int8.onnx".into(),
                tokens: "tokens.txt".into(),
            })
        );
    }

    #[test]
    fn a_role_is_the_end_of_the_file_name() {
        let got = from_names(&names("encoder-epoch-99-avg-1.onnx tokens.txt"), no_tokens);
        // "encoder-epoch-99-avg-1" does not end in the role: not recognised.
        assert!(got.is_err());
        let got = from_names(
            &names("x_encoder.onnx x_decoder.onnx x_joiner.onnx tokens.txt"),
            no_tokens,
        );
        assert!(matches!(got, Ok(Found::Transducer { .. })));
    }

    #[test]
    fn whisper_prefers_int8_files() {
        let got = from_names(
            &names(
                "small-decoder.int8.onnx small-decoder.onnx small-encoder.int8.onnx small-encoder.onnx small-tokens.txt",
            ),
            no_tokens,
        );
        assert_eq!(
            got,
            Ok(Found::Whisper {
                encoder: "small-encoder.int8.onnx".into(),
                decoder: "small-decoder.int8.onnx".into(),
                tokens: "small-tokens.txt".into(),
            })
        );
    }

    #[test]
    fn whisper_full_precision_alone_is_used() {
        let got = from_names(
            &names("tiny.en-encoder.onnx tiny.en-decoder.onnx tiny.en-tokens.txt"),
            no_tokens,
        );
        assert!(
            matches!(got, Ok(Found::Whisper { ref encoder, .. }) if encoder == "tiny.en-encoder.onnx")
        );
    }

    #[test]
    fn sense_voice_is_told_by_its_tokens() {
        let got = from_names(
            &names("model.int8.onnx model.onnx tokens.txt"),
            sense_voice_tokens,
        );
        assert_eq!(
            got,
            Ok(Found::SenseVoice {
                model: "model.int8.onnx".into(),
                tokens: "tokens.txt".into(),
            })
        );
        let other = from_names(&names("model.onnx tokens.txt"), |_| {
            Some("<unk> 0\n".into())
        });
        assert!(other.unwrap_err().contains("not SenseVoice's"));
    }

    #[test]
    fn an_encoder_and_decoder_without_whisper_names_is_refused() {
        // A Canary model: encoder and decoder, no prefix.
        let e = from_names(
            &names("encoder.int8.onnx decoder.int8.onnx tokens.txt"),
            no_tokens,
        )
        .unwrap_err();
        assert!(e.contains("not named as a Whisper model's"), "{e}");
    }

    #[test]
    fn missing_tokens_are_named() {
        let e = from_names(&names("encoder.onnx decoder.onnx joiner.onnx"), no_tokens).unwrap_err();
        assert!(e.contains("no tokens.txt"), "{e}");
        let e = from_names(&names("small-encoder.onnx small-decoder.onnx"), no_tokens).unwrap_err();
        assert!(e.contains("no small-tokens.txt"), "{e}");
    }

    #[test]
    fn an_empty_or_partial_directory_is_refused() {
        let e = from_names(&names("README.md"), no_tokens).unwrap_err();
        assert!(e.contains("no model files"), "{e}");
        let e = from_names(&names("encoder.onnx joiner.onnx tokens.txt"), no_tokens).unwrap_err();
        assert!(e.contains("no decoder"), "{e}");
    }

    #[test]
    fn two_models_in_one_directory_are_refused() {
        let e = from_names(
            &names("a-encoder.onnx b-encoder.onnx a-decoder.onnx a-tokens.txt"),
            no_tokens,
        )
        .unwrap_err();
        assert!(e.contains("more than one encoder"), "{e}");
    }

    #[test]
    fn a_missing_directory_and_a_file_are_named() {
        let e = detect(Path::new("/no/such/model/dir")).unwrap_err();
        assert!(e.starts_with("no model directory at "), "{e}");
        let file = std::env::current_exe().unwrap();
        let e = detect(&file).unwrap_err();
        assert!(e.contains("is not a model directory"), "{e}");
    }

    #[test]
    fn detect_returns_paths_in_the_directory() {
        let dir = std::env::temp_dir().join(format!(
            "pisr-model-{}",
            crate::token::random_hex(6).unwrap()
        ));
        fs::create_dir_all(&dir).unwrap();
        for n in ["model.int8.onnx", "tokens.txt"] {
            fs::write(dir.join(n), "<|withitn|> 1\n").unwrap();
        }
        let got = detect(&dir);
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(
            got,
            Ok(Model::SenseVoice {
                model: dir.join("model.int8.onnx"),
                tokens: dir.join("tokens.txt"),
            })
        );
    }
}
