//! `play`: audio from standard input or a file to the default output device, played as
//! it arrives.
//!
//! A feeder thread decodes the input, converts it to the device's format and pushes it
//! into a bounded queue; when the queue is full the feeder (and so whoever writes to our
//! input) waits. The device's callback takes from the queue, and plays silence while the
//! input stalls. After the input has ended and the queue has drained, the stream stays
//! open until the device has played what it holds: the largest latency it reported, one
//! period, and a margin. A stop empties nothing and waits for nothing: the device closes
//! at once.

use super::convert::Converter;
use super::decode::{Coded, Decode, Pcm};
use super::device::{Format, Output};
use crate::proc::{lock, start_thread};
use crate::signals;
use crate::stream::{MAX_RATE, MIN_RATE};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub const USAGE: &str = "pi-speech-receiver play (s16le <rate> <channels> | mp3 | wav | <file>)";

/// How much converted audio the queue holds before the feeder waits.
pub const QUEUE: Duration = Duration::from_millis(500);
/// Added to the device's own latency before the stream closes.
pub const TAIL_MARGIN: Duration = Duration::from_millis(80);

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

    /// Open the input: blocks until a stream's header has arrived.
    fn open(self) -> Result<Box<dyn Decode>, String> {
        let stdin = std::io::stdin;
        Ok(match self {
            Source::Pcm { rate, channels } => Box::new(Pcm::new(stdin(), rate, channels)),
            Source::Mp3 => Box::new(Coded::from_stream(stdin(), Some("mp3"))?),
            Source::Wav => Box::new(Coded::from_stream(stdin(), Some("wav"))?),
            Source::File(path) => {
                let file = std::fs::File::open(&path)
                    .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
                let ext = path.extension().map(|e| e.to_string_lossy().to_lowercase());
                Box::new(Coded::open(Box::new(file), ext.as_deref())?)
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
enum End {
    Stopped(i32),
    Failed(String),
}

#[derive(Default)]
struct State {
    samples: VecDeque<f32>,
    input_ended: bool,
    /// The input has ended and the device has taken all of it.
    drained: bool,
    end: Option<End>,
}

/// The audio between the feeder and the device, in the device's format.
struct Queue {
    st: Mutex<State>,
    cv: Condvar,
    cap: usize,
    format: Format,
    /// The largest latency the device reported, and its longest period, in ns.
    latency: AtomicU64,
    period: AtomicU64,
}

impl Queue {
    fn new(format: Format) -> Queue {
        Queue {
            st: Mutex::new(State::default()),
            cv: Condvar::new(),
            cap: format.samples_in(QUEUE).max(1),
            format,
            latency: AtomicU64::new(0),
            period: AtomicU64::new(0),
        }
    }

    /// Add audio, waiting while the queue is full. False once the playback has ended.
    fn push(&self, mut samples: &[f32]) -> bool {
        let mut st = lock(&self.st);
        while !samples.is_empty() {
            st = self
                .cv
                .wait_while(st, |s| s.end.is_none() && s.samples.len() >= self.cap)
                .unwrap_or_else(|e| e.into_inner());
            if st.end.is_some() {
                return false;
            }
            let n = samples.len().min(self.cap - st.samples.len());
            st.samples.extend(&samples[..n]);
            samples = &samples[n..];
        }
        st.end.is_none()
    }

    fn end_input(&self) {
        let mut st = lock(&self.st);
        st.input_ended = true;
        st.drained = st.samples.is_empty();
        self.cv.notify_all();
    }

    /// End the playback early, unless it already ended.
    fn end(&self, end: End) {
        let mut st = lock(&self.st);
        if st.end.is_none() {
            st.end = Some(end);
        }
        self.cv.notify_all();
    }

    /// The device's callback: the next audio, or silence when there is none.
    fn fill(&self, out: &mut [f32], latency: Duration) {
        let period = self.format.duration_of(out.len());
        self.latency
            .fetch_max(latency.as_nanos() as u64, Ordering::Relaxed);
        self.period
            .fetch_max(period.as_nanos() as u64, Ordering::Relaxed);
        let mut st = lock(&self.st);
        let n = if st.end.is_some() {
            0
        } else {
            out.len().min(st.samples.len())
        };
        for (o, s) in out.iter_mut().zip(st.samples.drain(..n)) {
            *o = s;
        }
        out[n..].fill(0.0);
        if st.input_ended && st.samples.is_empty() {
            st.drained = true;
        }
        self.cv.notify_all();
    }

    /// Wait until the device has taken all the input, or the playback ended early.
    fn wait_drained(&self) -> Option<End> {
        let st = lock(&self.st);
        let mut st = self
            .cv
            .wait_while(st, |s| s.end.is_none() && !s.drained)
            .unwrap_or_else(|e| e.into_inner());
        st.end.take()
    }

    /// Wait for the device to play what it was given, unless the playback ends early.
    fn wait_heard(&self) -> Option<End> {
        let ns = |a: &AtomicU64| Duration::from_nanos(a.load(Ordering::Relaxed));
        let tail = ns(&self.latency) + ns(&self.period) + TAIL_MARGIN;
        let st = lock(&self.st);
        let (mut st, _) = self
            .cv
            .wait_timeout_while(st, tail, |s| s.end.is_none())
            .unwrap_or_else(|e| e.into_inner());
        st.end.take()
    }
}

/// A playback on an output device.
pub struct Player {
    output: Output,
    queue: Arc<Queue>,
}

impl Player {
    pub fn new(output: Output) -> Player {
        let queue = Arc::new(Queue::new(output.format()));
        Player { output, queue }
    }

    /// Something any thread may call to stop the playback at once, as by signal `sig`.
    pub fn stopper(&self) -> impl FnOnce(i32) + Send + 'static {
        let q = Arc::clone(&self.queue);
        move |sig| q.end(End::Stopped(sig))
    }

    /// Play `source` to its end, or until stopped.
    pub fn play(self, source: Source) -> Result<Outcome, String> {
        self.play_from(move || source.open())
    }

    /// Play what `open` gives, on the feeder thread.
    pub fn play_from<F>(self, open: F) -> Result<Outcome, String>
    where
        F: FnOnce() -> Result<Box<dyn Decode>, String> + Send + 'static,
    {
        let Player { output, queue } = self;
        let format = output.format();
        let (q, f) = (Arc::clone(&queue), Arc::clone(&queue));
        let stream = output.start(
            move |buf, latency| q.fill(buf, latency),
            move |why| f.end(End::Failed(why)),
        )?;
        let q = Arc::clone(&queue);
        start_thread("feeder", move || match feed(open, &q, format) {
            Ok(()) => q.end_input(),
            Err(e) => q.end(End::Failed(e)),
        })
        .map_err(|e| format!("cannot start the feeder: {e}"))?;
        let end = queue.wait_drained().or_else(|| queue.wait_heard());
        drop(stream);
        match end {
            None => Ok(Outcome::Played),
            Some(End::Stopped(sig)) => Ok(Outcome::Stopped(sig)),
            Some(End::Failed(why)) => Err(why),
        }
    }
}

/// Decode the input and queue it in the device's format, until it ends or the playback
/// does.
fn feed<F>(open: F, queue: &Queue, format: Format) -> Result<(), String>
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
        if !queue.push(&out) {
            return Ok(());
        }
    }
    if let Some(c) = conv.as_mut() {
        out.clear();
        c.finish(&mut out);
        queue.push(&out);
    }
    Ok(())
}

/// `pi-speech-receiver play ...`
pub fn main(args: &[String]) -> ExitCode {
    let source = match Source::parse(args) {
        Ok(s) => s,
        Err(e) => return fail(&e, 2),
    };
    let output = match Output::open_default() {
        Ok(o) => o,
        Err(e) => return fail(&e, 1),
    };
    let player = Player::new(output);
    if let Err(e) = signals::on_first(player.stopper()) {
        return fail(&format!("cannot handle signals: {e}"), 1);
    }
    match player.play(source) {
        Ok(Outcome::Played) => ExitCode::SUCCESS,
        // As a shell reports a program a signal ended: 128 + its number.
        Ok(Outcome::Stopped(sig)) => ExitCode::from(128u8.wrapping_add(sig as u8)),
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
    use crate::audio::decode::tests::{open_wav, pcm_bytes, Dribble};
    use std::time::Instant;

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

    fn queue() -> Queue {
        Queue::new(Format {
            rate: 1000,
            channels: 1,
        })
    }

    #[test]
    fn a_stall_plays_silence_and_the_audio_resumes_after_it() {
        let q = queue();
        assert!(q.push(&[0.5; 30]));
        let mut out = [9.0; 20];
        q.fill(&mut out, Duration::ZERO);
        assert_eq!(out, [0.5; 20]);
        q.fill(&mut out, Duration::ZERO);
        assert_eq!(out[..10], [0.5; 10]);
        assert_eq!(out[10..], [0.0; 10], "silence while the input stalls");
        q.fill(&mut out, Duration::ZERO);
        assert_eq!(out, [0.0; 20]);
        assert!(!lock(&q.st).drained, "a stall is not the end");
        assert!(q.push(&[0.25; 5]));
        q.end_input();
        q.fill(&mut out, Duration::ZERO);
        assert_eq!(out[..5], [0.25; 5]);
        assert!(lock(&q.st).drained);
    }

    #[test]
    fn a_full_queue_holds_the_feeder_until_the_device_takes_audio() {
        let q = Arc::new(queue());
        let cap = q.cap; // 0.5 s at 1000 Hz
        assert_eq!(cap, 500);
        let feeder = {
            let q = Arc::clone(&q);
            std::thread::spawn(move || q.push(&vec![0.1; cap + 100]))
        };
        std::thread::sleep(Duration::from_millis(200));
        assert!(
            !feeder.is_finished(),
            "the feeder waits while the queue is full"
        );
        assert_eq!(lock(&q.st).samples.len(), cap);
        let mut out = vec![0.0; 100];
        q.fill(&mut out, Duration::ZERO);
        assert!(feeder.join().unwrap());
        assert_eq!(lock(&q.st).samples.len(), cap);
    }

    #[test]
    fn a_stop_frees_a_waiting_feeder_and_silences_the_device() {
        let q = Arc::new(queue());
        let feeder = {
            let q = Arc::clone(&q);
            std::thread::spawn(move || q.push(&vec![0.1; 2000]))
        };
        std::thread::sleep(Duration::from_millis(100));
        q.end(End::Stopped(2));
        assert!(!feeder.join().unwrap());
        let mut out = [9.0; 10];
        q.fill(&mut out, Duration::ZERO);
        assert_eq!(out, [0.0; 10]);
        assert!(matches!(q.wait_drained(), Some(End::Stopped(2))));
    }

    #[test]
    fn the_tail_wait_is_the_largest_latency_plus_a_period_and_the_margin() {
        let q = queue();
        q.fill(&mut [0.0; 20], Duration::from_millis(40)); // 20 ms period
        q.fill(&mut [0.0; 10], Duration::from_millis(100));
        q.fill(&mut [0.0; 10], Duration::from_millis(10));
        let t = Instant::now();
        assert!(q.wait_heard().is_none());
        let waited = t.elapsed();
        let want = Duration::from_millis(100 + 20) + TAIL_MARGIN;
        assert!(
            waited >= want && waited < want + Duration::from_millis(150),
            "{waited:?}"
        );
    }

    /// Play `bytes` of `source`'s kind through the null output, as `play` does.
    fn play_null(
        make: impl FnOnce() -> Result<Box<dyn Decode>, String> + Send + 'static,
    ) -> (Result<Outcome, String>, Duration) {
        let player = Player::new(Output::null());
        let t = Instant::now();
        let r = player.play_from(make);
        (r, t.elapsed())
    }

    #[test]
    fn pcm_and_an_open_ended_wav_play_to_their_end_on_the_null_device() {
        let pcm = pcm_bytes(&vec![1000i16; 24000 * 3 / 10]); // 0.3 s
        let (r, took) = play_null(move || {
            Ok(Box::new(Pcm::new(Dribble::new(pcm, 4801), 24000, 1)) as Box<dyn Decode>)
        });
        assert_eq!(r, Ok(Outcome::Played));
        assert!(took >= Duration::from_millis(300), "cut short: {took:?}");
        assert!(took < Duration::from_millis(1300), "{took:?}");

        let wav = open_wav(16000, 2, &vec![1000i16; 2 * 16000 * 3 / 10]);
        let (r, took) = play_null(move || {
            Ok(Box::new(Coded::from_stream(Dribble::new(wav, 999), None)?) as Box<dyn Decode>)
        });
        assert_eq!(r, Ok(Outcome::Played));
        assert!(took >= Duration::from_millis(300), "cut short: {took:?}");
    }

    #[test]
    fn undecodable_input_fails_with_a_reason() {
        let (r, _) = play_null(|| {
            Ok(Box::new(Coded::from_stream(
                Dribble::new(b"not audio".repeat(50), 64),
                None,
            )?) as Box<dyn Decode>)
        });
        assert!(r.is_err_and(|e| !e.is_empty()));
    }
}
