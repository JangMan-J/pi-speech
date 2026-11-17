//! Real-time 12-band speech spectrum meter (`0..=100` per band), shared between `play` /
//! `record` and `serve` through `PI_SPEECH_LEVELS_FILE`.

use std::f32::consts::{PI, TAU};
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};

pub const LEVELS_ENV: &str = "PI_SPEECH_LEVELS_FILE";
pub const BANDS: usize = 12;
pub const WINDOW: usize = 1024;
const LOG2_WINDOW: u32 = 10;

/// Log-spaced speech band edges (Hz) from 175 Hz to 6.85 kHz: skips sub-175 Hz room rumble and
/// heavy chest boom while integrating full formant and consonant energy across every bin in each band.
const EDGES: [f32; BANDS + 1] = [
    175.0, 240.0, 325.0, 440.0, 595.0, 805.0, 1090.0, 1480.0, 2010.0, 2730.0, 3710.0, 5040.0,
    6850.0,
];

/// Low-shelf trim (dB) on the lowest three bands so F0 chest fundamentals do not dominate formants.
const LOW_TRIM_DB: [f32; BANDS] = [
    -5.5, -3.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
];

/// The latest [`WINDOW`] mono samples, written by an audio callback and read by the
/// thread that runs the meter. Lock-free: a device callback must never wait for anyone,
/// and a reader racing a writer at worst sees one torn window, which only blurs one frame
/// of the meter. One writer at a time (the device's callback).
pub struct SampleTap {
    samples: [AtomicU32; WINDOW],
    pos: AtomicUsize,
    seq: AtomicU64,
}

impl Default for SampleTap {
    fn default() -> Self {
        Self {
            samples: std::array::from_fn(|_| AtomicU32::new(0)),
            pos: AtomicUsize::new(0),
            seq: AtomicU64::new(0),
        }
    }
}

impl SampleTap {
    /// Add interleaved samples, downmixed to mono. Never blocks, never allocates.
    pub fn try_push_interleaved(&self, samples: &[f32], channels: usize) {
        if samples.is_empty() || channels == 0 {
            return;
        }
        let mut pos = self.pos.load(Ordering::Relaxed);
        for frame in samples.chunks_exact(channels) {
            let sum: f32 = frame.iter().copied().sum();
            self.samples[pos].store((sum / channels as f32).to_bits(), Ordering::Relaxed);
            pos = (pos + 1) % WINDOW;
        }
        self.pos.store(pos, Ordering::Relaxed);
        self.seq.fetch_add(1, Ordering::Release);
    }

    /// Copy the latest `WINDOW` samples in chronological order, if new audio arrived
    /// since `last_seq`.
    pub fn snapshot(&self, last_seq: &mut u64, out: &mut [f32; WINDOW]) -> bool {
        let seq = self.seq.load(Ordering::Acquire);
        if seq == *last_seq {
            return false;
        }
        *last_seq = seq;
        let pos = self.pos.load(Ordering::Relaxed);
        for (i, o) in out.iter_mut().enumerate() {
            *o = f32::from_bits(self.samples[(pos + i) % WINDOW].load(Ordering::Relaxed));
        }
        true
    }
}

/// Computes smoothed 12-band magnitudes (`0..=100`) and writes them to `PI_SPEECH_LEVELS_FILE`
/// when set.
pub struct Meter {
    bins: [(usize, usize); BANDS],
    tilt_db: [f32; BANDS],
    hann: [f32; WINDOW],
    ring: [f32; WINDOW],
    filled: usize,
    smoothed: [f32; BANDS],
    file: Option<File>,
}

impl Meter {
    pub fn new(rate: u32) -> Self {
        let r = (rate as f32).max(8000.0);
        let nyquist_bin = (WINDOW / 2).saturating_sub(1);
        let hz_per_bin = r / WINDOW as f32;
        let mut bins = [(1usize, 1usize); BANDS];
        let mut tilt_db = [0.0f32; BANDS];
        for b in 0..BANDS {
            let f_lo = EDGES[b].min(r * 0.44);
            let f_hi = EDGES[b + 1].min(r * 0.47).max(f_lo + hz_per_bin);
            let fc = (f_lo * f_hi).sqrt();
            let k_lo = ((f_lo / hz_per_bin).floor() as usize).clamp(1, nyquist_bin);
            let k_hi = ((f_hi / hz_per_bin).ceil() as usize).clamp(k_lo, nyquist_bin);
            bins[b] = (k_lo, k_hi);
            // Lift formants & sibilants above 450 Hz (on top of multi-bin bandwidth integration)
            // and trim low chest fundamentals so speech dances evenly across all 12 bands.
            tilt_db[b] = LOW_TRIM_DB[b] + 3.3 * (fc / 450.0).max(1.0).log2();
        }
        let mut hann = [0.0f32; WINDOW];
        for (n, w) in hann.iter_mut().enumerate() {
            *w = 0.5 * (1.0 - (2.0 * PI * n as f32 / (WINDOW - 1) as f32).cos());
        }
        let file = std::env::var_os(LEVELS_ENV)
            .filter(|v| !v.is_empty())
            .and_then(|path| {
                OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(path)
                    .ok()
            });
        Self {
            bins,
            tilt_db,
            hann,
            ring: [0.0; WINDOW],
            filled: 0,
            smoothed: [0.0; BANDS],
            file,
        }
    }

    pub fn enabled(&self) -> bool {
        self.file.is_some()
    }

    /// Update bands from new mono samples (accumulated into an internal `WINDOW` sliding buffer
    /// so short capture chunks keep full window resolution without zero-padding transients).
    pub fn update(&mut self, mono: &[f32]) -> [u8; BANDS] {
        let raw = if mono.is_empty() {
            [0.0; BANDS]
        } else {
            if mono.len() >= WINDOW {
                self.ring.copy_from_slice(&mono[mono.len() - WINDOW..]);
                self.filled = WINDOW;
            } else {
                let n = mono.len();
                self.ring.copy_within(n..WINDOW, 0);
                self.ring[WINDOW - n..].copy_from_slice(mono);
                self.filled = (self.filled + n).min(WINDOW);
            }
            self.measure()
        };

        let mut out = [0u8; BANDS];
        for (i, dst) in out.iter_mut().enumerate() {
            let alpha = if raw[i] > self.smoothed[i] {
                0.92
            } else {
                0.68
            };
            self.smoothed[i] += alpha * (raw[i] - self.smoothed[i]);
            if self.smoothed[i] < 0.5 {
                self.smoothed[i] = 0.0;
            }
            *dst = self.smoothed[i].round().clamp(0.0, 100.0) as u8;
        }
        self.write(&out);
        out
    }

    /// Decay bands crisply when no new audio arrived.
    pub fn decay(&mut self) -> [u8; BANDS] {
        let mut out = [0u8; BANDS];
        for (i, dst) in out.iter_mut().enumerate() {
            self.smoothed[i] *= 0.45;
            if self.smoothed[i] < 0.5 {
                self.smoothed[i] = 0.0;
            }
            *dst = self.smoothed[i].round().clamp(0.0, 100.0) as u8;
        }
        self.write(&out);
        out
    }

    fn measure(&self) -> [f32; BANDS] {
        if self.filled == 0 {
            return [0.0; BANDS];
        }
        let active = &self.ring[WINDOW - self.filled..];
        let dc = active.iter().copied().sum::<f32>() / active.len() as f32;

        let mut re = [0.0f32; WINDOW];
        let mut im = [0.0f32; WINDOW];
        if self.filled == WINDOW {
            for (dst, (&x, &w)) in re.iter_mut().zip(self.ring.iter().zip(self.hann.iter())) {
                *dst = (x - dc) * w;
            }
        } else {
            let len = active.len();
            let denom = (len.saturating_sub(1)).max(1) as f32;
            for (i, &x) in active.iter().enumerate() {
                let w = 0.5 * (1.0 - (2.0 * PI * i as f32 / denom).cos());
                re[WINDOW - len + i] = (x - dc) * w;
            }
        }

        fft_in_place(&mut re, &mut im);

        // Coherent gain of the active Hann window (`0.5 * N`), times single-sided factor `2` -> `0.25 * N`.
        let norm = (0.25 * self.filled as f32).max(1.0);
        let mut out = [0.0f32; BANDS];
        for (b, dst) in out.iter_mut().enumerate() {
            let (k_lo, k_hi) = self.bins[b];
            let mut power_sum = 0.0f32;
            for k in k_lo..=k_hi {
                power_sum += re[k] * re[k] + im[k] * im[k];
            }
            let mag = power_sum.sqrt() / norm;
            let db = if mag > 1e-6 {
                20.0 * mag.log10() + self.tilt_db[b]
            } else {
                -120.0
            };
            // Map -47.5 dB .. -9.5 dB to 0 .. 100 with `1.20` expansion: normal speech sits around
            // 50-80% with headroom for loud emphasis, while inter-syllable dips drop cleanly to zero.
            let lin = ((db + 47.5) / 38.0).clamp(0.0, 1.0);
            *dst = (lin.powf(1.20) * 100.0).clamp(0.0, 100.0);
        }
        out
    }

    fn write(&mut self, bands: &[u8; BANDS]) {
        let Some(f) = self.file.as_mut() else {
            return;
        };
        if f.seek(SeekFrom::Start(0)).is_ok() {
            let _ = f.write_all(bands);
        }
    }
}

/// In-place radix-2 Cooley-Tukey FFT over `WINDOW` (`1024 = 2^10`) samples.
fn fft_in_place(re: &mut [f32; WINDOW], im: &mut [f32; WINDOW]) {
    for i in 0..WINDOW {
        let j = i.reverse_bits() >> (usize::BITS - LOG2_WINDOW);
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= WINDOW {
        let half = len / 2;
        let step = -TAU / len as f32;
        let (w_step_sin, w_step_cos) = step.sin_cos();
        let mut start = 0;
        while start < WINDOW {
            let (mut wr, mut wi) = (1.0f32, 0.0f32);
            for k in 0..half {
                let a = start + k;
                let b = a + half;
                let tr = wr * re[b] - wi * im[b];
                let ti = wr * im[b] + wi * re[b];
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let next_wr = wr * w_step_cos - wi * w_step_sin;
                wi = wr * w_step_sin + wi * w_step_cos;
                wr = next_wr;
            }
            start += len;
        }
        len <<= 1;
    }
}

/// Read the latest 12-band snapshot written by a running `play` or `record`.
pub fn read_levels(path: &Path) -> Option<[u8; BANDS]> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < BANDS {
        return None;
    }
    let mut out = [0u8; BANDS];
    for (dst, &b) in out.iter_mut().zip(bytes[..BANDS].iter()) {
        *dst = b.min(100);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f32, rate: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| 0.5 * (TAU * hz * i as f32 / rate).sin())
            .collect()
    }

    #[test]
    fn silence_is_zero_and_tones_peak_in_matching_bands() {
        let mut m = Meter::new(24000);
        assert_eq!(m.update(&vec![0.0; WINDOW]), [0; BANDS]);

        let low = sine(480.0, 24000.0, WINDOW);
        let b_low = m.update(&low);
        let peak_low = b_low
            .iter()
            .enumerate()
            .max_by_key(|(_, &v)| v)
            .map(|(i, _)| i)
            .unwrap();
        assert!(
            (2..=4).contains(&peak_low),
            "480 Hz peaked at {peak_low}: {b_low:?}"
        );

        let mut m2 = Meter::new(24000);
        let high = sine(3000.0, 24000.0, WINDOW);
        let b_high = m2.update(&high);
        let peak_high = b_high
            .iter()
            .enumerate()
            .max_by_key(|(_, &v)| v)
            .map(|(i, _)| i)
            .unwrap();
        assert!(
            (8..=10).contains(&peak_high),
            "3000 Hz peaked at {peak_high}: {b_high:?}"
        );
    }

    #[test]
    fn short_chunks_accumulate_without_step_transients_and_balance_speech_tilt() {
        // Feed 240-sample (10 ms) chunks of a 2.2 kHz formant tone: sliding window must peak in band 8
        // without spurious low-end step leakage in band 0.
        let mut m = Meter::new(24000);
        let full = sine(2200.0, 24000.0, WINDOW * 2);
        let mut last = [0u8; BANDS];
        for chunk in full.chunks(240) {
            last = m.update(chunk);
        }
        assert_eq!(last[0], 0, "unexpected low-band leakage: {last:?}");
        assert!(last[8] >= 85, "expected strong mid-high response: {last:?}");
    }

    #[test]
    fn sample_tap_tracks_chronological_window() {
        let tap = SampleTap::default();
        let data: Vec<f32> = (0..WINDOW).map(|i| i as f32).collect();
        tap.try_push_interleaved(&data, 1);
        let mut seq = 0;
        let mut out = [0.0f32; WINDOW];
        assert!(tap.snapshot(&mut seq, &mut out));
        assert_eq!(out[0], 0.0);
        assert_eq!(out[WINDOW - 1], (WINDOW - 1) as f32);
        assert!(!tap.snapshot(&mut seq, &mut out));
    }
}
