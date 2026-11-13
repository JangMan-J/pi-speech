//! A lock-free ring of interleaved audio between one producer thread and one consumer
//! thread. Neither side ever waits for, locks out or allocates for the other, so one side
//! can be a device callback.
//!
//! It holds and moves whole frames only, so a side that takes less than it asked for
//! never splits a frame between channels. Each slot is an atomic holding a sample's bits:
//! no `unsafe`. The counts of samples written and read only grow (64 bits do not wrap in
//! any recording's lifetime); a sample's slot is its count modulo the capacity.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

struct Shared {
    slots: Box<[AtomicU32]>,
    channels: usize,
    /// Samples written since the start: only the producer stores it.
    written: AtomicU64,
    /// Samples read since the start: only the consumer stores it.
    read: AtomicU64,
}

impl Shared {
    fn capacity(&self) -> usize {
        self.slots.len()
    }

    fn slot(&self, count: u64) -> &AtomicU32 {
        &self.slots[(count % self.slots.len() as u64) as usize]
    }

    /// `n` samples, rounded down to whole frames.
    fn whole(&self, n: usize) -> usize {
        n - n % self.channels
    }
}

/// The writing side.
pub struct Producer {
    ring: Arc<Shared>,
}

/// The reading side.
pub struct Consumer {
    ring: Arc<Shared>,
}

/// A ring holding `frames` frames of `channels` channels.
pub fn ring(frames: usize, channels: usize) -> (Producer, Consumer) {
    assert!(frames > 0 && channels > 0);
    let ring = Arc::new(Shared {
        slots: (0..frames * channels).map(|_| AtomicU32::new(0)).collect(),
        channels,
        written: AtomicU64::new(0),
        read: AtomicU64::new(0),
    });
    let producer = Producer {
        ring: Arc::clone(&ring),
    };
    (producer, Consumer { ring })
}

impl Producer {
    /// Room left, in samples (whole frames).
    pub fn free(&self) -> usize {
        let r = &self.ring;
        let used = r.written.load(Ordering::Relaxed) - r.read.load(Ordering::Acquire);
        r.capacity() - used as usize
    }

    /// Append as many whole frames of `samples` as there is room for; returns the samples
    /// taken.
    pub fn push(&mut self, samples: &[f32]) -> usize {
        self.put(samples.len(), |i| samples[i])
    }

    /// Append up to `n` samples of silence, in whole frames; returns the samples added.
    pub fn push_silence(&mut self, n: usize) -> usize {
        self.put(n, |_| 0.0)
    }

    fn put(&mut self, want: usize, sample: impl Fn(usize) -> f32) -> usize {
        let r = &self.ring;
        let n = r.whole(want.min(self.free()));
        let at = r.written.load(Ordering::Relaxed);
        for i in 0..n {
            r.slot(at + i as u64)
                .store(sample(i).to_bits(), Ordering::Relaxed);
        }
        // Publishes the samples to the consumer.
        r.written.store(at + n as u64, Ordering::Release);
        n
    }
}

impl Consumer {
    /// Samples waiting to be read (whole frames).
    pub fn len(&self) -> usize {
        let r = &self.ring;
        (r.written.load(Ordering::Acquire) - r.read.load(Ordering::Relaxed)) as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Fill the start of `out` with as many whole frames as are waiting; returns the
    /// samples read.
    pub fn pop(&mut self, out: &mut [f32]) -> usize {
        let r = &self.ring;
        let n = r.whole(out.len().min(self.len()));
        let at = r.read.load(Ordering::Relaxed);
        for (i, o) in out[..n].iter_mut().enumerate() {
            *o = f32::from_bits(r.slot(at + i as u64).load(Ordering::Relaxed));
        }
        // Hands the slots back to the producer.
        r.read.store(at + n as u64, Ordering::Release);
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_takes_what_fits_and_gives_it_back_in_order() {
        let (mut p, mut c) = ring(4, 1);
        assert_eq!(p.free(), 4);
        assert!(c.is_empty());
        assert_eq!(p.push(&[1.0, 2.0, 3.0]), 3);
        assert_eq!(p.push(&[4.0, 5.0, 6.0]), 1, "only the room left");
        assert_eq!(p.free(), 0);
        let mut out = [0.0; 3];
        assert_eq!(c.pop(&mut out), 3);
        assert_eq!(out, [1.0, 2.0, 3.0]);
        assert_eq!(p.push(&[5.0, 6.0]), 2, "across the end of the slots");
        let mut out = [9.0; 5];
        assert_eq!(c.pop(&mut out), 3);
        assert_eq!(out, [4.0, 5.0, 6.0, 9.0, 9.0]);
        assert_eq!(c.pop(&mut out), 0);
    }

    #[test]
    fn only_whole_frames_go_in_and_come_out() {
        let (mut p, mut c) = ring(3, 2);
        assert_eq!(p.push(&[1.0, -1.0, 2.0, -2.0, 3.0]), 4, "not half a frame");
        assert_eq!(p.push(&[3.0, -3.0, 4.0, -4.0]), 2, "one frame of room");
        assert_eq!(p.push_silence(2), 0);
        let mut out = [0.0; 3];
        assert_eq!(c.pop(&mut out), 2, "room in `out` for one frame only");
        assert_eq!(out[..2], [1.0, -1.0]);
        assert_eq!(p.push_silence(5), 2);
        let mut out = [9.0; 8];
        assert_eq!(c.pop(&mut out), 6);
        assert_eq!(out[..6], [2.0, -2.0, 3.0, -3.0, 0.0, 0.0]);
    }

    #[test]
    fn two_threads_pass_every_sample_in_order() {
        const N: usize = 200_000;
        let (mut p, mut c) = ring(64, 2);
        let producer = std::thread::spawn(move || {
            let all: Vec<f32> = (0..N).map(|i| i as f32).collect();
            let mut rest = &all[..];
            while !rest.is_empty() {
                let n = p.push(&rest[..rest.len().min(30)]);
                rest = &rest[n..];
                if n == 0 {
                    std::thread::yield_now();
                }
            }
        });
        let mut got = Vec::with_capacity(N);
        let mut buf = [0.0; 50];
        while got.len() < N {
            let n = c.pop(&mut buf);
            got.extend_from_slice(&buf[..n]);
            if n == 0 {
                std::thread::yield_now();
            }
        }
        producer.join().unwrap();
        assert!(got.iter().enumerate().all(|(i, &s)| s == i as f32));
    }
}
