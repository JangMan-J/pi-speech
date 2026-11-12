//! Running out of file descriptors: no busy loop, and service resumes. This file holds a
//! single test because it lowers the descriptor limit of the whole test process.

mod support;

use pi_speech_receiver::server::{Config, Server};
use std::fs::File;
use std::time::Duration;
use support::*;

const TOKEN: &str = "fds-token-0123456789abcdef0123456789abcdef";

fn cpu_seconds() -> f64 {
    // getrusage needs no descriptor, unlike reading /proc.
    let mut u: libc::rusage = unsafe { std::mem::zeroed() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut u) };
    let t = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1e6;
    t(u.ru_utime) + t(u.ru_stime)
}

#[test]
fn accept_failures_back_off_instead_of_spinning_and_service_resumes() {
    let lim = libc::rlimit {
        rlim_cur: 200,
        rlim_max: 200,
    };
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) }, 0);
    let dir = scratch("fds");
    let cfg = Config::new("127.0.0.1:0".parse().unwrap(), TOKEN.into(), dir.clone());
    let srv = Server::start(cfg).unwrap();
    let addr = srv.local_addr();

    let mut dummies = Vec::new();
    while let Ok(f) = File::open("/dev/null") {
        dummies.push(f);
    }
    // One descriptor for the client's connection; none left for the receiver to accept it.
    dummies.pop();
    let waiting = std::net::TcpStream::connect(addr).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let before = cpu_seconds();
    std::thread::sleep(Duration::from_secs(2));
    let spent = cpu_seconds() - before;
    assert!(spent < 0.5, "spun for {spent:.2}s of CPU in 2 s");

    drop(waiting);
    drop(dummies);
    let mut status = 0;
    wait_until(Duration::from_secs(10), || {
        status = std::panic::catch_unwind(|| {
            request(addr, "GET", "/v1/health", Some(TOKEN), &[], &[], None).status
        })
        .unwrap_or(0);
        status == 200
    });
    assert_eq!(status, 200, "no answer after descriptors were free again");
    srv.shutdown();
    std::fs::remove_dir_all(dir).ok();
}
