//! The built-in audio engine end to end: the `play` and `record` subcommands of the
//! binary, on the null audio device (never the real speakers or microphone).

mod support;

use pi_speech_receiver::wav::wav_seconds;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};
use support::*;

const BIN: &str = env!("CARGO_BIN_EXE_pi-speech-receiver");
const MP3: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/tone-0.5s-24k.mp3"
);
/// The null output's latency plus the engine's margin: the least a playback outlasts its
/// audio once the input has ended.
const TAIL: Duration = Duration::from_millis(30 + 80);

fn engine(args: &[&str]) -> Command {
    let mut c = Command::new(BIN);
    c.args(args)
        .env("PI_SPEECH_AUDIO_NULL", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    c
}

/// `seconds` of 24 kHz mono s16le PCM: a quiet ramp, so it is not all zeros.
fn pcm(seconds: f64) -> Vec<u8> {
    (0..(seconds * 24000.0) as usize)
        .flat_map(|i| (((i % 100) as i16 - 50) * 40).to_le_bytes())
        .collect()
}

fn signal(child: &Child, sig: i32) {
    unsafe { libc::kill(child.id() as i32, sig) };
}

fn wait_within(child: &mut Child, limit: Duration) -> Option<ExitStatus> {
    let mut status = None;
    wait_until(limit, || {
        status = child.try_wait().unwrap();
        status.is_some()
    });
    status
}

fn stderr_of(child: &mut Child) -> String {
    let mut s = String::new();
    child.stderr.take().unwrap().read_to_string(&mut s).unwrap();
    s
}

/// Write `bytes` to `input` on a thread (the player may hold the writer back), then close it.
fn feed(mut input: ChildStdin, bytes: Vec<u8>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let _ = input.write_all(&bytes);
    })
}

#[test]
fn play_pcm_exits_0_once_all_of_it_and_the_latency_have_passed() {
    let t0 = Instant::now();
    let mut child = engine(&["play", "s16le", "24000", "1"]).spawn().unwrap();
    feed(child.stdin.take().unwrap(), pcm(1.0)).join().unwrap();
    let status = wait_within(&mut child, Duration::from_secs(10)).expect("still playing");
    let took = t0.elapsed();
    assert!(status.success(), "{status:?}: {}", stderr_of(&mut child));
    assert!(took >= Duration::from_secs(1) + TAIL, "cut short: {took:?}");
    assert!(took < Duration::from_millis(1800), "{took:?}");
}

#[test]
fn a_stall_in_the_input_does_not_end_the_playback() {
    let t0 = Instant::now();
    let mut child = engine(&["play", "s16le", "24000", "1"]).spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(&pcm(0.3)).unwrap();
    std::thread::sleep(Duration::from_millis(1000));
    assert!(
        child.try_wait().unwrap().is_none(),
        "ended during the stall"
    );
    input.write_all(&pcm(0.3)).unwrap();
    drop(input);
    let status = wait_within(&mut child, Duration::from_secs(10)).expect("still playing");
    let took = t0.elapsed();
    assert!(status.success(), "{status:?}: {}", stderr_of(&mut child));
    assert!(took >= Duration::from_millis(1300) + TAIL, "{took:?}");
}

#[test]
fn sigint_or_sigterm_stops_a_playback_at_once() {
    for sig in [libc::SIGINT, libc::SIGTERM] {
        let mut child = engine(&["play", "s16le", "24000", "1"]).spawn().unwrap();
        let writer = feed(child.stdin.take().unwrap(), pcm(10.0));
        std::thread::sleep(Duration::from_millis(500));
        assert!(child.try_wait().unwrap().is_none());
        let t = Instant::now();
        signal(&child, sig);
        let status = wait_within(&mut child, Duration::from_secs(5)).expect("did not stop");
        assert!(
            t.elapsed() < Duration::from_millis(500),
            "{:?}",
            t.elapsed()
        );
        assert_eq!(status.code(), Some(128 + sig), "{sig}");
        writer.join().unwrap();
    }
}

/// A 16-bit PCM WAV whose sizes say "open-ended", as xAI writes them.
fn open_wav(seconds: f64) -> Vec<u8> {
    let rate = 22050u32;
    let mut v = b"RIFF".to_vec();
    v.extend(0xFFFF_FFFFu32.to_le_bytes());
    v.extend(b"WAVEfmt ");
    v.extend(16u32.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(rate.to_le_bytes());
    v.extend((rate * 2).to_le_bytes());
    v.extend(2u16.to_le_bytes());
    v.extend(16u16.to_le_bytes());
    v.extend(b"data");
    v.extend(0x7FFF_FFFFu32.to_le_bytes());
    v.extend(
        (0..(seconds * rate as f64) as usize).flat_map(|i| ((i % 50) as i16 * 100).to_le_bytes()),
    );
    v
}

#[test]
fn wav_and_mp3_play_from_the_input_and_from_files() {
    let dir = scratch("engine-files");
    let file = dir.join("open.wav");
    std::fs::write(&file, open_wav(0.4)).unwrap();
    let mp3 = std::fs::read(MP3).unwrap();
    let cases: [(&[&str], Vec<u8>, f64); 4] = [
        (&["play", "wav"], open_wav(0.4), 0.4),
        (&["play", "mp3"], mp3, 0.5),
        (&["play", file.to_str().unwrap()], Vec::new(), 0.4),
        (&["play", MP3], Vec::new(), 0.5),
    ];
    for (args, input, seconds) in cases {
        let t0 = Instant::now();
        let mut child = engine(args).spawn().unwrap();
        feed(child.stdin.take().unwrap(), input).join().unwrap();
        let status = wait_within(&mut child, Duration::from_secs(10)).expect("still playing");
        let took = t0.elapsed();
        assert!(status.success(), "{args:?}: {}", stderr_of(&mut child));
        let least = Duration::from_secs_f64(seconds) + TAIL;
        assert!(took >= least, "{args:?} cut short: {took:?}");
        assert!(took < least + Duration::from_secs(1), "{args:?}: {took:?}");
    }
    std::fs::remove_dir_all(dir).ok();
}

fn one_line_failure(mut child: Child) -> String {
    let status = wait_within(&mut child, Duration::from_secs(5)).expect("did not end");
    let err = stderr_of(&mut child);
    assert_eq!(status.code(), Some(1), "{err}");
    assert_eq!(err.trim_end().lines().count(), 1, "{err:?}");
    err
}

#[test]
fn undecodable_input_or_no_device_fails_with_a_one_line_reason() {
    let mut child = engine(&["play", "mp3"]).spawn().unwrap();
    feed(
        child.stdin.take().unwrap(),
        b"this is not audio\n".repeat(200),
    )
    .join()
    .unwrap();
    let err = one_line_failure(child);
    assert!(err.contains("not WAV or MP3"), "{err}");

    let err = one_line_failure(engine(&["play", "/nonexistent/a.wav"]).spawn().unwrap());
    assert!(err.contains("cannot open"), "{err}");

    let mut c = engine(&["play", "s16le", "24000", "1"]);
    c.env("PI_SPEECH_AUDIO_NULL", "none");
    let err = one_line_failure(c.spawn().unwrap());
    assert!(err.contains("no audio output device"), "{err}");
}

#[test]
fn an_unknown_null_device_value_fails_and_never_falls_back_to_a_real_device() {
    let dir = scratch("engine-unknown-null");
    let out = dir.join("out.wav");
    for args in [
        &["play", "s16le", "24000", "1"][..],
        &["play", MP3],
        &["record", out.to_str().unwrap()],
    ] {
        let mut c = engine(args);
        c.env("PI_SPEECH_AUDIO_NULL", "no-such-mode");
        let t = Instant::now();
        let err = one_line_failure(c.spawn().unwrap());
        assert!(
            err.contains("unknown PI_SPEECH_AUDIO_NULL value: \"no-such-mode\""),
            "{args:?}: {err}"
        );
        assert!(t.elapsed() < Duration::from_secs(2), "{args:?}");
    }
    assert!(!out.exists(), "no recording was started");
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn a_device_that_stops_calling_back_fails_the_playback_instead_of_hanging() {
    let mut c = engine(&["play", "s16le", "24000", "1"]);
    // The null output stops calling back after 0.3 s, as a hung device does.
    c.env("PI_SPEECH_AUDIO_NULL", "stuck");
    let t = Instant::now();
    let mut child = c.spawn().unwrap();
    // More than the queue holds, so the feeder is waiting for room when the device stops.
    let writer = feed(child.stdin.take().unwrap(), pcm(10.0));
    let Some(status) = wait_within(&mut child, Duration::from_secs(8)) else {
        child.kill().unwrap();
        panic!("the playback hung on a device that stopped calling back");
    };
    let took = t.elapsed();
    let err = stderr_of(&mut child);
    assert_eq!(status.code(), Some(1), "{err}");
    assert_eq!(err.trim_end().lines().count(), 1, "{err:?}");
    assert!(err.contains("the audio device stopped responding"), "{err}");
    assert!(
        took >= Duration::from_secs(2) && took < Duration::from_secs(4),
        "{took:?}"
    );
    writer.join().unwrap();
}

#[test]
fn a_signal_while_the_output_is_being_opened_stops_the_playback() {
    let mut c = engine(&["play", "s16le", "24000", "1"]);
    // The null output takes 1 s to open, as a sound server slow to answer does.
    c.env("PI_SPEECH_AUDIO_NULL", "slow");
    let t = Instant::now();
    let mut child = c.spawn().unwrap();
    let writer = feed(child.stdin.take().unwrap(), pcm(5.0));
    std::thread::sleep(Duration::from_millis(400));
    signal(&child, libc::SIGINT);
    let status = wait_within(&mut child, Duration::from_secs(5)).expect("did not stop");
    assert_eq!(
        status.code(),
        Some(128 + libc::SIGINT),
        "{status:?}: {}",
        stderr_of(&mut child)
    );
    // Ended once the output was open, without playing the 5 s it was given.
    assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
    writer.join().unwrap();
}

#[test]
fn bad_arguments_are_a_usage_error() {
    for args in [
        &["play"][..],
        &["play", "s16le", "24000"],
        &["record"],
        &["record", "a", "b"],
    ] {
        let out = engine(args).stdin(Stdio::null()).output().unwrap();
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("usage"));
    }
}

fn recorded(path: &Path) -> f64 {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[22..24], &1u16.to_le_bytes(), "mono");
    assert_eq!(&bytes[34..36], &16u16.to_le_bytes(), "16-bit");
    assert!(u32::from_le_bytes(bytes[24..28].try_into().unwrap()) >= 16000);
    wav_seconds(&bytes).expect("a valid WAV")
}

#[test]
fn record_finishes_a_valid_wav_on_sigint_and_on_the_end_of_its_input() {
    for how in ["SIGINT", "end of input"] {
        let dir = scratch("engine-rec");
        let out = dir.join("out.wav");
        let t0 = Instant::now();
        let mut child = engine(&["record", out.to_str().unwrap()]).spawn().unwrap();
        let input = child.stdin.take().unwrap();
        std::thread::sleep(Duration::from_millis(1200));
        match how {
            "SIGINT" => signal(&child, libc::SIGINT),
            _ => drop(input),
        }
        let status = wait_within(&mut child, Duration::from_secs(5)).expect("did not stop");
        let ran = t0.elapsed().as_secs_f64();
        assert!(
            status.success(),
            "{how}: {status:?}: {}",
            stderr_of(&mut child)
        );
        let secs = recorded(&out);
        assert!(secs > 1.0 && secs <= ran, "{how}: {secs} s in {ran} s");
        std::fs::remove_dir_all(dir).ok();
    }
}

#[test]
fn record_fails_fast_without_an_input_device() {
    let dir = scratch("engine-nomic");
    let out = dir.join("out.wav");
    let mut c = engine(&["record", out.to_str().unwrap()]);
    c.env("PI_SPEECH_AUDIO_NULL", "none");
    let t = Instant::now();
    let child = c.spawn().unwrap();
    let err = one_line_failure(child);
    assert!(
        t.elapsed() < Duration::from_millis(500),
        "{:?}",
        t.elapsed()
    );
    assert!(err.contains("no audio input device"), "{err}");
    std::fs::remove_dir_all(dir).ok();
}
