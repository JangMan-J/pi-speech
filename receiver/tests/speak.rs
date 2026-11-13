//! `speak <model> [--voice] [--speed]`: arguments and errors without a model, and real voices when
//! `PI_SPEECH_TEST_MODELS` names a directory of unpacked sherpa-onnx models (skipped when unset):
//! the first audio comes out while the rest is still being generated, the audio is not silent,
//! and a stop (SIGTERM, or the reader going away) ends it at once. For example:
//!
//! ```sh
//! PI_SPEECH_AUDIO_NULL=1 PI_SPEECH_TEST_MODELS=~/.cache/pi-speech/models cargo test --release --test speak -- --nocapture
//! ```
//!
//! A Piper voice needs a lexicon (sherpa-onnx 2.0 no longer runs espeak-ng): `models download` of
//! an English Piper voice puts `lexicon-en-us.txt` from sherpa-onnx's `tts-models` release in the
//! model cache; in another directory, put it there by hand.

mod support;

use pi_speech_receiver::engines::synthesize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use support::scratch;

const BIN: &str = env!("CARGO_BIN_EXE_pi-speech-receiver");
const TEXT: &str = "The quick brown fox jumps over the lazy dog. It was a bright cold day in \
    April, and the clocks were striking thirteen. Speech that starts early feels much faster \
    than speech that waits for the end.";

fn command(args: &[&str]) -> Command {
    let mut c = Command::new(BIN);
    c.arg("speak")
        .args(args)
        // Never the real speakers.
        .env("PI_SPEECH_AUDIO_NULL", "1");
    c
}

/// Run with `text` on standard input.
fn run(c: &mut Command, text: &str) -> Output {
    let mut child = c
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // The command may fail before it reads its input.
    let _ = child.stdin.take().unwrap().write_all(text.as_bytes());
    child.wait_with_output().unwrap()
}

/// The JSON events on standard error, in order.
fn events(stderr: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stderr)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("event").is_some())
        .collect()
}

fn error_of(o: &Output) -> String {
    let ev = events(&o.stderr);
    let last = ev.last().unwrap_or_else(|| {
        panic!(
            "no events: {}",
            String::from_utf8_lossy(&o.stderr).into_owned()
        )
    });
    assert_eq!(last["event"], "error", "{ev:?}");
    last["message"].as_str().unwrap().to_string()
}

#[test]
fn wrong_arguments_print_the_usage_and_exit_2() {
    for args in [
        &[][..],
        &["a", "b"][..],
        &["a", "--speed", "fast"][..],
        &["a", "--pitch", "2"][..],
    ] {
        let o = run(&mut command(args), "");
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert!(o.stdout.is_empty());
    }
    let o = run(&mut command(&[]), "");
    assert!(String::from_utf8_lossy(&o.stderr).contains("usage: pi-speech-receiver speak"));
    let o = run(&mut command(&["--help"]), "");
    assert_eq!(o.status.code(), Some(0));
    let help = String::from_utf8_lossy(&o.stdout);
    assert!(help.contains("speak <model-dir>|<model-id>"), "{help}");
    assert!(
        help.contains(r#"{"event":"format","rate":<Hz>,"channels":1}"#),
        "{help}"
    );
}

#[test]
fn a_missing_or_unrecognised_model_is_named_as_an_error_event() {
    let dir = scratch("sp-missing");
    let o = run(
        &mut command(&[dir.join("nope").to_str().unwrap()]),
        "Hello.",
    );
    assert_eq!(o.status.code(), Some(1));
    assert!(o.stdout.is_empty());
    assert!(error_of(&o).starts_with("no model directory at "));
    std::fs::write(dir.join("README.md"), "not a voice").unwrap();
    let o = run(&mut command(&[dir.to_str().unwrap()]), "Hello.");
    assert_eq!(o.status.code(), Some(1));
    let e = error_of(&o);
    assert!(e.contains("unrecognised voice model directory"), "{e}");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_model_sherpa_onnx_cannot_load_fails_cleanly_after_the_text_is_read() {
    let dir = scratch("sp-broken");
    for f in ["model.onnx", "voices.bin", "tokens.txt"] {
        std::fs::write(dir.join(f), "x").unwrap();
    }
    let o = run(&mut command(&[dir.to_str().unwrap()]), "   \n");
    assert_eq!(o.status.code(), Some(1));
    assert!(error_of(&o).contains("text on standard input is empty"));
    let o = run(&mut command(&[dir.to_str().unwrap()]), "Hello.");
    assert_eq!(o.status.code(), Some(1));
    assert!(o.stdout.is_empty());
    assert!(error_of(&o).contains("cannot load the Kokoro model"));
    // No format line before a failure.
    assert!(events(&o.stderr).iter().all(|e| e["event"] != "format"));
    std::fs::remove_dir_all(&dir).ok();
}

/// `speak <model-id>`: an id from the catalogue names a speech model in the model cache.
#[test]
fn a_catalogue_id_names_a_downloaded_speech_model() {
    let dir = scratch("sp-id");
    let cache = dir.join("cache");
    let catalog = dir.join("catalog.json");
    std::fs::write(
        &catalog,
        r#"[{"id":"test-voice","kind":"speech","name":"V","languages":["en"],"size":1,
            "url":"http://127.0.0.1:1/v.tar.bz2","sha256":"00","dir":"test-voice-v1"},
           {"id":"test-model","kind":"transcription","name":"T","languages":["en"],"size":1,
            "url":"http://127.0.0.1:1/t.tar.bz2","sha256":"00","dir":"test-model"},
           {"id":"test-piper","kind":"speech","name":"P","languages":["en"],"size":1,
            "url":"http://127.0.0.1:1/p.tar.bz2","sha256":"00","dir":"test-piper",
            "lexicon":{"url":"http://127.0.0.1:1/lexicon-en-us.txt","size":1,"sha256":"00"}}]"#,
    )
    .unwrap();
    let speak = |id: &str| {
        run(
            command(&[id])
                .env("PI_SPEECH_MODELS_DIR", &cache)
                .env("PI_SPEECH_MODELS_CATALOG", &catalog),
            "Hello.",
        )
    };
    let o = speak("test-voice");
    assert_eq!(o.status.code(), Some(1));
    let e = error_of(&o);
    assert!(
        e.contains("`pi-speech-receiver models download test-voice`"),
        "{e}"
    );
    let o = speak("test-model");
    assert!(error_of(&o).contains("test-model is a transcription model"));
    std::fs::create_dir_all(cache.join("test-voice-v1")).unwrap();
    std::fs::write(cache.join("test-voice-v1").join("README.md"), "x").unwrap();
    let e = error_of(&speak("test-voice"));
    assert!(e.contains("unrecognised voice model directory"), "{e}");
    assert!(e.contains("test-voice-v1"), "{e}");
    // A voice that needs a lexicon is not ready without it.
    std::fs::create_dir_all(cache.join("test-piper")).unwrap();
    let e = error_of(&speak("test-piper"));
    assert!(e.contains("needs the lexicon lexicon-en-us.txt"), "{e}");
    assert!(
        e.contains("`pi-speech-receiver models download test-piper`"),
        "{e}"
    );
    std::fs::write(cache.join("lexicon-en-us.txt"), "x").unwrap();
    let e = error_of(&speak("test-piper"));
    assert!(e.contains("unrecognised voice model directory"), "{e}");
    // The built-in catalogue's ids.
    let o = run(
        command(&["kokoro-multi-lang-v1.1-int8"])
            .env("PI_SPEECH_MODELS_DIR", &cache)
            .env_remove("PI_SPEECH_MODELS_CATALOG"),
        "Hello.",
    );
    assert!(error_of(&o).contains("models download kokoro-multi-lang-v1.1-int8"));
    std::fs::remove_dir_all(&dir).ok();
}

// Real voices.

/// The voice model directories in `PI_SPEECH_TEST_MODELS`; `None` when it is unset.
fn test_voices() -> Option<Vec<PathBuf>> {
    let root = PathBuf::from(std::env::var_os("PI_SPEECH_TEST_MODELS")?);
    let mut found = Vec::new();
    for entry in std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("PI_SPEECH_TEST_MODELS={}: {e}", root.display()))
    {
        let path = entry.unwrap().path();
        match synthesize::detect(&path) {
            Ok(_) => found.push(path),
            Err(e) if e.contains("has no lexicon") => eprintln!("skipped: {e}"),
            Err(_) => {}
        }
    }
    found.sort();
    Some(found)
}

struct Spoken {
    child: Child,
    started: Instant,
    events: mpsc::Receiver<Value>,
}

fn start(dir: &Path, extra: &[&str]) -> Spoken {
    let mut args = vec![dir.to_str().unwrap()];
    args.extend_from_slice(extra);
    let started = Instant::now();
    let mut child = command(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(TEXT.as_bytes()).unwrap();
    drop(stdin);
    let (tx, rx) = mpsc::channel();
    let stderr = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("event").is_some() {
                    let _ = tx.send(v);
                }
            }
        }
    });
    Spoken {
        child,
        started,
        events: rx,
    }
}

fn next_event(s: &Spoken) -> Value {
    s.events.recv_timeout(Duration::from_secs(120)).unwrap()
}

#[test]
fn real_voices_speak_as_the_audio_is_generated() {
    let Some(voices) = test_voices() else {
        eprintln!("skipped: PI_SPEECH_TEST_MODELS is not set");
        return;
    };
    if voices.is_empty() {
        eprintln!("skipped: PI_SPEECH_TEST_MODELS holds no voice models");
    }
    for dir in &voices {
        let mut s = start(dir, &[]);
        let mut out = s.child.stdout.take().unwrap();
        let mut first = [0u8; 2];
        out.read_exact(&mut first).unwrap();
        let first_at = s.started.elapsed();
        // The first audio is out while the model is still generating the rest.
        assert!(
            s.child.try_wait().unwrap().is_none(),
            "{}: the process ended before its first audio was read",
            dir.display()
        );
        let format = next_event(&s);
        assert_eq!(format["event"], "format", "{format}");
        assert_eq!(format["channels"], 1);
        let rate = format["rate"].as_u64().unwrap();
        assert!((8000..=48000).contains(&rate), "{format}");
        let mut rest = Vec::new();
        out.read_to_end(&mut rest).unwrap();
        let status = s.child.wait().unwrap();
        let all = s.started.elapsed();
        assert!(status.success(), "{}: {status}", dir.display());
        assert_eq!(next_event(&s)["event"], "done");
        let mut pcm = first.to_vec();
        pcm.extend(rest);
        assert_eq!(pcm.len() % 2, 0);
        let samples: Vec<f64> = pcm
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b) as f64 / 32768.0)
            .collect();
        let seconds = samples.len() as f64 / rate as f64;
        let rms = (samples.iter().map(|s| s * s).sum::<f64>() / samples.len() as f64).sqrt();
        eprintln!(
            "{}: first audio at {first_at:.2?}, all at {all:.2?}; {seconds:.1} s of audio at {rate} Hz, rms {rms:.3}",
            dir.display()
        );
        assert!(
            (4.0..40.0).contains(&seconds),
            "{}: {seconds} s",
            dir.display()
        );
        assert!(rms > 0.01, "{}: silent (rms {rms})", dir.display());
    }
}

#[test]
fn real_voices_stop_when_the_reader_goes_away_or_on_sigterm() {
    let Some(voices) = test_voices() else {
        eprintln!("skipped: PI_SPEECH_TEST_MODELS is not set");
        return;
    };
    for dir in &voices {
        // The reader goes away after the first audio.
        let mut s = start(dir, &["--speed", "0.5"]);
        let mut out = s.child.stdout.take().unwrap();
        let mut first = [0u8; 2];
        out.read_exact(&mut first).unwrap();
        let at = Instant::now();
        drop(out);
        let status = s.child.wait().unwrap();
        let took = at.elapsed();
        assert_eq!(status.code(), Some(1), "{}", dir.display());
        let mut seen = Vec::new();
        while let Ok(v) = s.events.recv_timeout(Duration::from_secs(5)) {
            seen.push(v["event"].as_str().unwrap_or("").to_string());
        }
        assert_eq!(seen.last().map(String::as_str), Some("stopped"), "{seen:?}");
        eprintln!(
            "{}: stopped {took:.2?} after the reader went away",
            dir.display()
        );
        #[cfg(unix)]
        assert!(took < Duration::from_secs(2), "{}: {took:?}", dir.display());

        #[cfg(unix)]
        {
            let mut s = start(dir, &["--speed", "0.5"]);
            let mut out = s.child.stdout.take().unwrap();
            out.read_exact(&mut first).unwrap();
            let at = Instant::now();
            unsafe {
                libc::kill(s.child.id() as i32, libc::SIGTERM);
            }
            let status = s.child.wait().unwrap();
            assert_eq!(status.code(), Some(1), "{}", dir.display());
            assert!(at.elapsed() < Duration::from_secs(2));
            let mut last = None;
            while let Ok(v) = s.events.recv_timeout(Duration::from_secs(5)) {
                last = Some(v);
            }
            assert_eq!(last.unwrap()["event"], "stopped");
        }
    }
}

#[test]
fn real_voices_list_their_voices() {
    let Some(voices) = test_voices() else {
        eprintln!("skipped: PI_SPEECH_TEST_MODELS is not set");
        return;
    };
    for dir in &voices {
        let o = run(&mut command(&[dir.to_str().unwrap(), "--list-voices"]), "");
        assert!(o.status.success(), "{}", dir.display());
        let lines: Vec<Value> = String::from_utf8(o.stdout)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert!(!lines.is_empty());
        for (i, v) in lines.iter().enumerate() {
            assert_eq!(v["number"], i as u64);
            assert!(v["name"].as_str().is_some_and(|n| !n.is_empty()));
        }
        eprintln!("{}: {} voices", dir.display(), lines.len());
        // A voice by name speaks; an unknown one is refused before any audio.
        let name = lines.last().unwrap()["name"].as_str().unwrap();
        let o = run(
            &mut command(&[dir.to_str().unwrap(), "--voice", name]),
            "Hi.",
        );
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        assert!(!o.stdout.is_empty());
        let o = run(
            &mut command(&[dir.to_str().unwrap(), "--voice", "no-such-voice"]),
            "Hi.",
        );
        assert_eq!(o.status.code(), Some(1));
        assert!(o.stdout.is_empty());
        assert!(error_of(&o).contains("no voice \"no-such-voice\""));
    }
}
