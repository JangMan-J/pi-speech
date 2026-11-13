//! SIGINT and SIGTERM delivered on a pipe, so ordinary threads can wait for them.

use crate::proc::start_thread;
use std::fs::File;
use std::io::{self, Read};
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

/// Route SIGINT and SIGTERM into a pipe; returns its read end. Each byte read is the
/// number of a signal received.
pub fn pipe() -> io::Result<File> {
    let mut fds = [0 as libc::c_int; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
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
