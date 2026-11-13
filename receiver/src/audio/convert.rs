//! Sample-rate and channel conversion of interleaved `f32` audio.

/// Map one frame of `src.len()` channels onto `out.len()` channels: mono is copied to
/// every channel, many channels to mono are averaged, otherwise the channels both have are
/// copied and the rest are silent.
pub fn map_frame(src: &[f32], out: &mut [f32]) {
    match (src.len(), out.len()) {
        (s, o) if s == o => out.copy_from_slice(src),
        (1, _) => out.fill(src[0]),
        (s, 1) => out[0] = src.iter().sum::<f32>() / s as f32,
        _ => {
            for (i, o) in out.iter_mut().enumerate() {
                *o = src.get(i).copied().unwrap_or(0.0);
            }
        }
    }
}

/// Converts interleaved frames from one rate and channel count to another, with linear
/// interpolation between neighbouring frames. Feed it in pieces of any size; the result
/// is the same as feeding it all at once.
pub struct Converter {
    src_rate: u32,
    src_channels: usize,
    /// Source frames per output frame.
    step: f64,
    /// Where the next output frame lies, in source frames after `prev`.
    pos: f64,
    /// The last source frame, already mapped to the output channels.
    prev: Vec<f32>,
    cur: Vec<f32>,
    primed: bool,
}

impl Converter {
    pub fn new(src_rate: u32, src_channels: usize, dst_rate: u32, dst_channels: usize) -> Self {
        assert!(src_rate > 0 && dst_rate > 0 && src_channels > 0 && dst_channels > 0);
        Converter {
            src_rate,
            src_channels,
            step: src_rate as f64 / dst_rate as f64,
            pos: 0.0,
            prev: vec![0.0; dst_channels],
            cur: vec![0.0; dst_channels],
            primed: false,
        }
    }

    /// Whether this converter takes audio of `rate` and `channels`.
    pub fn takes(&self, rate: u32, channels: usize) -> bool {
        rate == self.src_rate && channels == self.src_channels
    }

    /// Convert `src` (whole frames) and append the result to `out`.
    pub fn push(&mut self, src: &[f32], out: &mut Vec<f32>) {
        debug_assert_eq!(src.len() % self.src_channels, 0);
        for frame in src.chunks_exact(self.src_channels) {
            map_frame(frame, &mut self.cur);
            if !self.primed {
                self.prev.copy_from_slice(&self.cur);
                self.primed = true;
                continue;
            }
            self.emit_until(1.0, out);
            self.pos -= 1.0;
            std::mem::swap(&mut self.prev, &mut self.cur);
        }
    }

    /// The end of the input: what lies after the last frame, holding that frame.
    pub fn finish(&mut self, out: &mut Vec<f32>) {
        if self.primed {
            self.cur.copy_from_slice(&self.prev);
            self.emit_until(1.0, out);
            self.pos = 0.0;
            self.primed = false;
        }
    }

    fn emit_until(&mut self, end: f64, out: &mut Vec<f32>) {
        while self.pos < end {
            let t = self.pos as f32;
            for (a, b) in self.prev.iter().zip(&self.cur) {
                out.push(a + (b - a) * t);
            }
            self.pos += self.step;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convert(src: &[f32], from: (u32, usize), to: (u32, usize)) -> Vec<f32> {
        let mut c = Converter::new(from.0, from.1, to.0, to.1);
        let mut out = Vec::new();
        c.push(src, &mut out);
        c.finish(&mut out);
        out
    }

    #[test]
    fn mono_is_copied_to_every_channel() {
        let mut out = [9.0; 3];
        map_frame(&[0.25], &mut out);
        assert_eq!(out, [0.25; 3]);
    }

    #[test]
    fn many_channels_to_mono_are_averaged() {
        let mut out = [9.0];
        map_frame(&[0.5, -0.25, 0.25, 0.5], &mut out);
        assert_eq!(out, [0.25]);
    }

    #[test]
    fn other_layouts_keep_the_shared_channels_and_silence_the_rest() {
        let mut out = [9.0; 4];
        map_frame(&[0.1, 0.2], &mut out);
        assert_eq!(out, [0.1, 0.2, 0.0, 0.0]);
        let mut out = [9.0; 2];
        map_frame(&[0.1, 0.2, 0.3], &mut out);
        assert_eq!(out, [0.1, 0.2]);
    }

    #[test]
    fn same_rate_and_channels_is_the_identity() {
        let src: Vec<f32> = (0..100).map(|i| i as f32 / 100.0).collect();
        assert_eq!(convert(&src, (24000, 1), (24000, 1)), src);
        let stereo: Vec<f32> = (0..200).map(|i| (i % 7) as f32 / 7.0).collect();
        assert_eq!(convert(&stereo, (48000, 2), (48000, 2)), stereo);
    }

    #[test]
    fn upsampling_interpolates_and_keeps_the_duration() {
        let src: Vec<f32> = (0..24).map(|i| i as f32).collect();
        let out = convert(&src, (24000, 1), (48000, 2));
        assert_eq!(out.len(), 48 * 2);
        // A ramp stays a ramp, at half the step, in both channels.
        for (i, f) in out.chunks(2).take(47).enumerate() {
            assert_eq!(f, [i as f32 / 2.0; 2]);
        }
        assert_eq!(out[94..], [23.0, 23.0], "the last frame is held");
    }

    #[test]
    fn downsampling_and_odd_ratios_keep_the_duration() {
        for (from, to) in [
            (48000, 24000),
            (44100, 48000),
            (48000, 44100),
            (8000, 192000),
        ] {
            let n = from as usize / 10; // 0.1 s
            let src = vec![0.5f32; n];
            let out = convert(&src, (from, 1), (to, 1));
            let want = to as usize / 10;
            assert!(out.len().abs_diff(want) <= 1, "{from}->{to}: {}", out.len());
            assert!(out.iter().all(|&s| (s - 0.5).abs() < 1e-6));
        }
    }

    #[test]
    fn pieces_of_any_size_give_the_same_result() {
        let src: Vec<f32> = (0..2 * 1000)
            .map(|i| ((i * 37) % 101) as f32 / 101.0)
            .collect();
        let whole = convert(&src, (44100, 2), (48000, 1));
        let mut c = Converter::new(44100, 2, 48000, 1);
        let mut pieces = Vec::new();
        let mut rest = &src[..];
        for size in [2, 6, 0, 18, 400, 2].iter().cycle() {
            if rest.is_empty() {
                break;
            }
            let n = (*size).min(rest.len());
            c.push(&rest[..n], &mut pieces);
            rest = &rest[n..];
        }
        c.finish(&mut pieces);
        assert_eq!(pieces, whole);
    }

    #[test]
    fn a_converter_knows_what_it_takes() {
        let c = Converter::new(24000, 1, 48000, 2);
        assert!(c.takes(24000, 1));
        assert!(!c.takes(24000, 2));
        assert!(!c.takes(22050, 1));
    }
}
