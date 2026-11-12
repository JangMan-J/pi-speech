use pi_speech_receiver::server::{self, Config, Server, DEFAULT_PORT};
use pi_speech_receiver::token;
use std::net::SocketAddr;
use std::os::unix::io::FromRawFd;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::atomic::{AtomicI32, Ordering};
use std::{fs, io::Read};

const USAGE: &str = "usage: pi-speech-receiver [--listen 127.0.0.1:47613] [--token-file PATH]";

static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(_: libc::c_int) {
    let b = 1u8;
    unsafe {
        libc::write(
            SIGNAL_PIPE.load(Ordering::Relaxed),
            (&raw const b).cast(),
            1,
        );
    }
}

/// Route SIGINT and SIGTERM into a pipe; returns its read end.
fn signal_pipe() -> std::io::Result<fs::File> {
    let mut fds = [0 as libc::c_int; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    SIGNAL_PIPE.store(fds[1], Ordering::SeqCst);
    for sig in [libc::SIGINT, libc::SIGTERM] {
        let mut sa: libc::sigaction = unsafe { std::mem::zeroed() };
        sa.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as usize;
        sa.sa_flags = libc::SA_RESTART;
        unsafe {
            libc::sigemptyset(&mut sa.sa_mask);
            if libc::sigaction(sig, &sa, std::ptr::null_mut()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
    }
    Ok(unsafe { fs::File::from_raw_fd(fds[0]) })
}

struct Args {
    listen: SocketAddr,
    token_file: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut listen = SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT));
    let mut token_file = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(v.to_string())),
            _ => (a.clone(), None),
        };
        let mut value = |what: &str| {
            inline
                .clone()
                .or_else(|| it.next())
                .ok_or_else(|| format!("{what} needs a value"))
        };
        match name.as_str() {
            "--listen" => {
                let v = value("--listen")?;
                listen = v.parse().map_err(|_| {
                    format!("--listen must be an address like 127.0.0.1:47613, got {v:?}")
                })?;
            }
            "--token-file" => token_file = Some(PathBuf::from(value("--token-file")?)),
            "-h" | "--help" => {
                println!("{USAGE}");
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument {a:?}")),
        }
    }
    Ok(Args { listen, token_file })
}

fn run() -> Result<(), String> {
    let args = parse_args()?;
    server::check_loopback(&args.listen)?;
    let signals = signal_pipe().map_err(|e| format!("cannot handle signals: {e}"))?;
    let token = token::load_token(args.token_file.as_deref()).map_err(|e| e.to_string())?;
    let tmp = server::private_tmp_dir()
        .map_err(|e| format!("cannot create the temporary directory: {e}"))?;
    let srv = match Server::start(Config::new(args.listen, token, tmp.clone())) {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(format!("cannot listen on {}: {e}", args.listen));
        }
    };
    println!("listening {}", srv.local_addr());

    let mut byte = [0u8; 1];
    let mut signals = signals;
    let _ = signals.read(&mut byte);
    srv.shutdown();
    let _ = fs::remove_dir_all(&tmp);
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("pi-speech-receiver: {e}");
            ExitCode::from(2)
        }
    }
}
