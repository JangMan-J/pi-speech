//! Audio devices: the system's default output and input through cpal, or the null
//! devices, which run at real-time pace without hardware (for tests and CI).
//!
//! Above this module all audio is interleaved `f32`. A running device (its device stream)
//! hands its callback a buffer to fill (output) or a buffer it captured (input), in the
//! device's own format. The callbacks allocate nothing: their buffers are made before
//! the device stream starts.

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

/// Which devices to use. Unset or empty: the system's. `1`: the null devices. `stuck`:
/// null devices that stop calling back after [`STUCK_AFTER`], as a hung device does.
/// `slow`: null devices that take [`SLOW_OPEN`] to open, as a sound server slow to answer
/// does. `none`: there are no devices at all. Any other value is an error, so a mistyped
/// test setting can never reach the real speakers or microphone.
pub const NULL_ENV: &str = "PI_SPEECH_AUDIO_NULL";
pub const STUCK_AFTER: Duration = Duration::from_millis(300);
pub const SLOW_OPEN: Duration = Duration::from_secs(1);

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
/// The most samples a callback converts at once; a larger device buffer is converted in
/// slices of this size.
const SCRATCH_SAMPLES: usize = 8192;

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    System,
    Null(Null),
    Nothing,
}

/// How a null device behaves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Null {
    Steady,
    Stuck,
    Slow,
}

fn mode() -> Result<Mode, String> {
    mode_of(std::env::var_os(NULL_ENV).as_deref())
}

/// The devices [`NULL_ENV`] asks for: the system's only when it is unset or empty. A
/// value this engine does not know is an error, never the system's devices: whoever set
/// it wanted no real device.
fn mode_of(value: Option<&std::ffi::OsStr>) -> Result<Mode, String> {
    let Some(value) = value.filter(|v| !v.is_empty()) else {
        return Ok(Mode::System);
    };
    match value.to_str() {
        Some("1") => Ok(Mode::Null(Null::Steady)),
        Some("stuck") => Ok(Mode::Null(Null::Stuck)),
        Some("slow") => Ok(Mode::Null(Null::Slow)),
        Some("none") => Ok(Mode::Nothing),
        _ => Err(format!("unknown {NULL_ENV} value: {value:?}")),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    Output,
    Input,
}

impl Direction {
    fn name(self) -> &'static str {
        match self {
            Direction::Output => "output",
            Direction::Input => "input",
        }
    }

    fn missing(self) -> &'static str {
        match self {
            Direction::Output => "no audio output device",
            Direction::Input => "no audio input device (microphone)",
        }
    }

    fn null_format(self) -> Format {
        match self {
            Direction::Output => NULL_OUTPUT,
            Direction::Input => NULL_INPUT,
        }
    }
}

enum Backend {
    Cpal {
        device: Box<cpal::Device>,
        config: StreamConfig,
        sample_format: SampleFormat,
    },
    Null {
        /// A stuck null device stops calling back this long after it starts.
        stalls_after: Option<Duration>,
    },
}

/// A device found but not yet running; [`Output`] and [`Input`] are its two kinds.
struct Device {
    backend: Backend,
    format: Format,
    direction: Direction,
}

/// The default output device, found but not yet playing.
pub struct Output(Device);

/// The default input device, found but not yet capturing.
pub struct Input(Device);

/// A running device; dropping it stops the device and its callbacks.
pub struct DeviceStream {
    _inner: Running,
}

// Held only to be dropped: that stops the device.
#[allow(dead_code)]
enum Running {
    Cpal(cpal::Stream),
    Null(NullStream),
}

impl Device {
    /// The default device of `direction`, or a null one when [`NULL_ENV`] asks for it.
    fn open_default(direction: Direction) -> Result<Device, String> {
        match mode()? {
            Mode::Nothing => Err(direction.missing().into()),
            Mode::Null(null) => {
                if null == Null::Slow {
                    std::thread::sleep(SLOW_OPEN);
                }
                let stalls_after = (null == Null::Stuck).then_some(STUCK_AFTER);
                Ok(Device::null(direction, stalls_after))
            }
            Mode::System => {
                let host = cpal::default_host();
                let device = match direction {
                    Direction::Output => host.default_output_device(),
                    Direction::Input => host.default_input_device(),
                }
                .ok_or(direction.missing())?;
                let sup = match direction {
                    Direction::Output => device.default_output_config(),
                    Direction::Input => device.default_input_config(),
                }
                .map_err(|e| {
                    format!("the audio {} device cannot be used: {e}", direction.name())
                })?;
                Ok(cpal_device(device, sup, direction))
            }
        }
    }

    fn null(direction: Direction, stalls_after: Option<Duration>) -> Device {
        Device {
            backend: Backend::Null { stalls_after },
            format: direction.null_format(),
            direction,
        }
    }

    fn start(self, callbacks: impl Callbacks) -> Result<DeviceStream, String> {
        let name = self.direction.name();
        let inner = match self.backend {
            Backend::Null { stalls_after } => {
                Running::Null(callbacks.null(self.format, stalls_after)?)
            }
            Backend::Cpal {
                device,
                config,
                sample_format,
            } => {
                let device_stream = callbacks
                    .cpal(&device, config, sample_format)?
                    .map_err(|e| format!("cannot start the audio {name}: {e}"))?;
                device_stream
                    .play()
                    .map_err(|e| format!("cannot start the audio {name}: {e}"))?;
                Running::Cpal(device_stream)
            }
        };
        Ok(DeviceStream { _inner: inner })
    }
}

impl Output {
    /// The default output device, or the null one when [`NULL_ENV`] asks for it.
    pub fn open_default() -> Result<Output, String> {
        Device::open_default(Direction::Output).map(Output)
    }

    pub fn null() -> Output {
        Output(Device::null(Direction::Output, None))
    }

    /// A null output that stops calling back after `after`, as a hung device does.
    pub fn null_stuck(after: Duration) -> Output {
        Output(Device::null(Direction::Output, Some(after)))
    }

    pub fn format(&self) -> Format {
        self.0.format
    }

    /// Start playing. `fill` is called from the device's thread with a buffer to fill
    /// and the time until the buffer's first frame will be heard. `fatal` is called when
    /// the device stops working.
    pub fn start<F, E>(self, fill: F, fatal: E) -> Result<DeviceStream, String>
    where
        F: FnMut(&mut [f32], Duration) + Send + 'static,
        E: FnMut(String) + Send + 'static,
    {
        self.0.start(Play { fill, fatal })
    }
}

impl Input {
    /// The default input device, or the null one when [`NULL_ENV`] asks for it.
    pub fn open_default() -> Result<Input, String> {
        Device::open_default(Direction::Input).map(Input)
    }

    pub fn null() -> Input {
        Input(Device::null(Direction::Input, None))
    }

    pub fn format(&self) -> Format {
        self.0.format
    }

    /// Start capturing. `take` is called from the device's thread with each buffer
    /// captured; `fatal` when the device stops working.
    pub fn start<T, E>(self, take: T, fatal: E) -> Result<DeviceStream, String>
    where
        T: FnMut(&[f32]) + Send + 'static,
        E: FnMut(String) + Send + 'static,
    {
        self.0.start(Capture { take, fatal })
    }
}

/// What a running device calls back, made into a null or a cpal device stream.
trait Callbacks {
    fn null(self, format: Format, stalls_after: Option<Duration>) -> Result<NullStream, String>;
    fn cpal(
        self,
        device: &cpal::Device,
        config: StreamConfig,
        sample_format: SampleFormat,
    ) -> Result<Result<cpal::Stream, cpal::Error>, String>;
}

/// An output's callbacks.
struct Play<F, E> {
    fill: F,
    fatal: E,
}

/// An input's callbacks.
struct Capture<T, E> {
    take: T,
    fatal: E,
}

impl<F, E> Callbacks for Play<F, E>
where
    F: FnMut(&mut [f32], Duration) + Send + 'static,
    E: FnMut(String) + Send + 'static,
{
    fn null(self, format: Format, stalls_after: Option<Duration>) -> Result<NullStream, String> {
        NullStream::output(format, stalls_after, self.fill)
    }

    fn cpal(
        self,
        device: &cpal::Device,
        config: StreamConfig,
        sample_format: SampleFormat,
    ) -> Result<Result<cpal::Stream, cpal::Error>, String> {
        by_format!(
            sample_format,
            output_stream,
            device,
            config,
            self.fill,
            self.fatal
        )
    }
}

impl<T, E> Callbacks for Capture<T, E>
where
    T: FnMut(&[f32]) + Send + 'static,
    E: FnMut(String) + Send + 'static,
{
    fn null(self, format: Format, stalls_after: Option<Duration>) -> Result<NullStream, String> {
        NullStream::input(format, stalls_after, self.take)
    }

    fn cpal(
        self,
        device: &cpal::Device,
        config: StreamConfig,
        sample_format: SampleFormat,
    ) -> Result<Result<cpal::Stream, cpal::Error>, String> {
        by_format!(
            sample_format,
            input_stream,
            device,
            config,
            self.take,
            self.fatal
        )
    }
}

fn cpal_device(device: cpal::Device, sup: SupportedStreamConfig, direction: Direction) -> Device {
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
    Device {
        backend,
        format,
        direction,
    }
}

/// About 20 ms per device period, within what the device allows. Hosts' defaults can be
/// seconds (PulseAudio's is about 2 s): playback then starts late and the end of what was
/// played or recorded is lost when the device stream closes.
fn period(rate: u32, supported: &SupportedBufferSize) -> BufferSize {
    let want = (rate / 50).max(1);
    match *supported {
        SupportedBufferSize::Range { min, max } if min <= max => {
            BufferSize::Fixed(want.clamp(min, max))
        }
        _ => BufferSize::Default,
    }
}

/// Whether the device plays or captures nothing more after an error of this kind.
fn is_fatal(kind: cpal::ErrorKind) -> bool {
    use cpal::ErrorKind as K;
    match kind {
        // The device, its host or the access to it is gone; or cpal cannot say what
        // happened, which its documentation says to treat as permanent.
        K::DeviceNotAvailable
        | K::HostUnavailable
        | K::PermissionDenied
        | K::StreamInvalidated
        | K::Other => true,
        // Glitches and refusals the device stream goes on after (ALSA retries
        // `BackendError`). One that leaves a playback silent is caught by its watchdog.
        K::DeviceBusy
        | K::DeviceChanged
        | K::InvalidInput
        | K::RealtimeDenied
        | K::ResourceExhausted
        | K::UnsupportedConfig
        | K::UnsupportedOperation
        | K::Xrun
        | K::BackendError => false,
        // Kinds newer than cpal 0.18.2.
        _ => false,
    }
}

/// The device stream's error callback: a fatal error goes to `fatal`; any other is
/// passed to `note` once per kind (an underrun can repeat every period), and the device
/// goes on.
fn on_error(
    mut fatal: impl FnMut(String) + Send + 'static,
    mut note: impl FnMut(String) + Send + 'static,
) -> impl FnMut(cpal::Error) + Send + 'static {
    let mut noted: Vec<cpal::ErrorKind> = Vec::with_capacity(16);
    move |e: cpal::Error| {
        if is_fatal(e.kind()) {
            fatal(format!("the audio device failed: {e}"));
        } else if !noted.contains(&e.kind()) {
            noted.push(e.kind());
            note(format!("the audio device reported a problem, ignored: {e}"));
        }
    }
}

fn note_on_stderr(why: String) {
    eprintln!("pi-speech-receiver: {why}");
}

/// A buffer for converting at most [`SCRATCH_SAMPLES`] samples, in whole frames.
fn scratch(channels: usize) -> Vec<f32> {
    vec![0.0; (SCRATCH_SAMPLES / channels).max(1) * channels]
}

/// Write `src` (`f32`, any range) into the device's samples, clipped to full scale.
fn to_device<T: SizedSample + FromSample<f32>>(src: &[f32], dst: &mut [T]) {
    for (d, &s) in dst.iter_mut().zip(src) {
        *d = T::from_sample(s.clamp(-1.0, 1.0));
    }
}

/// Write the device's samples into `dst` as `f32`.
fn from_device<T: SizedSample>(src: &[T], dst: &mut [f32])
where
    f32: FromSample<T>,
{
    for (d, &s) in dst.iter_mut().zip(src) {
        *d = f32::from_sample(s);
    }
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
    let format = Format {
        rate: config.sample_rate,
        channels: config.channels as usize,
    };
    let mut buf = scratch(format.channels);
    device.build_output_stream::<T, _, _>(
        config,
        move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
            let ts = info.timestamp();
            let mut latency = ts.playback.duration_since(ts.callback);
            for dst in data.chunks_mut(buf.len()) {
                let src = &mut buf[..dst.len()];
                fill(src, latency);
                to_device(src, dst);
                latency += format.duration_of(dst.len());
            }
        },
        on_error(fatal, note_on_stderr),
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
    let mut buf = scratch(config.channels as usize);
    device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            for src in data.chunks(buf.len()) {
                let dst = &mut buf[..src.len()];
                from_device(src, dst);
                take(dst);
            }
        },
        on_error(fatal, note_on_stderr),
        None,
    )
}

/// A null device stream: a thread that hands out or takes one period of audio per
/// period of wall-clock time, on a fixed schedule so it neither drifts nor hurries.
struct NullStream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl NullStream {
    fn output(
        format: Format,
        stalls_after: Option<Duration>,
        mut fill: impl FnMut(&mut [f32], Duration) + Send + 'static,
    ) -> Result<NullStream, String> {
        let mut buf = vec![0.0f32; format.samples_in(NULL_PERIOD)];
        NullStream::run(stalls_after, move || fill(&mut buf, NULL_LATENCY))
    }

    fn input(
        format: Format,
        stalls_after: Option<Duration>,
        mut take: impl FnMut(&[f32]) + Send + 'static,
    ) -> Result<NullStream, String> {
        let mut buf = vec![0.0f32; format.samples_in(NULL_PERIOD)];
        let step = std::f32::consts::TAU * NULL_TONE_HZ / format.rate as f32;
        let mut phase = 0.0f32;
        NullStream::run(stalls_after, move || {
            for frame in buf.chunks_mut(format.channels) {
                frame.fill(NULL_TONE_LEVEL * phase.sin());
                phase = (phase + step) % std::f32::consts::TAU;
            }
            take(&buf)
        })
    }

    fn run(
        stalls_after: Option<Duration>,
        mut period: impl FnMut() + Send + 'static,
    ) -> Result<NullStream, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = Arc::clone(&stop);
        let thread = start_thread("null-audio", move || {
            let start = Instant::now();
            let mut n = 0u32;
            while !stopped.load(Ordering::SeqCst) {
                // A stuck device stops calling back, but stays open until it is dropped.
                if stalls_after.is_none_or(|d| start.elapsed() < d) {
                    period();
                }
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
    fn only_an_unset_or_empty_null_variable_selects_the_system_devices() {
        use std::ffi::OsStr;
        let m = |v: &str| mode_of(Some(OsStr::new(v)));
        assert_eq!(mode_of(None), Ok(Mode::System));
        assert_eq!(m(""), Ok(Mode::System));
        assert_eq!(m("1"), Ok(Mode::Null(Null::Steady)));
        assert_eq!(m("stuck"), Ok(Mode::Null(Null::Stuck)));
        assert_eq!(m("slow"), Ok(Mode::Null(Null::Slow)));
        assert_eq!(m("none"), Ok(Mode::Nothing));
        for unknown in ["stuck-ish", "0", "true", "yes", " 1", "NONE"] {
            assert_eq!(
                m(unknown),
                Err(format!("unknown PI_SPEECH_AUDIO_NULL value: {unknown:?}")),
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            assert!(mode_of(Some(OsStr::from_bytes(b"\xff"))).is_err());
        }
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStringExt;
            let lone_surrogate = std::ffi::OsString::from_wide(&[0xD800]);
            assert!(mode_of(Some(&lone_surrogate)).is_err());
        }
    }

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
    fn permanent_errors_are_fatal_and_the_rest_are_noted_once_per_kind() {
        use cpal::ErrorKind as K;
        let fatal = Arc::new(Mutex::new(Vec::new()));
        let notes = Arc::new(Mutex::new(Vec::new()));
        let (f, n) = (Arc::clone(&fatal), Arc::clone(&notes));
        let mut on = on_error(
            move |why| f.lock().unwrap().push(why),
            move |why| n.lock().unwrap().push(why),
        );
        for kind in [K::Xrun, K::Xrun, K::DeviceBusy, K::Xrun, K::BackendError] {
            on(cpal::Error::new(kind));
        }
        assert!(fatal.lock().unwrap().is_empty());
        let noted = notes.lock().unwrap().clone();
        assert_eq!(noted.len(), 3, "{noted:?}");
        assert!(noted.iter().all(|n| n.contains("ignored")), "{noted:?}");

        for kind in [
            K::Other,
            K::DeviceNotAvailable,
            K::HostUnavailable,
            K::PermissionDenied,
            K::StreamInvalidated,
        ] {
            on(cpal::Error::new(kind));
        }
        assert_eq!(fatal.lock().unwrap().len(), 5);
        assert_eq!(notes.lock().unwrap().len(), 3);
        assert!(fatal.lock().unwrap()[0].starts_with("the audio device failed"));
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
            let mut back = [9.0f32; 5];
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
    fn the_scratch_buffer_holds_whole_frames() {
        for channels in [1, 2, 3, 6, 8] {
            let n = scratch(channels).len();
            assert!(
                n <= SCRATCH_SAMPLES && n.is_multiple_of(channels),
                "{channels}: {n}"
            );
        }
    }

    /// What a null output was asked for in about `run`: (samples, last latency, the
    /// seconds it actually ran, which a busy machine can make longer than `run`).
    fn null_output_takes(stalls_after: Option<Duration>, run: Duration) -> (usize, Duration, f64) {
        let taken = Arc::new(Mutex::new((0usize, Duration::ZERO)));
        let t = Arc::clone(&taken);
        let started = Instant::now();
        let s = NullStream::output(NULL_OUTPUT, stalls_after, move |buf, lat| {
            let mut g = t.lock().unwrap();
            g.0 += buf.len();
            g.1 = lat;
        })
        .unwrap();
        std::thread::sleep(run);
        drop(s);
        let ran = started.elapsed().as_secs_f64();
        let (n, lat) = *taken.lock().unwrap();
        (n, lat, ran)
    }

    #[test]
    fn the_null_output_takes_audio_at_real_time_pace() {
        let (n, lat, ran) = null_output_takes(None, Duration::from_millis(500));
        let secs = NULL_OUTPUT.duration_of(n).as_secs_f64();
        assert!((secs - ran).abs() < 0.1, "{secs} s taken in {ran} s");
        assert_eq!(lat, NULL_LATENCY);
    }

    #[test]
    fn a_stuck_null_output_stops_calling_back_and_still_closes() {
        let t = Instant::now();
        let (n, _, _) =
            null_output_takes(Some(Duration::from_millis(200)), Duration::from_millis(600));
        let secs = NULL_OUTPUT.duration_of(n).as_secs_f64();
        assert!((0.15..=0.25).contains(&secs), "{secs}");
        assert!(t.elapsed() < Duration::from_millis(800), "closed promptly");
    }

    #[test]
    fn the_null_input_gives_a_quiet_tone_at_real_time_pace() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let g = Arc::clone(&got);
        let started = Instant::now();
        let s = NullStream::input(NULL_INPUT, None, move |buf| {
            g.lock().unwrap().extend_from_slice(buf)
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        drop(s);
        // A busy machine can sleep longer than asked: the pace is against the time it ran.
        let ran = started.elapsed().as_secs_f64();
        let got = got.lock().unwrap();
        let secs = NULL_INPUT.duration_of(got.len()).as_secs_f64();
        assert!((secs - ran).abs() < 0.1, "{secs} s captured in {ran} s");
        let peak = got.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.05 && peak <= NULL_TONE_LEVEL, "{peak}");
    }
}
