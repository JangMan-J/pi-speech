//! `models list | download <id> | delete <id>`: the local speech models in the catalogue, and
//! the per-user model cache. Output is machine-readable: one JSON object per line.
//!
//! - `list`: one line per catalogue entry:
//!   `{"id","kind":"transcription"|"speech","name","languages":[..],"size",
//!   "downloaded":bool,"partial":bytes,"path"}` (`size` is the archive's bytes, `partial` the
//!   bytes of an interrupted download, `path` where the model is or will be). A voice that needs
//!   a shared lexicon (an English Piper voice) also has `"lexicon":{"name","size","downloaded"}`,
//!   and is `downloaded` only when the lexicon is there too.
//! - `download <id>`: `{"event":"progress","id","done","total"}` as bytes arrive, then
//!   `{"event":"verifying"}`, `{"event":"unpacking"}`; for a voice that needs a lexicon not yet
//!   in the cache, `{"event":"progress","id","file":"<lexicon name>","done","total"}` as its
//!   bytes arrive (or, while another download fetches the same lexicon, as that one's do: it
//!   waits for it, see `download::lexicon`); then `{"event":"done","path"}`; or `{"event":"error","message"}` (exit 1)
//!   or `{"event":"stopped","done","total"}` (exit 1, with `file` when stopped in the
//!   lexicon) when stopped by SIGINT, SIGTERM or the closing of standard input, which leaves the
//!   part to resume.
//!   The extension cancels a download by closing its standard input, so a download stops at
//!   once when standard input closes or is at its end (e.g. `< /dev/null`, or a script run
//!   without a terminal). From a script, keep standard input open for the whole download:
//!   `sleep 3600 | pi-speech-receiver models download <id>`.
//! - `delete <id>`: `{"event":"deleted","id","freed":bytes}`. A shared lexicon stays.

pub mod cache;
pub mod catalog;
pub mod download;

use crate::proc::{lock, start_thread};
use crate::signals;
use catalog::{Catalog, Entry, Kind, Lexicon};
use download::{Event, Failure};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const USAGE: &str = "pi-speech-receiver models list | download <id> | delete <id>";
/// What `--help` adds to [`USAGE`].
pub const HELP_NOTE: &str = "download stops at once when its standard input closes (that is how \
it is cancelled); from a script, keep standard input open for the whole download, e.g.\n  \
sleep 3600 | pi-speech-receiver models download <id>";

/// How long a stopped download may take to wind down before the process exits anyway (a
/// network read can block); the part on disk stays a valid prefix either way.
const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    List,
    Download(String),
    Delete(String),
}

pub fn parse_args(args: &[String]) -> Result<Command, String> {
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match args.as_slice() {
        ["-h" | "--help"] => Ok(Command::Help),
        ["list"] => Ok(Command::List),
        ["download", id] if usable(id) => Ok(Command::Download(id.to_string())),
        ["delete", id] if usable(id) => Ok(Command::Delete(id.to_string())),
        _ => Err(format!("usage: {USAGE}")),
    }
}

fn usable(arg: &str) -> bool {
    !arg.is_empty() && !arg.starts_with('-')
}

/// One line of output; the lock keeps lines whole and in order.
static OUT: Mutex<bool> = Mutex::new(false);

fn print_line(v: &Value) {
    let _finished = lock(&OUT);
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

/// Print the line that ends the command, once.
fn print_last(v: &Value) {
    let mut finished = lock(&OUT);
    if *finished {
        return;
    }
    *finished = true;
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// A catalogue entry, with the lexicon it needs if any, and its state in the cache `root`, as
/// `list` prints it.
pub fn list_line(entry: &Entry, lexicon: Option<&Lexicon>, root: &Path) -> Value {
    let mut v = json!({
        "id": entry.id,
        "kind": entry.kind.as_str(),
        "name": entry.name,
        "languages": entry.languages,
        "size": entry.size,
        "downloaded": cache::is_ready(root, entry, lexicon),
        "partial": cache::partial_bytes(root, entry),
        "path": path_str(&cache::model_path(root, entry)),
    });
    if let Some(l) = lexicon {
        v["lexicon"] = json!({
            "name": l.name,
            "size": l.size,
            "downloaded": cache::lexicon_path(root, l).is_file(),
        });
    }
    v
}

fn find<'c>(catalog: &'c Catalog, id: &str) -> Result<&'c Entry, String> {
    catalog.get(id).ok_or_else(|| {
        let ids: Vec<&str> = catalog.entries.iter().map(|e| e.id.as_str()).collect();
        format!("unknown model {id:?}; the models are {}", ids.join(", "))
    })
}

fn fail(id: Option<&str>, message: &str) -> ExitCode {
    eprintln!("pi-speech-receiver: {message}");
    let mut v = json!({"event": "error", "message": message});
    if let Some(id) = id {
        v["id"] = json!(id);
    }
    print_last(&v);
    ExitCode::from(1)
}

pub fn main(args: &[String]) -> ExitCode {
    let command = match parse_args(args) {
        Ok(Command::Help) => {
            println!("usage: {USAGE}\n\n{HELP_NOTE}");
            return ExitCode::SUCCESS;
        }
        Ok(c) => c,
        Err(e) => {
            eprintln!("pi-speech-receiver: {e}");
            return ExitCode::from(2);
        }
    };
    let setup = Catalog::load().and_then(|c| cache::models_dir().map(|root| (c, root)));
    let (catalog, root) = match setup {
        Ok(x) => x,
        Err(e) => return fail(None, &e),
    };
    match command {
        Command::Help => ExitCode::SUCCESS,
        Command::List => {
            for entry in &catalog.entries {
                print_line(&list_line(entry, catalog.lexicon(entry), &root));
            }
            ExitCode::SUCCESS
        }
        Command::Delete(id) => {
            let entry = match find(&catalog, &id) {
                Ok(e) => e,
                Err(e) => return fail(Some(&id), &e),
            };
            match cache::delete(&root, entry) {
                Ok(freed) => {
                    print_last(&json!({"event": "deleted", "id": id, "freed": freed}));
                    ExitCode::SUCCESS
                }
                Err(e) => fail(Some(&id), &e),
            }
        }
        Command::Download(id) => {
            let entry = match find(&catalog, &id) {
                Ok(e) => e.clone(),
                Err(e) => return fail(Some(&id), &e),
            };
            let lexicon = catalog.lexicon(&entry).cloned();
            run_download(&entry, lexicon.as_ref(), &root, catalog.allow_http)
        }
    }
}

/// Where a download is: the bytes done of the file being fetched, and that file when it is a
/// lexicon (`None`: the archive).
#[derive(Clone, Debug, Default)]
struct At {
    done: u64,
    total: u64,
    file: Option<String>,
}

/// The `stopped` line for a download that got to `at`.
fn stopped_line(id: &str, at: &At) -> Value {
    let mut v = json!({"event": "stopped", "id": id, "done": at.done, "total": at.total});
    if let Some(file) = &at.file {
        v["file"] = json!(file);
    }
    v
}

fn run_download(
    entry: &Entry,
    lexicon: Option<&Lexicon>,
    root: &Path,
    allow_http: bool,
) -> ExitCode {
    let stop = Arc::new(AtomicBool::new(false));
    let at = Arc::new(Mutex::new(At {
        total: entry.size,
        ..At::default()
    }));
    let on_stop = {
        let (stop, at, id) = (stop.clone(), at.clone(), entry.id.clone());
        Arc::new(move || {
            if stop.swap(true, Ordering::SeqCst) {
                return;
            }
            let (at, id) = (at.clone(), id.clone());
            let _ = start_thread("stop-grace", move || {
                std::thread::sleep(STOP_GRACE);
                let now = lock(&at).clone();
                print_last(&stopped_line(&id, &now));
                std::process::exit(1);
            });
        })
    };
    let on_signal = on_stop.clone();
    if let Err(e) = signals::on_first(move |_| on_signal()) {
        return fail(Some(&entry.id), &format!("cannot handle signals: {e}"));
    }
    let on_eof = on_stop.clone();
    let watch = start_thread("stdin", move || {
        let mut buf = [0u8; 256];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        on_eof();
    });
    if let Err(e) = watch {
        return fail(Some(&entry.id), &format!("cannot watch the input: {e}"));
    }
    let id = entry.id.as_str();
    let mut emit = |event: Event| {
        let line = match event {
            Event::Progress { done, total } => {
                *lock(&at) = At {
                    done,
                    total,
                    file: None,
                };
                json!({"event": "progress", "id": id, "done": done, "total": total})
            }
            Event::LexiconProgress { name, done, total } => {
                *lock(&at) = At {
                    done,
                    total,
                    file: Some(name.clone()),
                };
                json!({"event": "progress", "id": id, "file": name, "done": done, "total": total})
            }
            Event::Verifying => json!({"event": "verifying", "id": id}),
            Event::Unpacking => json!({"event": "unpacking", "id": id}),
            // Printed once the lexicon is there too.
            Event::Done { .. } => return,
        };
        print_line(&line);
    };
    let result =
        download::download(entry, root, allow_http, &stop, &mut emit).and_then(
            |path| match lexicon {
                Some(l) => download::lexicon(l, root, allow_http, &stop, &mut emit).map(|_| path),
                None => Ok(path),
            },
        );
    match result {
        Ok(path) => {
            print_last(&json!({"event": "done", "id": id, "path": path_str(&path)}));
            ExitCode::SUCCESS
        }
        Err(Failure::Stopped { done }) => {
            let mut now = lock(&at).clone();
            now.done = done;
            print_last(&stopped_line(id, &now));
            ExitCode::from(1)
        }
        Err(Failure::Failed(e)) => fail(Some(id), &e),
    }
}

/// The model directory `transcribe` was given: a path, or a catalogue id of a downloaded
/// transcription model (a path that exists wins).
pub fn resolve_model_dir(arg: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(arg);
    if path.exists() {
        return Ok(path);
    }
    let catalog = Catalog::load()?;
    let Some(entry) = catalog.get(arg) else {
        return Ok(path);
    };
    if entry.kind != Kind::Transcription {
        return Err(format!(
            "{arg} is a speech model, not a transcription model"
        ));
    }
    let root = cache::models_dir()?;
    if !cache::is_downloaded(&root, entry) {
        return Err(format!(
            "the model {arg} is not downloaded; download it with \
             `pi-speech-receiver models download {arg}`"
        ));
    }
    Ok(cache::model_path(&root, entry))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn the_arguments_name_a_subcommand_and_an_id() {
        assert_eq!(parse_args(&args("list")), Ok(Command::List));
        assert_eq!(
            parse_args(&args("download whisper-small")),
            Ok(Command::Download("whisper-small".into()))
        );
        assert_eq!(
            parse_args(&args("delete whisper-small")),
            Ok(Command::Delete("whisper-small".into()))
        );
        assert_eq!(parse_args(&args("--help")), Ok(Command::Help));
        for bad in [
            "",
            "list x",
            "download",
            "download -x",
            "delete a b",
            "fetch a",
        ] {
            assert_eq!(
                parse_args(&args(bad)),
                Err(format!("usage: {USAGE}")),
                "{bad:?}"
            );
        }
    }
}
