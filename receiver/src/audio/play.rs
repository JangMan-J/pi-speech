//! `play`: audio from standard input or a file to the default output device, played as
//! it arrives (a Stream, when the input is one).
//!
//! A feeder thread decodes the input, converts it to the device's format and pushes it
//! into a lock-free ring; when the ring is full the feeder (and so whoever writes to our
//! input) waits. The device's callback takes from the ring, and plays silence while the
//! input stalls. After the input has ended and the ring has drained, the device stream
//! stays open until the device has played what it holds: the largest latency it reported,
//! one period, and a margin. A stop empties nothing and waits for nothing: the device
//! closes at once. A device that stops calling back for [`STALL`] fails the playback.

use super::convert::Converter;
use super::decode::{Decode, Pcm, WavOrMp3};
use super::device::{Format, Output};
use super::fail;
use super::ring::{self, Consumer, Producer};
use crate::proc::{lock, start_thread};
use crate::signals;
use crate::stream::{MAX_RATE, MIN_RATE};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{fence, AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const USAGE: &str = "pi-speech-receiver play (s16le <rate> <channels> | mp3 | wav | <file>)";

/// How much converted audio the ring holds before the feeder waits.
pub const QUEUE: Duration = Duration::from_millis(500);
/// Added to the device's own latency before the device stream closes.
pub const TAIL_MARGIN: Duration = Duration::from_millis(80);
/// How long the device may go without calling back, while there is input to come or to
/// drain, before the playback fails.
pub const STALL: Duration = Duration::from_secs(2);
pub const STALLED: &str = "the audio device stopped responding";
/// How often the waiting thread looks for callbacks.
const WATCH: Duration = Duration::from_millis(100);

/// What to play.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// Raw signed 16-bit little-endian PCM on standard input.
    Pcm { rate: u32, channels: usize },
    /// An MP3 file on standard input.
    Mp3,
    /// A WAV file on standard input.
    Wav,
    /// A WAV or MP3 file.
    File(PathBuf),
}

impl Source {
    pub fn parse(args: &[String]) -> Result<Source, String> {
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        match args.as_slice() {
            ["s16le", rate, channels] => {
                let rate = rate
                    .parse()
                    .ok()
                    .filter(|r| (MIN_RATE..=MAX_RATE).contains(r))
                    .ok_or(format!("the rate must be {MIN_RATE} to {MAX_RATE} Hz"))?;
                let channels = match *channels {
                    "1" => 1,
                    "2" => 2,
                    _ => return Err("the channels must be 1 or 2".into()),
                };
                Ok(Source::Pcm { rate, channels })
            }
            ["mp3"] => Ok(Source::Mp3),
            ["wav"] => Ok(Source::Wav),
            [path] if !path.is_empty() && !path.starts_with('-') => {
                Ok(Source::File(PathBuf::from(path)))
            }
            _ => Err(format!("usage: {USAGE}")),
        }
    }

    /// Open the input: for WAV or MP3 on standard input (non-seekable input), blocks
    /// until its header has arrived.
    fn open(self) -> Result<Box<dyn Decode>, String> {
        let stdin = std::io::stdin;
        Ok(match self {
            Source::Pcm { rate, channels } => Box::new(Pcm::new(stdin(), rate, channels)),
            Source::Mp3 => Box::new(WavOrMp3::from_non_seekable(stdin(), Some("mp3"))?),
            Source::Wav => Box::new(WavOrMp3::from_non_seekable(stdin(), Some("wav"))?),
            Source::File(path) => {
                let file = std::fs::File::open(&path)
                    .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
                let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
                Box::new(WavOrMp3::open(Box::new(file), ext.as_deref())?)
            }
        })
    }
}

/// How a playback ended, when it did not fail.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Everything was played and heard.
    Played,
    /// Stopped by a signal, whose number this is.
    Stopped(i32),
}

/// Why a playback ended early.
#[derive(Debug)]
enum End {
    Stopped(i32),
    Failed(String),
}

/// What the feeder, the device's callback and the waiting thread share. The audio itself
/// goes through a lock-free ring; the lock guards only how the playback ended early, and
/// the callback takes it only to wake a thread that can go on (the feeder when the ring
/// is no longer full, the waiting thread when the input has drained), for as long as a
/// waiter takes to look at its condition.
#[derive(Default)]
struct Shared {
    end: Mutex<Option<End>>,
    /// The feeder waits here for room in the ring.
    room: Condvar,
    /// The waiting thread waits here for the input to drain or the playback to end.
    done: Condvar,
    /// Set with `end`: the device plays silence and the feeder stops.
    ended: AtomicBool,
    input_ended: AtomicBool,
    /// The input has ended and the device has taken all of it.
    drained: AtomicBool,
    /// The feeder waits, or is about to, for room in the ring.
    wants_room: AtomicBool,
    /// The device's callbacks so far, for the watchdog.
    callbacks: AtomicU64,
    /// The largest latency the device reported, and its longest period, in ns.
    latency: AtomicU64,
    period: AtomicU64,
}

impl Shared {
    fn lock_end(&self) -> MutexGuard<'_, Option<End>> {
        lock(&self.end)
    }

    /// End the playback early, unless it already ended.
    fn end(&self, why: End) {
        let mut end = self.lock_end();
        self.end_locked(&mut end, why);
    }

    fn end_locked(&self, end: &mut Option<End>, why: End) {
        if end.is_none() {
            *end = Some(why);
        }
        self.ended.store(true, Ordering::Release);
        self.room.notify_all();
        self.done.notify_all();
    }

    /// Wait until the device has taken all the input, or the playback ended early. A
    /// device that has not called back for `stall` ends it.
    fn wait_drained(&self, stall: Duration) -> Option<End> {
        let mut end = self.lock_end();
        let mut seen = self.callbacks.load(Ordering::Relaxed);
        let mut since = Instant::now();
        while end.is_none() && !self.drained.load(Ordering::Acquire) {
            end = self
                .done
                .wait_timeout(end, WATCH)
                .unwrap_or_else(|e| e.into_inner())
                .0;
            let now = self.callbacks.load(Ordering::Relaxed);
            if now != seen {
                (seen, since) = (now, Instant::now());
            } else if since.elapsed() >= stall {
                self.end_locked(&mut end, End::Failed(STALLED.into()));
            }
        }
        end.take()
    }

    /// Wait for the device to play what it was given, unless the playback ends early.
    fn wait_heard(&self) -> Option<End> {
        let ns = |a: &AtomicU64| Duration::from_nanos(a.load(Ordering::Relaxed));
        let tail = ns(&self.latency) + ns(&self.period) + TAIL_MARGIN;
        let end = self.lock_end();
        let (mut end, _) = self
            .done
            .wait_timeout_while(end, tail, |e| e.is_none())
            .unwrap_or_else(|e| e.into_inner());
        end.take()
    }
}

/// The feeder's side of the ring.
struct Feeder {
    ring: Producer,
    shared: Arc<Shared>,
    channels: usize,
}

impl Feeder {
    /// Add audio (whole frames), waiting while the ring is full. False once the playback
    /// has ended.
    fn push(&mut self, samples: &[f32]) -> bool {
        let mut rest = &samples[..samples.len() - samples.len() % self.channels];
        loop {
            if self.shared.ended.load(Ordering::Acquire) {
                return false;
            }
            let n = self.ring.push(rest);
            rest = &rest[n..];
            if rest.is_empty() {
                return true;
            }
            self.wait_for_room();
        }
    }

    fn wait_for_room(&self) {
        let s = &self.shared;
        let end = s.lock_end();
        s.wants_room.store(true, Ordering::Relaxed);
        // Paired with the fence in `Tap::fill`: either the callback sees `wants_room` and
        // wakes us, or we see the room it made and do not wait.
        fence(Ordering::SeqCst);
        let _end = s
            .room
            .wait_while(end, |_| {
                self.ring.free() == 0 && !s.ended.load(Ordering::Acquire)
            })
            .unwrap_or_else(|e| e.into_inner());
        s.wants_room.store(false, Ordering::Relaxed);
    }

    fn end_input(&self) {
        self.shared.input_ended.store(true, Ordering::Release);
    }
}

/// The device's side of the ring.
struct Tap {
    ring: Consumer,
    shared: Arc<Shared>,
    format: Format,
}

impl Tap {
    /// The device's callback: the next audio, or silence when there is none. Waits for
    /// no one; takes the lock only to wake a waiter that can go on.
    fn fill(&mut self, out: &mut [f32], latency: Duration) {
        let s = &self.shared;
        s.callbacks.fetch_add(1, Ordering::Relaxed);
        let period = self.format.duration_of(out.len());
        s.latency
            .fetch_max(latency.as_nanos() as u64, Ordering::Relaxed);
        s.period
            .fetch_max(period.as_nanos() as u64, Ordering::Relaxed);
        let n = if s.ended.load(Ordering::Acquire) {
            0
        } else {
            self.ring.pop(out)
        };
        out[n..].fill(0.0);
        // See `Feeder::wait_for_room`.
        fence(Ordering::SeqCst);
        if n > 0 && s.wants_room.swap(false, Ordering::Relaxed) {
            let _end = s.lock_end();
            s.room.notify_all();
        }
        if s.input_ended.load(Ordering::Acquire)
            && self.ring.is_empty()
            && !s.drained.swap(true, Ordering::AcqRel)
        {
            let _end = s.lock_end();
            s.done.notify_all();
        }
    }
}

/// A playback; it may be stopped before its output device is open.
#[derive(Default)]
pub struct Player {
    shared: Arc<Shared>,
}

impl Player {
    pub fn new() -> Player {
        Player::default()
    }

    /// Something any thread may call to stop the playback at once, as by signal `sig`.
    pub fn stopper(&self) -> impl FnOnce(i32) + Send + 'static {
        let s = Arc::clone(&self.shared);
        move |sig| s.end(End::Stopped(sig))
    }

    /// Play `source` on `output` to its end, or until stopped.
    pub fn play(self, output: Output, source: Source) -> Result<Outcome, String> {
        self.play_from(output, move || source.open())
    }

    /// Play what `open` gives, on the feeder thread.
    pub fn play_from<F>(self, output: Output, open: F) -> Result<Outcome, String>
    where
        F: FnOnce() -> Result<Box<dyn Decode>, String> + Send + 'static,
    {
        let shared = self.shared;
        if shared.ended.load(Ordering::Acquire) {
            // Stopped while the output was being opened: nothing to play.
            return outcome(shared.lock_end().take());
        }
        let format = output.format();
        let (producer, consumer) = ring::ring(
            (format.samples_in(QUEUE) / format.channels).max(1),
            format.channels,
        );
        let mut tap = Tap {
            ring: consumer,
            shared: Arc::clone(&shared),
            format,
        };
        let f = Arc::clone(&shared);
        let device = output.start(
            move |buf, latency| tap.fill(buf, latency),
            move |why| f.end(End::Failed(why)),
        )?;
        let mut feeder = Feeder {
            ring: producer,
            shared: Arc::clone(&shared),
            channels: format.channels,
        };
        start_thread("feeder", move || match feed(open, &mut feeder, format) {
            Ok(()) => feeder.end_input(),
            Err(e) => feeder.shared.end(End::Failed(e)),
        })
        .map_err(|e| format!("cannot start the feeder: {e}"))?;
        let end = shared.wait_drained(STALL).or_else(|| shared.wait_heard());
        drop(device);
        outcome(end)
    }
}

fn outcome(end: Option<End>) -> Result<Outcome, String> {
    match end {
        None => Ok(Outcome::Played),
        Some(End::Stopped(sig)) => Ok(Outcome::Stopped(sig)),
        Some(End::Failed(why)) => Err(why),
    }
}

/// Decode the input and queue it in the device's format, until it ends or the playback
/// does.
fn feed<F>(open: F, feeder: &mut Feeder, format: Format) -> Result<(), String>
where
    F: FnOnce() -> Result<Box<dyn Decode>, String>,
{
    let mut decoder = open()?;
    let mut conv: Option<Converter> = None;
    let mut out = Vec::new();
    while let Some(chunk) = decoder.next_chunk()? {
        out.clear();
        // A change of format (rare, but MP3 allows it) starts a new conversion.
        if !conv
            .as_ref()
            .is_some_and(|c| c.takes(chunk.rate, chunk.channels))
        {
            if let Some(old) = conv.as_mut() {
                old.finish(&mut out);
            }
            conv = Some(Converter::new(
                chunk.rate,
                chunk.channels,
                format.rate,
                format.channels,
            ));
        }
        if let Some(c) = conv.as_mut() {
            c.push(chunk.samples, &mut out);
        }
        if !feeder.push(&out) {
            return Ok(());
        }
    }
    if let Some(c) = conv.as_mut() {
        out.clear();
        c.finish(&mut out);
        feeder.push(&out);
    }
    Ok(())
}

/// `pi-speech-receiver play ...`
pub fn main(args: &[String]) -> ExitCode {
    let source = match Source::parse(args) {
        Ok(s) => s,
        Err(e) => return fail(&e, 2),
    };
    // Before the device is opened, which can take a while: a signal meanwhile still stops.
    let player = Player::new();
    if let Err(e) = signals::on_first(player.stopper()) {
        return fail(&format!("cannot handle signals: {e}"), 1);
    }
    let output = match Output::open_default() {
        Ok(o) => o,
        Err(e) => return fail(&e, 1),
    };
    match player.play(output, source) {
        Ok(Outcome::Played) => ExitCode::SUCCESS,
        // As a shell reports a program a signal ended: 128 + its number. (`record` exits 0
        // instead: a signal is how a recording is meant to end, but it cuts a playback short.)
        Ok(Outcome::Stopped(sig)) => ExitCode::from(128u8.wrapping_add(sig as u8)),
        Err(e) => fail(&e, 1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::decode::tests::{open_wav, pcm_bytes, Dribble};

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn the_arguments_name_the_source() {
        let p = |s: &str| Source::parse(&args(s));
        assert_eq!(
            p("s16le 24000 1"),
            Ok(Source::Pcm {
                rate: 24000,
                channels: 1
            })
        );
        assert_eq!(p("mp3"), Ok(Source::Mp3));
        assert_eq!(p("wav"), Ok(Source::Wav));
        assert_eq!(p("/tmp/a.wav"), Ok(Source::File("/tmp/a.wav".into())));
        for bad in [
            "",
            "s16le 24000",
            "s16le 7999 1",
            "s16le 24000 3",
            "s16le x 1",
            "mp3 extra",
            "--help",
        ] {
            assert!(p(bad).is_err(), "{bad:?}");
        }
    }

    const FORMAT: Format = Format {
        rate: 1000,
        channels: 1,
    };

    /// A feeder and a device side around a ring of 0.5 s at 1000 Hz mono.
    fn pair() -> (Arc<Shared>, Feeder, Tap) {
        let shared = Arc::new(Shared::default());
        let (p, c) = ring::ring(FORMAT.samples_in(QUEUE), 1);
        let feeder = Feeder {
            ring: p,
            shared: Arc::clone(&shared),
            channels: 1,
        };
        let tap = Tap {
            ring: c,
            shared: Arc::clone(&shared),
            format: FORMAT,
        };
        (shared, feeder, tap)
    }

    #[test]
    fn a_stall_plays_silence_and_the_audio_resumes_after_it() {
        let (s, mut feeder, mut tap) = pair();
        assert!(feeder.push(&[0.5; 30]));
        let mut out = [9.0; 20];
        tap.fill(&mut out, Duration::ZERO);
        assert_eq!(out, [0.5; 20]);
        tap.fill(&mut out, Duration::ZERO);
        assert_eq!(out[..10], [0.5; 10]);
        assert_eq!(out[10..], [0.0; 10], "silence while the input stalls");
        tap.fill(&mut out, Duration::ZERO);
        assert_eq!(out, [0.0; 20]);
        assert!(!s.drained.load(Ordering::Relaxed), "a stall is not the end");
        assert!(feeder.push(&[0.25; 5]));
        feeder.end_input();
        tap.fill(&mut out, Duration::ZERO);
        assert_eq!(out[..5], [0.25; 5]);
        assert!(s.drained.load(Ordering::Relaxed));
        assert!(s.wait_drained(STALL).is_none());
    }

    #[test]
    fn a_full_ring_holds_the_feeder_until_the_device_takes_audio() {
        let (_s, mut feeder, mut tap) = pair();
        let feeder = std::thread::spawn(move || {
            let ok = feeder.push(&[0.1; 600]); // 0.1 s more than the ring holds
            (ok, feeder)
        });
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !feeder.is_finished(),
            "the feeder waits while the ring is full"
        );
        assert_eq!(tap.ring.len(), 500);
        tap.fill(&mut [0.0; 100], Duration::ZERO);
        let (ok, feeder) = feeder.join().unwrap();
        assert!(ok);
        assert_eq!(tap.ring.len(), 500);
        assert!(!feeder.shared.wants_room.load(Ordering::Relaxed));
    }

    #[test]
    fn the_device_side_waits_for_no_lock_when_no_one_waits_on_it() {
        let (s, mut feeder, mut tap) = pair();
        assert!(feeder.push(&[0.5; 100]));
        let held = s.lock_end(); // as a waiter looking at its condition would
        let device = std::thread::spawn(move || {
            let mut out = [0.0; 20];
            tap.fill(&mut out, Duration::ZERO);
            out
        });
        std::thread::sleep(Duration::from_millis(100));
        assert!(device.is_finished(), "the callback waited for the lock");
        drop(held);
        assert_eq!(device.join().unwrap(), [0.5; 20]);
    }

    #[test]
    fn a_stop_frees_a_waiting_feeder_and_silences_the_device() {
        let (s, mut feeder, mut tap) = pair();
        let feeder = std::thread::spawn(move || feeder.push(&[0.1; 2000]));
        std::thread::sleep(Duration::from_millis(100));
        s.end(End::Stopped(2));
        assert!(!feeder.join().unwrap());
        let mut out = [9.0; 10];
        tap.fill(&mut out, Duration::ZERO);
        assert_eq!(out, [0.0; 10]);
        assert!(matches!(s.wait_drained(STALL), Some(End::Stopped(2))));
    }

    #[test]
    fn a_device_without_callbacks_fails_the_wait_and_frees_the_feeder() {
        let (s, mut feeder, mut tap) = pair();
        let feeder = std::thread::spawn(move || feeder.push(&[0.1; 2000]));
        tap.fill(&mut [0.0; 10], Duration::ZERO);
        let t = Instant::now();
        let end = s.wait_drained(Duration::from_millis(300));
        let waited = t.elapsed();
        assert!(
            matches!(&end, Some(End::Failed(w)) if w == STALLED),
            "{end:?}"
        );
        assert!(
            waited >= Duration::from_millis(300) && waited < Duration::from_millis(600),
            "{waited:?}"
        );
        assert!(!feeder.join().unwrap(), "the feeder is freed");
    }

    #[test]
    fn the_tail_wait_is_the_largest_latency_plus_a_period_and_the_margin() {
        let (s, _feeder, mut tap) = pair();
        tap.fill(&mut [0.0; 20], Duration::from_millis(40)); // 20 ms period
        tap.fill(&mut [0.0; 10], Duration::from_millis(100));
        tap.fill(&mut [0.0; 10], Duration::from_millis(10));
        let t = Instant::now();
        assert!(s.wait_heard().is_none());
        let waited = t.elapsed();
        let want = Duration::from_millis(100 + 20) + TAIL_MARGIN;
        assert!(
            waited >= want && waited < want + Duration::from_millis(150),
            "{waited:?}"
        );
    }

    /// Play what `make` gives through `output`, as `play` does.
    fn play_on(
        output: Output,
        make: impl FnOnce() -> Result<Box<dyn Decode>, String> + Send + 'static,
    ) -> (Result<Outcome, String>, Duration) {
        let t = Instant::now();
        let r = Player::new().play_from(output, make);
        (r, t.elapsed())
    }

    fn pcm_source(seconds: f64) -> impl FnOnce() -> Result<Box<dyn Decode>, String> + Send {
        let pcm = pcm_bytes(&vec![1000i16; (24000.0 * seconds) as usize]);
        move || Ok(Box::new(Pcm::new(Dribble::new(pcm, 4801), 24000, 1)) as Box<dyn Decode>)
    }

    #[test]
    fn pcm_and_an_open_ended_wav_play_to_their_end_on_the_null_device() {
        let (r, took) = play_on(Output::null(), pcm_source(0.3));
        assert_eq!(r, Ok(Outcome::Played));
        assert!(took >= Duration::from_millis(300), "cut short: {took:?}");
        assert!(took < Duration::from_millis(1300), "{took:?}");

        let wav = open_wav(16000, 2, &vec![1000i16; 2 * 16000 * 3 / 10]);
        let (r, took) = play_on(Output::null(), move || {
            Ok(
                Box::new(WavOrMp3::from_non_seekable(Dribble::new(wav, 999), None)?)
                    as Box<dyn Decode>,
            )
        });
        assert_eq!(r, Ok(Outcome::Played));
        assert!(took >= Duration::from_millis(300), "cut short: {took:?}");
    }

    #[test]
    fn a_device_that_stops_calling_back_fails_the_playback() {
        let (r, took) = play_on(
            Output::null_stuck(Duration::from_millis(200)),
            pcm_source(10.0),
        );
        assert_eq!(r, Err(STALLED.to_string()));
        let least = Duration::from_millis(200) + STALL;
        assert!(
            took >= least && took < least + Duration::from_millis(500),
            "{took:?}"
        );
    }

    #[test]
    fn a_playback_stopped_before_its_device_opened_plays_nothing() {
        let player = Player::new();
        player.stopper()(15);
        let t = Instant::now();
        let r = player.play_from(Output::null(), || panic!("the input was opened"));
        assert_eq!(r, Ok(Outcome::Stopped(15)));
        assert!(t.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn undecodable_input_fails_with_a_reason() {
        let (r, _) = play_on(Output::null(), || {
            Ok(Box::new(WavOrMp3::from_non_seekable(
                Dribble::new(b"not audio".repeat(50), 64),
                None,
            )?) as Box<dyn Decode>)
        });
        assert!(r.is_err_and(|e| !e.is_empty()));
    }
}
