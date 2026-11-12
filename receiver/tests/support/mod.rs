#![allow(dead_code)]
//! Shared helpers: scratch directories, a raw HTTP client, WAV bytes, fake programs.

use pi_speech_receiver::token::random_hex;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pisr-{name}-{}", random_hex(6).unwrap()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

pub fn wav(seconds: f64) -> Vec<u8> {
    let rate = 16000u32;
    let data = vec![0u8; (seconds * rate as f64) as usize * 2];
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

pub fn wav_len(b: &[u8]) -> usize {
    b.len().saturating_sub(44) / 2
}

pub struct Reply {
    pub status: u16,
    pub head: String,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

pub fn parse_reply(raw: Vec<u8>) -> Reply {
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .expect("response head");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    Reply {
        status,
        head,
        body: raw[split + 4..].to_vec(),
    }
}

/// Send one request. `declared_len` overrides Content-Length (for truncated uploads).
pub fn request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    token: Option<&str>,
    headers: &[(&str, &str)],
    body: &[u8],
    declared_len: Option<usize>,
) -> Reply {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\n");
    if let Some(t) = token {
        req.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    for (k, v) in headers {
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    if declared_len.is_some() || !body.is_empty() {
        req.push_str(&format!(
            "Content-Length: {}\r\n",
            declared_len.unwrap_or(body.len())
        ));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).unwrap();
    let _ = s.write_all(body);
    if declared_len.is_some() {
        let _ = s.shutdown(Shutdown::Write);
    }
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    parse_reply(raw)
}

pub fn wait_until(timeout: Duration, mut f: impl FnMut() -> bool) -> bool {
    let end = Instant::now() + timeout;
    loop {
        if f() {
            return true;
        }
        if Instant::now() > end {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn script(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Extract `"key": "value"` from a flat JSON object.
pub fn json_field(body: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\": \"");
    let i = body.find(&pat)? + pat.len();
    let rest = &body[i..];
    Some(rest[..rest.find('"')?].to_string())
}
