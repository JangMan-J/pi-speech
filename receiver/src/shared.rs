//! One receiver shared by all of the user's `pi-speech-receiver ssh` sessions.
//!
//! The first session starts it as a process of its own (`pi-speech-receiver shared <dir>`,
//! detached from the terminal); later sessions reuse it. Each session holds a lease while
//! its `ssh` runs, and the receiver stops once no session holds one, so closing one of
//! several sessions leaves the others' audio alone.
//!
//! In `<dir>` (the directory of the token file):
//! - `receiver.lock`: locked by the shared receiver for as long as it serves;
//! - `receiver.port`: the port it listens on (127.0.0.1);
//! - `receiver.start`: locked while a session joins or leaves, or the receiver decides to
//!   stop, so these never cross;
//! - `leases/<port>`: one per session, locked by it; the name is the spare port (47614 to
//!   47633) its `ssh` forwards besides 47613. On Unix it holds the session's terminal,
//!   where pairing codes are shown.
//!
//! The locks are the operating system's file locks, which a process that dies gives up.

use crate::pair::Notice;
use crate::server::{self, Config, Server};
use crate::{private, signals, token};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::SocketAddr;
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// The ports a session forwards besides 47613, one per session.
pub const SPARE_PORTS: RangeInclusive<u16> = 47614..=47633;
const LOCK: &str = "receiver.lock";
const PORT: &str = "receiver.port";
const START: &str = "receiver.start";
const LEASES: &str = "leases";
/// How often the shared receiver looks whether any session still holds a lease.
const WATCH: Duration = Duration::from_millis(200);

/// A session's hold on the shared receiver; dropping it lets the receiver stop once no
/// other session holds one.
pub struct Lease {
    dir: PathBuf,
    path: PathBuf,
    file: Option<File>,
    /// The shared receiver's port on 127.0.0.1.
    pub port: u16,
    /// The spare port this session forwards, if one was free.
    pub spare: Option<u16>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        // Under the start lock, so no other session takes this file between its closing
        // and its removal.
        let start = open_lock(&self.dir.join(START));
        if let Ok(s) = &start {
            let _ = s.lock();
        }
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

fn open_lock(path: &Path) -> io::Result<File> {
    private::file()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

/// Whether someone else holds the lock of `f`. A failed check counts as held.
fn held(f: &File) -> bool {
    match f.try_lock() {
        Ok(()) => {
            let _ = f.unlock();
            false
        }
        Err(TryLockError::WouldBlock) => true,
        Err(TryLockError::Error(_)) => true,
    }
}

/// The terminal of this process, if it has one: where pairing codes are shown to the user.
#[cfg(unix)]
fn own_terminal() -> Option<String> {
    use std::ffi::CStr;
    [2, 0, 1].into_iter().find_map(|fd| unsafe {
        if libc::isatty(fd) != 1 {
            return None;
        }
        let p = libc::ttyname(fd);
        (!p.is_null()).then(|| CStr::from_ptr(p).to_string_lossy().into_owned())
    })
}

#[cfg(not(unix))]
fn own_terminal() -> Option<String> {
    None
}

/// Take a lease: the first spare port no live session holds, or none when all are held.
fn take_lease(leases: &Path) -> io::Result<(File, PathBuf, Option<u16>)> {
    for port in SPARE_PORTS {
        let path = leases.join(port.to_string());
        let f = open_lock(&path)?;
        if f.try_lock().is_ok() {
            return Ok((f, path, Some(port)));
        }
    }
    let path = leases.join(format!(
        "x-{}-{}",
        std::process::id(),
        token::random_hex(4)?
    ));
    let f = open_lock(&path)?;
    f.lock()?;
    Ok((f, path, None))
}

/// Join the shared receiver whose state is in `dir`, starting it with `program` when
/// none runs.
pub fn join(dir: &Path, program: &Path) -> Result<Lease, String> {
    let fail = |what: &str, e: io::Error| format!("{what}: {e}");
    let leases = dir.join(LEASES);
    private::dir()
        .recursive(true)
        .create(&leases)
        .map_err(|e| fail("cannot make the receiver's state directory", e))?;
    let start = open_lock(&dir.join(START)).map_err(|e| fail("cannot open the start lock", e))?;
    start
        .lock()
        .map_err(|e| fail("cannot take the start lock", e))?;
    let (mut file, path, spare) =
        take_lease(&leases).map_err(|e| fail("cannot take a lease on the receiver", e))?;
    let _ = file.set_len(0);
    if let Some(tty) = own_terminal() {
        let _ = writeln!(file, "{tty}");
    }
    let mut lease = Lease {
        dir: dir.to_path_buf(),
        path,
        file: Some(file),
        port: 0,
        spare,
    };
    let running = open_lock(&dir.join(LOCK))
        .map(|f| held(&f))
        .unwrap_or(false);
    let port = if running {
        fs::read_to_string(dir.join(PORT))
            .ok()
            .and_then(|s| s.trim().parse::<u16>().ok())
            .ok_or_else(|| "the shared receiver runs, but its port is not known".to_string())
    } else {
        spawn(program, dir)
    };
    drop(start);
    lease.port = port?;
    Ok(lease)
}

/// Start the shared receiver and wait for its `listening` line; its port.
fn spawn(program: &Path, dir: &Path) -> Result<u16, String> {
    let mut cmd = Command::new(program);
    cmd.arg("shared")
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    detach(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start the shared receiver: {e}"))?;
    let mut line = String::new();
    if let Some(out) = child.stdout.take() {
        let _ = BufReader::new(out).read_line(&mut line);
    }
    let port = line
        .trim()
        .strip_prefix("listening ")
        .and_then(|a| a.parse::<SocketAddr>().ok())
        .map(|a| a.port());
    match port {
        Some(p) => {
            // It goes on alone; its exit is not waited for here.
            drop(child.stderr.take());
            Ok(p)
        }
        None => {
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            let _ = child.wait();
            let err = err.trim().trim_start_matches("pi-speech-receiver: ");
            Err(format!(
                "cannot start the shared receiver{}",
                if err.is_empty() {
                    String::new()
                } else {
                    format!(": {err}")
                }
            ))
        }
    }
}

/// Out of the terminal's session, so neither Ctrl+C nor the terminal closing reaches it.
#[cfg(unix)]
fn detach(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

#[cfg(windows)]
fn detach(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};
    cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
}

/// The leases of live sessions, with what each holds (its terminal); stale ones (their
/// session has gone) are removed. The caller holds the start lock.
fn live_leases(leases: &Path) -> Vec<String> {
    let mut live = Vec::new();
    for e in fs::read_dir(leases).into_iter().flatten().flatten() {
        let path = e.path();
        let Ok(f) = OpenOptions::new().read(true).write(true).open(&path) else {
            continue;
        };
        if held(&f) {
            live.push(fs::read_to_string(&path).unwrap_or_default());
        } else {
            drop(f);
            let _ = fs::remove_file(&path);
        }
    }
    live
}

/// Pairing codes go to the terminals of the sessions that hold a lease.
fn terminals_notice(leases: PathBuf) -> Notice {
    Arc::new(move |msg: &str| {
        for f in fs::read_dir(&leases).into_iter().flatten().flatten() {
            let path = f.path();
            let live = OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .is_ok_and(|f| held(&f));
            let tty = fs::read_to_string(&path).unwrap_or_default();
            let tty = tty.trim();
            if live && tty.starts_with("/dev/") {
                write_terminal(tty, msg);
            }
        }
    })
}

#[cfg(unix)]
fn write_terminal(tty: &str, msg: &str) {
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(mut t) = OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NOCTTY | libc::O_NONBLOCK)
        .open(tty)
    {
        let _ = write!(t, "\r\npi-speech-receiver: {msg}\r\n");
    }
}

#[cfg(not(unix))]
fn write_terminal(_tty: &str, _msg: &str) {}

fn say(msg: &str) {
    let _ = writeln!(io::stderr(), "pi-speech-receiver: {msg}");
}

/// `pi-speech-receiver shared <dir>`: the shared receiver itself, started by `join`.
pub fn shared_main(args: &[String]) -> ExitCode {
    let [dir] = args else {
        say("usage: pi-speech-receiver shared <state-dir> (started by pi-speech-receiver ssh)");
        return ExitCode::from(2);
    };
    match serve_shared(Path::new(dir)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            say(&e);
            ExitCode::from(2)
        }
    }
}

fn serve_shared(dir: &Path) -> Result<(), String> {
    let lock = open_lock(&dir.join(LOCK)).map_err(|e| format!("cannot open the lock: {e}"))?;
    if lock.try_lock().is_err() {
        return Err("a shared receiver already runs".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&stop);
    signals::on_first(move |_| flag.store(true, Ordering::SeqCst))
        .map_err(|e| format!("cannot handle signals: {e}"))?;
    let token = token::load_token(None).map_err(|e| e.to_string())?;
    let tmp = server::private_tmp_dir()
        .map_err(|e| format!("cannot create the temporary directory: {e}"))?;
    let mut cfg = Config::new(SocketAddr::from(([127, 0, 0, 1], 0)), token, tmp.clone());
    if cfg!(unix) {
        cfg.notice = terminals_notice(dir.join(LEASES));
    }
    let srv = match Server::start(cfg) {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(format!("cannot start the receiver: {e}"));
        }
    };
    let port_file = dir.join(PORT);
    let tmp_port = dir.join(format!("{PORT}.{}", std::process::id()));
    let wrote = fs::write(&tmp_port, srv.local_addr().port().to_string())
        .and_then(|()| fs::rename(&tmp_port, &port_file));
    if let Err(e) = wrote {
        srv.shutdown();
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("cannot write the port file: {e}"));
    }
    let mut out = io::stdout();
    let _ = writeln!(out, "listening {}", srv.local_addr());
    let _ = out.flush();

    let watch = || -> bool {
        // Stop, under the start lock, once no session holds a lease.
        let Ok(start) = open_lock(&dir.join(START)) else {
            return false;
        };
        if start.lock().is_err() || !live_leases(&dir.join(LEASES)).is_empty() {
            return false;
        }
        let _ = fs::remove_file(&port_file);
        let _ = lock.unlock();
        true
    };
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(WATCH);
        if watch() {
            break;
        }
    }
    if stop.load(Ordering::SeqCst) {
        let _ = fs::remove_file(&port_file);
    }
    srv.shutdown();
    let _ = fs::remove_dir_all(&tmp);
    Ok(())
}
