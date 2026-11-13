//! Audio input decoded chunk by chunk as it arrives: raw PCM, or WAV and MP3 through
//! symphonia, which reads non-seekable input (a pipe) without waiting for its end.

use std::io::{self, Read};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::codecs::CodecParameters;
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, TrackType};
use symphonia::core::io::{
    MediaSource, MediaSourceStream, MediaSourceStreamOptions, ReadOnlySource,
};
use symphonia::core::meta::MetadataOptions;

/// A chunk of decoded audio: interleaved `f32` frames.
pub struct Chunk<'a> {
    pub rate: u32,
    pub channels: usize,
    pub samples: &'a [f32],
}

pub trait Decode {
    /// The next chunk of audio; `None` once the input has ended.
    fn next_chunk(&mut self) -> Result<Option<Chunk<'_>>, String>;
}

/// Raw signed 16-bit little-endian PCM. A partial frame at the very end is dropped.
pub struct Pcm<R> {
    reader: R,
    rate: u32,
    channels: usize,
    raw: Vec<u8>,
    /// Bytes read but not yet decoded: less than one frame.
    carry: Vec<u8>,
    out: Vec<f32>,
}

impl<R: Read> Pcm<R> {
    pub fn new(reader: R, rate: u32, channels: usize) -> Self {
        assert!(rate > 0 && channels > 0);
        Pcm {
            reader,
            rate,
            channels,
            raw: vec![0; 8192],
            carry: Vec::new(),
            out: Vec::new(),
        }
    }
}

impl<R: Read> Decode for Pcm<R> {
    fn next_chunk(&mut self) -> Result<Option<Chunk<'_>>, String> {
        let frame = 2 * self.channels;
        loop {
            let n = match self.reader.read(&mut self.raw) {
                Ok(0) => return Ok(None),
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(format!("cannot read the audio: {e}")),
            };
            self.carry.extend_from_slice(&self.raw[..n]);
            let whole = self.carry.len() - self.carry.len() % frame;
            if whole == 0 {
                continue;
            }
            self.out.clear();
            let (pairs, _) = self.carry[..whole].as_chunks::<2>();
            self.out.extend(
                pairs
                    .iter()
                    .map(|&b| i16::from_le_bytes(b) as f32 / 32768.0),
            );
            self.carry.drain(..whole);
            return Ok(Some(Chunk {
                rate: self.rate,
                channels: self.channels,
                samples: &self.out,
            }));
        }
    }
}

/// A WAV or MP3 decoder, for a file or for non-seekable input.
pub struct WavOrMp3 {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track: u32,
    out: Vec<f32>,
}

impl WavOrMp3 {
    /// Decode non-seekable input, such as standard input. `extension` (`wav`,
    /// `mp3`) is a hint; the content decides.
    pub fn from_non_seekable<R>(reader: R, extension: Option<&str>) -> Result<WavOrMp3, String>
    where
        R: Read + Send + Sync + 'static,
    {
        WavOrMp3::open(Box::new(ReadOnlySource::new(reader)), extension)
    }

    pub fn open(source: Box<dyn MediaSource>, extension: Option<&str>) -> Result<WavOrMp3, String> {
        let input = MediaSourceStream::new(source, MediaSourceStreamOptions::default());
        let mut hint = Hint::new();
        if let Some(ext) = extension {
            hint.with_extension(ext);
        }
        let format = symphonia::default::get_probe()
            .probe(
                &hint,
                input,
                FormatOptions::default(),
                MetadataOptions::default(),
            )
            .map_err(|e| match e {
                SymError::IoError(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                    "the input ended before any audio".to_string()
                }
                SymError::IoError(e) => format!("cannot read the audio: {e}"),
                e => format!("the input is not WAV or MP3 audio ({e})"),
            })?;
        let track = format
            .default_track(TrackType::Audio)
            .ok_or("the input holds no audio track")?;
        let params = match &track.codec_params {
            Some(CodecParameters::Audio(p)) => p.clone(),
            _ => return Err("the input holds no audio track".into()),
        };
        let track = track.id;
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .map_err(|e| format!("cannot decode the audio: {e}"))?;
        Ok(WavOrMp3 {
            format,
            decoder,
            track,
            out: Vec::new(),
        })
    }
}

impl Decode for WavOrMp3 {
    fn next_chunk(&mut self) -> Result<Option<Chunk<'_>>, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return Ok(None),
                // Input whose header promised more than came (an open-ended WAV).
                Err(SymError::IoError(e)) if e.kind() == io::ErrorKind::UnexpectedEof => {
                    return Ok(None)
                }
                Err(e) => return Err(format!("cannot read the audio: {e}")),
            };
            if packet.track_id != self.track {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(d) => d,
                // One damaged frame is skipped, as players do.
                Err(SymError::DecodeError(_)) => continue,
                Err(e) => return Err(format!("cannot decode the audio: {e}")),
            };
            let spec = decoded.spec();
            let (rate, channels) = (spec.rate(), spec.channels().count());
            if rate == 0 || channels == 0 {
                return Err("the audio has no sample rate or no channels".into());
            }
            self.out.clear();
            decoded.copy_to_vec_interleaved(&mut self.out);
            if self.out.is_empty() {
                continue;
            }
            return Ok(Some(Chunk {
                rate,
                channels,
                samples: &self.out,
            }));
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A reader that cannot seek and hands out at most `step` bytes per read, as a pipe
    /// fed a little at a time does.
    pub(crate) struct Dribble {
        data: Vec<u8>,
        at: usize,
        step: usize,
    }

    impl Dribble {
        pub(crate) fn new(data: Vec<u8>, step: usize) -> Dribble {
            Dribble { data, at: 0, step }
        }
    }

    impl Read for Dribble {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = buf.len().min(self.step).min(self.data.len() - self.at);
            buf[..n].copy_from_slice(&self.data[self.at..self.at + n]);
            self.at += n;
            Ok(n)
        }
    }

    pub(crate) fn pcm_bytes(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    /// A 16-bit PCM WAV whose sizes say "open-ended", as xAI writes them.
    pub(crate) fn open_wav(rate: u32, channels: u16, samples: &[i16]) -> Vec<u8> {
        let mut v = b"RIFF".to_vec();
        v.extend(0xFFFF_FFFFu32.to_le_bytes());
        v.extend(b"WAVEfmt ");
        v.extend(16u32.to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(channels.to_le_bytes());
        v.extend(rate.to_le_bytes());
        v.extend((rate * 2 * channels as u32).to_le_bytes());
        v.extend((2 * channels).to_le_bytes());
        v.extend(16u16.to_le_bytes());
        v.extend(b"data");
        v.extend(0x7FFF_FFFFu32.to_le_bytes());
        v.extend(pcm_bytes(samples));
        v
    }

    pub(crate) const MP3: &[u8] = include_bytes!("../../tests/fixtures/tone-0.5s-24k.mp3");

    /// All the audio a decoder gives: (rate, channels, samples).
    fn drain(d: &mut dyn Decode) -> (u32, usize, Vec<f32>) {
        let (mut rate, mut channels, mut all) = (0, 0, Vec::new());
        while let Some(c) = d.next_chunk().unwrap() {
            (rate, channels) = (c.rate, c.channels);
            all.extend_from_slice(c.samples);
        }
        (rate, channels, all)
    }

    #[test]
    fn pcm_is_decoded_across_reads_that_split_frames() {
        let samples: Vec<i16> = (0..1000).map(|i| (i * 31 - 15000) as i16).collect();
        let mut d = Pcm::new(Dribble::new(pcm_bytes(&samples), 3), 24000, 2);
        let (rate, channels, got) = drain(&mut d);
        assert_eq!((rate, channels), (24000, 2));
        let want: Vec<f32> = samples.iter().map(|&s| s as f32 / 32768.0).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn pcm_drops_a_partial_frame_at_the_end() {
        let mut bytes = pcm_bytes(&[100, 200, 300, 400]);
        bytes.extend([1, 2, 3]);
        let mut d = Pcm::new(Dribble::new(bytes, 5), 8000, 2);
        assert_eq!(drain(&mut d).2.len(), 4);
    }

    #[test]
    fn an_open_ended_wav_plays_from_a_pipe_to_its_last_sample() {
        let samples: Vec<i16> = (0..24000)
            .map(|i| ((i % 200) * 100 - 10000) as i16)
            .collect();
        let wav = open_wav(24000, 1, &samples);
        let mut d = WavOrMp3::from_non_seekable(Dribble::new(wav, 1000), Some("wav")).unwrap();
        let (rate, channels, got) = drain(&mut d);
        assert_eq!((rate, channels), (24000, 1));
        assert_eq!(got.len(), samples.len());
        for (g, s) in got.iter().zip(&samples) {
            assert!((g - *s as f32 / 32768.0).abs() < 1e-4);
        }
    }

    #[test]
    fn a_stereo_wav_keeps_its_channels() {
        let samples: Vec<i16> = (0..2 * 4800)
            .map(|i| if i % 2 == 0 { 8000 } else { -8000 })
            .collect();
        let mut d =
            WavOrMp3::from_non_seekable(Dribble::new(open_wav(48000, 2, &samples), 777), None)
                .unwrap();
        let (rate, channels, got) = drain(&mut d);
        assert_eq!((rate, channels, got.len()), (48000, 2, samples.len()));
        assert!(got[0] > 0.2 && got[1] < -0.2);
    }

    #[test]
    fn mp3_is_decoded_from_a_pipe() {
        let mut d =
            WavOrMp3::from_non_seekable(Dribble::new(MP3.to_vec(), 200), Some("mp3")).unwrap();
        let (rate, channels, got) = drain(&mut d);
        assert_eq!((rate, channels), (24000, 1));
        let secs = got.len() as f64 / 24000.0;
        assert!((0.45..0.65).contains(&secs), "{secs}");
        let peak = got.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        // ffmpeg's `sine` source, which made the fixture, is at 1/8 of full scale.
        assert!((0.1..0.15).contains(&peak), "the tone, not silence: {peak}");
    }

    #[test]
    fn what_is_not_audio_is_refused_with_a_reason() {
        for bytes in [b"hello, this is not audio at all".repeat(100), Vec::new()] {
            let e = WavOrMp3::from_non_seekable(Dribble::new(bytes, 64), Some("mp3")).err();
            assert!(e.is_some_and(|e| !e.is_empty() && !e.contains('\n')));
        }
    }
}
