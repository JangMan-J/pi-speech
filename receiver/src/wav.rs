//! Inspection of audio bytes (upload sniffing and recording duration), and writing
//! recordings.

use std::fs::{File, OpenOptions};
use std::io::{self, BufWriter, Seek, SeekFrom, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Wav,
    Mp3,
}

impl Kind {
    pub fn extension(self) -> &'static str {
        match self {
            Kind::Wav => "wav",
            Kind::Mp3 => "mp3",
        }
    }
}

/// True when `b` starts like a WAV file: `RIFF....WAVE`.
pub fn is_wav(b: &[u8]) -> bool {
    b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WAVE"
}

/// True when `b` starts with an ID3 tag or an MPEG audio frame sync.
pub fn is_mp3(b: &[u8]) -> bool {
    if b.len() >= 3 && &b[0..3] == b"ID3" {
        return true;
    }
    if b.len() < 4 || b[0] != 0xFF || b[1] & 0xE0 != 0xE0 {
        return false;
    }
    let version = (b[1] >> 3) & 3;
    let layer = (b[1] >> 1) & 3;
    let bitrate = b[2] >> 4;
    let rate = (b[2] >> 2) & 3;
    version != 1 && layer != 0 && bitrate != 0 && bitrate != 15 && rate != 3
}

/// Whether the bytes are of the declared kind.
pub fn matches(kind: Kind, b: &[u8]) -> bool {
    match kind {
        Kind::Wav => is_wav(b),
        Kind::Mp3 => is_mp3(b),
    }
}

/// Duration in seconds of a PCM WAV, found by walking its chunks.
/// `None` when the bytes are not a WAV with a usable `fmt ` and `data` chunk.
/// A `data` size that is `0xFFFFFFFF` or runs past the end is clipped to the file.
pub fn wav_seconds(b: &[u8]) -> Option<f64> {
    if !is_wav(b) {
        return None;
    }
    let mut pos = 12usize;
    let mut rate_block: Option<(u32, u32)> = None;
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let size = u32::from_le_bytes(b[pos + 4..pos + 8].try_into().ok()?) as usize;
        let body = pos + 8;
        if id == b"fmt " {
            if body + 16 > b.len() {
                return None;
            }
            let rate = u32::from_le_bytes(b[body + 4..body + 8].try_into().ok()?);
            let block = u16::from_le_bytes(b[body + 12..body + 14].try_into().ok()?) as u32;
            rate_block = Some((rate, block));
        } else if id == b"data" {
            let (rate, block) = rate_block?;
            if rate == 0 || block == 0 {
                return None;
            }
            let avail = b.len() - body;
            let n = if size == 0xFFFF_FFFF {
                avail
            } else {
                size.min(avail)
            };
            return Some(n as f64 / (rate as f64 * block as f64));
        }
        pos = body.checked_add(size)?.checked_add(size & 1)?;
    }
    None
}

/// Writes a 16-bit PCM WAV file as its samples come; [`Writer::finish`] sets the sizes
/// in its header. Samples past what a WAV can hold (its sizes are 32-bit) are dropped.
pub struct Writer {
    out: BufWriter<File>,
    channels: u16,
    data_bytes: u64,
    /// The most data bytes this file takes: [`max_data`].
    limit: u64,
}

const HEADER_BYTES: u64 = 44;
/// The bytes the RIFF size counts besides the data: `WAVE`, the `fmt ` chunk and the
/// `data` chunk's header.
const RIFF_OVERHEAD: u64 = HEADER_BYTES - 8;

/// The most data bytes a 16-bit WAV of `channels` holds, in whole frames: the RIFF size
/// (the data plus [`RIFF_OVERHEAD`]) must fit in 32 bits.
fn max_data(channels: u16) -> u64 {
    let block = 2 * channels as u64;
    (u32::MAX as u64 - RIFF_OVERHEAD) / block * block
}

/// The header's RIFF and data sizes for `data_bytes` of data, each saturated at what 32
/// bits hold (which readers take as "to the end of the file").
fn header_sizes(data_bytes: u64) -> (u32, u32) {
    let clip = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
    (
        clip(data_bytes.saturating_add(RIFF_OVERHEAD)),
        clip(data_bytes),
    )
}

impl Writer {
    /// Create (or replace) `path`, readable by its owner only (mode 0600 on Unix; on
    /// Windows the default ACLs of its directory, in the user's profile, do that).
    pub fn create(path: &Path, rate: u32, channels: u16) -> io::Result<Writer> {
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(path)?;
        let mut out = BufWriter::new(file);
        let block = 2 * channels;
        let mut h = Vec::with_capacity(HEADER_BYTES as usize);
        h.extend(b"RIFF");
        h.extend((RIFF_OVERHEAD as u32).to_le_bytes()); // set by `finish`
        h.extend(b"WAVEfmt ");
        h.extend(16u32.to_le_bytes());
        h.extend(1u16.to_le_bytes()); // PCM
        h.extend(channels.to_le_bytes());
        h.extend(rate.to_le_bytes());
        h.extend((rate * block as u32).to_le_bytes());
        h.extend(block.to_le_bytes());
        h.extend(16u16.to_le_bytes());
        h.extend(b"data");
        h.extend(0u32.to_le_bytes()); // set by `finish`
        out.write_all(&h)?;
        Ok(Writer {
            out,
            channels,
            data_bytes: 0,
            limit: max_data(channels),
        })
    }

    /// Append interleaved samples (whole frames); those past what the file can hold are
    /// dropped.
    pub fn write(&mut self, samples: &[i16]) -> io::Result<()> {
        let block = 2 * self.channels as u64;
        let room = (self.limit.saturating_sub(self.data_bytes) / block * block / 2) as usize;
        let samples = &samples[..samples.len().min(room)];
        for s in samples {
            self.out.write_all(&s.to_le_bytes())?;
        }
        self.data_bytes += 2 * samples.len() as u64;
        Ok(())
    }

    /// Set the sizes in the header and flush the file to disk; returns the frames written.
    pub fn finish(mut self) -> io::Result<u64> {
        let (riff, data) = header_sizes(self.data_bytes);
        self.out.flush()?;
        let mut file = self.out.into_inner().map_err(|e| e.into_error())?;
        file.seek(SeekFrom::Start(4))?;
        file.write_all(&riff.to_le_bytes())?;
        file.seek(SeekFrom::Start(40))?;
        file.write_all(&data.to_le_bytes())?;
        file.sync_all()?;
        Ok(self.data_bytes / (2 * self.channels as u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_written_file_is_a_wav_of_its_length() {
        let dir = std::env::temp_dir().join(format!(
            "pisr-wav-{}-{}",
            std::process::id(),
            crate::token::random_hex(4).unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.wav");
        let mut w = Writer::create(&path, 24000, 1).unwrap();
        w.write(&[0i16; 12000]).unwrap();
        w.write(&[i16::MAX, i16::MIN]).unwrap();
        assert_eq!(w.finish().unwrap(), 12002);
        let b = std::fs::read(&path).unwrap();
        assert_eq!(b.len(), 44 + 2 * 12002);
        assert_eq!(wav_seconds(&b), Some(12002.0 / 24000.0));
        assert_eq!(&b[4..8], &(36u32 + 2 * 12002).to_le_bytes());
        assert_eq!(&b[b.len() - 4..], &[0xFF, 0x7F, 0x00, 0x80]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_header_sizes_saturate_near_the_32_bit_limit() {
        let max = u32::MAX as u64;
        assert_eq!(header_sizes(0), (36, 0));
        assert_eq!(header_sizes(max - 36), (u32::MAX, u32::MAX - 36));
        for data in [max - 35, max - 1, max, max + 1, u64::MAX] {
            let (riff, size) = header_sizes(data);
            assert_eq!(riff, u32::MAX, "{data}");
            assert_eq!(size as u64, data.min(max), "{data}");
        }
    }

    #[test]
    fn the_data_stops_at_what_a_wav_can_hold_in_whole_frames() {
        assert_eq!(max_data(1), 4_294_967_258);
        assert_eq!(max_data(2), 4_294_967_256);
        assert!(36 + max_data(1) <= u32::MAX as u64);

        let dir = std::env::temp_dir().join(format!(
            "pisr-wav-full-{}-{}",
            std::process::id(),
            crate::token::random_hex(4).unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("out.wav");
        let mut w = Writer::create(&path, 8000, 2).unwrap();
        w.limit = 4 * 10; // 10 stereo frames, standing in for the 32-bit limit
        w.write(&[1; 14]).unwrap();
        w.write(&[2; 14]).unwrap();
        w.write(&[3; 4]).unwrap();
        assert_eq!(w.finish().unwrap(), 10);
        let b = std::fs::read(&path).unwrap();
        assert_eq!(b.len(), 44 + 40);
        assert_eq!(&b[40..44], &40u32.to_le_bytes());
        assert_eq!(&b[4..8], &76u32.to_le_bytes());
        assert_eq!(
            &b[b.len() - 4..],
            &[2, 0, 2, 0],
            "the last whole frame that fit"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    fn wav(frames: usize, rate: u32) -> Vec<u8> {
        let data = vec![0u8; frames * 2];
        let mut v = b"RIFF".to_vec();
        v.extend((36 + data.len() as u32).to_le_bytes());
        v.extend(b"WAVEfmt ");
        v.extend(16u32.to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(rate.to_le_bytes());
        v.extend((rate * 2).to_le_bytes());
        v.extend(2u16.to_le_bytes());
        v.extend(16u16.to_le_bytes());
        v.extend(b"data");
        v.extend((data.len() as u32).to_le_bytes());
        v.extend(data);
        v
    }

    #[test]
    fn duration_is_frames_over_rate() {
        assert_eq!(wav_seconds(&wav(8000, 16000)), Some(0.5));
        assert_eq!(wav_seconds(&wav(0, 16000)), Some(0.0));
    }

    #[test]
    fn oversized_data_chunk_is_clipped_to_the_file() {
        let mut w = wav(16000, 16000);
        w[40..44].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        assert_eq!(wav_seconds(&w), Some(1.0));
    }

    #[test]
    fn non_wav_has_no_duration() {
        assert_eq!(wav_seconds(b"hello world, not audio"), None);
        assert_eq!(wav_seconds(&wav(10, 16000)[..30]), None);
    }

    #[test]
    fn sniffing() {
        assert!(is_wav(&wav(1, 8000)));
        assert!(!is_wav(b"RIFF\0\0\0\0AVI "));
        assert!(is_mp3(b"ID3\x04\0\0\0\0\0\0"));
        assert!(is_mp3(&[0xFF, 0xFB, 0x90, 0x00]));
        assert!(!is_mp3(&[0xFF, 0xFB, 0xF0, 0x00]));
        assert!(!is_mp3(b"\0\0\0\0"));
        assert!(!is_mp3(&wav(1, 8000)));
    }
}
