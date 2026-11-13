//! SIGINT and SIGTERM delivered on a pipe, so ordinary threads can wait for them.
//!
//! On Windows, which has no such signals, the console's control events take their place:
//! Ctrl+C and Ctrl+Break arrive as SIGINT (2), and closing the console, logging off or
//! shutting down as SIGTERM (15).

use crate::proc::start_thread;
use std::io::{self, Read};

#[cfg(unix)]
pub use unix::pipe;
#[cfg(windows)]
pub use windows::pipe;

#[cfg(unix)]
mod unix {
    use std::fs::File;
    use std::io;
    use std::os::unix::io::FromRawFd;
    use std::sync::atomic::{AtomicI32, Ordering};

    static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn on_signal(sig: libc::c_int) {
        let b = sig as u8;
        unsafe {
            libc::write(
                SIGNAL_PIPE.load(Ordering::Relaxed),
                (&raw const b).cast(),
                1,
            );
        }
    }

    /// A pipe whose ends are closed on exec.
    #[cfg(not(target_vendor = "apple"))]
    fn cloexec_pipe(fds: &mut [libc::c_int; 2]) -> io::Result<()> {
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// A pipe whose ends are closed on exec. Apple has no `pipe2`; this runs before any
    /// child is started, so nothing can inherit the ends between the two calls.
    #[cfg(target_vendor = "apple")]
    fn cloexec_pipe(fds: &mut [libc::c_int; 2]) -> io::Result<()> {
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        for fd in *fds {
            if unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
                let e = io::Error::last_os_error();
                unsafe {
                    libc::close(fds[0]);
                    libc::close(fds[1]);
                }
                return Err(e);
            }
        }
        Ok(())
    }

    /// Route SIGINT and SIGTERM into a pipe; returns its read end. Each byte read is the
    /// number of a signal received.
    pub fn pipe() -> io::Result<File> {
        let mut fds = [0 as libc::c_int; 2];
        cloexec_pipe(&mut fds)?;
        SIGNAL_PIPE.store(fds[1], Ordering::SeqCst);
        for sig in [libc::SIGINT, libc::SIGTERM] {
            let mut sa: libc::sigaction = unsafe { std::mem::zeroed() };
            sa.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as usize;
            sa.sa_flags = libc::SA_RESTART;
            unsafe {
                libc::sigemptyset(&mut sa.sa_mask);
                if libc::sigaction(sig, &sa, std::ptr::null_mut()) != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
        }
        Ok(unsafe { File::from_raw_fd(fds[0]) })
    }
}

#[cfg(windows)]
mod windows {
    use crate::proc::lock;
    use std::io::{self, PipeReader, PipeWriter, Write};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{FALSE, TRUE};
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT,
        CTRL_SHUTDOWN_EVENT,
    };

    const SIGINT: u8 = 2;
    const SIGTERM: u8 = 15;

    /// Where control events are written; the latest [`pipe`] replaces the one before, as
    /// on Unix.
    static SIGNAL_PIPE: Mutex<Option<PipeWriter>> = Mutex::new(None);
    /// Whether installing the handler (done once) worked: else the system's error code.
    static HANDLER: OnceLock<Result<(), i32>> = OnceLock::new();

    /// Runs on a thread the system starts for each event, so it may lock and write.
    unsafe extern "system" fn on_event(event: u32) -> BOOL {
        let sig = match event {
            CTRL_C_EVENT | CTRL_BREAK_EVENT => SIGINT,
            CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT => SIGTERM,
            _ => return FALSE,
        };
        if let Some(w) = lock(&SIGNAL_PIPE).as_mut() {
            let _ = w.write_all(&[sig]);
        }
        if sig == SIGTERM {
            // The system ends the process as soon as this returns (and at the latest some
            // seconds later): wait here, so the main thread can stop the children, delete
            // the files and exit first.
            std::thread::sleep(Duration::from_secs(30));
        }
        TRUE
    }

    /// Route the console's control events into a pipe; returns its read end. Each byte
    /// read is the number of the signal the event stands for (2 or 15). The handler is
    /// installed by the first call; when that failed, every call returns its error.
    pub fn pipe() -> io::Result<PipeReader> {
        let (r, w) = io::pipe()?;
        *lock(&SIGNAL_PIPE) = Some(w);
        let installed = *HANDLER.get_or_init(|| {
            if unsafe { SetConsoleCtrlHandler(Some(on_event), TRUE) } == 0 {
                Err(io::Error::last_os_error().raw_os_error().unwrap_or(0))
            } else {
                Ok(())
            }
        });
        installed.map(|()| r).map_err(io::Error::from_raw_os_error)
    }
}

/// Handle SIGINT and SIGTERM from now on: the first one calls `f` with its number, on a
/// thread of its own.
pub fn on_first(f: impl FnOnce(i32) + Send + 'static) -> io::Result<()> {
    let mut signals = pipe()?;
    start_thread("signals", move || {
        let mut b = [0u8; 1];
        loop {
            match signals.read(&mut b) {
                Ok(1) => return f(b[0] as i32),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                _ => return,
            }
        }
    })?;
    Ok(())
}
