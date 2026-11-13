use pi_speech_receiver::audio::{play, record};
use pi_speech_receiver::server::{self, Config, Server, DEFAULT_PORT};
use pi_speech_receiver::{signals, token, transcribe};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::{fs, io::Read};

const SERVE_USAGE: &str =
    "pi-speech-receiver [serve] [--listen 127.0.0.1:47613] [--token-file PATH]";

fn usage() -> String {
    format!(
        "usage: {SERVE_USAGE}\n       {}\n       {}\n       {}",
        play::USAGE,
        record::USAGE,
        transcribe::USAGE
    )
}

struct Args {
    listen: SocketAddr,
    token_file: Option<PathBuf>,
}

fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut listen = SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT));
    let mut token_file = None;
    let mut it = args.iter().cloned();
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
                println!("{}", usage());
                std::process::exit(0);
            }
            _ => return Err(format!("unknown argument {a:?}")),
        }
    }
    Ok(Args { listen, token_file })
}

fn serve(args: &[String]) -> Result<(), String> {
    let args = parse_args(args)?;
    server::check_loopback(&args.listen)?;
    let signals = signals::pipe().map_err(|e| format!("cannot handle signals: {e}"))?;
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
    let args: Vec<String> = std::env::args().skip(1).collect();
    let serve_args = match args.first().map(String::as_str) {
        Some("play") => return play::main(&args[1..]),
        Some("record") => return record::main(&args[1..]),
        Some("transcribe") => return transcribe::main(&args[1..]),
        Some("serve") => &args[1..],
        _ => &args[..],
    };
    match serve(serve_args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("pi-speech-receiver: {e}");
            ExitCode::from(2)
        }
    }
}
