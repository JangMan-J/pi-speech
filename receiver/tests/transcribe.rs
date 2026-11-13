//! `transcribe <model-dir> <audio>`: arguments and errors without a model, and real recordings
//! with real models when `PI_SPEECH_TEST_MODELS` names a directory of unpacked sherpa-onnx models
//! (skipped when unset). For example, with the models in `~/.cache/pi-speech/models/`:
//!
//! ```sh
//! PI_SPEECH_AUDIO_NULL=1 PI_SPEECH_TEST_MODELS=~/.cache/pi-speech/models cargo test --release --test transcribe
//! ```

mod support;

use pi_speech_receiver::engines::model::{self, Kind};
use pi_speech_receiver::transcribe::load_audio;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use support::scratch;

const BIN: &str = env!("CARGO_BIN_EXE_pi-speech-receiver");
const FOX_WORDS: &str = "the quick brown fox jumps over the lazy dog";

fn fox() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../e2e/fixtures/quick-brown-fox.wav")
}

fn run(args: &[&Path]) -> Output {
    Command::new(BIN)
        .arg("transcribe")
        .args(args)
        // Never the real speakers or microphone.
        .env("PI_SPEECH_AUDIO_NULL", "1")
        .output()
        .unwrap()
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

#[test]
fn wrong_arguments_print_the_usage_and_exit_2() {
    for args in [&[][..], &["only-a-dir"][..], &["a", "b", "c"][..]] {
        let o = Command::new(BIN)
            .arg("transcribe")
            .args(args)
            .env("PI_SPEECH_AUDIO_NULL", "1")
            .output()
            .unwrap();
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(stderr(&o).contains("usage: pi-speech-receiver transcribe <model-dir>"));
        assert!(o.stdout.is_empty());
    }
    let o = Command::new(BIN)
        .args(["transcribe", "--help"])
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&o.stdout).contains("transcribe <model-dir>"));
}

#[test]
fn a_missing_model_directory_is_named() {
    let dir = scratch("tr-missing");
    let o = run(&[&dir.join("no-such-model"), &fox()]);
    assert_eq!(o.status.code(), Some(1));
    assert!(
        stderr(&o).contains("no model directory at "),
        "{}",
        stderr(&o)
    );
    assert!(o.stdout.is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_unrecognised_model_directory_is_named() {
    let dir = scratch("tr-unknown");
    std::fs::write(dir.join("README.md"), "not a model").unwrap();
    let o = run(&[&dir, &fox()]);
    assert_eq!(o.status.code(), Some(1));
    let e = stderr(&o);
    assert!(e.contains("unrecognised model directory"), "{e}");
    assert!(
        e.contains("Parakeet (transducer), Whisper or SenseVoice"),
        "{e}"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn unreadable_audio_is_named_before_the_model_loads() {
    // Files that look like a model but are not: the audio is checked before they are loaded.
    let dir = scratch("tr-audio");
    for f in ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"] {
        std::fs::write(dir.join(f), "x").unwrap();
    }
    let o = run(&[&dir, &dir.join("missing.wav")]);
    assert_eq!(o.status.code(), Some(1));
    assert!(stderr(&o).contains("no audio file at "), "{}", stderr(&o));
    let text = dir.join("text.wav");
    std::fs::write(&text, "not audio at all").unwrap();
    let o = run(&[&dir, &text]);
    assert_eq!(o.status.code(), Some(1));
    assert!(
        stderr(&o).contains("cannot read the audio file"),
        "{}",
        stderr(&o)
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_model_sherpa_onnx_cannot_load_fails_cleanly() {
    let dir = scratch("tr-broken");
    for f in ["encoder.onnx", "decoder.onnx", "joiner.onnx", "tokens.txt"] {
        std::fs::write(dir.join(f), "x").unwrap();
    }
    let o = run(&[&dir, &fox()]);
    assert_eq!(o.status.code(), Some(1));
    assert!(
        stderr(&o).contains("cannot load the transducer (Parakeet) model"),
        "{}",
        stderr(&o)
    );
    assert!(o.stdout.is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

// Real models.

/// The recognised model directories in `PI_SPEECH_TEST_MODELS`; `None` when it is unset.
fn test_models() -> Option<Vec<(PathBuf, Kind)>> {
    let root = PathBuf::from(std::env::var_os("PI_SPEECH_TEST_MODELS")?);
    let mut found = Vec::new();
    for entry in std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("PI_SPEECH_TEST_MODELS={}: {e}", root.display()))
    {
        let path = entry.unwrap().path();
        if let Ok(m) = model::detect(&path) {
            found.push((path, m.kind()));
        }
    }
    found.sort_by(|a, b| a.0.cmp(&b.0));
    assert!(
        !found.is_empty(),
        "PI_SPEECH_TEST_MODELS={} holds no model directories",
        root.display()
    );
    Some(found)
}

/// Lower case letters and single spaces only.
fn words(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn transcribe(dir: &Path, audio: &Path) -> String {
    let t = std::time::Instant::now();
    let o = run(&[dir, audio]);
    assert_eq!(
        o.status.code(),
        Some(0),
        "{}: {}",
        dir.display(),
        stderr(&o)
    );
    let text = String::from_utf8(o.stdout).unwrap();
    eprintln!("{} ({:.1?}): {}", dir.display(), t.elapsed(), text.trim());
    text
}

#[test]
fn real_models_transcribe_a_known_recording() {
    let Some(models) = test_models() else {
        eprintln!("skipped: PI_SPEECH_TEST_MODELS is not set");
        return;
    };
    for (dir, _) in &models {
        assert_eq!(
            words(&transcribe(dir, &fox())),
            FOX_WORDS,
            "{}",
            dir.display()
        );
    }
}

/// A 16-bit mono WAV of `samples`.
fn write_wav(path: &Path, rate: u32, samples: &[f32]) {
    let data: Vec<u8> = samples
        .iter()
        .flat_map(|s| ((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())
        .collect();
    let mut v = b"RIFF".to_vec();
    v.extend((36 + data.len() as u32).to_le_bytes());
    v.extend(b"WAVEfmt ");
    v.extend(16u32.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(rate.to_le_bytes());
    v.extend((rate * 2).to_le_bytes());
    v.extend(2u16.to_le_bytes());
    v.extend(16u16.to_le_bytes());
    v.extend(b"data");
    v.extend((data.len() as u32).to_le_bytes());
    v.extend(data);
    std::fs::write(path, v).unwrap();
}

#[test]
fn real_models_transcribe_more_than_30_seconds() {
    // Whisper hears 30 s at a time: the recording is cut at its pauses, and nothing is lost.
    let Some(models) = test_models() else {
        eprintln!("skipped: PI_SPEECH_TEST_MODELS is not set");
        return;
    };
    let fox = load_audio(&fox()).unwrap();
    let pause = vec![0.0f32; 16_000 * 2];
    let mut long = Vec::new();
    let times = 9;
    for _ in 0..times {
        long.extend_from_slice(&fox);
        long.extend_from_slice(&pause);
    }
    assert!(long.len() > 16_000 * 40);
    let dir = scratch("tr-long");
    let audio = dir.join("long.wav");
    write_wav(&audio, 16_000, &long);
    for (model, _) in &models {
        let got = words(&transcribe(model, &audio));
        assert_eq!(
            got.matches("lazy dog").count(),
            times,
            "{}: {got}",
            model.display()
        );
    }
    std::fs::remove_dir_all(&dir).ok();
}
