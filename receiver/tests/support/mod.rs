#![allow(dead_code)]
//! Shared helpers: scratch directories, a raw HTTP client, WAV bytes, fake programs.

use pi_speech_receiver::token::random_hex;
use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
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

/// An executable script. (On Windows only the file: these scripts are for Unix shells.)
pub fn script(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Extract `"key": "value"` from a flat JSON object.
pub fn json_field(body: &str, key: &str) -> Option<String> {
    let pat = format!("\"{key}\": \"");
    let i = body.find(&pat)? + pat.len();
    let rest = &body[i..];
    Some(rest[..rest.find('"')?].to_string())
}

/// One chunk of a chunked body.
pub fn chunk_frame(data: &[u8]) -> Vec<u8> {
    [
        format!("{:x}\r\n", data.len()).into_bytes(),
        data.to_vec(),
        b"\r\n".to_vec(),
    ]
    .concat()
}

/// Whether process `pid` is gone (no such process, or only a zombie left).
#[cfg(target_os = "linux")]
pub fn gone(pid: u32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat
            .rsplit_once(')')
            .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')),
    }
}

/// Whether process `pid` is gone. Without /proc a zombie still counts as running, but
/// the receiver reaps its children at once, and orphans are reaped by the system.
#[cfg(all(unix, not(target_os = "linux")))]
pub fn gone(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// SIGINT; on Windows, which has none, Ctrl+Break, which the receiver takes for it.
pub const SIGINT: i32 = 2;
/// SIGTERM (Unix only).
pub const SIGTERM: i32 = 15;

/// The signals the receiver and the engine stop on, the first the one a user or the system
/// would send; on Windows, Ctrl+Break.
#[cfg(unix)]
pub const STOP_SIGNALS: [i32; 2] = [SIGTERM, SIGINT];
#[cfg(windows)]
pub const STOP_SIGNALS: [i32; 1] = [SIGINT];

/// Prepare `c` so that [`signal`] can reach the process: on Windows, a console process
/// group of its own, on a console this test process shares. Nothing to do on Unix.
pub fn signalable(c: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Console::AllocConsole;
        use windows_sys::Win32::System::Threading::CREATE_NEW_PROCESS_GROUP;
        static CONSOLE: std::sync::Once = std::sync::Once::new();
        // Control events only reach processes on the sender's console. This fails,
        // harmlessly, when the test process already has one.
        CONSOLE.call_once(|| unsafe {
            AllocConsole();
        });
        c.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
    c
}

/// Send `sig` to `child`. On Windows every signal is Ctrl+Break (the child must have
/// been started [`signalable`]), which the receiver takes for SIGINT.
pub fn signal(child: &Child, sig: i32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, sig)
    };
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
        let _ = sig;
        let ok = unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, child.id()) };
        assert!(
            ok != 0,
            "cannot send Ctrl+Break: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// The audio request of a Stream, sent piece by piece as a client would.
pub struct Upload(pub TcpStream);

impl Upload {
    /// Open `POST /v1/play/<id>/audio` with `framing` as its body header line(s).
    pub fn open_with(addr: SocketAddr, id: &str, token: Option<&str>, framing: &str) -> Upload {
        let mut s = TcpStream::connect(addr).unwrap();
        s.set_nodelay(true).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        let mut head = format!("POST /v1/play/{id}/audio HTTP/1.1\r\nHost: {addr}\r\n");
        if let Some(t) = token {
            head.push_str(&format!("Authorization: Bearer {t}\r\n"));
        }
        head.push_str(framing);
        head.push_str("\r\n");
        s.write_all(head.as_bytes()).unwrap();
        Upload(s)
    }

    pub fn chunked(addr: SocketAddr, id: &str, token: &str) -> Upload {
        Upload::open_with(addr, id, Some(token), "Transfer-Encoding: chunked\r\n")
    }

    pub fn chunk(&mut self, data: &[u8]) {
        self.0.write_all(&chunk_frame(data)).unwrap();
    }

    /// The terminating chunk, then the answer.
    pub fn end(mut self) -> Reply {
        self.0.write_all(b"0\r\n\r\n").unwrap();
        self.reply()
    }

    pub fn reply(mut self) -> Reply {
        let mut raw = Vec::new();
        let _ = self.0.read_to_end(&mut raw);
        parse_reply(raw)
    }
}
