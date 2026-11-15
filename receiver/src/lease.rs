//! `pi-speech-receiver lease`: hold this machine's shared receiver for a Pi on another
//! machine, which runs this over SSH (its "Remote machine" connection).
//!
//! It joins the shared receiver (starting it if none runs, see `shared.rs`), prints one
//! JSON line, `{"event": "ready", "port": <its port on 127.0.0.1>, "token": "<token>",
//! "version": "<this program's version>"}`, and holds its lease until its standard input
//! ends (the SSH connection, or the Pi session, is gone) or a signal comes. The shared
//! receiver stops once no lease is held, so it lives as long as the last Pi talking to it.

use crate::{shared, signals, token};
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::mpsc;

pub const USAGE: &str = "pi-speech-receiver lease";

pub fn lease_main(args: &[String]) -> ExitCode {
    if !args.is_empty() {
        eprintln!("pi-speech-receiver: usage: {USAGE}");
        return ExitCode::from(2);
    }
    match lease() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            // As JSON on standard output too, so the Pi on the other end can say why.
            println!("{}", serde_json::json!({ "event": "error", "message": e }));
            eprintln!("pi-speech-receiver: {e}");
            ExitCode::from(1)
        }
    }
}

fn lease() -> Result<(), String> {
    let token = token::load_token(None).map_err(|e| e.to_string())?;
    let dir = token::default_token_path()
        .map_err(|e| e.to_string())?
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let program = std::env::current_exe().map_err(|e| format!("cannot find this program: {e}"))?;
    let lease = shared::join(&dir, &program)?;
    let ready = serde_json::json!({
        "event": "ready",
        "port": lease.port,
        "token": token,
        "version": env!("CARGO_PKG_VERSION"),
    });
    let mut out = io::stdout();
    writeln!(out, "{ready}")
        .and_then(|()| out.flush())
        .map_err(|e| format!("cannot answer: {e}"))?;
    // Held until the input ends or a signal comes.
    let (tx, rx) = mpsc::channel::<()>();
    let on_signal = tx.clone();
    signals::on_first(move |_| {
        let _ = on_signal.send(());
    })
    .map_err(|e| format!("cannot handle signals: {e}"))?;
    std::thread::spawn(move || {
        let mut sink = [0u8; 256];
        let mut stdin = io::stdin();
        while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
        let _ = tx.send(());
    });
    let _ = rx.recv();
    drop(lease);
    Ok(())
}
