//! Inspection of audio bytes: upload sniffing and recording duration.

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

#[cfg(test)]
mod tests {
    use super::*;

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
