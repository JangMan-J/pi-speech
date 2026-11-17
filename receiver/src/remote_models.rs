//! Local models run here for a Pi on the other end of the bridge (protocol/bridge.md,
//! "Running local models"): `GET /v1/models`, `GET /v1/voices`, `POST /v1/transcribe`,
//! `POST /v1/speak`, and `POST /v1/models/download` and `/delete` to manage them.
//!
//! All HTTP handlers talk to a narrow [`ModelHost`] port:
//! - [`InProcessHost`] (default): runs catalog, cache, download, and warm in-process
//!   [`WarmRecognizer`] / [`WarmSynthesizer`] workers directly without spawning child processes.
//! - [`SubprocessHost`] (when `PI_SPEECH_RECEIVER_MODELS` is set): delegates to an external
//!   program (`models list`, `speak`, `transcribe`, ...).

use crate::engines::synthesize::{self, pcm16, voice_number};
use crate::http::{json_str, BodyFault, Conn, Framing, Request, Response};
use crate::models;
use crate::models::download::Failure;
use crate::private;
use crate::proc::{lock, start_thread};
use crate::speak::{self, WarmSynthesizer};
use crate::token::random_hex;
use crate::transcribe::{self, WarmRecognizer};
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

/// Names a program run instead of the built-in in-process host (tests use a stand-in).
pub const MODELS_ENV: &str = "PI_SPEECH_RECEIVER_MODELS";
/// The largest body of `POST /v1/speak`.
pub const MAX_SPEAK_REQUEST: u64 = 1024 * 1024;
const POLL: Duration = Duration::from_millis(20);
/// How many model runs may wait for the one running.
pub const MAX_WAITING: usize = 8;
/// How often a waiting run looks whether its client is still there.
const QUEUE_POLL: Duration = Duration::from_millis(100);
const FULL: &str = "too many model runs are waiting on this machine; try again when they are done";

// ── ModelHost port ──────────────────────────────────────────────────────────

#[derive(Debug)]
pub enum HostError {
    /// The host itself could not run (e.g. missing subprocess binary).
    Unavailable(String),
    /// The model operation failed (not downloaded, bad voice, bad audio, etc.).
    Failed(String),
    /// Cancelled because the receiver is shutting down.
    Down,
}

impl HostError {
    fn into_response(self, failed_status: u16) -> Response {
        match self {
            HostError::Unavailable(m) => Response::error(503, &m),
            HostError::Failed(m) => Response::error(failed_status, &m),
            HostError::Down => Response::error(503, "the receiver is shutting down"),
        }
    }
}

pub struct SpeakRequest<'a> {
    pub model: &'a str,
    pub text: &'a str,
    pub voice: Option<&'a str>,
    pub speed: f32,
    pub lang: Option<&'a str>,
}

pub enum SpeakEvent<'a> {
    Format(u32, u32),
    Pcm(&'a [u8]),
}

/// Narrow port behind the `/v1/models*`, `/v1/voices`, `/v1/transcribe`, and `/v1/speak` endpoints.
pub trait ModelHost: Send + Sync + std::panic::RefUnwindSafe {
    fn list(&self) -> Result<Vec<Value>, HostError>;
    fn voices(&self, model: &str) -> Result<Vec<Value>, HostError>;
    fn transcribe(
        &self,
        model: &str,
        audio_path: &Path,
        language: Option<&str>,
        cancel: &AtomicBool,
    ) -> Result<String, HostError>;
    fn speak(
        &self,
        req: SpeakRequest<'_>,
        cancel: &AtomicBool,
        on_event: &mut dyn FnMut(SpeakEvent<'_>) -> bool,
    ) -> Result<(), HostError>;
    /// Stream download events via `on_event`; returns `Ok(true)` when a terminal event
    /// (`done`, `stopped`, `error`) was already emitted, or `Ok(false)` if stopped early.
    fn download(
        &self,
        model: &str,
        cancel: &AtomicBool,
        on_event: &mut dyn FnMut(Value),
    ) -> Result<bool, HostError>;
    fn delete(&self, model: &str) -> Result<u64, HostError>;
    fn stop(&self) {}
}

// ── In-process warm adapter ─────────────────────────────────────────────────

enum WarmJob {
    Transcribe {
        model: String,
        audio_path: PathBuf,
        language: Option<String>,
        cancel: Arc<AtomicBool>,
        reply: mpsc::Sender<Result<String, HostError>>,
    },
    Speak {
        model: String,
        text: String,
        voice: Option<String>,
        speed: f32,
        lang: Option<String>,
        cancel: Arc<AtomicBool>,
        tx: mpsc::Sender<SpeakMsg>,
    },
}

enum SpeakMsg {
    Format(u32, u32),
    Pcm(Vec<u8>),
    Done(Result<(), HostError>),
}

/// Production [`ModelHost`] adapter: runs catalog/cache operations directly and keeps the last
/// loaded STT recognizer and TTS synthesizer warm on a dedicated worker thread across HTTP calls.
#[derive(Default)]
pub struct InProcessHost {
    worker: Mutex<Option<mpsc::Sender<WarmJob>>>,
}

impl InProcessHost {
    pub fn new() -> Self {
        Self::default()
    }

    fn sender(&self) -> Result<mpsc::Sender<WarmJob>, HostError> {
        let mut guard = lock(&self.worker);
        if let Some(tx) = guard.as_ref() {
            return Ok(tx.clone());
        }
        let (tx, rx) = mpsc::channel::<WarmJob>();
        start_thread("model-host", move || warm_worker(rx))
            .map_err(|e| HostError::Unavailable(format!("cannot start model worker: {e}")))?;
        *guard = Some(tx.clone());
        Ok(tx)
    }
}

fn warm_worker(rx: mpsc::Receiver<WarmJob>) {
    let mut stt = WarmRecognizer::new();
    let mut tts = WarmSynthesizer::new();
    for job in rx {
        match job {
            WarmJob::Transcribe {
                model,
                audio_path,
                language,
                cancel,
                reply,
            } => {
                let res = run_warm_transcribe(
                    &mut stt,
                    &model,
                    &audio_path,
                    language.as_deref(),
                    &cancel,
                );
                let _ = reply.send(res);
            }
            WarmJob::Speak {
                model,
                text,
                voice,
                speed,
                lang,
                cancel,
                tx,
            } => {
                let res = run_warm_speak(
                    &mut tts,
                    SpeakRequest {
                        model: &model,
                        text: &text,
                        voice: voice.as_deref(),
                        speed,
                        lang: lang.as_deref(),
                    },
                    cancel,
                    tx.clone(),
                );
                let _ = tx.send(SpeakMsg::Done(res));
            }
        }
    }
}

fn run_warm_transcribe(
    stt: &mut WarmRecognizer,
    model: &str,
    audio_path: &Path,
    language: Option<&str>,
    cancel: &AtomicBool,
) -> Result<String, HostError> {
    if cancel.load(Ordering::SeqCst) {
        return Err(HostError::Down);
    }
    let samples = transcribe::load_audio(audio_path).map_err(HostError::Failed)?;
    let rec = stt.get(model, language).map_err(HostError::Failed)?;
    if cancel.load(Ordering::SeqCst) {
        return Err(HostError::Down);
    }
    rec.transcribe(&samples).map_err(HostError::Failed)
}

fn run_warm_speak(
    tts: &mut WarmSynthesizer,
    req: SpeakRequest<'_>,
    cancel: Arc<AtomicBool>,
    tx: mpsc::Sender<SpeakMsg>,
) -> Result<(), HostError> {
    if cancel.load(Ordering::SeqCst) {
        return Err(HostError::Down);
    }
    let text = req.text.trim();
    if text.is_empty() {
        return Err(HostError::Failed(
            "nothing to say: the text is empty".into(),
        ));
    }
    let dir = speak::resolve_voice_dir(req.model).map_err(HostError::Failed)?;
    let found = synthesize::detect(&dir).map_err(HostError::Failed)?;
    synthesize::pick_language(&found.languages(), req.lang, found.family())
        .map_err(HostError::Failed)?;
    let synth = tts.get(req.model).map_err(HostError::Failed)?;
    let sid = match req.voice {
        Some(v) => voice_number(synth.voices(), v).map_err(HostError::Failed)?,
        None => 0,
    };
    if tx.send(SpeakMsg::Format(synth.sample_rate(), 1)).is_err() {
        return Ok(());
    }
    let stopped = Arc::new(AtomicBool::new(false));
    let stopped_cb = Arc::clone(&stopped);
    let res = synth.generate(text, sid, req.speed, req.lang, move |samples| {
        if cancel.load(Ordering::SeqCst) {
            stopped_cb.store(true, Ordering::SeqCst);
            return false;
        }
        if samples.is_empty() {
            return true;
        }
        if tx.send(SpeakMsg::Pcm(pcm16(samples))).is_err() {
            stopped_cb.store(true, Ordering::SeqCst);
            return false;
        }
        true
    });
    if stopped.load(Ordering::SeqCst) {
        return Err(HostError::Down);
    }
    res.map_err(HostError::Failed)
}

impl ModelHost for InProcessHost {
    fn list(&self) -> Result<Vec<Value>, HostError> {
        models::list_all().map_err(HostError::Unavailable)
    }

    fn voices(&self, model: &str) -> Result<Vec<Value>, HostError> {
        let names = speak::list_voices_of(model).map_err(HostError::Failed)?;
        Ok(names
            .into_iter()
            .enumerate()
            .map(|(number, name)| json!({ "name": name, "number": number }))
            .collect())
    }

    fn transcribe(
        &self,
        model: &str,
        audio_path: &Path,
        language: Option<&str>,
        cancel: &AtomicBool,
    ) -> Result<String, HostError> {
        let tx = self.sender()?;
        let (reply_tx, reply_rx) = mpsc::channel();
        let job_cancel = Arc::new(AtomicBool::new(cancel.load(Ordering::SeqCst)));
        tx.send(WarmJob::Transcribe {
            model: model.to_string(),
            audio_path: audio_path.to_path_buf(),
            language: language.map(String::from),
            cancel: Arc::clone(&job_cancel),
            reply: reply_tx,
        })
        .map_err(|_| HostError::Unavailable("model worker stopped".into()))?;
        loop {
            if cancel.load(Ordering::SeqCst) {
                job_cancel.store(true, Ordering::SeqCst);
            }
            match reply_rx.recv_timeout(POLL) {
                Ok(res) => return res,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(HostError::Unavailable("model worker stopped".into()))
                }
            }
        }
    }

    fn speak(
        &self,
        req: SpeakRequest<'_>,
        cancel: &AtomicBool,
        on_event: &mut dyn FnMut(SpeakEvent<'_>) -> bool,
    ) -> Result<(), HostError> {
        let tx = self.sender()?;
        let (msg_tx, msg_rx) = mpsc::channel();
        let job_cancel = Arc::new(AtomicBool::new(cancel.load(Ordering::SeqCst)));
        tx.send(WarmJob::Speak {
            model: req.model.to_string(),
            text: req.text.to_string(),
            voice: req.voice.map(String::from),
            speed: req.speed,
            lang: req.lang.map(String::from),
            cancel: Arc::clone(&job_cancel),
            tx: msg_tx,
        })
        .map_err(|_| HostError::Unavailable("model worker stopped".into()))?;
        loop {
            if cancel.load(Ordering::SeqCst) {
                job_cancel.store(true, Ordering::SeqCst);
            }
            match msg_rx.recv_timeout(POLL) {
                Ok(SpeakMsg::Format(rate, channels)) => {
                    if !on_event(SpeakEvent::Format(rate, channels)) {
                        job_cancel.store(true, Ordering::SeqCst);
                        return Ok(());
                    }
                }
                Ok(SpeakMsg::Pcm(bytes)) => {
                    if !on_event(SpeakEvent::Pcm(&bytes)) {
                        job_cancel.store(true, Ordering::SeqCst);
                        return Ok(());
                    }
                }
                Ok(SpeakMsg::Done(res)) => return res,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(HostError::Unavailable("model worker stopped".into()))
                }
            }
        }
    }

    fn download(
        &self,
        model: &str,
        cancel: &AtomicBool,
        on_event: &mut dyn FnMut(Value),
    ) -> Result<bool, HostError> {
        match models::download_model(model, cancel, on_event) {
            Ok(path) => {
                on_event(json!({
                    "event": "done",
                    "id": model,
                    "path": path.to_string_lossy(),
                }));
                Ok(true)
            }
            Err(Failure::Stopped { done }) => {
                on_event(json!({
                    "event": "stopped",
                    "id": model,
                    "done": done,
                }));
                Ok(true)
            }
            Err(Failure::Failed(message)) => {
                on_event(json!({
                    "event": "error",
                    "id": model,
                    "message": message,
                }));
                Ok(true)
            }
        }
    }

    fn delete(&self, model: &str) -> Result<u64, HostError> {
        models::delete_model(model).map_err(HostError::Failed)
    }
}

// ── Subprocess adapter (PI_SPEECH_RECEIVER_MODELS) ──────────────────────────

/// Subprocess [`ModelHost`] adapter used when `PI_SPEECH_RECEIVER_MODELS` names an external
/// program (such as a test stand-in).
pub struct SubprocessHost {
    program: PathBuf,
    active: Mutex<Option<Arc<Mutex<Child>>>>,
}

impl SubprocessHost {
    pub fn new(program: PathBuf) -> Self {
        Self {
            program,
            active: Mutex::new(None),
        }
    }

    fn spawn_active(&self, mut cmd: Command) -> Result<Arc<Mutex<Child>>, HostError> {
        let child = Arc::new(Mutex::new(cmd.spawn().map_err(|e| self.cannot_run(&e))?));
        *lock(&self.active) = Some(Arc::clone(&child));
        Ok(child)
    }

    fn clear_active(&self, child: &Arc<Mutex<Child>>) {
        let mut g = lock(&self.active);
        if g.as_ref().is_some_and(|c| Arc::ptr_eq(c, child)) {
            *g = None;
        }
    }

    fn cannot_run(&self, e: &io::Error) -> HostError {
        HostError::Unavailable(format!(
            "cannot run the models program {}: {e}",
            self.program.display()
        ))
    }
}

impl ModelHost for SubprocessHost {
    fn list(&self) -> Result<Vec<Value>, HostError> {
        let out = command(&self.program, &["models", "list"])
            .output()
            .map_err(|e| self.cannot_run(&e))?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        if !out.status.success() {
            return Err(HostError::Unavailable(why(&stderr, "models list failed")));
        }
        Ok(objects(&out.stdout)
            .into_iter()
            .filter(|v| v.get("id").is_some())
            .collect())
    }

    fn voices(&self, model: &str) -> Result<Vec<Value>, HostError> {
        let out = command(&self.program, &["speak", model, "--list-voices"])
            .output()
            .map_err(|e| self.cannot_run(&e))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(HostError::Failed(why(
                &stderr,
                "the voices could not be listed",
            )));
        }
        Ok(objects(&out.stdout)
            .into_iter()
            .filter(|v| v["name"].is_string() && v["number"].is_number())
            .collect())
    }

    fn transcribe(
        &self,
        model: &str,
        audio_path: &Path,
        language: Option<&str>,
        cancel: &AtomicBool,
    ) -> Result<String, HostError> {
        let path_arg = audio_path.to_string_lossy();
        let mut args = vec!["transcribe", model, &path_arg];
        if let Some(l) = language {
            args.extend(["--language", l]);
        }
        let child = self.spawn_active(command(&self.program, &args))?;
        let (out, err) = {
            let mut c = lock(&child);
            (drain(c.stdout.take()), drain(c.stderr.take()))
        };
        let status = wait(&child, cancel);
        self.clear_active(&child);
        let (stdout, stderr) = (
            out.join().unwrap_or_default(),
            err.join().unwrap_or_default(),
        );
        match status {
            Ok(s) if s.success() => Ok(String::from_utf8_lossy(&stdout).trim().to_string()),
            _ if cancel.load(Ordering::SeqCst) => Err(HostError::Down),
            _ => Err(HostError::Failed(why(
                &String::from_utf8_lossy(&stderr),
                "the transcription failed",
            ))),
        }
    }

    fn speak(
        &self,
        req: SpeakRequest<'_>,
        cancel: &AtomicBool,
        on_event: &mut dyn FnMut(SpeakEvent<'_>) -> bool,
    ) -> Result<(), HostError> {
        let mut args = vec!["speak".to_string(), req.model.to_string()];
        if let Some(v) = req.voice.filter(|v| !v.is_empty()) {
            args.extend(["--voice".into(), v.to_string()]);
        }
        if (req.speed - 1.0).abs() > f32::EPSILON {
            args.extend(["--speed".into(), req.speed.to_string()]);
        }
        if let Some(l) = req.lang.filter(|l| !l.is_empty()) {
            args.extend(["--lang".into(), l.to_string()]);
        }
        let mut cmd = Command::new(&self.program);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = self.spawn_active(cmd)?;
        struct Guard<'a> {
            host: &'a SubprocessHost,
            child: Arc<Mutex<Child>>,
        }
        impl Drop for Guard<'_> {
            fn drop(&mut self) {
                {
                    let mut c = lock(&self.child);
                    let _ = c.kill();
                    let _ = c.wait();
                }
                self.host.clear_active(&self.child);
            }
        }
        let guard = Guard {
            host: self,
            child: Arc::clone(&child),
        };
        let (stdin, stdout, stderr) = {
            let mut c = lock(&guard.child);
            (c.stdin.take(), c.stdout.take(), c.stderr.take())
        };
        let text = req.text.to_string();
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
        let (rate, channels) = loop {
            match rx.recv() {
                Ok(Event::Format(r, c)) if r > 0 => break (r as u32, c as u32),
                Ok(Event::Format(..) | Event::Done) => {}
                Ok(Event::Error(m)) => return Err(HostError::Failed(m)),
                Ok(Event::Closed(n)) => {
                    let m = if n.is_empty() {
                        "speak failed".into()
                    } else {
                        n
                    };
                    return Err(HostError::Failed(m));
                }
                Err(_) => return Err(HostError::Failed("speak failed".into())),
            }
        };
        if !on_event(SpeakEvent::Format(rate, channels)) {
            return Ok(());
        }
        let mut buf = vec![0u8; 16 * 1024];
        if let Some(mut out) = stdout {
            loop {
                match out.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if cancel.load(Ordering::SeqCst) || !on_event(SpeakEvent::Pcm(&buf[..n])) {
                            return Err(HostError::Down);
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }
        }
        let status = wait(&guard.child, cancel);
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
            Ok(())
        } else {
            Err(HostError::Failed("speak failed".into()))
        }
    }

    fn download(
        &self,
        model: &str,
        cancel: &AtomicBool,
        on_event: &mut dyn FnMut(Value),
    ) -> Result<bool, HostError> {
        let mut cmd = command(&self.program, &["models", "download", model]);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| self.cannot_run(&e))?;
        let mut stdin = child.stdin.take();
        let stderr = drain(child.stderr.take());
        let (tx, rx) = mpsc::channel::<String>();
        if let Some(out) = child.stdout.take() {
            thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if tx.send(line).is_err() {
                        return;
                    }
                }
            });
        }
        let mut finished = false;
        loop {
            if cancel.load(Ordering::SeqCst) {
                drop(stdin.take());
                break;
            }
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(v) = serde_json::from_str::<Value>(line) {
                        finished |=
                            matches!(v["event"].as_str(), Some("done" | "stopped" | "error"));
                        on_event(v);
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        drop(stdin.take());
        let status = child.wait();
        let noise = String::from_utf8_lossy(&stderr.join().unwrap_or_default()).to_string();
        if !finished {
            let ok = status.as_ref().is_ok_and(|s| s.success());
            if ok {
                on_event(json!({ "event": "stopped", "id": model }));
            } else {
                on_event(json!({
                    "event": "error",
                    "id": model,
                    "message": why(&noise, "the download stopped"),
                }));
            }
        }
        Ok(true)
    }

    fn delete(&self, model: &str) -> Result<u64, HostError> {
        let out = command(&self.program, &["models", "delete", model])
            .output()
            .map_err(|e| self.cannot_run(&e))?;
        let deleted = objects(&out.stdout)
            .into_iter()
            .find(|v| v["event"] == "deleted");
        match deleted {
            Some(v) if out.status.success() => Ok(v["freed"].as_u64().unwrap_or(0)),
            _ => Err(HostError::Failed(why(
                &String::from_utf8_lossy(&out.stderr),
                "the model was not deleted",
            ))),
        }
    }

    fn stop(&self) {
        if let Some(c) = lock(&self.active).as_ref() {
            let _ = lock(c).kill();
        }
    }
}

// ── Queue & HTTP handlers ───────────────────────────────────────────────────

/// The one model job (a transcription or a speech) that may run, and the jobs waiting for it
/// in turn; and whether a model download runs (one at a time).
#[derive(Default)]
pub struct Jobs {
    queue: Mutex<Queue>,
    turn: Condvar,
    downloading: AtomicBool,
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

/// The running job; dropping it frees the slot.
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
}

impl Drop for Job<'_> {
    fn drop(&mut self) {
        lock(&self.jobs.queue).busy = false;
        self.jobs.turn.notify_all();
    }
}

/// What a model endpoint needs from the server.
pub struct Ctx<'a> {
    pub host: &'a dyn ModelHost,
    pub tmp_dir: &'a Path,
    pub max_body: u64,
    pub idle: Duration,
    pub jobs: &'a Jobs,
    /// Set when the receiver shuts down.
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

/// The JSON objects of a program's output, one per line.
fn objects(stdout: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(Value::is_object)
        .collect()
}

/// `GET /v1/models`: the catalogue with each model's state in this machine's model cache.
pub fn list(host: &dyn ModelHost) -> Response {
    match host.list() {
        Ok(models) => Response::json(200, json!({ "models": models }).to_string()),
        Err(e) => e.into_response(503),
    }
}

/// `GET /v1/voices?model=<id>`: the voices of a downloaded speech model.
pub fn voices(host: &dyn ModelHost, req: &Request) -> Response {
    let model = match model_id(query_param(req.query.as_deref(), "model").as_deref()) {
        Ok(m) => m,
        Err(r) => return r,
    };
    match host.voices(&model) {
        Ok(voices) => Response::json(200, json!({ "voices": voices }).to_string()),
        Err(e) => e.into_response(422),
    }
}

/// Wait for `child` to exit, killing it when `cancel` is set.
fn wait(child: &Mutex<Child>, cancel: &AtomicBool) -> io::Result<ExitStatus> {
    loop {
        {
            let mut c = lock(child);
            if let Some(s) = c.try_wait()? {
                return Ok(s);
            }
            if cancel.load(Ordering::SeqCst) {
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
    let language = query_param(req.query.as_deref(), "language").filter(|l| !l.is_empty());
    if let Some(l) = &language {
        if l.len() > 16
            || !l
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return Response::error(400, "language must be a language tag such as de or pt-BR");
        }
    }
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
    let r = transcribe_file(
        ctx,
        conn,
        req,
        framing,
        (&model, language.as_deref()),
        &path,
        &too_large,
    );
    let _ = fs::remove_file(&path);
    r
}

#[allow(clippy::too_many_arguments)]
fn transcribe_file(
    ctx: &Ctx,
    conn: &mut Conn,
    req: &Request,
    framing: Framing,
    (model, language): (&str, Option<&str>),
    path: &Path,
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
    let _job = match ctx.jobs.claim(|| conn.peer_gone(), ctx.down) {
        Ok(j) => j,
        Err(why) => return why.answer(),
    };
    match ctx.host.transcribe(model, path, language, ctx.down) {
        Ok(text) => Response::json(200, format!("{{\"text\": {}}}", json_str(&text))),
        Err(e) => e.into_response(422),
    }
}

enum Event {
    Format(u64, u64),
    Error(String),
    Done,
    /// The program's error output ended; its last line that was not an event.
    Closed(String),
}

/// `POST /v1/speak` with `{"model", "text", "voice"?, "speed"?, "lang"?}`: the speech as raw
/// 16-bit mono PCM in a chunked body as it is generated, its rate in `X-Pi-Speech-Rate`.
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
    let voice = match &v["voice"] {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        Value::String(s) if plain(s) => Some(s.as_str()),
        _ => return Response::error(400, "voice must be a voice name or number"),
    };
    let speed = match &v["speed"] {
        Value::Null => 1.0,
        Value::Number(n) if n.as_f64().is_some_and(|s| (0.25..=4.0).contains(&s)) => {
            n.as_f64().unwrap() as f32
        }
        _ => return Response::error(400, "speed must be a number from 0.25 to 4"),
    };
    let lang = match &v["lang"] {
        Value::Null => None,
        Value::String(s) if s.is_empty() => None,
        Value::String(s) if plain(s) => Some(s.as_str()),
        _ => return Response::error(400, "lang must be a language code"),
    };
    let _job = match ctx.jobs.claim(|| conn.peer_gone(), ctx.down) {
        Ok(j) => j,
        Err(why) => return why.answer(),
    };
    let mut begun = false;
    let mut broke_off = false;
    let mut on_event = |ev: SpeakEvent<'_>| -> bool {
        match ev {
            SpeakEvent::Format(rate, channels) => {
                let headers = [
                    ("X-Pi-Speech-Format", "pcm".to_string()),
                    ("X-Pi-Speech-Rate", rate.to_string()),
                    ("X-Pi-Speech-Channels", channels.to_string()),
                ];
                if conn
                    .begin_chunked("application/octet-stream", &headers)
                    .is_err()
                {
                    broke_off = true;
                    return false;
                }
                begun = true;
                true
            }
            SpeakEvent::Pcm(chunk) => {
                if ctx.down.load(Ordering::SeqCst) || conn.write_chunk(chunk).is_err() {
                    conn.break_off();
                    broke_off = true;
                    return false;
                }
                true
            }
        }
    };
    let res = ctx.host.speak(
        SpeakRequest {
            model: &model,
            text,
            voice,
            speed,
            lang,
        },
        ctx.down,
        &mut on_event,
    );
    if !begun {
        if broke_off {
            return Response::sent();
        }
        return match res {
            Ok(()) => Response::error(422, "speak failed"),
            Err(e) => e.into_response(422),
        };
    }
    if broke_off {
        return Response::sent();
    }
    match res {
        Ok(()) => {
            let _ = conn.end_chunked();
        }
        Err(_) => conn.break_off(),
    }
    Response::sent()
}

/// `POST /v1/models/download?model=<id>`: download a model here. The answer streams the
/// download's events as they come, one JSON object a line (`application/x-ndjson`).
pub fn download(ctx: &Ctx, conn: &mut Conn, req: &Request) -> Response {
    let model = match model_id(query_param(req.query.as_deref(), "model").as_deref()) {
        Ok(m) => m,
        Err(r) => return r,
    };
    if ctx.jobs.downloading.swap(true, Ordering::SeqCst) {
        return Response::error(409, "a model is downloading on this machine; one at a time");
    }
    struct Release<'a>(&'a AtomicBool);
    impl Drop for Release<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _release = Release(&ctx.jobs.downloading);
    let cancel = AtomicBool::new(ctx.down.load(Ordering::SeqCst));
    let (tx, rx) = mpsc::channel::<Value>();
    let mut begun = false;
    let mut finished = false;
    let mut write_failed = false;
    let res = thread::scope(|s| {
        let tx_dl = tx;
        let host = ctx.host;
        let model_ref = model.as_str();
        let cancel_ref = &cancel;
        let handle = s.spawn(move || {
            host.download(model_ref, cancel_ref, &mut |ev| {
                let _ = tx_dl.send(ev);
            })
        });
        loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(ev) => {
                    if !begun {
                        if conn.begin_chunked("application/x-ndjson", &[]).is_err() {
                            cancel.store(true, Ordering::SeqCst);
                            write_failed = true;
                            break;
                        }
                        begun = true;
                    }
                    finished |= matches!(ev["event"].as_str(), Some("done" | "stopped" | "error"));
                    if ctx.down.load(Ordering::SeqCst)
                        || conn.write_chunk(format!("{ev}\n").as_bytes()).is_err()
                    {
                        cancel.store(true, Ordering::SeqCst);
                        write_failed = true;
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if ctx.down.load(Ordering::SeqCst) || conn.peer_gone() {
                        cancel.store(true, Ordering::SeqCst);
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        handle
            .join()
            .unwrap_or_else(|_| Err(HostError::Unavailable("download worker panicked".into())))
    });
    if write_failed {
        return Response::sent();
    }
    if !begun {
        if let Err(HostError::Unavailable(m)) = res {
            return Response::error(503, &m);
        }
        if conn.begin_chunked("application/x-ndjson", &[]).is_err() {
            return Response::sent();
        }
    }
    if !finished {
        let line = match res {
            Ok(true) => None,
            Ok(false) | Err(HostError::Down) => Some(json!({ "event": "stopped", "id": model })),
            Err(HostError::Failed(m) | HostError::Unavailable(m)) => {
                Some(json!({ "event": "error", "id": model, "message": m }))
            }
        };
        if let Some(v) = line {
            let _ = conn.write_chunk(format!("{v}\n").as_bytes());
        }
    }
    let _ = conn.end_chunked();
    Response::sent()
}

/// `POST /v1/models/delete?model=<id>`: delete a model here, and any interrupted download
/// of it. `200 {"id": ..., "freed": <bytes>}`; a model being downloaded is `409`.
pub fn delete(ctx: &Ctx, req: &Request) -> Response {
    let model = match model_id(query_param(req.query.as_deref(), "model").as_deref()) {
        Ok(m) => m,
        Err(r) => return r,
    };
    if ctx.jobs.downloading.load(Ordering::SeqCst) {
        return Response::error(
            409,
            "a model is downloading on this machine; delete it once that is done",
        );
    }
    match ctx.host.delete(&model) {
        Ok(freed) => Response::json(200, json!({ "id": model, "freed": freed }).to_string()),
        Err(e) => e.into_response(422),
    }
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
