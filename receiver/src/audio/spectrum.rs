//! Real-time 12-band speech spectrum meter (`0..=100` per band), shared between `play` /
//! `record` and `serve` through `PI_SPEECH_LEVELS_FILE`.

use std::f32::consts::{PI, TAU};
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;

pub const LEVELS_ENV: &str = "PI_SPEECH_LEVELS_FILE";
pub const BANDS: usize = 12;
const WINDOW: usize = 256;

/// Log-spaced center frequencies (Hz) across the speech range, all below 16 kHz Nyquist.
const FREQS: [f32; BANDS] = [
    90.0, 140.0, 210.0, 310.0, 450.0, 660.0, 960.0, 1400.0, 2050.0, 3000.0, 4400.0, 6400.0,
];

/// Fixed-size sample window filled by an audio callback via `try_lock` (never allocates,
/// never waits).
pub struct SampleTap {
    buf: Mutex<TapBuf>,
}

struct TapBuf {
    samples: [f32; WINDOW],
    pos: usize,
    seq: u64,
}

impl Default for SampleTap {
    fn default() -> Self {
        Self {
            buf: Mutex::new(TapBuf {
                samples: [0.0; WINDOW],
                pos: 0,
                seq: 0,
            }),
        }
    }
}

impl SampleTap {
    /// Copy up to `WINDOW` interleaved samples (downmixed to mono) without blocking.
    pub fn try_push_interleaved(&self, samples: &[f32], channels: usize) {
        if samples.is_empty() || channels == 0 {
            return;
        }
        let Ok(mut g) = self.buf.try_lock() else {
            return;
        };
        let mut pos = g.pos;
        for frame in samples.chunks_exact(channels) {
            let sum: f32 = frame.iter().copied().sum();
            g.samples[pos] = sum / channels as f32;
            pos = (pos + 1) % WINDOW;
        }
        g.pos = pos;
        g.seq = g.seq.wrapping_add(1);
    }

    /// Snapshot the latest `WINDOW` samples in chronological order, if new audio arrived
    /// since `last_seq`.
    pub fn snapshot(&self, last_seq: &mut u64, out: &mut [f32; WINDOW]) -> bool {
        let Ok(g) = self.buf.lock() else {
            return false;
        };
        if g.seq == *last_seq {
            return false;
        }
        *last_seq = g.seq;
        let tail = WINDOW - g.pos;
        out[..tail].copy_from_slice(&g.samples[g.pos..]);
        out[tail..].copy_from_slice(&g.samples[..g.pos]);
        true
    }
}

/// Computes smoothed 12-band magnitudes (`0..=100`) and writes them to `PI_SPEECH_LEVELS_FILE`
/// when set.
pub struct Meter {
    rate: f32,
    coeffs: [f32; BANDS],
    hann: [f32; WINDOW],
    smoothed: [f32; BANDS],
    file: Option<File>,
}

impl Meter {
    pub fn new(rate: u32) -> Self {
        let r = (rate as f32).max(8000.0);
        let mut coeffs = [0.0f32; BANDS];
        for (i, &f) in FREQS.iter().enumerate() {
            // Clamp below Nyquist so high bands never alias at low sample rates.
            let fc = f.min(r * 0.45);
            let k = (WINDOW as f32) * fc / r;
            coeffs[i] = 2.0 * (TAU * k / WINDOW as f32).cos();
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
            rate: r,
            coeffs,
            hann,
            smoothed: [0.0; BANDS],
            file,
        }
    }

    pub fn enabled(&self) -> bool {
        self.file.is_some()
    }

    /// Update bands from a mono window (uses the last `WINDOW` samples if longer).
    pub fn update(&mut self, mono: &[f32]) -> [u8; BANDS] {
        let _ = self.rate;
        let raw = if mono.len() >= WINDOW {
            self.measure(&mono[mono.len() - WINDOW..])
        } else if !mono.is_empty() {
            let mut padded = [0.0f32; WINDOW];
            padded[WINDOW - mono.len()..].copy_from_slice(mono);
            self.measure(&padded)
        } else {
            [0.0; BANDS]
        };

        let mut out = [0u8; BANDS];
        for (i, dst) in out.iter_mut().enumerate() {
            let alpha = if raw[i] > self.smoothed[i] { 0.8 } else { 0.35 };
            self.smoothed[i] += alpha * (raw[i] - self.smoothed[i]);
            if self.smoothed[i] < 0.5 {
                self.smoothed[i] = 0.0;
            }
            *dst = self.smoothed[i].round().clamp(0.0, 100.0) as u8;
        }
        self.write(&out);
        out
    }

    /// Decay bands gently when no new audio arrived.
    pub fn decay(&mut self) -> [u8; BANDS] {
        let mut out = [0u8; BANDS];
        for (i, dst) in out.iter_mut().enumerate() {
            self.smoothed[i] *= 0.65;
            if self.smoothed[i] < 0.5 {
                self.smoothed[i] = 0.0;
            }
            *dst = self.smoothed[i].round().clamp(0.0, 100.0) as u8;
        }
        self.write(&out);
        out
    }

    fn measure(&self, window: &[f32]) -> [f32; BANDS] {
        let mut out = [0.0f32; BANDS];
        // Coherent gain of Hann window is 0.5 * WINDOW.
        let norm = 0.5 * WINDOW as f32;
        for (b, &coeff) in self.coeffs.iter().enumerate() {
            let mut q1 = 0.0f32;
            let mut q2 = 0.0f32;
            for (x, &w) in window.iter().zip(self.hann.iter()) {
                let q0 = coeff * q1 - q2 + x * w;
                q2 = q1;
                q1 = q0;
            }
            let power = (q1 * q1 + q2 * q2 - coeff * q1 * q2).max(0.0);
            let mag = power.sqrt() / norm;
            // Map -54 dB .. -6 dB to 0 .. 100.
            let db = if mag > 1e-6 {
                20.0 * mag.log10()
            } else {
                -120.0
            };
            out[b] = ((db + 54.0) / 48.0 * 100.0).clamp(0.0, 100.0);
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

        let low = sine(450.0, 24000.0, WINDOW);
        let b_low = m.update(&low);
        let peak_low = b_low
            .iter()
            .enumerate()
            .max_by_key(|(_, &v)| v)
            .map(|(i, _)| i)
            .unwrap();
        assert!(
            (3..=5).contains(&peak_low),
            "450 Hz peaked at {peak_low}: {b_low:?}"
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
