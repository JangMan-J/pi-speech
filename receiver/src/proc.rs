//! Child programs (players and recorders): spawn, observe, and stop.
//!
//! On Unix, stopping sends SIGINT, waits up to [`STOP_GRACE`], then SIGKILL. Each child
//! leads its own process group so strays can be removed with it.
//!
//! Windows has no SIGINT for a child. A player is stopped with a hard kill: that is what
//! stopping playback means. A recorder is stopped by closing its standard input (the
//! built-in recorder finishes its WAV and exits when its input ends), then the same
//! grace, then a kill. Each child runs in a job object of its own, the counterpart of the
//! process group: a kill ends the job, so strays go with it. Each also gets a console
//! process group of its own, so the console's Ctrl+C reaches only the receiver, which
//! then stops its children itself.

use std::io::{self, Read};
#[cfg(unix)]
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

pub const STOP_GRACE: Duration = Duration::from_secs(2);
const TAIL_BYTES: usize = 2048;
const TAIL_CHARS: usize = 400;

/// Start a named thread; an error (the system cannot start one) is returned, not a panic.
pub(crate) fn start_thread<F, T>(name: &str, f: F) -> io::Result<thread::JoinHandle<T>>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
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
    /// Why the receiver stopped the child, when that stop was a failure, not a cancel.
    failure: Option<String>,
}

/// How a child is asked to stop on Windows. (On Unix every child gets SIGINT.)
#[derive(Clone, Copy, PartialEq, Eq)]
#[cfg_attr(unix, allow(dead_code))]
enum StopBy {
    /// At once, for good: players.
    Kill,
    /// By closing its standard input: recorders.
    CloseInput,
}

/// Handle on a running child.
pub struct ProcCtl {
    #[cfg(unix)]
    pid: libc::pid_t,
    #[cfg(windows)]
    os: windows::Child,
    st: Mutex<St>,
    cv: Condvar,
}

/// What happened to a child, handed to the `on_exit` callback.
pub struct Exit {
    pub status: Option<ExitStatus>,
    /// The receiver asked the child to stop (SIGINT; on Windows a kill or the end of its
    /// input) before it ended.
    pub stop_requested: bool,
    /// The child did not stop when asked within the grace, and was killed.
    pub killed: bool,
    /// Set when the stop was the receiver's own failure (see [`ProcCtl::fail`]).
    pub failure: Option<String>,
    /// The end of the child's standard error, readable text.
    pub stderr_tail: String,
}

impl Exit {
    pub fn success(&self) -> bool {
        self.status.is_some_and(|s| s.success())
    }

    pub fn describe(&self) -> String {
        match self.status {
            Some(s) => match (s.code(), signal_of(s)) {
                (Some(c), _) => format!("exited with status {c}"),
                (_, Some(sig)) => format!("killed by signal {sig}"),
                _ => "ended".to_string(),
            },
            None => "ended".to_string(),
        }
    }
}

#[cfg(unix)]
fn signal_of(s: ExitStatus) -> Option<i32> {
    s.signal()
}

#[cfg(windows)]
fn signal_of(_: ExitStatus) -> Option<i32> {
    None
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
    #[cfg(unix)]
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

    /// Whether the child has already ended. Its handle is held open, so it is never
    /// confused with another process.
    #[cfg(windows)]
    fn has_exited(&self) -> bool {
        self.os.has_exited()
    }

    /// Whether a stop was asked for or the child has ended.
    pub fn stopping(&self) -> bool {
        let s = lock(&self.st);
        s.stop_requested || s.exited
    }

    /// Stop the child and wait for it to be gone. True when it was still running.
    pub fn stop(&self) -> bool {
        self.stop_within(STOP_GRACE, None)
    }

    /// Stop the child as a failure, `reason`, unless a stop was already asked for (that
    /// earlier stop then decides). True when it was still running.
    pub fn fail(&self, reason: &str) -> bool {
        self.stop_within(STOP_GRACE, Some(reason))
    }

    fn stop_within(&self, grace: Duration, failure: Option<&str>) -> bool {
        {
            let mut s = lock(&self.st);
            if s.exited {
                return false;
            }
            if !s.stop_requested {
                s.stop_requested = true;
                s.failure = failure.map(String::from);
                #[cfg(unix)]
                unsafe {
                    libc::kill(self.pid, libc::SIGINT)
                };
                #[cfg(windows)]
                self.os.ask_to_stop();
            }
        }
        if !self.wait_exit(grace) {
            let mut s = lock(&self.st);
            // While `exited` is false the child is still unreaped, so the pid is ours.
            // It may have exited without the exit being published yet; that is not a kill.
            if !s.exited && !self.has_exited() {
                s.killed = true;
                #[cfg(unix)]
                unsafe {
                    libc::kill(-self.pid, libc::SIGKILL);
                    libc::kill(self.pid, libc::SIGKILL);
                }
                #[cfg(windows)]
                self.os.kill();
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
pub fn spawn<F>(cmd: Command, on_exit: F) -> io::Result<Arc<ProcCtl>>
where
    F: FnOnce(Exit) + Send + 'static,
{
    start(cmd, false, StopBy::Kill, on_exit).map(|(ctl, _)| ctl)
}

/// As [`spawn`], but the child's standard input is a pipe; its writing end is returned.
/// Dropping it closes the child's input.
pub fn spawn_with_input<F>(cmd: Command, on_exit: F) -> io::Result<(Arc<ProcCtl>, ChildStdin)>
where
    F: FnOnce(Exit) + Send + 'static,
{
    match start(cmd, true, StopBy::Kill, on_exit)? {
        (ctl, Some(input)) => Ok((ctl, input)),
        // Not reachable with a piped stdin; never leave the child behind regardless.
        (ctl, None) => {
            ctl.stop();
            Err(io::Error::other("the child has no input pipe"))
        }
    }
}

/// Start a recorder, as [`spawn`] does.
///
/// On Unix it is stopped like any child, with SIGINT. With `keep_input` it also gets a
/// standard input pipe, returned, that it ends on when it closes (the built-in recorder);
/// otherwise its input is closed from the start.
///
/// On Windows every recorder gets that pipe, whatever `keep_input` says: closing it is
/// the only gentle stop there is. The returned handle keeps it and closes it to stop the
/// recorder, so none is returned.
pub fn spawn_recorder<F>(
    cmd: Command,
    keep_input: bool,
    on_exit: F,
) -> io::Result<(Arc<ProcCtl>, Option<ChildStdin>)>
where
    F: FnOnce(Exit) + Send + 'static,
{
    #[cfg(unix)]
    {
        if keep_input {
            spawn_with_input(cmd, on_exit).map(|(c, input)| (c, Some(input)))
        } else {
            spawn(cmd, on_exit).map(|c| (c, None))
        }
    }
    #[cfg(windows)]
    {
        let _ = keep_input;
        start(cmd, true, StopBy::CloseInput, on_exit)
    }
}

fn start<F>(
    mut cmd: Command,
    with_input: bool,
    how: StopBy,
    on_exit: F,
) -> io::Result<(Arc<ProcCtl>, Option<ChildStdin>)>
where
    F: FnOnce(Exit) + Send + 'static,
{
    // Rust creates its pipes close-on-exec (not inheritable on Windows), so no later
    // child inherits this input.
    cmd.stdin(if with_input {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::null())
    .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    windows::prepare(&mut cmd);
    let mut child = cmd.spawn()?;
    let input = child.stdin.take();

    // Once the child exists, any failure below must stop and reap it.
    #[cfg(unix)]
    let abandon = |child: &std::process::Child| {
        let pid = child.id() as libc::pid_t;
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
    };
    // Its job, if it has one yet, ends with the handle on it.
    #[cfg(windows)]
    let abandon = windows::abandon;

    #[cfg(unix)]
    let pid = child.id() as libc::pid_t;
    #[cfg(unix)]
    let ctl = {
        let _ = how;
        Arc::new(ProcCtl {
            pid,
            st: Mutex::new(St::default()),
            cv: Condvar::new(),
        })
    };
    #[cfg(windows)]
    let (ctl, input) = match windows::Child::new(&child, how, input) {
        Ok((os, input)) => (
            Arc::new(ProcCtl {
                os,
                st: Mutex::new(St::default()),
                cv: Condvar::new(),
            }),
            input,
        ),
        Err(e) => {
            abandon(&child);
            return Err(e);
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
        #[cfg(unix)]
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
        #[cfg(unix)]
        unsafe {
            libc::kill(-pid, libc::SIGKILL)
        };
        // Wait (the handle stays open, so the process stays ours), then end what it left
        // running in its job and close its input.
        #[cfg(windows)]
        c.os.wait_and_clean_up();
        let (stop_requested, killed, failure) = {
            let mut s = lock(&c.st);
            s.exited = true;
            c.cv.notify_all();
            (s.stop_requested, s.killed, s.failure.take())
        };
        let status = lock(&theirs).take().and_then(|mut ch| ch.wait().ok());
        let _ = done_rx.recv_timeout(Duration::from_millis(300));
        let stderr_tail = tail_text(&lock(&tail));
        on_exit(Exit {
            status,
            stop_requested,
            killed,
            failure,
            stderr_tail,
        });
    });
    if let Err(e) = waiter {
        if let Some(ch) = lock(&child).take() {
            abandon(&ch);
        }
        return Err(e);
    }
    Ok((ctl, input))
}

#[cfg(windows)]
mod windows {
    use super::{lock, StopBy};
    use std::io;
    use std::os::windows::io::{AsHandle, AsRawHandle, FromRawHandle, OwnedHandle};
    use std::os::windows::process::CommandExt;
    use std::process::{ChildStdin, Command};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        TerminateProcess, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, INFINITE,
    };

    /// The exit status of a child the receiver kills.
    const KILLED: u32 = 1;

    /// A console process group of its own: the console's Ctrl+C then reaches only the
    /// receiver, which stops the child itself (as the Unix process group keeps the
    /// terminal's SIGINT away from it).
    pub(super) fn prepare(cmd: &mut Command) {
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    /// The Windows side of a running child.
    pub(super) struct Child {
        /// Held open until the handle on the child is dropped, so it can always be waited
        /// for and killed, and its id is never another process's.
        process: OwnedHandle,
        /// Its job, the counterpart of a process group: what the child starts runs in it
        /// too. Everything in it ends when the job's handle closes. `None` when the system
        /// would not make one; the child alone is then killed.
        job: Option<OwnedHandle>,
        how: StopBy,
        /// A recorder's input, closed to stop it.
        input: Mutex<Option<ChildStdin>>,
    }

    fn new_job() -> Option<OwnedHandle> {
        let h = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if h.is_null() {
            return None;
        }
        let job = unsafe { OwnedHandle::from_raw_handle(h) };
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        (ok != 0).then_some(job)
    }

    impl Child {
        /// Take charge of `child`, just started; `input` is its standard input, if piped.
        /// Returns the input the caller is to keep: none for a recorder, whose input this
        /// keeps to close it.
        pub(super) fn new(
            child: &std::process::Child,
            how: StopBy,
            input: Option<ChildStdin>,
        ) -> io::Result<(Child, Option<ChildStdin>)> {
            let process = child.as_handle().try_clone_to_owned()?;
            // What the child starts before it is in the job escapes it; the child itself
            // is still killed.
            let job = new_job().filter(|job| unsafe {
                AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) != 0
            });
            let (kept, returned) = match how {
                StopBy::CloseInput => (input, None),
                StopBy::Kill => (None, input),
            };
            let os = Child {
                process,
                job,
                how,
                input: Mutex::new(kept),
            };
            Ok((os, returned))
        }

        pub(super) fn has_exited(&self) -> bool {
            unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) == WAIT_OBJECT_0 }
        }

        /// Ask the child to stop: a player is killed, a recorder's input is closed.
        pub(super) fn ask_to_stop(&self) {
            match self.how {
                StopBy::Kill => self.kill(),
                StopBy::CloseInput => drop(lock(&self.input).take()),
            }
        }

        /// Kill the child and everything in its job.
        pub(super) fn kill(&self) {
            self.end_job();
            unsafe { TerminateProcess(self.process.as_raw_handle(), KILLED) };
        }

        fn end_job(&self) {
            if let Some(job) = &self.job {
                unsafe { TerminateJobObject(job.as_raw_handle(), KILLED) };
            }
        }

        /// Wait for the child to exit, then end what it left running and close its input.
        pub(super) fn wait_and_clean_up(&self) {
            unsafe { WaitForSingleObject(self.process.as_raw_handle(), INFINITE) };
            self.end_job();
            drop(lock(&self.input).take());
        }
    }

    /// Kill `child` and wait for it to be gone.
    pub(super) fn abandon(child: &std::process::Child) {
        let h = child.as_raw_handle();
        unsafe {
            TerminateProcess(h, KILLED);
            WaitForSingleObject(h, INFINITE);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::cell::Cell;
    #[cfg(target_os = "linux")]
    use std::path::Path;
    use std::path::PathBuf;
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

    #[cfg(target_os = "linux")]
    fn fail_thread_at(n: usize) {
        FAIL_AT.with(|f| f.set(Some(n)));
    }

    #[cfg(unix)]
    fn sh(script: &str) -> Command {
        let mut c = Command::new("sh");
        c.arg("-c").arg(script);
        c
    }

    /// `cmd /c <line>`, the line passed as it is.
    #[cfg(windows)]
    fn cmd(line: &str) -> Command {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("cmd");
        c.args(["/d", "/c"]).raw_arg(line);
        c
    }

    /// Reads its input to the end and drops it.
    #[cfg(unix)]
    fn sink() -> Command {
        sh("cat > /dev/null")
    }

    #[cfg(windows)]
    fn sink() -> Command {
        cmd("sort > NUL")
    }

    /// Writes its input to `out` (by the time the input ends).
    #[cfg(unix)]
    fn copy_input_to(out: &std::path::Path) -> Command {
        sh(&format!("cat > '{}'", out.display()))
    }

    #[cfg(windows)]
    fn copy_input_to(out: &std::path::Path) -> Command {
        cmd(&format!("sort > \"{}\"", out.display()))
    }

    /// A uniquely named copy of `sleep`, so its processes can be told apart.
    #[cfg(target_os = "linux")]
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
    #[cfg(target_os = "linux")]
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

    // Linux only: it looks for the child in /proc.
    #[test]
    #[cfg(target_os = "linux")]
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
    #[cfg(unix)]
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
        assert!(ctl.stop_within(Duration::from_millis(100), None));
        assert!(!lock(&ctl.st).killed, "the child had ended on its own");
        child.wait().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn a_child_that_ignores_sigint_is_killed_and_reported_so() {
        let (tx, rx) = channel();
        let ctl = spawn(sh("trap '' INT; while :; do sleep 0.05; done"), move |e| {
            tx.send(e).unwrap()
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300)); // let the trap be set
        assert!(ctl.stop_within(Duration::from_millis(300), None));
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(exit.killed && exit.stop_requested);
    }

    #[test]
    fn input_reaches_the_child_and_closing_it_ends_the_child() {
        use std::io::Write;
        let dir = scratch();
        let out = dir.join("out");
        let (tx, rx) = channel();
        let (ctl, mut input) =
            spawn_with_input(copy_input_to(&out), move |e| tx.send(e).unwrap()).unwrap();
        input.write_all(b"first").unwrap();
        drop(input);
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(exit.success() && !exit.stop_requested && exit.failure.is_none());
        assert!(!ctl.stop(), "already ended");
        // `sort` ends the line it writes.
        assert_eq!(std::fs::read(&out).unwrap().trim_ascii_end(), b"first");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_failure_is_reported_unless_a_stop_came_first() {
        for stop_first in [false, true] {
            let (tx, rx) = channel();
            let (ctl, _input) = spawn_with_input(sink(), move |e| tx.send(e).unwrap()).unwrap();
            if stop_first {
                assert!(ctl.stop());
            }
            assert_eq!(ctl.fail("the audio broke off"), !stop_first);
            assert!(ctl.stopping());
            let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert!(exit.stop_requested);
            let want = (!stop_first).then(|| "the audio broke off".to_string());
            assert_eq!(exit.failure, want, "stop first: {stop_first}");
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_child_that_stops_within_the_grace_is_not_killed() {
        let (tx, rx) = channel();
        let ctl = spawn(
            sh("trap 'sleep 0.2; exit 0' INT; while :; do sleep 0.05; done"),
            move |e| tx.send(e).unwrap(),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(ctl.stop_within(Duration::from_secs(3), None));
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!exit.killed && exit.stop_requested && exit.success());
    }

    /// Runs for 30 s unless killed, writing a line each second to its output.
    #[cfg(windows)]
    const LONG: &str = "ping -n 30 127.0.0.1";

    #[test]
    #[cfg(windows)]
    fn a_player_is_stopped_at_once_by_a_kill_with_what_it_started() {
        let dir = scratch();
        let out = dir.join("out");
        let (tx, rx) = channel();
        // `ping` is the child of `cmd`: it must end with it.
        let line = format!("{LONG} > \"{}\"", out.display());
        let ctl = spawn(cmd(&line), move |e| tx.send(e).unwrap()).unwrap();
        let size = || std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        let t = std::time::Instant::now();
        while size() == 0 {
            assert!(t.elapsed() < Duration::from_secs(10), "ping wrote nothing");
            std::thread::sleep(Duration::from_millis(50));
        }
        let t = std::time::Instant::now();
        assert!(ctl.stop());
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(exit.stop_requested && !exit.killed && !exit.success());
        let after = size();
        std::thread::sleep(Duration::from_millis(2500));
        assert_eq!(size(), after, "what the player started still runs");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    #[cfg(windows)]
    fn a_recorder_is_stopped_by_closing_its_input() {
        let dir = scratch();
        let out = dir.join("out");
        let (tx, rx) = channel();
        let (ctl, input) =
            spawn_recorder(copy_input_to(&out), false, move |e| tx.send(e).unwrap()).unwrap();
        assert!(input.is_none(), "the handle keeps the input");
        std::thread::sleep(Duration::from_millis(500));
        assert!(!ctl.stopping(), "it waits for its input to end");
        let t = std::time::Instant::now();
        assert!(ctl.stop_within(Duration::from_secs(3), None));
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(exit.stop_requested && !exit.killed && exit.success());
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        assert!(out.exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    #[cfg(windows)]
    fn a_recorder_that_does_not_end_with_its_input_is_killed_and_reported_so() {
        let (tx, rx) = channel();
        let (ctl, _) = spawn_recorder(cmd(&format!("{LONG} > NUL")), true, move |e| {
            tx.send(e).unwrap()
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(ctl.stop_within(Duration::from_millis(300), None));
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(exit.killed && exit.stop_requested);
    }
}
