//! `record <out.wav>`: the default input device to a 16-bit mono WAV file, until SIGINT,
//! SIGTERM or the end of standard input. The file is finished either way.
//!
//! The device's callback hands each captured buffer to a writer thread through a bounded
//! channel (it never waits: a buffer that finds the channel full is lost and counted);
//! the writer converts to 24 kHz mono and writes. On a stop the device closes first, so
//! everything it captured is written before the file is finished.

use super::convert::Converter;
use super::device::Input;
use crate::proc::start_thread;
use crate::signals;
use crate::wav;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;

pub const USAGE: &str = "pi-speech-receiver record <out.wav>";
/// The rate of recordings (the protocol asks for 16 kHz or more).
pub const RATE: u32 = 24000;
/// Captured buffers waiting for the writer: about 5 s at 20 ms per buffer.
const BACKLOG: usize = 256;

/// What ends a recording.
pub enum Event {
    /// A signal, or the end of standard input: finish the file.
    Stop,
    /// The device or the file failed: finish what there is, and report this.
    Failed(String),
}

enum Msg {
    Audio(Vec<f32>),
    End,
}

/// Record from `input` into a new WAV file at `path` until `events` says to end; `tx`
/// sends to `events`. Returns the seconds recorded.
pub fn record(
    path: &Path,
    input: Input,
    tx: Sender<Event>,
    events: Receiver<Event>,
) -> Result<f64, String> {
    let format = input.format();
    let mut file = wav::Writer::create(path, RATE, 1)
        .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    let (audio_tx, audio_rx) = mpsc::sync_channel::<Msg>(BACKLOG);
    let writer_tx = tx.clone();
    let writer = thread::Builder::new()
        .name("wav-writer".into())
        .spawn(move || -> Result<u64, String> {
            let mut conv = Converter::new(format.rate, format.channels, RATE, 1);
            let (mut mono, mut pcm) = (Vec::new(), Vec::new());
            let mut write = |mono: &[f32]| {
                pcm.clear();
                pcm.extend(
                    mono.iter()
                        .map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16),
                );
                file.write(&pcm).map_err(|e| {
                    let why = format!("cannot write the recording: {e}");
                    let _ = writer_tx.send(Event::Failed(why.clone()));
                    why
                })
            };
            while let Ok(Msg::Audio(buf)) = audio_rx.recv() {
                mono.clear();
                conv.push(&buf, &mut mono);
                write(&mono)?;
            }
            mono.clear();
            conv.finish(&mut mono);
            write(&mono)?;
            drop(write);
            file.finish()
                .map_err(|e| format!("cannot finish the recording: {e}"))
        })
        .map_err(|e| format!("cannot start the writer: {e}"))?;

    let lost = Arc::new(AtomicU64::new(0));
    let (cb_tx, cb_lost) = (audio_tx.clone(), Arc::clone(&lost));
    let fatal_tx = tx;
    let started = input.start(
        move |buf| {
            if cb_tx.try_send(Msg::Audio(buf.to_vec())).is_err() {
                cb_lost.fetch_add(buf.len() as u64, Ordering::Relaxed);
            }
        },
        move |why| {
            let _ = fatal_tx.send(Event::Failed(why));
        },
    );
    let stream = match started {
        Ok(s) => s,
        Err(e) => {
            let _ = audio_tx.send(Msg::End);
            let _ = writer.join();
            let _ = std::fs::remove_file(path);
            return Err(e);
        }
    };

    let event = events.recv().unwrap_or(Event::Stop);
    // Closed first, so all it captured is queued ahead of the end.
    drop(stream);
    let _ = audio_tx.send(Msg::End);
    let frames = writer
        .join()
        .unwrap_or_else(|_| Err("the writer failed".into()))?;
    let lost = lost.load(Ordering::Relaxed);
    if lost > 0 {
        let ms = lost as f64 * 1000.0 / format.channels as f64 / format.rate as f64;
        eprintln!(
            "pi-speech-receiver: {ms:.0} ms of audio were lost: the file was written too slowly"
        );
    }
    match event {
        Event::Stop => Ok(frames as f64 / RATE as f64),
        Event::Failed(why) => Err(why),
    }
}

/// `pi-speech-receiver record <out.wav>`
pub fn main(args: &[String]) -> ExitCode {
    let path = match args {
        [p] if !p.is_empty() && !p.starts_with('-') => PathBuf::from(p),
        _ => return fail(&format!("usage: {USAGE}"), 2),
    };
    let (tx, events) = mpsc::channel();
    let on_signal = tx.clone();
    if let Err(e) = signals::on_first(move |_| {
        let _ = on_signal.send(Event::Stop);
    }) {
        return fail(&format!("cannot handle signals: {e}"), 1);
    }
    let on_eof = tx.clone();
    let watch = start_thread("stdin", move || {
        let mut buf = [0u8; 256];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = on_eof.send(Event::Stop);
    });
    if let Err(e) = watch {
        return fail(&format!("cannot watch the input: {e}"), 1);
    }
    let input = match Input::open_default() {
        Ok(i) => i,
        Err(e) => return fail(&e, 1),
    };
    match record(&path, input, tx, events) {
        Ok(_) => ExitCode::SUCCESS,
        Err(e) => fail(&e, 1),
    }
}

fn fail(why: &str, code: u8) -> ExitCode {
    eprintln!("pi-speech-receiver: {why}");
    ExitCode::from(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::device::Input;
    use std::time::{Duration, Instant};

    #[test]
    fn the_null_input_records_a_wav_of_the_time_it_ran() {
        let dir = std::env::temp_dir().join(format!(
            "pisr-rec-{}-{}",
            std::process::id(),
            crate::token::random_hex(4).unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.wav");
        let (tx, rx) = mpsc::channel();
        let stop = tx.clone();
        let t = Instant::now();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            stop.send(Event::Stop).unwrap();
        });
        let secs = record(&path, Input::null(), tx, rx).unwrap();
        let ran = t.elapsed().as_secs_f64();
        assert!((secs - ran).abs() < 0.1, "{secs} s recorded in {ran} s");
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(wav::wav_seconds(&bytes), Some(secs));
        assert_eq!(&bytes[22..24], &1u16.to_le_bytes(), "mono");
        assert_eq!(&bytes[24..28], &RATE.to_le_bytes());
        let peak = bytes[44..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&b| i16::from_le_bytes(b).unsigned_abs())
            .max()
            .unwrap();
        assert!(peak > 2000, "the null input's tone, not silence: {peak}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_file_that_cannot_be_created_is_an_error() {
        let (tx, rx) = mpsc::channel();
        let r = record(Path::new("/nonexistent/dir/out.wav"), Input::null(), tx, rx);
        assert!(r.is_err_and(|e| e.contains("cannot create")));
    }
}
