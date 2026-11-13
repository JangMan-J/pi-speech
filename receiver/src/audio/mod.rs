//! The built-in audio engine: the `play` and `record` subcommands, which `serve` runs as
//! its default player, Stream player and recorder.

pub mod convert;
pub mod decode;
pub mod device;
pub mod play;
pub mod record;
pub mod ring;

use std::process::ExitCode;

/// End a subcommand: `why` as one line on standard error, and exit status `code`.
fn fail(why: &str, code: u8) -> ExitCode {
    eprintln!("pi-speech-receiver: {why}");
    ExitCode::from(code)
}
