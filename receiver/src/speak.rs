//! `speak <model-dir|model-id> [--voice <name-or-number>] [--speed <x>] [--lang <code>]`: the
//! text on standard input, spoken by a local voice model (Kokoro, Kitten, Piper, Supertonic,
//! Pocket TTS) run in-process, as audio on standard output while it is generated, sentence by
//! sentence.
//!
//! - Standard output: raw signed 16-bit little-endian mono PCM at the model's rate, nothing else
//!   (none for text with no letter or digit).
//! - Standard error: one JSON object per line. `{"event":"format","rate":<Hz>,"channels":1}`
//!   before any audio; then `{"event":"done"}` (exit 0) once all of it is written, or
//!   `{"event":"error","message"}` (exit 1). Other lines (from the model's libraries) may appear
//!   and are not JSON objects with an `event`.
//! - SIGINT, SIGTERM, or the closing of standard output stop it at once:
//!   `{"event":"stopped"}`, exit 1.
//! - `--list-voices`: one line per voice on standard output, `{"name","number"}`.
//! - `--lang`: the language of the text, for a model that is told it (Supertonic: `en`, `de`, …;
//!   English when left out). Another model refuses it.
//!
//! A catalogue id (`models list`) names a downloaded speech model in the model cache (with the
//! lexicon it needs, for a Piper or Kitten voice).
//!
//! `speak --serve` stays running and keeps the last voice model it used loaded, so that only the
//! first utterance pays for loading it (about 2 s for most models). Requests are JSON lines on
//! standard input, read on their own thread so that a cancel can arrive while one is spoken:
//!
//! - `{"id":<n>,"model":"<id or dir>","text":"…","voice":"…","speed":1,"lang":"de"}`: speak it
//!   (`voice`, `speed` and `lang` optional);
//! - `{"id":<n>,"model":"…","load":true}`: load the model now;
//! - `{"cancel":<n>}`: stop request `n` at the next piece of audio (the model stays loaded); a
//!   cancel of a request already answered does nothing.
//!
//! Answers go to standard output as frames, each one byte of kind, its length (4 bytes, little
//! endian), and that many bytes: `J`, a JSON event with the request's `id` (`format` with `rate`
//! and `channels`, then `done`, `stopped` or `error` with `message`; `loaded` for a load); `A`,
//! audio of the request whose `format` came last (signed 16-bit little-endian PCM). Requests are
//! answered one at a time, in order. It exits when standard input closes, or its reader goes.

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

pub const USAGE: &str = "pi-speech-receiver speak <model-dir>|<model-id> [--voice <name-or-number>] [--speed <x>] [--lang <code>] [--list-voices]";
/// What `--help` adds to [`USAGE`].
pub const HELP_NOTE: &str = "speak reads the text on standard input and writes raw signed 16-bit \
little-endian mono PCM to standard output as it is generated; standard error carries JSON lines: \
{\"event\":\"format\",\"rate\":<Hz>,\"channels\":1} before any audio, then {\"event\":\"done\"} or \
{\"event\":\"error\",\"message\":...}. --list-voices prints {\"name\",\"number\"} lines. --lang \
names the language of the text for a model told it (Supertonic; English by default).";

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
        /// The language of the text, for a model told it.
        lang: Option<String>,
    },
}

pub fn parse_args(args: &[String]) -> Result<Command, String> {
    let usage = || format!("usage: {USAGE}");
    let mut model = None;
    let mut voice = None;
    let mut speed = None;
    let mut lang = None;
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
            "--lang" if lang.is_none() => lang = Some(value()?),
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
        if voice.is_some() || speed.is_some() || lang.is_some() {
            return Err(usage());
        }
        return Ok(Command::ListVoices { model });
    }
    Ok(Command::Speak {
        model,
        voice,
        speed: speed.unwrap_or(1.0),
        lang,
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

fn speak(model: &str, voice: Option<&str>, speed: f32, lang: Option<&str>) -> Result<(), String> {
    // The cheap checks first: a wrong path fails before a large model is loaded.
    let dir = resolve_voice_dir(model)?;
    let found = synthesize::detect(&dir)?;
    synthesize::pick_language(&found.languages(), lang, found.family())?;
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
    synth.generate(text.trim(), sid, speed, lang, move |samples| {
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

/// The kept voice model of `serve`: its directory and the loaded model.
type Kept = Option<(PathBuf, Synthesizer)>;

/// The frames of `serve` on standard output.
struct Frames(io::Stdout);

impl Frames {
    fn send(&self, kind: u8, payload: &[u8]) {
        let mut out = self.0.lock();
        let len = u32::try_from(payload.len())
            .unwrap_or(u32::MAX)
            .to_le_bytes();
        let ok = out
            .write_all(&[kind])
            .and_then(|()| out.write_all(&len))
            .and_then(|()| out.write_all(payload))
            .and_then(|()| out.flush());
        if ok.is_err() {
            // Nobody reads the answers any more.
            exit_now(0);
        }
    }

    fn event(&self, v: Value) {
        self.send(b'J', v.to_string().as_bytes());
    }
}

/// The voice model `model` names, loaded (the kept one when it is that one).
fn synthesizer<'a>(kept: &'a mut Kept, model: &str) -> Result<&'a Synthesizer, String> {
    let dir = resolve_voice_dir(model)?;
    if !kept.as_ref().is_some_and(|(d, _)| *d == dir) {
        *kept = None;
        let found = synthesize::detect(&dir)?;
        *kept = Some((dir, Synthesizer::load(&found)?));
    }
    Ok(&kept.as_ref().expect("kept above").1)
}

/// One request of `serve`, answered.
fn answer(
    kept: &mut Kept,
    req: &Value,
    frames: &Arc<Frames>,
    cancel: &Arc<std::sync::atomic::AtomicI64>,
) {
    let id = req.get("id").and_then(Value::as_i64).unwrap_or(-1);
    let s = |k: &str| req.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    let fail = |m: String| frames.event(json!({"id": id, "event": "error", "message": m}));
    let Some(model) = s("model") else {
        return fail("the request names no model".into());
    };
    if req.get("load").and_then(Value::as_bool) == Some(true) {
        match synthesizer(kept, model) {
            Ok(_) => frames.event(json!({"id": id, "event": "loaded"})),
            Err(e) => fail(e),
        }
        return;
    }
    let text = s("text").map(str::trim).unwrap_or("");
    if text.is_empty() {
        return fail("nothing to say: the text is empty".into());
    }
    let speed = req.get("speed").and_then(Value::as_f64).unwrap_or(1.0) as f32;
    if !(MIN_SPEED..=MAX_SPEED).contains(&speed) {
        return fail(format!("speed must be from {MIN_SPEED} to {MAX_SPEED}"));
    }
    let lang = s("lang");
    let synth = match synthesizer(kept, model) {
        Ok(s) => s,
        Err(e) => return fail(e),
    };
    let sid = match s("voice") {
        Some(v) => match voice_number(synth.voices(), v) {
            Ok(n) => n,
            Err(e) => return fail(e),
        },
        None => 0,
    };
    frames.event(json!({"id": id, "event": "format", "rate": synth.sample_rate(), "channels": 1}));
    let stopped = Arc::new(AtomicBool::new(false));
    let (f, c, st) = (frames.clone(), cancel.clone(), stopped.clone());
    let result = synth.generate(text, sid, speed, lang, move |samples| {
        if c.load(Ordering::SeqCst) == id {
            st.store(true, Ordering::SeqCst);
            return false;
        }
        if !samples.is_empty() {
            f.send(b'A', &pcm16(samples));
        }
        true
    });
    match result {
        _ if stopped.load(Ordering::SeqCst) => frames.event(json!({"id": id, "event": "stopped"})),
        Ok(()) => frames.event(json!({"id": id, "event": "done"})),
        Err(e) => fail(e),
    }
}

/// `speak --serve`: requests on standard input, frames on standard output.
pub fn serve() -> ExitCode {
    use std::io::BufRead;
    use std::sync::atomic::AtomicI64;
    let frames = Arc::new(Frames(io::stdout()));
    let cancel = Arc::new(AtomicI64::new(-1));
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    let c = cancel.clone();
    let reader = crate::proc::start_thread("speak-requests", move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(n) = v.get("cancel").and_then(Value::as_i64) {
                c.store(n, Ordering::SeqCst);
            } else if tx.send(v).is_err() {
                break;
            }
        }
    });
    if let Err(e) = reader {
        frames.event(json!({"event": "error", "message": format!("cannot read requests: {e}")}));
        return ExitCode::from(1);
    }
    let mut kept: Kept = None;
    for req in rx {
        answer(&mut kept, &req, &frames, &cancel);
    }
    ExitCode::SUCCESS
}

pub fn main(args: &[String]) -> ExitCode {
    if matches!(args, [a] if a == "--serve") {
        return serve();
    }
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
            lang,
        } => {
            watch_stdout();
            speak(&model, voice.as_deref(), speed, lang.as_deref())
                .map(|()| event(&json!({"event": "done"})))
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
            lang: None,
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
        assert_eq!(
            parse_args(&args("supertonic --lang de --voice M1")),
            Ok(Command::Speak {
                model: "supertonic".into(),
                voice: Some("M1".into()),
                speed: 1.0,
                lang: Some("de".into()),
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
            "a --lang",
            "a --lang de --lang fr",
            "a --list-voices --lang de",
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
