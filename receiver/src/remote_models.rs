//! Local models run here for a Pi on the other end of the bridge (protocol/bridge.md,
//! "Running local models"): `GET /v1/models`, `GET /v1/voices`, `POST /v1/transcribe` and
//! `POST /v1/speak`. Each runs this program's own `models list`, `speak` or `transcribe`
//! (or the program named by `PI_SPEECH_RECEIVER_MODELS`) as a child, as the extension does
//! on its own machine. One transcription or speech runs at a time; the others wait their
//! turn in a bounded queue, which a client that goes away leaves.

use crate::http::{json_str, BodyFault, Conn, Framing, Request, Response};
use crate::private;
use crate::proc::lock;
use crate::token::random_hex;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

/// Names a program run instead of this one for model runs (tests use a stand-in).
pub const MODELS_ENV: &str = "PI_SPEECH_RECEIVER_MODELS";
/// The largest body of `POST /v1/speak`.
pub const MAX_SPEAK_REQUEST: u64 = 1024 * 1024;
const POLL: Duration = Duration::from_millis(20);
/// How many model runs may wait for the one running.
pub const MAX_WAITING: usize = 8;
/// How often a waiting run looks whether its client is still there.
const QUEUE_POLL: Duration = Duration::from_millis(100);
const FULL: &str = "too many model runs are waiting on this machine; try again when they are done";

/// The one model job (a transcription or a speech) that may run, its child, and the jobs
/// waiting for it in turn.
#[derive(Default)]
pub struct Jobs {
    queue: Mutex<Queue>,
    turn: Condvar,
    child: Mutex<Option<Arc<Mutex<Child>>>>,
}

#[derive(Default)]
struct Queue {
    busy: bool,
    waiting: VecDeque<u64>,
    next: u64,
}

/// Why a job did not get its turn.
pub enum Refused {
    /// The queue is full.
    Full,
    /// The client went away while it waited.
    Gone,
    /// The receiver shuts down.
    Down,
}

impl Refused {
    fn answer(self) -> Response {
        match self {
            Refused::Full => Response::error(409, FULL),
            Refused::Gone => Response::error(400, "the client left while its model run waited"),
            Refused::Down => Response::error(503, "the receiver is shutting down"),
        }
    }
}

/// The running job; dropping it kills its child if it still runs and frees the slot.
pub struct Job<'a> {
    jobs: &'a Jobs,
}

impl Jobs {
    /// Wait for this job's turn, first come first served. `gone` tells whether the client
    /// has left; it is asked every 100 ms while the job waits.
    pub fn claim(&self, gone: impl Fn() -> bool, down: &AtomicBool) -> Result<Job<'_>, Refused> {
        let mut q = lock(&self.queue);
        if !q.busy && q.waiting.is_empty() {
            q.busy = true;
            return Ok(Job { jobs: self });
        }
        if q.waiting.len() >= MAX_WAITING {
            return Err(Refused::Full);
        }
        let me = q.next;
        q.next += 1;
        q.waiting.push_back(me);
        loop {
            if !q.busy && q.waiting.front() == Some(&me) {
                q.waiting.pop_front();
                q.busy = true;
                return Ok(Job { jobs: self });
            }
            let why = if down.load(Ordering::SeqCst) {
                Some(Refused::Down)
            } else {
                drop(q);
                let left = gone();
                q = lock(&self.queue);
                left.then_some(Refused::Gone)
            };
            if let Some(why) = why {
                q.waiting.retain(|&t| t != me);
                self.turn.notify_all();
                return Err(why);
            }
            q = self
                .turn
                .wait_timeout(q, QUEUE_POLL)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// Kill the running job's child (at shutdown).
    pub fn stop(&self) {
        if let Some(c) = lock(&self.child).as_ref() {
            let _ = lock(c).kill();
        }
    }
}

impl Job<'_> {
    fn spawn(&self, mut cmd: Command) -> io::Result<Arc<Mutex<Child>>> {
        let child = Arc::new(Mutex::new(cmd.spawn()?));
        *lock(&self.jobs.child) = Some(Arc::clone(&child));
        Ok(child)
    }
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        if let Some(c) = lock(&self.jobs.child).take() {
            let mut c = lock(&c);
            let _ = c.kill();
            let _ = c.wait();
        }
        lock(&self.jobs.queue).busy = false;
        self.jobs.turn.notify_all();
    }
}

/// What a model endpoint needs from the server.
pub struct Ctx<'a> {
    /// The program run as `<program> models list`, `speak ...`, `transcribe ...`.
    pub program: &'a Path,
    pub tmp_dir: &'a Path,
    pub max_body: u64,
    pub idle: Duration,
    pub jobs: &'a Jobs,
    /// Set when the receiver shuts down: a running child is then killed.
    pub down: &'a AtomicBool,
}

/// The value of `name` in a query string, percent-decoded.
pub fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    query?.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (k == name).then(|| percent_decode(v))
    })
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = |c: u8| (c as char).to_digit(16);
        match b[i] {
            b'%' if i + 2 < b.len() => match (hex(b[i + 1]), hex(b[i + 2])) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                _ => out.push(b'%'),
            },
            b'+' => out.push(b' '),
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A catalogue id or a voice: letters, digits, `.`, `_`, `-`, not starting with `-` or `.`
/// (so never an option or a path).
fn plain(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && !v.starts_with(['-', '.'])
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

fn model_id(v: Option<&str>) -> Result<String, Response> {
    match v {
        Some(id) if plain(id) => Ok(id.to_string()),
        _ => Err(Response::error(
            400,
            "model must be a model id of `pi-speech-receiver models list`",
        )),
    }
}

/// Why a model run failed: its last `{"event":"error"}` message, else its last line of
/// error output, else `fallback`.
fn why(stderr: &str, fallback: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let event = lines.iter().rev().find_map(|l| {
        let v: Value = serde_json::from_str(l).ok()?;
        (v["event"] == "error").then(|| v["message"].as_str().map(String::from))?
    });
    event
        .or_else(|| {
            lines
                .last()
                .map(|l| l.trim_start_matches("pi-speech-receiver: ").to_string())
        })
        .unwrap_or_else(|| fallback.to_string())
}

fn command(program: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}

fn cannot_run(program: &Path, e: &io::Error) -> Response {
    Response::error(
        503,
        &format!("cannot run the models program {}: {e}", program.display()),
    )
}

/// The JSON objects of a program's output, one per line.
fn objects(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(Value::is_object)
        .collect()
}

/// `GET /v1/models`: the catalogue with each model's state in this machine's model cache.
pub fn list(program: &Path) -> Response {
    let out = match command(program, &["models", "list"]).output() {
        Ok(o) => o,
        Err(e) => return cannot_run(program, &e),
    };
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        return Response::error(503, &why(&stderr, "models list failed"));
    }
    let models: Vec<Value> = objects(&out.stdout)
        .into_iter()
        .filter(|v| v.get("id").is_some())
        .collect();
    Response::json(200, json!({ "models": models }).to_string())
}

/// `GET /v1/voices?model=<id>`: the voices of a downloaded speech model.
pub fn voices(program: &Path, req: &Request) -> Response {
    let model = match model_id(query_param(req.query.as_deref(), "model").as_deref()) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let out = match command(program, &["speak", &model, "--list-voices"]).output() {
        Ok(o) => o,
        Err(e) => return cannot_run(program, &e),
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Response::error(422, &why(&stderr, "the voices could not be listed"));
    }
    let voices: Vec<Value> = objects(&out.stdout)
        .into_iter()
        .filter(|v| v["name"].is_string() && v["number"].is_number())
        .collect();
    Response::json(200, json!({ "voices": voices }).to_string())
}

/// Wait for `child` to exit, killing it when the receiver shuts down.
fn wait(child: &Mutex<Child>, down: &AtomicBool) -> io::Result<ExitStatus> {
    loop {
        {
            let mut c = lock(child);
            if let Some(s) = c.try_wait()? {
                return Ok(s);
            }
            if down.load(Ordering::SeqCst) {
                let _ = c.kill();
            }
        }
        thread::sleep(POLL);
    }
}

/// Read a pipe to its end on a thread of its own.
fn drain(pipe: Option<impl Read + Send + 'static>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    })
}

fn audio_ext(req: &Request) -> Option<&'static str> {
    let ty = req.header("content-type")?;
    let ty = ty.split(';').next()?.trim().to_ascii_lowercase();
    match ty.as_str() {
        "audio/wav" | "audio/x-wav" | "audio/wave" | "audio/vnd.wave" => Some("wav"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        _ => None,
    }
}

/// `POST /v1/transcribe?model=<id>`: the body is a WAV or MP3 file; the answer its text.
pub fn transcribe(ctx: &Ctx, conn: &mut Conn, req: &Request) -> Response {
    let model = match model_id(query_param(req.query.as_deref(), "model").as_deref()) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let Some(ext) = audio_ext(req) else {
        return Response::error(415, "the audio must be WAV (audio/wav) or MP3 (audio/mpeg)");
    };
    let framing = match Framing::of(req) {
        Ok(f) => f,
        Err(e) => return Response::error(400, e),
    };
    let too_large = format!(
        "the audio is larger than the limit of {} bytes",
        ctx.max_body
    );
    if matches!(framing, Framing::Length(n) if n > ctx.max_body) {
        return Response::error(413, &too_large);
    }
    let name = match random_hex(8) {
        Ok(h) => format!("transcribe-{h}.{ext}"),
        Err(e) => return Response::error(503, &format!("no random source: {e}")),
    };
    let path = ctx.tmp_dir.join(name);
    let r = transcribe_file(ctx, conn, req, framing, &model, &path, &too_large);
    let _ = fs::remove_file(&path);
    r
}

#[allow(clippy::too_many_arguments)]
fn transcribe_file(
    ctx: &Ctx,
    conn: &mut Conn,
    req: &Request,
    framing: Framing,
    model: &str,
    path: &PathBuf,
    too_large: &str,
) -> Response {
    let mut file = match private::file().write(true).create_new(true).open(path) {
        Ok(f) => f,
        Err(e) => return Response::error(503, &format!("cannot keep the audio: {e}")),
    };
    conn.send_continue(req);
    let mut wrote = Ok(());
    let read = conn.read_pieces(framing, ctx.max_body, ctx.idle, |p| {
        if wrote.is_ok() {
            wrote = file.write_all(p);
        }
    });
    match read {
        Ok(_) => {}
        Err(BodyFault::TooLarge) => return Response::error(413, too_large),
        Err(f) => return Response::error(400, &format!("the audio broke off: {}", f.describe())),
    }
    if let Err(e) = wrote.and_then(|_| file.flush()) {
        return Response::error(503, &format!("cannot keep the audio: {e}"));
    }
    drop(file);
    // The audio is here; now wait for the turn to run the model.
    let job = match ctx.jobs.claim(|| conn.peer_gone(), ctx.down) {
        Ok(j) => j,
        Err(why) => return why.answer(),
    };
    let path_arg = path.to_string_lossy();
    let child = match job.spawn(command(ctx.program, &["transcribe", model, &path_arg])) {
        Ok(c) => c,
        Err(e) => return cannot_run(ctx.program, &e),
    };
    let (out, err) = {
        let mut c = lock(&child);
        (drain(c.stdout.take()), drain(c.stderr.take()))
    };
    let status = wait(&child, ctx.down);
    let (stdout, stderr) = (
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
    );
    match status {
        Ok(s) if s.success() => {
            let text = String::from_utf8_lossy(&stdout).trim().to_string();
            Response::json(200, format!("{{\"text\": {}}}", json_str(&text)))
        }
        _ if ctx.down.load(Ordering::SeqCst) => {
            Response::error(503, "the receiver is shutting down")
        }
        _ => Response::error(
            422,
            &why(
                &String::from_utf8_lossy(&stderr),
                "the transcription failed",
            ),
        ),
    }
}

enum Event {
    Format(u64, u64),
    Error(String),
    Done,
    /// The program's error output ended; its last line that was not an event.
    Closed(String),
}

/// `POST /v1/speak` with `{"model", "text", "voice"?, "speed"?}`: the speech as raw 16-bit
/// mono PCM in a chunked body as it is generated, its rate in `X-Pi-Speech-Rate`.
pub fn speak(ctx: &Ctx, conn: &mut Conn, req: &Request) -> Response {
    let framing = match Framing::of(req) {
        Ok(f) => f,
        Err(e) => return Response::error(400, e),
    };
    conn.send_continue(req);
    let mut body = Vec::new();
    match conn.read_pieces(framing, MAX_SPEAK_REQUEST, ctx.idle, |p| {
        body.extend_from_slice(p)
    }) {
        Ok(_) => {}
        Err(BodyFault::TooLarge) => {
            return Response::error(
                413,
                &format!("the request is larger than the limit of {MAX_SPEAK_REQUEST} bytes"),
            )
        }
        Err(f) => return Response::error(400, &format!("the request broke off: {}", f.describe())),
    }
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v @ Value::Object(_)) => v,
        _ => return Response::error(400, "the body must be a JSON object"),
    };
    let model = match model_id(v["model"].as_str()) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let Some(text) = v["text"].as_str() else {
        return Response::error(400, "text must be a string");
    };
    let mut args = vec!["speak".to_string(), model];
    match &v["voice"] {
        Value::Null => {}
        Value::String(s) if s.is_empty() => {}
        Value::String(s) if plain(s) => args.extend(["--voice".into(), s.clone()]),
        _ => return Response::error(400, "voice must be a voice name or number"),
    }
    match &v["speed"] {
        Value::Null => {}
        Value::Number(n) if n.as_f64().is_some_and(|s| (0.25..=4.0).contains(&s)) => {
            args.extend(["--speed".into(), n.to_string()])
        }
        _ => return Response::error(400, "speed must be a number from 0.25 to 4"),
    }
    let job = match ctx.jobs.claim(|| conn.peer_gone(), ctx.down) {
        Ok(j) => j,
        Err(why) => return why.answer(),
    };
    let mut cmd = Command::new(ctx.program);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let child = match job.spawn(cmd) {
        Ok(c) => c,
        Err(e) => return cannot_run(ctx.program, &e),
    };
    let (stdin, stdout, stderr) = {
        let mut c = lock(&child);
        (c.stdin.take(), c.stdout.take(), c.stderr.take())
    };
    let text = text.to_string();
    thread::spawn(move || {
        if let Some(mut w) = stdin {
            let _ = w.write_all(text.as_bytes());
        }
    });
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut noise = String::new();
        if let Some(e) = stderr {
            for line in BufReader::new(e).lines().map_while(Result::ok) {
                let line = line.trim().to_string();
                let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                let event = match v["event"].as_str() {
                    Some("format") => Event::Format(
                        v["rate"].as_u64().unwrap_or(0),
                        v["channels"].as_u64().unwrap_or(1),
                    ),
                    Some("error") => {
                        Event::Error(v["message"].as_str().unwrap_or("speak failed").into())
                    }
                    Some("done") => Event::Done,
                    Some(_) => continue,
                    None => {
                        if !line.is_empty() {
                            noise = line.trim_start_matches("pi-speech-receiver: ").into();
                        }
                        continue;
                    }
                };
                if tx.send(event).is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(Event::Closed(noise));
    });
    // Nothing is answered before the model has loaded: a failure until then is an error
    // with the model's own words.
    let (rate, channels) = loop {
        match rx.recv() {
            Ok(Event::Format(r, c)) if r > 0 => break (r, c),
            Ok(Event::Format(..) | Event::Done) => {}
            Ok(Event::Error(m)) => return Response::error(422, &m),
            Ok(Event::Closed(n)) => {
                let m = if n.is_empty() {
                    "speak failed".into()
                } else {
                    n
                };
                return Response::error(422, &m);
            }
            Err(_) => return Response::error(422, "speak failed"),
        }
    };
    let headers = [
        ("X-Pi-Speech-Format", "pcm".to_string()),
        ("X-Pi-Speech-Rate", rate.to_string()),
        ("X-Pi-Speech-Channels", channels.to_string()),
    ];
    if conn
        .begin_chunked("application/octet-stream", &headers)
        .is_err()
    {
        return Response::sent();
    }
    let mut buf = vec![0u8; 16 * 1024];
    if let Some(mut out) = stdout {
        loop {
            match out.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    // A client that has gone (or a shutdown) ends the speech at once.
                    if ctx.down.load(Ordering::SeqCst) || conn.write_chunk(&buf[..n]).is_err() {
                        conn.break_off();
                        return Response::sent();
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    }
    let status = wait(&child, ctx.down);
    let mut done = false;
    while let Ok(e) = rx.recv_timeout(Duration::from_secs(5)) {
        match e {
            Event::Done => done = true,
            Event::Error(_) => done = false,
            Event::Closed(_) => break,
            Event::Format(..) => {}
        }
    }
    if done && status.is_ok_and(|s| s.success()) {
        let _ = conn.end_chunked();
    } else {
        conn.break_off();
    }
    Response::sent()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_values_are_decoded_and_ids_never_name_an_option_or_a_path() {
        assert_eq!(
            query_param(Some("a=1&model=kokoro%2Dv1&x"), "model").as_deref(),
            Some("kokoro-v1")
        );
        assert_eq!(
            query_param(Some("model=a+b%"), "model").as_deref(),
            Some("a b%")
        );
        assert!(plain("piper-en_US-lessac-medium"));
        for bad in ["", "--list-voices", "../x", "/etc", "a b", ".hidden"] {
            assert!(!plain(bad), "{bad}");
        }
    }

    #[test]
    fn a_failure_is_told_in_the_model_s_own_words() {
        let err = "warning\n{\"event\":\"error\",\"message\":\"unknown voice\"}\n";
        assert_eq!(why(err, "x"), "unknown voice");
        assert_eq!(
            why("pi-speech-receiver: kokoro is not downloaded\n", "x"),
            "kokoro is not downloaded"
        );
        assert_eq!(why("", "x"), "x");
    }
}
