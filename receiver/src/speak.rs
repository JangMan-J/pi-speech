//! `speak <model-dir|model-id> [--voice <name-or-number>] [--speed <x>]`: the text on standard
//! input, spoken by a local voice model (Kokoro, Piper) run in-process, as audio on standard
//! output while it is generated, sentence by sentence.
//!
//! - Standard output: raw signed 16-bit little-endian mono PCM at the model's rate, nothing else.
//! - Standard error: one JSON object per line. `{"event":"format","rate":<Hz>,"channels":1}`
//!   before any audio; then `{"event":"done"}` (exit 0) once all of it is written, or
//!   `{"event":"error","message"}` (exit 1). Other lines (from the model's libraries) may appear
//!   and are not JSON objects with an `event`.
//! - SIGINT, SIGTERM, or the closing of standard output stop it at once:
//!   `{"event":"stopped"}`, exit 1.
//! - `--list-voices`: one line per voice on standard output, `{"name","number"}`.
//!
//! A catalogue id (`models list`) names a downloaded speech model in the model cache (with the
//! lexicon it needs, for a Piper voice).

use crate::engines::synthesize::{self, pcm16, voice_number, Synthesizer};
use crate::models::cache;
use crate::models::catalog::{Catalog, Kind};
use crate::signals;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const USAGE: &str = "pi-speech-receiver speak <model-dir>|<model-id> [--voice <name-or-number>] [--speed <x>] [--list-voices]";
/// What `--help` adds to [`USAGE`].
pub const HELP_NOTE: &str = "speak reads the text on standard input and writes raw signed 16-bit \
little-endian mono PCM to standard output as it is generated; standard error carries JSON lines: \
{\"event\":\"format\",\"rate\":<Hz>,\"channels\":1} before any audio, then {\"event\":\"done\"} or \
{\"event\":\"error\",\"message\":...}. --list-voices prints {\"name\",\"number\"} lines.";

/// The slowest and fastest speed taken.
pub const MIN_SPEED: f32 = 0.25;
pub const MAX_SPEED: f32 = 4.0;

#[derive(Debug, PartialEq)]
pub enum Command {
    Help,
    ListVoices {
        model: String,
    },
    Speak {
        model: String,
        voice: Option<String>,
        speed: f32,
    },
}

pub fn parse_args(args: &[String]) -> Result<Command, String> {
    let usage = || format!("usage: {USAGE}");
    let mut model = None;
    let mut voice = None;
    let mut speed = None;
    let mut list = false;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n, Some(v.to_string())),
            _ => (a.as_str(), None),
        };
        let mut value = || {
            inline
                .clone()
                .or_else(|| it.next().cloned())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| format!("{name} needs a value; {}", usage()))
        };
        match name {
            "-h" | "--help" if args.len() == 1 => return Ok(Command::Help),
            "--voice" if voice.is_none() => voice = Some(value()?),
            "--speed" if speed.is_none() => {
                let v = value()?;
                let x: f32 = v
                    .parse()
                    .ok()
                    .filter(|x: &f32| x.is_finite())
                    .ok_or_else(|| format!("--speed must be a number, got {v:?}"))?;
                if !(MIN_SPEED..=MAX_SPEED).contains(&x) {
                    return Err(format!(
                        "--speed must be between {MIN_SPEED} and {MAX_SPEED}, got {v}"
                    ));
                }
                speed = Some(x);
            }
            "--list-voices" if inline.is_none() && !list => list = true,
            m if model.is_none() && !m.is_empty() && !m.starts_with('-') => {
                model = Some(m.to_string())
            }
            _ => return Err(usage()),
        }
    }
    let model = model.ok_or_else(usage)?;
    if list {
        if voice.is_some() || speed.is_some() {
            return Err(usage());
        }
        return Ok(Command::ListVoices { model });
    }
    Ok(Command::Speak {
        model,
        voice,
        speed: speed.unwrap_or(1.0),
    })
}

/// The line on standard error that gives the audio's format, before any audio.
pub fn format_line(rate: u32) -> Value {
    json!({"event": "format", "rate": rate, "channels": 1})
}

/// The model directory `speak` was given: a path, or a catalogue id of a downloaded speech
/// model (a path that exists wins).
pub fn resolve_voice_dir(arg: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(arg);
    if path.exists() {
        return Ok(path);
    }
    let catalog = Catalog::load()?;
    let Some(entry) = catalog.get(arg) else {
        return Ok(path);
    };
    if entry.kind != Kind::Speech {
        return Err(format!(
            "{arg} is a transcription model, not a speech model"
        ));
    }
    let root = cache::models_dir()?;
    if !cache::is_downloaded(&root, entry) {
        return Err(format!(
            "the model {arg} is not downloaded; download it with \
             `pi-speech-receiver models download {arg}`"
        ));
    }
    if let Some(l) = catalog.lexicon(entry) {
        if !cache::is_ready(&root, entry, Some(l)) {
            return Err(format!(
                "the voice {arg} needs the lexicon {}, which is not in the model cache; \
                 download it with `pi-speech-receiver models download {arg}`",
                l.name
            ));
        }
    }
    Ok(cache::model_path(&root, entry))
}

fn event(v: &Value) {
    let mut err = io::stderr().lock();
    let _ = writeln!(err, "{v}");
    let _ = err.flush();
}

/// End the process now, from any thread: the model may be in the middle of a sentence.
fn exit_now(code: i32) -> ! {
    #[cfg(unix)]
    unsafe {
        libc::_exit(code)
    }
    #[cfg(not(unix))]
    std::process::exit(code)
}

fn stopped() -> ! {
    event(&json!({"event": "stopped"}));
    exit_now(1)
}

/// Stop at once when the reader of standard output goes away, even mid-sentence (a write
/// would only tell at the end of the sentence). Unix pipes and sockets only; elsewhere the
/// next write tells.
#[cfg(unix)]
fn watch_stdout() {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(1, &mut st) } != 0 {
        return;
    }
    let kind = st.st_mode & libc::S_IFMT;
    if kind != libc::S_IFIFO && kind != libc::S_IFSOCK {
        return;
    }
    let _ = crate::proc::start_thread("stdout-watch", || loop {
        let mut fd = libc::pollfd {
            fd: 1,
            events: 0,
            revents: 0,
        };
        let n = unsafe { libc::poll(&mut fd, 1, -1) };
        if n > 0 && fd.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
            stopped();
        }
        if n < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return;
        }
    });
}

#[cfg(not(unix))]
fn watch_stdout() {}

fn list_voices(model: &str) -> Result<(), String> {
    let dir = resolve_voice_dir(model)?;
    let found = synthesize::detect(&dir)?;
    let synth = Synthesizer::load(&found)?;
    let mut out = io::stdout().lock();
    for (number, name) in synth.voices().iter().enumerate() {
        writeln!(out, "{}", json!({"name": name, "number": number}))
            .map_err(|e| format!("cannot write the voices: {e}"))?;
    }
    out.flush()
        .map_err(|e| format!("cannot write the voices: {e}"))
}

fn speak(model: &str, voice: Option<&str>, speed: f32) -> Result<(), String> {
    // The cheap checks first: a wrong path fails before a large model is loaded.
    let dir = resolve_voice_dir(model)?;
    let found = synthesize::detect(&dir)?;
    let mut text = String::new();
    io::stdin()
        .read_to_string(&mut text)
        .map_err(|e| format!("cannot read the text on standard input: {e}"))?;
    if text.trim().is_empty() {
        return Err("nothing to say: the text on standard input is empty".into());
    }
    let synth = Synthesizer::load(&found)?;
    let sid = match voice {
        Some(v) => voice_number(synth.voices(), v)?,
        None => 0,
    };
    event(&format_line(synth.sample_rate()));
    let closed = Arc::new(AtomicBool::new(false));
    let closed_cb = closed.clone();
    let mut out = io::stdout().lock();
    synth.generate(text.trim(), sid, speed, move |samples| {
        if samples.is_empty() {
            return true;
        }
        let ok = out.write_all(&pcm16(samples)).and_then(|()| out.flush());
        if ok.is_err() {
            closed_cb.store(true, Ordering::SeqCst);
        }
        ok.is_ok()
    })?;
    if closed.load(Ordering::SeqCst) {
        stopped();
    }
    Ok(())
}

pub fn main(args: &[String]) -> ExitCode {
    let command = match parse_args(args) {
        Ok(Command::Help) => {
            println!("usage: {USAGE}\n\n{HELP_NOTE}");
            return ExitCode::SUCCESS;
        }
        Ok(c) => c,
        Err(e) => {
            eprintln!("pi-speech-receiver: {e}");
            return ExitCode::from(2);
        }
    };
    if let Err(e) = signals::on_first(|_| stopped()) {
        event(&json!({"event": "error", "message": format!("cannot handle signals: {e}")}));
        return ExitCode::from(1);
    }
    let result = match command {
        Command::ListVoices { model } => list_voices(&model),
        Command::Speak {
            model,
            voice,
            speed,
        } => {
            watch_stdout();
            speak(&model, voice.as_deref(), speed).map(|()| event(&json!({"event": "done"})))
        }
        Command::Help => Ok(()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            event(&json!({"event": "error", "message": message}));
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

    fn speak(model: &str, voice: Option<&str>, speed: f32) -> Command {
        Command::Speak {
            model: model.into(),
            voice: voice.map(String::from),
            speed,
        }
    }

    #[test]
    fn the_arguments_name_a_model_a_voice_and_a_speed() {
        assert_eq!(parse_args(&args("kokoro")), Ok(speak("kokoro", None, 1.0)));
        assert_eq!(
            parse_args(&args("kokoro --voice af_sol --speed 1.5")),
            Ok(speak("kokoro", Some("af_sol"), 1.5))
        );
        assert_eq!(
            parse_args(&args("--voice=3 --speed=0.8 /m/kokoro")),
            Ok(speak("/m/kokoro", Some("3"), 0.8))
        );
        assert_eq!(
            parse_args(&args("piper --list-voices")),
            Ok(Command::ListVoices {
                model: "piper".into()
            })
        );
        assert_eq!(parse_args(&args("--help")), Ok(Command::Help));
        assert_eq!(parse_args(&args("-h")), Ok(Command::Help));
    }

    #[test]
    fn wrong_arguments_are_refused() {
        let usage = format!("usage: {USAGE}");
        for bad in [
            "",
            "a b",
            "--voice x",
            "a --voice",
            "a --voice x --voice y",
            "a --pitch 2",
            "a --list-voices --voice 1",
            "a --help",
            "a --list-voices=yes",
        ] {
            let e = parse_args(&args(bad)).unwrap_err();
            assert!(e.contains(&usage), "{bad:?}: {e}");
        }
        assert_eq!(
            parse_args(&args("a --speed fast")),
            Err("--speed must be a number, got \"fast\"".into())
        );
        assert_eq!(
            parse_args(&args("a --speed 9")),
            Err("--speed must be between 0.25 and 4, got 9".into())
        );
        assert!(parse_args(&args("a --speed NaN")).is_err());
    }

    #[test]
    fn the_format_line_gives_the_rate_and_one_channel() {
        let line = format_line(24000).to_string();
        assert!(!line.contains('\n'), "{line}");
        let v: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v, json!({"event": "format", "rate": 24000, "channels": 1}));
        let v: Value = serde_json::from_str(&format_line(22050).to_string()).unwrap();
        assert_eq!(v["event"], "format");
        assert_eq!(v["rate"], 22050);
        assert_eq!(v["channels"], 1);
    }
}
