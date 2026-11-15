//! Which speech model a directory holds, told from its files alone (a download may be renamed).
//!
//! - Parakeet and other transducers: `encoder`, `decoder` and `joiner` `.onnx` files and `tokens.txt`.
//! - Whisper: `<name>-encoder.onnx`, `<name>-decoder.onnx` and `<name>-tokens.txt` (sherpa-onnx's
//!   Whisper exports carry the size as the prefix, as `small-encoder.onnx`).
//! - Canary: `encoder.onnx`, `decoder.onnx` and `tokens.txt` whose tokens include `<|startofcontext|>`.
//! - Cohere Transcribe: as Canary (the same tokenizer), with a `README.md` that names Cohere.
//! - Moonshine (v2): `encoder_model.ort`, `decoder_model_merged.ort` and `tokens.txt`.
//! - Qwen3-ASR: `conv_frontend.onnx`, `encoder.onnx`, `decoder.onnx` and a `tokenizer/` directory.
//! - A streaming transducer (Nemotron): a transducer whose `README.md` says it streams; it is run
//!   by sherpa-onnx's online recogniser, fed the whole recording at once.
//! - SenseVoice, Dolphin and Omnilingual: `model.onnx` and `tokens.txt`, told apart by their tokens
//!   (SenseVoice's `<|withitn|>`; Dolphin's `<nospeech>` and `<asr>`; Omnilingual's list starts
//!   `<s>`, `<pad>`, `</s>`, `<unk>`).
//!
//! Where a model comes in several precisions (`encoder.onnx`, `encoder.int8.onnx`,
//! `encoder.fp16.onnx`), the int8 one is used on the CPU, where it is smaller and faster, and the
//! fp16 one, else full precision, on a GPU.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The model families the binary runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Transducer,
    Whisper,
    SenseVoice,
    Canary,
    Moonshine,
    Dolphin,
    Omnilingual,
    Qwen3,
    Streaming,
    Cohere,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Transducer => "transducer (Parakeet)",
            Kind::Whisper => "Whisper",
            Kind::SenseVoice => "SenseVoice",
            Kind::Canary => "Canary",
            Kind::Moonshine => "Moonshine",
            Kind::Dolphin => "Dolphin",
            Kind::Omnilingual => "Omnilingual",
            Kind::Qwen3 => "Qwen3-ASR",
            Kind::Streaming => "streaming transducer (Nemotron)",
            Kind::Cohere => "Cohere Transcribe",
        }
    }

    /// The longest piece of audio the model hears well at once, in seconds; longer audio is cut
    /// at its quiet moments. `None`: any length.
    pub fn max_seconds(self) -> Option<f64> {
        match self {
            Kind::Transducer | Kind::SenseVoice | Kind::Streaming => None,
            // Whisper and Moonshine hear 30 s at most, Omnilingual's CTC models 40 s; Canary, Dolphin
            // were trained on clips of that order.
            _ => Some(28.0),
        }
    }
}

/// A model's files: names (`Found`) or paths in its directory (`Model`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Files<P> {
    Transducer {
        encoder: P,
        decoder: P,
        joiner: P,
        tokens: P,
    },
    Whisper {
        encoder: P,
        decoder: P,
        tokens: P,
    },
    Canary {
        encoder: P,
        decoder: P,
        tokens: P,
    },
    Cohere {
        encoder: P,
        decoder: P,
        tokens: P,
    },
    Moonshine {
        encoder: P,
        merged_decoder: P,
        tokens: P,
    },
    Qwen3 {
        conv_frontend: P,
        encoder: P,
        decoder: P,
        /// A directory.
        tokenizer: P,
    },
    /// Run by the online recogniser.
    Streaming {
        encoder: P,
        decoder: P,
        joiner: P,
        tokens: P,
    },
    /// One `model` file and `tokens` (SenseVoice, Dolphin, Omnilingual).
    Single {
        kind: Kind,
        model: P,
        tokens: P,
    },
}

/// What `from_names` found: file names, not yet paths.
pub type Found = Files<String>;
/// A model's files, as paths inside its directory.
pub type Model = Files<PathBuf>;

impl<P> Files<P> {
    pub fn kind(&self) -> Kind {
        match self {
            Files::Transducer { .. } => Kind::Transducer,
            Files::Whisper { .. } => Kind::Whisper,
            Files::Canary { .. } => Kind::Canary,
            Files::Cohere { .. } => Kind::Cohere,
            Files::Moonshine { .. } => Kind::Moonshine,
            Files::Qwen3 { .. } => Kind::Qwen3,
            Files::Streaming { .. } => Kind::Streaming,
            Files::Single { kind, .. } => *kind,
        }
    }

    fn map<Q>(self, f: impl Fn(P) -> Q) -> Files<Q> {
        match self {
            Files::Transducer {
                encoder,
                decoder,
                joiner,
                tokens,
            } => Files::Transducer {
                encoder: f(encoder),
                decoder: f(decoder),
                joiner: f(joiner),
                tokens: f(tokens),
            },
            Files::Whisper {
                encoder,
                decoder,
                tokens,
            } => Files::Whisper {
                encoder: f(encoder),
                decoder: f(decoder),
                tokens: f(tokens),
            },
            Files::Canary {
                encoder,
                decoder,
                tokens,
            } => Files::Canary {
                encoder: f(encoder),
                decoder: f(decoder),
                tokens: f(tokens),
            },
            Files::Cohere {
                encoder,
                decoder,
                tokens,
            } => Files::Cohere {
                encoder: f(encoder),
                decoder: f(decoder),
                tokens: f(tokens),
            },
            Files::Moonshine {
                encoder,
                merged_decoder,
                tokens,
            } => Files::Moonshine {
                encoder: f(encoder),
                merged_decoder: f(merged_decoder),
                tokens: f(tokens),
            },
            Files::Qwen3 {
                conv_frontend,
                encoder,
                decoder,
                tokenizer,
            } => Files::Qwen3 {
                conv_frontend: f(conv_frontend),
                encoder: f(encoder),
                decoder: f(decoder),
                tokenizer: f(tokenizer),
            },
            Files::Streaming {
                encoder,
                decoder,
                joiner,
                tokens,
            } => Files::Streaming {
                encoder: f(encoder),
                decoder: f(decoder),
                joiner: f(joiner),
                tokens: f(tokens),
            },
            Files::Single {
                kind,
                model,
                tokens,
            } => Files::Single {
                kind,
                model: f(model),
                tokens: f(tokens),
            },
        }
    }
}

const SUPPORTED: &str = "a Parakeet or Nemotron (transducer), Whisper, Canary, Cohere Transcribe, Moonshine, Qwen3-ASR, SenseVoice, Dolphin or Omnilingual model from sherpa-onnx";
/// Qwen3-ASR's tokenizer directory, as `from_names` sees it (directories end in `/`).
const QWEN3_TOKENIZER: &str = "tokenizer/";
/// A token only SenseVoice's vocabulary has (inverse text normalisation on).
const SENSE_VOICE_TOKEN: &str = "<|withitn|>";
/// A token Canary's vocabulary has (the start of its prompt's context).
const CANARY_TOKEN: &str = "<|startofcontext|>";
/// Moonshine v2's files (sherpa-onnx ships them as ONNX Runtime `.ort` files).
const MOONSHINE_ENCODER: &str = "encoder_model.ort";
const MOONSHINE_DECODER: &str = "decoder_model_merged.ort";

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
        // Following links: a model directory may link to files elsewhere. Directories are
        // named with a trailing `/`.
        let Some(name) = entry.file_name().to_str().map(String::from) else {
            continue;
        };
        match fs::metadata(entry.path()) {
            Ok(m) if m.is_file() => names.push(name),
            Ok(m) if m.is_dir() => names.push(format!("{name}/")),
            _ => {}
        }
    }
    let read_tokens = |name: &str| fs::read_to_string(dir.join(name)).ok();
    let found = from_names(&names, read_tokens)
        .map_err(|why| format!("unrecognised model directory {shown}: {why}"))?;
    Ok(found.map(|n| dir.join(n.trim_end_matches('/'))))
}

/// One `.onnx` file playing `role`: its name and the prefix before the role (`small-`).
#[derive(Debug)]
struct Part {
    name: String,
    prefix: String,
}

/// The `.onnx` file for `role` (`encoder`, `model`...). Its stem is the role, or ends in `-role`
/// or `_role`, then perhaps `.int8` or `.fp16`. Of several precisions, the CPU's best first
/// (int8, then full, then fp16), or a GPU's ([`gpu_precision`]: fp16, full, int8).
fn part(names: &[String], role: &str) -> Result<Option<Part>, String> {
    // By precision: 0 int8, 1 full, 2 fp16.
    let mut by: [Vec<Part>; 3] = Default::default();
    for name in names {
        let Some(stem) = name.strip_suffix(".onnx") else {
            continue;
        };
        let (stem, precision) = if let Some(s) = stem.strip_suffix(".int8") {
            (s, 0)
        } else if let Some(s) = stem.strip_suffix(".fp16") {
            (s, 2)
        } else {
            (stem, 1)
        };
        let Some(prefix) = stem.strip_suffix(role) else {
            continue;
        };
        if !(prefix.is_empty() || prefix.ends_with('-') || prefix.ends_with('_')) {
            continue;
        }
        by[precision].push(Part {
            name: name.clone(),
            prefix: prefix.to_string(),
        });
    }
    let order = if gpu_precision() {
        [2, 1, 0]
    } else {
        [0, 1, 2]
    };
    let Some(mut pick) = order
        .into_iter()
        .map(|i| std::mem::take(&mut by[i]))
        .find(|v| !v.is_empty())
    else {
        return Ok(None);
    };
    match pick.len() {
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

/// Whether models run on a GPU ([`crate::engines::recognize::PROVIDER_ENV`] names one), where
/// fp16 and full-precision files run better than int8 ones.
fn gpu_precision() -> bool {
    std::env::var(crate::engines::recognize::PROVIDER_ENV)
        .is_ok_and(|p| !p.trim().is_empty() && !p.trim().eq_ignore_ascii_case("cpu"))
}

fn has(names: &[String], name: &str) -> bool {
    names.iter().any(|n| n == name)
}

/// Tell the model from the names of the files in its directory (directories end in `/`).
/// `read_tokens` reads a file of tokens, or the README, by name (`None` when it cannot be read).
pub fn from_names(
    names: &[String],
    read_tokens: impl Fn(&str) -> Option<String>,
) -> Result<Found, String> {
    let need_tokens = |what: &str| -> Result<String, String> {
        if has(names, "tokens.txt") {
            Ok("tokens.txt".into())
        } else {
            Err(format!("it has {what} but no tokens.txt"))
        }
    };
    if has(names, MOONSHINE_ENCODER) || has(names, MOONSHINE_DECODER) {
        if !(has(names, MOONSHINE_ENCODER) && has(names, MOONSHINE_DECODER)) {
            return Err(format!(
                "it has one of Moonshine's {MOONSHINE_ENCODER} and {MOONSHINE_DECODER} but not the other"
            ));
        }
        return Ok(Found::Moonshine {
            encoder: MOONSHINE_ENCODER.into(),
            merged_decoder: MOONSHINE_DECODER.into(),
            tokens: need_tokens("Moonshine's encoder and decoder")?,
        });
    }
    let encoder = part(names, "encoder")?;
    let decoder = part(names, "decoder")?;
    let joiner = part(names, "joiner")?;
    if let Some(front) = part(names, "conv_frontend")? {
        let (Some(e), Some(d)) = (encoder, decoder) else {
            return Err(format!(
                "it has Qwen3-ASR's {} but not its encoder and decoder",
                front.name
            ));
        };
        if !has(names, QWEN3_TOKENIZER) {
            return Err("it has Qwen3-ASR's model files but no tokenizer directory".into());
        }
        return Ok(Found::Qwen3 {
            conv_frontend: front.name,
            encoder: e.name,
            decoder: d.name,
            tokenizer: QWEN3_TOKENIZER.into(),
        });
    }
    match (encoder, decoder, joiner) {
        (Some(e), Some(d), Some(j)) => {
            let tokens = need_tokens("a transducer's encoder, decoder and joiner")?;
            let streams = read_tokens("README.md")
                .is_some_and(|r| r.to_ascii_lowercase().contains("streaming"));
            Ok(if streams {
                Found::Streaming {
                    encoder: e.name,
                    decoder: d.name,
                    joiner: j.name,
                    tokens,
                }
            } else {
                Found::Transducer {
                    encoder: e.name,
                    decoder: d.name,
                    joiner: j.name,
                    tokens,
                }
            })
        }
        (Some(e), Some(d), None) if e.prefix.is_empty() && d.prefix.is_empty() => {
            let tokens = need_tokens("an encoder and a decoder")?;
            match read_tokens(&tokens) {
                None => Err(format!("cannot read its {tokens}")),
                Some(t) if t.contains(CANARY_TOKEN) => {
                    let cohere = read_tokens("README.md")
                        .is_some_and(|r| r.to_ascii_lowercase().contains("cohere"));
                    Ok(if cohere {
                        Found::Cohere {
                            encoder: e.name,
                            decoder: d.name,
                            tokens,
                        }
                    } else {
                        Found::Canary {
                            encoder: e.name,
                            decoder: d.name,
                            tokens,
                        }
                    })
                }
                Some(_) => Err(format!(
                    "it has an encoder and a decoder ({}, {}) but no joiner, and its tokens are not Canary's; expected {SUPPORTED}",
                    e.name, d.name
                )),
            }
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
            let tokens = need_tokens(&model.name)?;
            let Some(t) = read_tokens(&tokens) else {
                return Err(format!("cannot read its {tokens}"));
            };
            let kind = single_kind(&t).ok_or_else(|| {
                format!(
                    "it has {} and tokens.txt, but the tokens are not SenseVoice's, Dolphin's or Omnilingual's; expected {SUPPORTED}",
                    model.name
                )
            })?;
            Ok(Found::Single {
                kind,
                model: model.name,
                tokens,
            })
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

/// Which one-file model a list of tokens belongs to.
fn single_kind(tokens: &str) -> Option<Kind> {
    let first: Vec<&str> = tokens
        .lines()
        .take(4)
        .filter_map(|l| l.split_whitespace().next())
        .collect();
    let line = |t: &str| {
        tokens
            .lines()
            .any(|l| l.split_whitespace().next() == Some(t))
    };
    if tokens.contains(SENSE_VOICE_TOKEN) {
        Some(Kind::SenseVoice)
    } else if line("<nospeech>") && line("<asr>") {
        Some(Kind::Dolphin)
    } else if first == ["<s>", "<pad>", "</s>", "<unk>"] {
        Some(Kind::Omnilingual)
    } else {
        None
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
    fn fp16_files_are_a_precision_the_cpu_takes_last() {
        let got = from_names(
            &names("encoder.fp16.onnx decoder.fp16.onnx encoder.int8.onnx decoder.int8.onnx tokens.txt"),
            |_| Some("<|startofcontext|> 7\n".into()),
        );
        assert!(
            matches!(got, Ok(Found::Canary { ref encoder, .. }) if encoder == "encoder.int8.onnx"),
            "{got:?}"
        );
        let got = from_names(
            &names("encoder.fp16.onnx decoder.fp16.onnx tokens.txt"),
            |_| Some("<|startofcontext|> 7\n".into()),
        );
        assert!(
            matches!(got, Ok(Found::Canary { ref encoder, .. }) if encoder == "encoder.fp16.onnx"),
            "{got:?}"
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
            Ok(Found::Single {
                kind: Kind::SenseVoice,
                model: "model.int8.onnx".into(),
                tokens: "tokens.txt".into(),
            })
        );
        let other = from_names(&names("model.onnx tokens.txt"), |_| {
            Some("<unk> 0\n".into())
        });
        assert!(other
            .unwrap_err()
            .contains("not SenseVoice's, Dolphin's or Omnilingual's"));
    }

    #[test]
    fn canary_is_an_encoder_and_decoder_told_by_its_tokens() {
        let canary = |_: &str| Some("<unk> 0\n<|startofcontext|> 7\n<|en|> 62\n".into());
        let got = from_names(
            &names("encoder.int8.onnx decoder.int8.onnx tokens.txt"),
            canary,
        );
        assert_eq!(
            got,
            Ok(Found::Canary {
                encoder: "encoder.int8.onnx".into(),
                decoder: "decoder.int8.onnx".into(),
                tokens: "tokens.txt".into(),
            })
        );
        // The same tokens with a README naming Cohere: Cohere Transcribe.
        let cohere = |n: &str| {
            Some(if n == "README.md" {
                "converted from https://huggingface.co/CohereLabs/cohere-transcribe-03-2026".into()
            } else {
                "<unk> 0\n<|startofcontext|> 7\n".into()
            })
        };
        let got = from_names(
            &names(
                "encoder.int8.onnx encoder.int8.onnx.data decoder.int8.onnx README.md tokens.txt",
            ),
            cohere,
        );
        assert_eq!(got.map(|f| f.kind()), Ok(Kind::Cohere));
        // Other tokens: neither Canary nor Whisper.
        let e = from_names(
            &names("encoder.int8.onnx decoder.int8.onnx tokens.txt"),
            |_| Some("<unk> 0\n".into()),
        )
        .unwrap_err();
        assert!(e.contains("not Canary's"), "{e}");
    }

    #[test]
    fn a_transducer_whose_readme_says_it_streams_is_run_streaming() {
        let files =
            names("encoder.int8.onnx decoder.int8.onnx joiner.int8.onnx README.md tokens.txt");
        let got = from_names(&files, |n: &str| {
            (n == "README.md")
                .then(|| "This model is from nvidia/nemotron-3.5-asr-streaming-0.6b".into())
        });
        assert_eq!(got.map(|f| f.kind()), Ok(Kind::Streaming));
        let got = from_names(&files, |n: &str| {
            (n == "README.md").then(|| "Parakeet TDT".into())
        });
        assert_eq!(got.map(|f| f.kind()), Ok(Kind::Transducer));
    }

    #[test]
    fn qwen3_asr_is_its_frontend_encoder_decoder_and_tokenizer() {
        let got = from_names(
            &names("conv_frontend.onnx encoder.int8.onnx decoder.int8.onnx tokenizer/ test_wavs/"),
            no_tokens,
        );
        assert_eq!(
            got,
            Ok(Found::Qwen3 {
                conv_frontend: "conv_frontend.onnx".into(),
                encoder: "encoder.int8.onnx".into(),
                decoder: "decoder.int8.onnx".into(),
                tokenizer: "tokenizer/".into(),
            })
        );
        let e = from_names(
            &names("conv_frontend.onnx encoder.int8.onnx decoder.int8.onnx"),
            no_tokens,
        )
        .unwrap_err();
        assert!(e.contains("no tokenizer directory"), "{e}");
    }

    #[test]
    fn moonshine_v2_is_its_two_ort_files() {
        let got = from_names(
            &names("decoder_model_merged.ort encoder_model.ort LICENSE tokens.txt"),
            no_tokens,
        );
        assert_eq!(
            got,
            Ok(Found::Moonshine {
                encoder: "encoder_model.ort".into(),
                merged_decoder: "decoder_model_merged.ort".into(),
                tokens: "tokens.txt".into(),
            })
        );
        let e = from_names(&names("encoder_model.ort tokens.txt"), no_tokens).unwrap_err();
        assert!(e.contains("not the other"), "{e}");
    }

    #[test]
    fn one_file_models_are_told_by_their_tokens() {
        let kind = |tokens: &'static str| {
            from_names(&names("model.int8.onnx tokens.txt"), move |_| {
                Some(tokens.into())
            })
            .map(|f| f.kind())
        };
        assert_eq!(
            kind("<blank> 0\n<unk> 1\n<na> 2\n<nospeech> 3\n<nopunc> 4\n<itn> 5\n<asr> 6\n"),
            Ok(Kind::Dolphin)
        );
        assert_eq!(
            kind("<s> 0\n<pad> 1\n</s> 2\n<unk> 3\n  4\nR 5\n"),
            Ok(Kind::Omnilingual)
        );
        assert_eq!(kind("<unk> 0\n<|withitn|> 25016\n"), Ok(Kind::SenseVoice));
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
            Ok(Model::Single {
                kind: Kind::SenseVoice,
                model: dir.join("model.int8.onnx"),
                tokens: dir.join("tokens.txt"),
            })
        );
    }
}
