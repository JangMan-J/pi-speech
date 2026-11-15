//! `transcribe <model-dir|model-id> <audio>`: the text spoken in a WAV or MP3 file, by a local
//! speech model run in-process, on standard output. A catalogue id (`models list`) names a
//! model downloaded into the model cache. `--language <code>` names the language spoken, for a
//! model that must be told (Canary); the others detect it and ignore this.
//!
//! `transcribe --serve` stays running and keeps the last model it used loaded, so that only the
//! first transcription pays for loading it (seconds, for the larger models). It reads one JSON
//! request a line on standard input and answers each, in order, with one JSON line on standard
//! output:
//!
//! - `{"model":"<id or dir>","language":"de","load":true}`: load the model now (before the audio
//!   is there), answered `{"loaded":true}`;
//! - `{"model":"<id or dir>","audio":"<file>","language":"de"}`: answered `{"text":"..."}`;
//! - a failure is answered `{"error":"..."}`, and the server goes on.
//!
//! `language` is optional. It exits when standard input closes.

use crate::audio::convert::Converter;
use crate::audio::decode::{Decode, WavOrMp3};
use crate::engines::model;
use crate::engines::recognize::{Recognizer, SAMPLE_RATE};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

pub const USAGE: &str =
    "pi-speech-receiver transcribe <model-dir>|<model-id> <audio.wav|audio.mp3> [--language <code>] | --serve";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    Serve,
    Run {
        model_dir: PathBuf,
        audio: PathBuf,
        language: Option<String>,
    },
}

pub fn parse_args(args: &[String]) -> Result<Command, String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["-h" | "--help"] => Ok(Command::Help),
        ["--serve"] => Ok(Command::Serve),
        [dir, audio] if usable(dir) && usable(audio) => Ok(Command::Run {
            model_dir: PathBuf::from(dir),
            audio: PathBuf::from(audio),
            language: None,
        }),
        [dir, audio, "--language", lang] if usable(dir) && usable(audio) && usable(lang) => {
            Ok(Command::Run {
                model_dir: PathBuf::from(dir),
                audio: PathBuf::from(audio),
                language: Some(lang.to_string()),
            })
        }
        _ => Err(format!("usage: {USAGE}")),
    }
}

fn usable(arg: &str) -> bool {
    !arg.is_empty() && !arg.starts_with('-')
}

/// The audio in `path` (WAV or MP3), as mono samples at the models' rate.
pub fn load_audio(path: &Path) -> Result<Vec<f32>, String> {
    let shown = path.display();
    let file = File::open(path).map_err(|e| match e.kind() {
        io::ErrorKind::NotFound => format!("no audio file at {shown}"),
        _ => format!("cannot read the audio file {shown}: {e}"),
    })?;
    if file.metadata().is_ok_and(|m| m.is_dir()) {
        return Err(format!("{shown} is a directory, not an audio file"));
    }
    let ext = path.extension().and_then(|e| e.to_str());
    let mut decoder = WavOrMp3::open(Box::new(file), ext)
        .map_err(|e| format!("cannot read the audio file {shown}: {e}"))?;
    let mut out = Vec::new();
    let mut converter: Option<Converter> = None;
    while let Some(chunk) = decoder
        .next_chunk()
        .map_err(|e| format!("cannot read the audio file {shown}: {e}"))?
    {
        match &mut converter {
            Some(c) if c.takes(chunk.rate, chunk.channels) => {}
            _ => {
                if let Some(c) = &mut converter {
                    c.finish(&mut out);
                }
                converter = Some(Converter::new(chunk.rate, chunk.channels, SAMPLE_RATE, 1));
            }
        }
        if let Some(c) = &mut converter {
            c.push(chunk.samples, &mut out);
        }
    }
    if let Some(c) = &mut converter {
        c.finish(&mut out);
    }
    if out.is_empty() {
        return Err(format!("the audio file {shown} holds no audio"));
    }
    Ok(out)
}

/// The text spoken in `audio`, by the model in `model_dir` (or the downloaded model of
/// that catalogue id).
pub fn transcribe(
    model_dir: &Path,
    audio: &Path,
    language: Option<&str>,
) -> Result<String, String> {
    // The cheap checks first: a wrong path fails before a large model is loaded.
    let model_dir = match model_dir.to_str() {
        Some(arg) => crate::models::resolve_model_dir(arg)?,
        None => model_dir.to_path_buf(),
    };
    let model = model::detect(&model_dir)?;
    let samples = load_audio(audio)?;
    Recognizer::load(&model, language)?.transcribe(&samples)
}

/// The loaded model `serve` keeps: its directory, the language it was loaded for (when that
/// matters to it), and the recogniser.
struct Kept {
    dir: PathBuf,
    language: Option<String>,
    recognizer: Recognizer,
}

/// The recogniser for `model` and `language`: the kept one when it is that, else a new one,
/// kept in its place (the old one is dropped first, so two large models are never held).
fn recognizer<'a>(
    kept: &'a mut Option<Kept>,
    model: &str,
    language: Option<&str>,
) -> Result<&'a Recognizer, String> {
    let dir = crate::models::resolve_model_dir(model)?;
    let found = model::detect(&dir)?;
    let language = Recognizer::language_matters(found.kind())
        .then(|| language.map(String::from))
        .flatten();
    let same = kept
        .as_ref()
        .is_some_and(|k| k.dir == dir && k.language == language);
    if !same {
        *kept = None;
        let recognizer = Recognizer::load(&found, language.as_deref())?;
        *kept = Some(Kept {
            dir,
            language,
            recognizer,
        });
    }
    Ok(&kept.as_ref().expect("kept above").recognizer)
}

/// One request of `serve`, answered.
fn answer(kept: &mut Option<Kept>, line: &str) -> serde_json::Value {
    use serde_json::{json, Value};
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return json!({ "error": format!("not a JSON request: {e}") }),
    };
    let s = |k: &str| req.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    let Some(model) = s("model") else {
        return json!({ "error": "the request names no model" });
    };
    let language = s("language").filter(|l| *l != "auto");
    let mut run = || -> Result<Value, String> {
        if req.get("load").and_then(Value::as_bool) == Some(true) {
            recognizer(kept, model, language)?;
            return Ok(json!({ "loaded": true }));
        }
        let audio = s("audio").ok_or("the request names no audio file")?;
        // The audio first: a bad file fails before a large model is loaded.
        let samples = load_audio(Path::new(audio))?;
        let text = recognizer(kept, model, language)?.transcribe(&samples)?;
        Ok(json!({ "text": text }))
    };
    run().unwrap_or_else(|e| json!({ "error": e }))
}

/// `transcribe --serve`: requests on standard input, answers on standard output.
pub fn serve() -> ExitCode {
    use std::io::{BufRead, Write};
    let mut kept = None;
    let stdout = io::stdout();
    for line in io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = answer(&mut kept, &line);
        let mut out = stdout.lock();
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
    ExitCode::SUCCESS
}

pub fn main(args: &[String]) -> ExitCode {
    let (model_dir, audio, language) = match parse_args(args) {
        Ok(Command::Help) => {
            println!("usage: {USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(Command::Serve) => return serve(),
        Ok(Command::Run {
            model_dir,
            audio,
            language,
        }) => (model_dir, audio, language),
        Err(e) => {
            eprintln!("pi-speech-receiver: {e}");
            return ExitCode::from(2);
        }
    };
    match transcribe(&model_dir, &audio, language.as_deref()) {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("pi-speech-receiver: {e}");
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn the_arguments_name_a_model_directory_and_an_audio_file() {
        assert_eq!(
            parse_args(&args("models/parakeet speech.wav")),
            Ok(Command::Run {
                model_dir: "models/parakeet".into(),
                audio: "speech.wav".into(),
                language: None,
            })
        );
        assert_eq!(
            parse_args(&args("canary speech.wav --language de")),
            Ok(Command::Run {
                model_dir: "canary".into(),
                audio: "speech.wav".into(),
                language: Some("de".into()),
            })
        );
        assert!(parse_args(&args("canary speech.wav --language")).is_err());
        assert_eq!(parse_args(&args("--help")), Ok(Command::Help));
        assert_eq!(parse_args(&args("-h")), Ok(Command::Help));
        for bad in ["", "dir", "dir a.wav extra", "--model dir a.wav", "dir -"] {
            assert_eq!(
                parse_args(&args(bad)),
                Err(format!("usage: {USAGE}")),
                "{bad:?}"
            );
        }
        assert!(parse_args(&[String::new(), "a.wav".into()]).is_err());
    }

    #[test]
    fn audio_is_resampled_to_mono_at_the_models_rate() {
        let dir = std::env::temp_dir().join(format!(
            "pisr-audio-{}",
            crate::token::random_hex(6).unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // One second of stereo at 24 kHz.
        let samples: Vec<i16> = (0..48000).map(|i| ((i / 2) % 100) as i16 * 100).collect();
        let wav = crate::audio::decode::tests::open_wav(24000, 2, &samples);
        let p = dir.join("a.wav");
        std::fs::write(&p, wav).unwrap();
        let got = load_audio(&p);
        std::fs::remove_dir_all(&dir).unwrap();
        let got = got.unwrap();
        assert!((15990..=16010).contains(&got.len()), "{}", got.len());
    }

    #[test]
    fn unreadable_audio_is_named() {
        let e = load_audio(Path::new("/no/such/audio.wav")).unwrap_err();
        assert_eq!(e, "no audio file at /no/such/audio.wav");
        let dir = std::env::temp_dir();
        let e = load_audio(&dir).unwrap_err();
        // Opening a directory fails outright on Windows, and on reading elsewhere.
        assert!(
            e.contains("cannot read the audio file")
                || e.contains("is a directory")
                || e.starts_with("no audio file at"),
            "{e}"
        );
        let p = dir.join(format!(
            "pisr-not-audio-{}.wav",
            crate::token::random_hex(6).unwrap()
        ));
        std::fs::write(&p, b"this is text, not audio").unwrap();
        let e = load_audio(&p).unwrap_err();
        std::fs::remove_file(&p).unwrap();
        assert!(e.starts_with("cannot read the audio file"), "{e}");
    }
}
