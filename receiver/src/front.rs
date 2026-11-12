//! The front door: accepts connections and reads request heads without a thread per
//! connection, so idle and slow clients cost a descriptor, not a thread, and never
//! delay anyone else. A connection whose head is complete is handed to `serve`.
//!
//! The whole head must arrive within `head_timeout` of the connection opening
//! (answered `408` when possible). Failing `accept` calls back off instead of spinning;
//! out of descriptors, the connection that has waited longest for its head is dropped to
//! make room.

use crate::http::{answer_nonblocking, parse_head, Head, Request, Response};
use std::io::{self, Read};
use std::net::{TcpListener, TcpStream};
use std::os::unix::io::AsRawFd;
use std::time::{Duration, Instant};

const READ_CHUNK: usize = 8 * 1024;
const BACKOFF_START: Duration = Duration::from_millis(10);
const BACKOFF_MAX: Duration = Duration::from_secs(1);
/// How often the loop looks at `stopped` when nothing else wakes it.
const TICK: Duration = Duration::from_millis(250);

/// What the front door hands over for a connection with a complete head.
pub struct Ready {
    pub stream: TcpStream,
    pub req: Request,
    /// Bytes that arrived after the head.
    pub ahead: Vec<u8>,
}

struct Pending {
    stream: TcpStream,
    buf: Vec<u8>,
    deadline: Instant,
}

fn no_descriptors(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(libc::EMFILE | libc::ENFILE))
}

fn timeout_ms(d: Duration) -> libc::c_int {
    // Round up so a deadline is never polled for twice at the same instant.
    (d.as_millis() + 1).min(libc::c_int::MAX as u128) as libc::c_int
}

/// Run until `stopped` says so. `handoff` takes over connections whose head is complete.
pub fn run(
    listener: TcpListener,
    head_timeout: Duration,
    stopped: impl Fn() -> bool,
    handoff: impl Fn(Ready),
) {
    if listener.set_nonblocking(true).is_err() {
        return;
    }
    let mut pending: Vec<Pending> = Vec::new();
    let mut backoff = BACKOFF_START;
    let mut accept_after: Option<Instant> = None;
    while !stopped() {
        let now = Instant::now();
        if accept_after.is_some_and(|t| now >= t) {
            accept_after = None;
        }
        let mut wait = TICK;
        if let Some(t) = accept_after {
            wait = wait.min(t - now);
        }
        for p in &pending {
            wait = wait.min(p.deadline.saturating_duration_since(now));
        }
        let mut fds = Vec::with_capacity(pending.len() + 1);
        fds.push(libc::pollfd {
            fd: if accept_after.is_none() {
                listener.as_raw_fd()
            } else {
                -1 // ignored by poll while backing off
            },
            events: libc::POLLIN,
            revents: 0,
        });
        fds.extend(pending.iter().map(|p| libc::pollfd {
            fd: p.stream.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        }));
        let n = unsafe {
            libc::poll(
                fds.as_mut_ptr(),
                fds.len() as libc::nfds_t,
                timeout_ms(wait),
            )
        };
        if n < 0 {
            if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                std::thread::sleep(BACKOFF_START);
            }
            continue;
        }
        if stopped() {
            break;
        }

        // Connections first: their descriptors may be what accept is missing.
        let now = Instant::now();
        let readable: Vec<bool> = fds[1..]
            .iter()
            .map(|f| f.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0)
            .collect();
        let mut keep = Vec::with_capacity(pending.len());
        for (mut p, ready) in pending.into_iter().zip(readable) {
            match step(&mut p, ready, now) {
                Step::Wait => keep.push(p),
                Step::Drop => {}
                Step::Answer(resp) => {
                    let mut s = p.stream;
                    answer_nonblocking(&mut s, &resp);
                }
                Step::Serve(req, used) => {
                    let ahead = p.buf.split_off(used);
                    handoff(Ready {
                        stream: p.stream,
                        req,
                        ahead,
                    });
                }
            }
        }
        pending = keep;

        if fds[0].revents & libc::POLLIN != 0 && accept_after.is_none() {
            // Take what is waiting, but not forever: other connections need their turn.
            for _ in 0..64 {
                match listener.accept() {
                    Ok((stream, _)) => {
                        backoff = BACKOFF_START;
                        if stream.set_nonblocking(true).is_ok() {
                            pending.push(Pending {
                                stream,
                                buf: Vec::new(),
                                deadline: Instant::now() + head_timeout,
                            });
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(e) => {
                        if no_descriptors(&e) && !pending.is_empty() {
                            // Longest waiting first: it is the likeliest to be idle.
                            pending.remove(0);
                        }
                        accept_after = Some(Instant::now() + backoff);
                        backoff = (backoff * 2).min(BACKOFF_MAX);
                        break;
                    }
                }
            }
        }
    }
}

enum Step {
    Wait,
    Drop,
    Answer(Response),
    Serve(Request, usize),
}

/// Advance one pending connection: read what is there, then decide.
fn step(p: &mut Pending, readable: bool, now: Instant) -> Step {
    if readable {
        let mut chunk = [0u8; READ_CHUNK];
        match p.stream.read(&mut chunk) {
            Ok(0) => {
                // The peer closed: an unfinished head still gets its 400, an empty one nothing.
                return if p.buf.is_empty() {
                    Step::Drop
                } else {
                    Step::Answer(Response::error(400, "malformed or oversized request head"))
                };
            }
            Ok(n) => p.buf.extend_from_slice(&chunk[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                ) => {}
            Err(_) => return Step::Drop,
        }
        match parse_head(&p.buf) {
            Head::Incomplete => {}
            Head::Bad(resp) => return Step::Answer(resp),
            Head::Complete { req, used } => return Step::Serve(req, used),
        }
    }
    if now >= p.deadline {
        return Step::Answer(Response::error(
            408,
            "the request head did not arrive in time",
        ));
    }
    Step::Wait
}
