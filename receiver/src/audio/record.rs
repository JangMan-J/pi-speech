//! `record <out.wav>`: the default input device to a 16-bit mono WAV file, until SIGINT,
//! SIGTERM or the end of standard input. The file is finished either way.
//!
//! The device's callback puts each captured buffer into a lock-free ring that holds
//! [`BACKLOG`]; it never waits and allocates nothing. Audio that finds the ring full is
//! lost and counted, and as much silence takes its place once there is room, so the
//! recording keeps its timeline. A writer thread takes from the ring, converts to 24 kHz
//! mono and writes. On a stop the device closes first, so everything it captured is
//! written before the file is finished.
//!
//! A real device that captured only exact zeros for the whole recording gave no signal
//! at all: on macOS that is what a microphone denied by the privacy settings delivers.
//! The file is still finished, but the recording ends in an error that says so. A real
//! microphone, however quiet, always has some noise; the null device is exempt.

use super::convert::Converter;
use super::device::{Format, Input};
use super::fail;
use super::ring::{self, Consumer, Producer};
use crate::proc::start_thread;
use crate::signals;
use crate::wav;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

pub const USAGE: &str = "pi-speech-receiver record <out.wav>";
/// The rate of recordings (the protocol asks for 16 kHz or more).
pub const RATE: u32 = 24000;
/// Captured audio the ring holds while the writer catches up.
const BACKLOG: Duration = Duration::from_secs(5);
/// How often the writer looks for captured audio.
const POLL: Duration = Duration::from_millis(20);

/// What ends a recording.
pub enum Event {
    /// A signal, or the end of standard input: finish the file.
    Stop,
    /// The device or the file failed: finish what there is, and report this.
    Failed(String),
}

/// Captured audio the ring had no room for, in samples.
#[derive(Default)]
struct Lost {
    /// All of it.
    total: AtomicU64,
    /// What has no silence in the ring yet; the device's callback keeps it, and the
    /// writer reads it once the device has closed.
    owed: AtomicU64,
}

/// Whether the device has captured anything, and anything but exact zeros.
#[derive(Default)]
struct Signal {
    /// Some samples were captured.
    captured: AtomicBool,
    /// Some captured sample was not exactly zero.
    heard: AtomicBool,
}

impl Signal {
    /// Note one captured buffer; called from the device's callback.
    fn see(&self, buf: &[f32]) {
        if buf.is_empty() {
            return;
        }
        self.captured.store(true, Ordering::Relaxed);
        if !self.heard.load(Ordering::Relaxed) && buf.iter().any(|&s| s != 0.0) {
            self.heard.store(true, Ordering::Relaxed);
        }
    }

    /// Samples were captured and every one of them was exactly zero.
    fn exactly_silent(&self) -> bool {
        self.captured.load(Ordering::Relaxed) && !self.heard.load(Ordering::Relaxed)
    }
}

/// The error for a real device that gave exact zeros for the whole recording.
fn no_signal_error() -> String {
    if cfg!(target_os = "macos") {
        "the microphone gave no signal at all (every sample was exactly zero); on macOS, allow \
         microphone access for this terminal in System Settings > Privacy & Security > Microphone"
            .into()
    } else {
        "the input device delivered no signal at all (every sample was exactly zero); check \
         that it is not muted and that this process may use it"
            .into()
    }
}

/// The device's side of the ring.
struct Capture {
    ring: Producer,
    /// Silence still to be put in the ring for audio lost, in samples.
    owed: usize,
    lost: Arc<Lost>,
    signal: Arc<Signal>,
}

impl Capture {
    /// The device's callback.
    fn take(&mut self, buf: &[f32]) {
        self.signal.see(buf);
        // The silence for audio lost earlier goes first, so what follows keeps its place.
        self.owed -= self.ring.push_silence(self.owed);
        let n = if self.owed == 0 {
            self.ring.push(buf)
        } else {
            0
        };
        if n < buf.len() {
            self.owed += buf.len() - n;
            self.lost
                .total
                .fetch_add((buf.len() - n) as u64, Ordering::Relaxed);
        }
        self.lost.owed.store(self.owed as u64, Ordering::Relaxed);
    }
}

/// Record from `input` into a new WAV file at `path` until `events` says to end; `tx`
/// sends to `events`. Returns the seconds recorded.
pub fn record(
    path: &Path,
    input: Input,
    tx: Sender<Event>,
    events: Receiver<Event>,
) -> Result<f64, String> {
    record_with(path, input, tx, events, BACKLOG)
}

fn record_with(
    path: &Path,
    input: Input,
    tx: Sender<Event>,
    events: Receiver<Event>,
    backlog: Duration,
) -> Result<f64, String> {
    let format = input.format();
    let real_device = !input.is_null();
    let file = wav::Writer::create(path, RATE, 1)
        .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
    let frames = (format.samples_in(backlog) / format.channels).max(1);
    let (producer, consumer) = ring::ring(frames, format.channels);
    let lost = Arc::new(Lost::default());
    let device_closed = Arc::new(AtomicBool::new(false));
    let writer = {
        let (lost, closed, failed) = (Arc::clone(&lost), Arc::clone(&device_closed), tx.clone());
        start_thread("wav-writer", move || {
            write_wav(file, consumer, format, &closed, &lost).inspect_err(|why| {
                let _ = failed.send(Event::Failed(why.clone()));
            })
        })
        .map_err(|e| format!("cannot start the writer: {e}"))?
    };
    // Once set, the device has closed: the writer drains the ring and finishes.
    let finish_writer = || {
        device_closed.store(true, Ordering::Release);
        writer.thread().unpark();
    };

    let signal = Arc::new(Signal::default());
    let mut capture = Capture {
        ring: producer,
        owed: 0,
        lost: Arc::clone(&lost),
        signal: Arc::clone(&signal),
    };
    let fatal_tx = tx;
    let started = input.start(
        move |buf| capture.take(buf),
        move |why| {
            let _ = fatal_tx.send(Event::Failed(why));
        },
    );
    let device = match started {
        Ok(d) => d,
        Err(e) => {
            finish_writer();
            let _ = writer.join();
            let _ = std::fs::remove_file(path);
            return Err(e);
        }
    };

    let event = events.recv().unwrap_or(Event::Stop);
    // Closed first, so all it captured is in the ring before the writer finishes.
    drop(device);
    finish_writer();
    let frames = writer
        .join()
        .unwrap_or_else(|_| Err("the writer failed".into()))?;
    let lost = lost.total.load(Ordering::Relaxed);
    if lost > 0 {
        let ms = format.duration_of(lost as usize).as_secs_f64() * 1000.0;
        eprintln!(
            "pi-speech-receiver: {ms:.0} ms of audio were lost: the file was written too slowly"
        );
    }
    match event {
        Event::Stop if real_device && signal.exactly_silent() => Err(no_signal_error()),
        Event::Stop => Ok(frames as f64 / RATE as f64),
        Event::Failed(why) => Err(why),
    }
}

/// The writer thread: what the ring holds, converted to 24 kHz mono and written, until
/// the device has closed; then the silence still owed for lost audio, and the file is
/// finished. Returns the frames written.
fn write_wav(
    mut file: wav::Writer,
    mut ring: Consumer,
    format: Format,
    device_closed: &AtomicBool,
    lost: &Lost,
) -> Result<u64, String> {
    let mut conv = Converter::new(format.rate, format.channels, RATE, 1);
    let mut buf = vec![0.0f32; format.samples_in(POLL * 4).max(format.channels)];
    let (mut mono, mut pcm) = (Vec::new(), Vec::new());
    let mut write = |samples: &[f32], conv: &mut Converter, end: bool| {
        mono.clear();
        conv.push(samples, &mut mono);
        if end {
            conv.finish(&mut mono);
        }
        pcm.clear();
        pcm.extend(
            mono.iter()
                .map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16),
        );
        file.write(&pcm)
            .map_err(|e| format!("cannot write the recording: {e}"))
    };
    loop {
        // Read before draining: once it is set, all the device captured is in the ring.
        let closed = device_closed.load(Ordering::Acquire);
        loop {
            let n = ring.pop(&mut buf);
            if n == 0 {
                break;
            }
            write(&buf[..n], &mut conv, false)?;
        }
        if closed {
            break;
        }
        std::thread::park_timeout(POLL);
    }
    let mut owed = lost.owed.load(Ordering::Relaxed) as usize;
    buf.fill(0.0);
    while owed > 0 {
        let n = owed.min(buf.len());
        write(&buf[..n], &mut conv, false)?;
        owed -= n;
    }
    write(&[], &mut conv, true)?;
    drop(write);
    file.finish()
        .map_err(|e| format!("cannot finish the recording: {e}"))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::device::Input;
    use std::time::Instant;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pisr-rec-{}-{}",
            std::process::id(),
            crate::token::random_hex(4).unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Record from the null input for `run`, with a ring of `backlog`: (seconds recorded,
    /// seconds until the stop was sent). The latter, not `run`, is what the recording
    /// should match: a busy machine can sleep longer than asked, and finishing the file
    /// (an fsync) can take a while after the stop.
    fn record_null(path: &Path, run: Duration, backlog: Duration) -> (f64, f64) {
        let (tx, rx) = mpsc::channel();
        let stop = tx.clone();
        let t = Instant::now();
        let stopper = std::thread::spawn(move || {
            std::thread::sleep(run);
            let at = t.elapsed().as_secs_f64();
            stop.send(Event::Stop).unwrap();
            at
        });
        let secs = record_with(path, Input::null(), tx, rx, backlog).unwrap();
        (secs, stopper.join().unwrap())
    }

    fn samples(bytes: &[u8]) -> Vec<i16> {
        bytes[44..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&b| i16::from_le_bytes(b))
            .collect()
    }

    #[test]
    fn the_null_input_records_a_wav_of_the_time_it_ran() {
        let dir = scratch();
        let path = dir.join("out.wav");
        let (secs, ran) = record_null(&path, Duration::from_millis(600), BACKLOG);
        assert!((secs - ran).abs() < 0.1, "{secs} s recorded in {ran} s");
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(wav::wav_seconds(&bytes), Some(secs));
        assert_eq!(&bytes[22..24], &1u16.to_le_bytes(), "mono");
        assert_eq!(&bytes[24..28], &RATE.to_le_bytes());
        let peak = samples(&bytes)
            .iter()
            .map(|s| s.unsigned_abs())
            .max()
            .unwrap();
        assert!(peak > 2000, "the null input's tone, not silence: {peak}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn audio_lost_to_a_full_ring_is_recorded_as_silence_in_its_place() {
        let (p, mut c) = ring::ring(4, 1);
        let lost = Arc::new(Lost::default());
        let mut cap = Capture {
            ring: p,
            owed: 0,
            lost: Arc::clone(&lost),
            signal: Arc::default(),
        };
        cap.take(&[1.0, 2.0, 3.0]);
        cap.take(&[4.0, 5.0, 6.0]); // room for one
        cap.take(&[7.0]); // no room
        assert_eq!(lost.total.load(Ordering::Relaxed), 3);
        assert_eq!(lost.owed.load(Ordering::Relaxed), 3);
        let mut out = [9.0; 4];
        assert_eq!(c.pop(&mut out), 4);
        assert_eq!(out, [1.0, 2.0, 3.0, 4.0]);
        cap.take(&[8.0, 9.0]); // the silence for 5 to 7 first, then room for 8 only
        assert_eq!(lost.total.load(Ordering::Relaxed), 4);
        assert_eq!(c.pop(&mut out), 4);
        assert_eq!(out, [0.0, 0.0, 0.0, 8.0]);
        cap.take(&[10.0]); // the silence for 9, then 10
        assert_eq!(lost.owed.load(Ordering::Relaxed), 0);
        let mut out = [9.0; 4];
        assert_eq!(c.pop(&mut out), 2);
        assert_eq!(
            out[..2],
            [0.0, 10.0],
            "every sample in its own place in time"
        );
    }

    #[test]
    fn a_recording_that_loses_audio_keeps_its_length() {
        let dir = scratch();
        let path = dir.join("out.wav");
        // A ring smaller than one of the null input's periods: most of each is lost.
        let (secs, ran) = record_null(&path, Duration::from_millis(600), Duration::from_millis(4));
        assert!((secs - ran).abs() < 0.1, "{secs} s recorded in {ran} s");
        let pcm = samples(&std::fs::read(&path).unwrap());
        let silent = pcm.iter().filter(|&&s| s == 0).count() as f64 / pcm.len() as f64;
        assert!(silent > 0.3, "the lost audio is silence: {silent}");
        let peak = pcm.iter().map(|s| s.unsigned_abs()).max().unwrap();
        assert!(peak > 2000, "and the rest is the tone: {peak}");
        std::fs::remove_dir_all(dir).ok();
    }

    fn silent(buffers: &[&[f32]]) -> bool {
        let s = Signal::default();
        for b in buffers {
            s.see(b);
        }
        s.exactly_silent()
    }

    #[test]
    fn only_exact_zeros_throughout_is_no_signal() {
        assert!(silent(&[&[0.0; 64], &[0.0, -0.0], &[0.0; 8]]));
        assert!(
            !silent(&[&[0.0; 64], &[0.0, 1e-9], &[0.0; 8]]),
            "faint noise"
        );
        assert!(!silent(&[&[-3e-5, 2e-5], &[0.0; 64]]), "noise, then zeros");
        assert!(!silent(&[&[0.0; 64], &[0.5]]), "zeros, then sound");
        assert!(!silent(&[]), "nothing captured is not silence");
        assert!(!silent(&[&[], &[]]));
        assert!(no_signal_error().contains("no signal"));
    }

    #[test]
    fn the_null_input_is_exempt_from_the_silence_check() {
        assert!(Input::null().is_null());
    }

    #[test]
    fn a_file_that_cannot_be_created_is_an_error() {
        let (tx, rx) = mpsc::channel();
        let r = record(Path::new("/nonexistent/dir/out.wav"), Input::null(), tx, rx);
        assert!(r.is_err_and(|e| e.contains("cannot create")));
    }
}
