//! Child programs (players and recorders): spawn, observe, and stop.
//!
//! Stopping sends SIGINT, waits up to [`STOP_GRACE`], then SIGKILL. Each child leads its
//! own process group so strays can be removed with it.

use std::io::{self, Read};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

pub const STOP_GRACE: Duration = Duration::from_secs(2);
const TAIL_BYTES: usize = 2048;
const TAIL_CHARS: usize = 400;

/// Start a named thread; an error (the system cannot start one) is returned, not a panic.
pub(crate) fn start_thread<F>(name: &str, f: F) -> io::Result<thread::JoinHandle<()>>
where
    F: FnOnce() + Send + 'static,
{
    #[cfg(test)]
    if tests::thread_fails() {
        return Err(io::Error::other("cannot start a thread (injected)"));
    }
    thread::Builder::new().name(name.into()).spawn(f)
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
struct St {
    exited: bool,
    stop_requested: bool,
    killed: bool,
}

/// Handle on a running child.
pub struct ProcCtl {
    pid: libc::pid_t,
    st: Mutex<St>,
    cv: Condvar,
}

/// What happened to a child, handed to the `on_exit` callback.
pub struct Exit {
    pub status: Option<ExitStatus>,
    /// The receiver asked the child to stop (SIGINT) before it ended.
    pub stop_requested: bool,
    /// The child ignored SIGINT and was killed.
    pub killed: bool,
    /// The end of the child's standard error, readable text.
    pub stderr_tail: String,
}

impl Exit {
    pub fn success(&self) -> bool {
        self.status.is_some_and(|s| s.success())
    }

    pub fn describe(&self) -> String {
        match self.status {
            Some(s) => match (s.code(), s.signal()) {
                (Some(c), _) => format!("exited with status {c}"),
                (_, Some(sig)) => format!("killed by signal {sig}"),
                _ => "ended".to_string(),
            },
            None => "ended".to_string(),
        }
    }
}

impl ProcCtl {
    /// Wait until the child has exited; false when `timeout` ran out first.
    pub fn wait_exit(&self, timeout: Duration) -> bool {
        let g = lock(&self.st);
        let (g, _) = self
            .cv
            .wait_timeout_while(g, timeout, |s| !s.exited)
            .unwrap_or_else(|e| e.into_inner());
        g.exited
    }

    /// Whether the child has already ended, without reaping it. Only valid while the
    /// child has not been reaped, so the pid cannot belong to anything else.
    fn has_exited(&self) -> bool {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let r = unsafe {
            libc::waitid(
                libc::P_PID,
                self.pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        r == 0 && unsafe { info.si_pid() } == self.pid
    }

    /// Stop the child and wait for it to be gone. True when it was still running.
    pub fn stop(&self) -> bool {
        self.stop_within(STOP_GRACE)
    }

    fn stop_within(&self, grace: Duration) -> bool {
        {
            let mut s = lock(&self.st);
            if s.exited {
                return false;
            }
            if !s.stop_requested {
                s.stop_requested = true;
                unsafe { libc::kill(self.pid, libc::SIGINT) };
            }
        }
        if !self.wait_exit(grace) {
            let mut s = lock(&self.st);
            // While `exited` is false the child is still unreaped, so the pid is ours.
            // It may have exited without the exit being published yet; that is not a kill.
            if !s.exited && !self.has_exited() {
                s.killed = true;
                unsafe {
                    libc::kill(-self.pid, libc::SIGKILL);
                    libc::kill(self.pid, libc::SIGKILL);
                }
            }
        }
        self.wait_exit(grace);
        true
    }
}

fn tail_text(raw: &[u8]) -> String {
    let s: String = String::from_utf8_lossy(raw)
        .chars()
        .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
        .collect();
    let s = s.trim();
    let n = s.chars().count();
    s.chars()
        .skip(n.saturating_sub(TAIL_CHARS))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Start `cmd` (stdin and stdout closed, stderr captured, own process group).
/// `on_exit` runs on a helper thread once the child has ended and been reaped.
pub fn spawn<F>(mut cmd: Command, on_exit: F) -> io::Result<Arc<ProcCtl>>
where
    F: FnOnce(Exit) + Send + 'static,
{
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = cmd.spawn()?;
    let pid = child.id() as libc::pid_t;
    let ctl = Arc::new(ProcCtl {
        pid,
        st: Mutex::new(St::default()),
        cv: Condvar::new(),
    });

    // Once the child exists, any failure below must stop and reap it.
    let abandon = |child: &std::process::Child| {
        let pid = child.id() as libc::pid_t;
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
    };

    let tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let (done_tx, done_rx) = mpsc::channel::<()>();
    if let Some(mut err) = child.stderr.take() {
        let tail = Arc::clone(&tail);
        let reader = start_thread("proc-stderr", move || {
            let mut buf = [0u8; 1024];
            while let Ok(n) = err.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut t = lock(&tail);
                t.extend_from_slice(&buf[..n]);
                if t.len() > TAIL_BYTES {
                    let cut = t.len() - TAIL_BYTES;
                    t.drain(..cut);
                }
            }
            let _ = done_tx.send(());
        });
        if let Err(e) = reader {
            abandon(&child);
            return Err(e);
        }
    }

    // The waiter owns the child; keep it reachable until the thread is known to run.
    let child = Arc::new(Mutex::new(Some(child)));
    let c = Arc::clone(&ctl);
    let theirs = Arc::clone(&child);
    let waiter = start_thread("proc-wait", move || {
        // Wait without reaping, so the pid stays ours until `exited` is published.
        loop {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let r = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if r == 0 || io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                break;
            }
        }
        // Remove anything the child left running in its group.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
        let (stop_requested, killed) = {
            let mut s = lock(&c.st);
            s.exited = true;
            c.cv.notify_all();
            (s.stop_requested, s.killed)
        };
        let status = lock(&theirs).take().and_then(|mut ch| ch.wait().ok());
        let _ = done_rx.recv_timeout(Duration::from_millis(300));
        let stderr_tail = tail_text(&lock(&tail));
        on_exit(Exit {
            status,
            stop_requested,
            killed,
            stderr_tail,
        });
    });
    if let Err(e) = waiter {
        if let Some(ch) = lock(&child).take() {
            abandon(&ch);
        }
        return Err(e);
    }
    Ok(ctl)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::Cell;
    use std::path::{Path, PathBuf};
    use std::sync::mpsc::channel;

    thread_local! {
        /// `Some(n)`: the n-th next `start_thread` on this thread fails (0 = the next).
        static FAIL_AT: Cell<Option<usize>> = const { Cell::new(None) };
    }

    pub(crate) fn thread_fails() -> bool {
        FAIL_AT.with(|f| match f.get() {
            Some(0) => {
                f.set(None);
                true
            }
            Some(n) => {
                f.set(Some(n - 1));
                false
            }
            None => false,
        })
    }

    fn fail_thread_at(n: usize) {
        FAIL_AT.with(|f| f.set(Some(n)));
    }

    fn sh(script: &str) -> Command {
        let mut c = Command::new("sh");
        c.arg("-c").arg(script);
        c
    }

    /// A uniquely named copy of `sleep`, so its processes can be told apart.
    fn probe(dir: &Path) -> PathBuf {
        let name = format!("pisr-{:08x}", std::process::id());
        let link = dir.join(&name[..15.min(name.len())]);
        let sleep = ["/bin/sleep", "/usr/bin/sleep"]
            .iter()
            .find(|p| Path::new(p).exists())
            .unwrap();
        std::os::unix::fs::symlink(sleep, &link).unwrap();
        link
    }

    /// Processes that are children of this one and carry `comm` (zombies included).
    fn children_named(comm: &str) -> usize {
        let me = std::process::id().to_string();
        std::fs::read_dir("/proc")
            .unwrap()
            .filter_map(|e| std::fs::read_to_string(e.ok()?.path().join("stat")).ok())
            .filter(|stat| {
                let (Some(a), Some(b)) = (stat.find('('), stat.rfind(')')) else {
                    return false;
                };
                let rest: Vec<&str> = stat[b + 1..].split_whitespace().collect();
                &stat[a + 1..b] == comm && rest.get(1) == Some(&me.as_str())
            })
            .count()
    }

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "pisr-proc-{}-{}",
            std::process::id(),
            crate::token::random_hex(4).unwrap()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_thread_that_cannot_start_leaves_no_child_behind() {
        for fail_at in [0, 1] {
            let dir = scratch();
            let link = probe(&dir);
            let comm = link.file_name().unwrap().to_string_lossy().into_owned();
            let mut cmd = Command::new(&link);
            cmd.arg("30");
            fail_thread_at(fail_at);
            let r = spawn(cmd, |_| {});
            assert!(r.is_err(), "thread {fail_at} failing must fail the spawn");
            // Reaped, not merely killed: not even a zombie remains.
            assert_eq!(children_named(&comm), 0, "fail_at {fail_at}");
            std::fs::remove_dir_all(dir).ok();
        }
    }

    #[test]
    fn an_exit_not_yet_published_is_not_a_kill() {
        let mut child = sh("exit 0").process_group(0).spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        // Wait for the exit without reaping, as the waiter does, but never publish it.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let r = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        assert_eq!(r, 0);
        let ctl = ProcCtl {
            pid,
            st: Mutex::new(St::default()),
            cv: Condvar::new(),
        };
        assert!(ctl.stop_within(Duration::from_millis(100)));
        assert!(!lock(&ctl.st).killed, "the child had ended on its own");
        child.wait().unwrap();
    }

    #[test]
    fn a_child_that_ignores_sigint_is_killed_and_reported_so() {
        let (tx, rx) = channel();
        let ctl = spawn(sh("trap '' INT; while :; do sleep 0.05; done"), move |e| {
            tx.send(e).unwrap()
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300)); // let the trap be set
        assert!(ctl.stop_within(Duration::from_millis(300)));
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(exit.killed && exit.stop_requested);
    }

    #[test]
    fn a_child_that_stops_within_the_grace_is_not_killed() {
        let (tx, rx) = channel();
        let ctl = spawn(
            sh("trap 'sleep 0.2; exit 0' INT; while :; do sleep 0.05; done"),
            move |e| tx.send(e).unwrap(),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(ctl.stop_within(Duration::from_secs(3)));
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!exit.killed && exit.stop_requested && exit.success());
    }
}
