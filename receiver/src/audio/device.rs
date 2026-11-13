//! Audio devices: the system's default output and input through cpal, or the null
//! devices, which run at real-time pace without hardware (for tests and CI).
//!
//! Above this module all audio is interleaved `f32`. A device hands its callback a buffer
//! to fill (output) or a buffer it captured (input), in the device's own format.

use crate::proc::start_thread;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, FromSample, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize,
    SupportedStreamConfig, I24, U24,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// `1`: use the null devices instead of the system's. `none`: there are no devices at all.
pub const NULL_ENV: &str = "PI_SPEECH_AUDIO_NULL";

/// The null output's format and the latency it reports.
pub const NULL_OUTPUT: Format = Format {
    rate: 48000,
    channels: 2,
};
pub const NULL_LATENCY: Duration = Duration::from_millis(30);
/// The null input's format; it captures a quiet 440 Hz tone.
pub const NULL_INPUT: Format = Format {
    rate: 44100,
    channels: 2,
};
const NULL_PERIOD: Duration = Duration::from_millis(10);
const NULL_TONE_HZ: f32 = 440.0;
const NULL_TONE_LEVEL: f32 = 0.1;

/// Call `$build::<T>(args)` with `T` the sample type of `$format`: `Err` for a format
/// this engine does not handle, else what `$build` returns.
macro_rules! by_format {
    ($format:expr, $build:ident, $($arg:expr),*) => {
        match $format {
            SampleFormat::I8 => Ok($build::<i8>($($arg),*)),
            SampleFormat::I16 => Ok($build::<i16>($($arg),*)),
            SampleFormat::I24 => Ok($build::<I24>($($arg),*)),
            SampleFormat::I32 => Ok($build::<i32>($($arg),*)),
            SampleFormat::I64 => Ok($build::<i64>($($arg),*)),
            SampleFormat::U8 => Ok($build::<u8>($($arg),*)),
            SampleFormat::U16 => Ok($build::<u16>($($arg),*)),
            SampleFormat::U24 => Ok($build::<U24>($($arg),*)),
            SampleFormat::U32 => Ok($build::<u32>($($arg),*)),
            SampleFormat::U64 => Ok($build::<u64>($($arg),*)),
            SampleFormat::F32 => Ok($build::<f32>($($arg),*)),
            SampleFormat::F64 => Ok($build::<f64>($($arg),*)),
            other => Err(format!("the device's sample format {other} is not supported")),
        }
    };
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    pub rate: u32,
    pub channels: usize,
}

impl Format {
    /// Interleaved samples in `d` of audio.
    pub fn samples_in(self, d: Duration) -> usize {
        (d.as_secs_f64() * self.rate as f64).round() as usize * self.channels
    }

    /// How long `samples` interleaved samples last.
    pub fn duration_of(self, samples: usize) -> Duration {
        Duration::from_secs_f64(samples as f64 / self.channels as f64 / self.rate as f64)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    System,
    Null,
    Nothing,
}

fn mode() -> Mode {
    match std::env::var(NULL_ENV).as_deref() {
        Ok("1") => Mode::Null,
        Ok("none") => Mode::Nothing,
        _ => Mode::System,
    }
}

enum Backend {
    Cpal {
        device: Box<cpal::Device>,
        config: StreamConfig,
        sample_format: SampleFormat,
    },
    Null,
}

/// The default output device, found but not yet playing.
pub struct Output {
    backend: Backend,
    format: Format,
}

/// The default input device, found but not yet capturing.
pub struct Input {
    backend: Backend,
    format: Format,
}

/// A running device; dropping it stops the device and its callbacks.
pub struct Stream {
    _inner: StreamInner,
}

// Held only to be dropped: that stops the device.
#[allow(dead_code)]
enum StreamInner {
    Cpal(cpal::Stream),
    Null(NullStream),
}

impl Output {
    /// The default output device, or the null one when [`NULL_ENV`] asks for it.
    pub fn open_default() -> Result<Output, String> {
        match mode() {
            Mode::Null => Ok(Output::null()),
            Mode::Nothing => Err("no audio output device".into()),
            Mode::System => {
                let device = cpal::default_host()
                    .default_output_device()
                    .ok_or("no audio output device")?;
                let sup = device
                    .default_output_config()
                    .map_err(|e| format!("the audio output device cannot be used: {e}"))?;
                let (backend, format) = cpal_backend(device, sup);
                Ok(Output { backend, format })
            }
        }
    }

    pub fn null() -> Output {
        Output {
            backend: Backend::Null,
            format: NULL_OUTPUT,
        }
    }

    pub fn format(&self) -> Format {
        self.format
    }

    /// Start playing. `fill` is called from the device's thread with a buffer to fill
    /// and the time until the buffer's first frame will be heard. `fatal` is called when
    /// the device stops working.
    pub fn start<F, E>(self, fill: F, fatal: E) -> Result<Stream, String>
    where
        F: FnMut(&mut [f32], Duration) + Send + 'static,
        E: FnMut(String) + Send + 'static,
    {
        let inner = match self.backend {
            Backend::Null => StreamInner::Null(NullStream::output(self.format, fill)?),
            Backend::Cpal {
                device,
                config,
                sample_format,
            } => {
                let stream =
                    by_format!(sample_format, output_stream, &device, config, fill, fatal)?
                        .map_err(|e| format!("cannot start the audio output: {e}"))?;
                stream
                    .play()
                    .map_err(|e| format!("cannot start the audio output: {e}"))?;
                StreamInner::Cpal(stream)
            }
        };
        Ok(Stream { _inner: inner })
    }
}

impl Input {
    /// The default input device, or the null one when [`NULL_ENV`] asks for it.
    pub fn open_default() -> Result<Input, String> {
        match mode() {
            Mode::Null => Ok(Input::null()),
            Mode::Nothing => Err("no audio input device (microphone)".into()),
            Mode::System => {
                let device = cpal::default_host()
                    .default_input_device()
                    .ok_or("no audio input device (microphone)")?;
                let sup = device
                    .default_input_config()
                    .map_err(|e| format!("the audio input device cannot be used: {e}"))?;
                let (backend, format) = cpal_backend(device, sup);
                Ok(Input { backend, format })
            }
        }
    }

    pub fn null() -> Input {
        Input {
            backend: Backend::Null,
            format: NULL_INPUT,
        }
    }

    pub fn format(&self) -> Format {
        self.format
    }

    /// Start capturing. `take` is called from the device's thread with each buffer
    /// captured; `fatal` when the device stops working.
    pub fn start<T, E>(self, take: T, fatal: E) -> Result<Stream, String>
    where
        T: FnMut(&[f32]) + Send + 'static,
        E: FnMut(String) + Send + 'static,
    {
        let inner = match self.backend {
            Backend::Null => StreamInner::Null(NullStream::input(self.format, take)?),
            Backend::Cpal {
                device,
                config,
                sample_format,
            } => {
                let stream = by_format!(sample_format, input_stream, &device, config, take, fatal)?
                    .map_err(|e| format!("cannot start the audio input: {e}"))?;
                stream
                    .play()
                    .map_err(|e| format!("cannot start the audio input: {e}"))?;
                StreamInner::Cpal(stream)
            }
        };
        Ok(Stream { _inner: inner })
    }
}

fn cpal_backend(device: cpal::Device, sup: SupportedStreamConfig) -> (Backend, Format) {
    let sample_format = sup.sample_format();
    let buffer_size = period(sup.sample_rate(), sup.buffer_size());
    let mut config: StreamConfig = sup.into();
    config.buffer_size = buffer_size;
    let format = Format {
        rate: config.sample_rate,
        channels: config.channels as usize,
    };
    let backend = Backend::Cpal {
        device: Box::new(device),
        config,
        sample_format,
    };
    (backend, format)
}

/// About 20 ms per device period, within what the device allows. Hosts' defaults can be
/// seconds (PulseAudio's is about 2 s): playback then starts late and the end of what was
/// played or recorded is lost when the stream closes.
fn period(rate: u32, supported: &SupportedBufferSize) -> BufferSize {
    let want = (rate / 50).max(1);
    match *supported {
        SupportedBufferSize::Range { min, max } if min <= max => {
            BufferSize::Fixed(want.clamp(min, max))
        }
        _ => BufferSize::Default,
    }
}

/// Errors after which the device plays or captures nothing more.
fn on_error(mut fatal: impl FnMut(String) + Send + 'static) -> impl FnMut(cpal::Error) + Send {
    move |e: cpal::Error| {
        use cpal::ErrorKind as K;
        if matches!(
            e.kind(),
            K::DeviceNotAvailable | K::HostUnavailable | K::PermissionDenied | K::StreamInvalidated
        ) {
            fatal(format!("the audio device failed: {e}"));
        }
    }
}

/// Write `src` (`f32`, any range) into the device's samples, clipped to full scale.
fn to_device<T: SizedSample + FromSample<f32>>(src: &[f32], dst: &mut [T]) {
    for (d, &s) in dst.iter_mut().zip(src) {
        *d = T::from_sample(s.clamp(-1.0, 1.0));
    }
}

/// Append the device's samples to `dst` as `f32`.
fn from_device<T: SizedSample>(src: &[T], dst: &mut Vec<f32>)
where
    f32: FromSample<T>,
{
    dst.extend(src.iter().map(|&s| f32::from_sample(s)));
}

fn output_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    mut fill: impl FnMut(&mut [f32], Duration) + Send + 'static,
    fatal: impl FnMut(String) + Send + 'static,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample + FromSample<f32>,
{
    let mut buf = Vec::new();
    device.build_output_stream::<T, _, _>(
        config,
        move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
            let ts = info.timestamp();
            buf.resize(data.len(), 0.0);
            fill(&mut buf, ts.playback.duration_since(ts.callback));
            to_device(&buf, data);
        },
        on_error(fatal),
        None,
    )
}

fn input_stream<T>(
    device: &cpal::Device,
    config: StreamConfig,
    mut take: impl FnMut(&[f32]) + Send + 'static,
    fatal: impl FnMut(String) + Send + 'static,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let mut buf = Vec::new();
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            buf.clear();
            from_device(data, &mut buf);
            take(&buf);
        },
        on_error(fatal),
        None,
    )
}

/// A null device: a thread that hands out or takes one period of audio per period of
/// wall-clock time, on a fixed schedule so it neither drifts nor hurries.
struct NullStream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl NullStream {
    fn output(
        format: Format,
        mut fill: impl FnMut(&mut [f32], Duration) + Send + 'static,
    ) -> Result<NullStream, String> {
        let mut buf = vec![0.0f32; format.samples_in(NULL_PERIOD)];
        NullStream::run(move || fill(&mut buf, NULL_LATENCY))
    }

    fn input(
        format: Format,
        mut take: impl FnMut(&[f32]) + Send + 'static,
    ) -> Result<NullStream, String> {
        let mut buf = vec![0.0f32; format.samples_in(NULL_PERIOD)];
        let step = std::f32::consts::TAU * NULL_TONE_HZ / format.rate as f32;
        let mut phase = 0.0f32;
        NullStream::run(move || {
            for frame in buf.chunks_mut(format.channels) {
                frame.fill(NULL_TONE_LEVEL * phase.sin());
                phase = (phase + step) % std::f32::consts::TAU;
            }
            take(&buf)
        })
    }

    fn run(mut period: impl FnMut() + Send + 'static) -> Result<NullStream, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let thread = start_thread("null-audio", move || {
            let start = Instant::now();
            let mut n = 0u32;
            while !stopped.load(Ordering::SeqCst) {
                period();
                n += 1;
                let next = start + NULL_PERIOD * n;
                std::thread::sleep(next.saturating_duration_since(Instant::now()));
            }
        })
        .map_err(|e| format!("cannot start the null audio device: {e}"))?;
        Ok(NullStream {
            stop,
            thread: Some(thread),
        })
    }
}

impl Drop for NullStream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn about_20_ms_within_the_device_range() {
        let range = |min, max| SupportedBufferSize::Range { min, max };
        assert_eq!(period(48000, &range(64, 8192)), BufferSize::Fixed(960));
        assert_eq!(period(44100, &range(64, 8192)), BufferSize::Fixed(882));
        assert_eq!(period(48000, &range(1024, 8192)), BufferSize::Fixed(1024));
        assert_eq!(period(48000, &range(64, 256)), BufferSize::Fixed(256));
        assert_eq!(
            period(48000, &SupportedBufferSize::Unknown),
            BufferSize::Default
        );
        assert_eq!(period(48000, &range(512, 256)), BufferSize::Default);
    }

    #[test]
    fn every_sample_format_converts_both_ways() {
        fn round_trip<T>()
        where
            T: SizedSample + FromSample<f32> + Default,
            f32: FromSample<T>,
        {
            let src = [0.0f32, 0.5, -0.5, 2.0, -2.0];
            let mut dev = [T::default(); 5];
            to_device(&src, &mut dev);
            let mut back = Vec::new();
            from_device(&dev, &mut back);
            let want = [0.0, 0.5, -0.5, 1.0, -1.0];
            for (b, w) in back.iter().zip(want) {
                assert!(
                    (b - w).abs() < 0.01,
                    "{}: {back:?}",
                    std::any::type_name::<T>()
                );
            }
        }
        round_trip::<i8>();
        round_trip::<i16>();
        round_trip::<I24>();
        round_trip::<i32>();
        round_trip::<i64>();
        round_trip::<u8>();
        round_trip::<u16>();
        round_trip::<U24>();
        round_trip::<u32>();
        round_trip::<u64>();
        round_trip::<f32>();
        round_trip::<f64>();
    }

    #[test]
    fn the_null_output_takes_audio_at_real_time_pace() {
        let taken = Arc::new(Mutex::new((0usize, Duration::ZERO)));
        let t = Arc::clone(&taken);
        let s = NullStream::output(NULL_OUTPUT, move |buf, lat| {
            let mut g = t.lock().unwrap();
            g.0 += buf.len();
            g.1 = lat;
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        drop(s);
        let (n, lat) = *taken.lock().unwrap();
        let secs = NULL_OUTPUT.duration_of(n).as_secs_f64();
        assert!((0.4..=0.6).contains(&secs), "{secs}");
        assert_eq!(lat, NULL_LATENCY);
    }

    #[test]
    fn the_null_input_gives_a_quiet_tone_at_real_time_pace() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = Arc::clone(&got);
        let s = NullStream::input(NULL_INPUT, move |buf| {
            g.lock().unwrap().extend_from_slice(buf)
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        drop(s);
        let got = got.lock().unwrap();
        let secs = NULL_INPUT.duration_of(got.len()).as_secs_f64();
        assert!((0.4..=0.6).contains(&secs), "{secs}");
        let peak = got.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.05 && peak <= NULL_TONE_LEVEL, "{peak}");
    }
}
