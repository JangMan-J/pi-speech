//! `transcribe <model-dir> <audio>`: the text spoken in a WAV or MP3 file, by a local speech
//! model run in-process, on standard output.

use crate::audio::convert::Converter;
use crate::audio::decode::{Decode, WavOrMp3};
use crate::engines::model;
use crate::engines::recognize::{Recognizer, SAMPLE_RATE};
use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

pub const USAGE: &str = "pi-speech-receiver transcribe <model-dir> <audio.wav|audio.mp3>";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    Run { model_dir: PathBuf, audio: PathBuf },
}

pub fn parse_args(args: &[String]) -> Result<Command, String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["-h" | "--help"] => Ok(Command::Help),
        [dir, audio] if usable(dir) && usable(audio) => Ok(Command::Run {
            model_dir: PathBuf::from(dir),
            audio: PathBuf::from(audio),
        }),
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

/// The text spoken in `audio`, by the model in `model_dir`.
pub fn transcribe(model_dir: &Path, audio: &Path) -> Result<String, String> {
    // The cheap checks first: a wrong path fails before a large model is loaded.
    let model = model::detect(model_dir)?;
    let samples = load_audio(audio)?;
    Recognizer::load(&model)?.transcribe(&samples)
}

pub fn main(args: &[String]) -> ExitCode {
    let (model_dir, audio) = match parse_args(args) {
        Ok(Command::Help) => {
            println!("usage: {USAGE}");
            return ExitCode::SUCCESS;
        }
        Ok(Command::Run { model_dir, audio }) => (model_dir, audio),
        Err(e) => {
            eprintln!("pi-speech-receiver: {e}");
            return ExitCode::from(2);
        }
    };
    match transcribe(&model_dir, &audio) {
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
            })
        );
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
