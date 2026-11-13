//! `models list | download | delete` against a local HTTP server started by each test, with a
//! catalogue file (`PI_SPEECH_MODELS_CATALOG`) pointing at it and a scratch model cache
//! (`PI_SPEECH_MODELS_DIR`): nothing here touches the network.

use pi_speech_receiver::models::catalog::{Entry, Kind};
use pi_speech_receiver::models::download::{self, Failure};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_pi-speech-receiver");
const DIR: &str = "test-model-v1";

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pisr-{name}-{}",
        pi_speech_receiver::token::random_hex(6).unwrap()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Bytes that do not compress, so the archive is about as large as its contents.
fn noise(n: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.wrapping_mul(2_654_435_761).max(1);
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

/// A .tar.bz2 holding <DIR>/tokens.txt and <DIR>/model.onnx.
fn archive(model_bytes: usize) -> Vec<u8> {
    let enc = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
    let mut tar = tar::Builder::new(enc);
    let mut add = |name: &str, data: &[u8]| {
        let mut h = tar::Header::new_gnu();
        h.set_size(data.len() as u64);
        h.set_mode(0o644);
        h.set_cksum();
        tar.append_data(&mut h, format!("{DIR}/{name}"), data)
            .unwrap();
    };
    add("tokens.txt", b"a 0\nb 1\n");
    add("model.onnx", &noise(model_bytes, 7));
    tar.into_inner().unwrap().finish().unwrap()
}

fn sha256(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// How the server answers a request.
#[derive(Clone, Copy, Default)]
enum Mode {
    #[default]
    Whole,
    /// Send this many body bytes, then close the connection.
    CutAfter(usize),
    /// Send the body a kilobyte at a time, slowly.
    Trickle,
    /// Ignore Range and send the whole file.
    NoRanges,
}

struct Server {
    port: u16,
    /// The Range header of each request, in order.
    ranges: Arc<Mutex<Vec<Option<String>>>>,
    closed: Arc<AtomicBool>,
}

impl Server {
    /// Serves body at every path; each request takes the next of modes (then Whole).
    fn start(body: Vec<u8>, modes: Vec<Mode>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let body = Arc::new(body);
        let (r, c) = (ranges.clone(), closed.clone());
        let mut modes = modes.into_iter();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if c.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(conn) = conn else { continue };
                let mode = modes.next().unwrap_or_default();
                let (body, r, c) = (body.clone(), r.clone(), c.clone());
                std::thread::spawn(move || serve(conn, &body, mode, &r, &c));
            }
        });
        Server {
            port,
            ranges,
            closed,
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/{DIR}.tar.bz2", self.port)
    }

    fn ranges(&self) -> Vec<Option<String>> {
        self.ranges.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn serve(
    mut conn: TcpStream,
    body: &[u8],
    mode: Mode,
    ranges: &Mutex<Vec<Option<String>>>,
    closed: &AtomicBool,
) {
    let mut reader = BufReader::new(conn.try_clone().unwrap());
    let mut range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.eq_ignore_ascii_case("range") {
                range = Some(v.trim().to_string());
            }
        }
    }
    ranges.lock().unwrap().push(range.clone());
    let from = match (mode, &range) {
        (Mode::NoRanges, _) | (_, None) => 0,
        (_, Some(r)) => r
            .strip_prefix("bytes=")
            .and_then(|r| r.strip_suffix('-'))
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap(),
    };
    let rest = &body[from..];
    let head = if from > 0 {
        format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {from}-{}/{}\r\nConnection: close\r\n\r\n",
            rest.len(),
            body.len() - 1,
            body.len()
        )
    } else {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            rest.len()
        )
    };
    if conn.write_all(head.as_bytes()).is_err() {
        return;
    }
    match mode {
        Mode::CutAfter(n) => {
            let _ = conn.write_all(&rest[..n.min(rest.len())]);
            let _ = conn.flush();
            let _ = conn.shutdown(std::net::Shutdown::Both);
        }
        Mode::Trickle => {
            for chunk in rest.chunks(1024) {
                if closed.load(Ordering::SeqCst) || conn.write_all(chunk).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        Mode::Whole | Mode::NoRanges => {
            let _ = conn.write_all(rest);
        }
    }
}

/// A scratch cache, and a catalogue with test-model (data at url) and test-voice.
struct Setup {
    root: PathBuf,
    cache: PathBuf,
    catalog: PathBuf,
}

impl Setup {
    fn new(name: &str, url: &str, data: &[u8], sha: Option<&str>) -> Setup {
        let root = scratch(name);
        let cache = root.join("cache");
        let catalog = root.join("catalog.json");
        let sha = sha.map_or_else(|| sha256(data), String::from);
        let entries = json!([
            {"id": "test-model", "kind": "transcription", "name": "Test model",
             "languages": ["en", "de"], "size": data.len(), "url": url, "sha256": sha,
             "dir": DIR},
            {"id": "test-voice", "kind": "speech", "name": "Test voice",
             "languages": ["en"], "size": 10, "url": "http://127.0.0.1:1/test-voice.tar.bz2",
             "sha256": "00", "dir": "test-voice"}
        ]);
        std::fs::write(&catalog, entries.to_string()).unwrap();
        Setup {
            root,
            cache,
            catalog,
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut c = Command::new(BIN);
        c.arg("models")
            .args(args)
            .env("PI_SPEECH_AUDIO_NULL", "1")
            .env("PI_SPEECH_MODELS_DIR", &self.cache)
            .env("PI_SPEECH_MODELS_CATALOG", &self.catalog);
        c
    }

    /// Run to the end with standard input open (closing it would stop a download).
    fn run(&self, args: &[&str]) -> (Output, Vec<Value>) {
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let out = child.wait_with_output().unwrap();
        drop(stdin);
        let lines = parse_lines(&out.stdout);
        (out, lines)
    }

    fn spawn(&self, args: &[&str]) -> (Child, ChildStdin, Receiver<Value>) {
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(serde_json::from_str::<Value>(&line).unwrap());
            }
        });
        (child, stdin, rx)
    }

    fn model(&self) -> PathBuf {
        self.cache.join(DIR)
    }

    fn part(&self) -> PathBuf {
        self.cache.join(format!("{DIR}.part"))
    }

    /// Everything in the cache directory, by name.
    fn cache_names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.cache)
            .map(|r| {
                r.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn parse_lines(out: &[u8]) -> Vec<Value> {
    String::from_utf8_lossy(out)
        .lines()
        .map(|l| serde_json::from_str(l).unwrap_or_else(|e| panic!("{l:?}: {e}")))
        .collect()
}

fn events(lines: &[Value]) -> Vec<&str> {
    lines.iter().map(|l| l["event"].as_str().unwrap()).collect()
}

fn wait_for(rx: &Receiver<Value>, what: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let v = rx.recv_timeout(left).expect("the line never came");
        if what(&v) {
            return v;
        }
    }
}

fn wait_exit(child: &mut Child, within: Duration) -> Option<i32> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(s) = child.try_wait().unwrap() {
            return s.code();
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    panic!("the download did not stop within {within:?}");
}

#[test]
fn a_download_reports_progress_then_verifies_unpacks_and_is_done() {
    let data = archive(300_000);
    let server = Server::start(data.clone(), vec![]);
    let s = Setup::new("dl", &server.url(), &data, None);
    let (out, lines) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(0), "{lines:?}");
    let ev = events(&lines);
    let n = ev.len();
    assert_eq!(&ev[n - 3..], ["verifying", "unpacking", "done"], "{ev:?}");
    assert!(ev[..n - 3].iter().all(|e| *e == "progress"), "{ev:?}");
    let progress: Vec<(u64, u64)> = lines[..n - 3]
        .iter()
        .map(|l| (l["done"].as_u64().unwrap(), l["total"].as_u64().unwrap()))
        .collect();
    let total = data.len() as u64;
    assert_eq!(progress.first(), Some(&(0, total)));
    assert_eq!(progress.last(), Some(&(total, total)));
    assert!(progress.windows(2).all(|w| w[0].0 <= w[1].0));
    for l in &lines {
        assert_eq!(l["id"], "test-model");
    }
    let path = lines[n - 1]["path"].as_str().unwrap();
    assert_eq!(Path::new(path), s.model());
    assert_eq!(
        std::fs::read(s.model().join("tokens.txt")).unwrap(),
        b"a 0\nb 1\n"
    );
    assert_eq!(
        std::fs::read(s.model().join("model.onnx")).unwrap(),
        noise(300_000, 7)
    );
    // Only the model is left: no part, no unpacking directory.
    assert_eq!(s.cache_names(), [DIR]);
    assert_eq!(server.ranges(), [None]);

    // Downloading it again asks nothing of the server.
    let (out, lines) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(events(&lines), ["progress", "done"]);
    assert_eq!(server.ranges().len(), 1);
}

#[test]
fn a_cut_connection_leaves_a_part_that_the_next_download_resumes() {
    let data = archive(400_000);
    let server = Server::start(data.clone(), vec![Mode::CutAfter(150_000)]);
    let s = Setup::new("resume", &server.url(), &data, None);
    let (out, lines) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(1));
    let last = lines.last().unwrap();
    assert_eq!(last["event"], "error");
    assert!(
        last["message"]
            .as_str()
            .unwrap()
            .contains("run it again to resume"),
        "{last}"
    );
    assert!(String::from_utf8_lossy(&out.stderr).contains("broke off"));
    let kept = std::fs::metadata(s.part()).unwrap().len();
    assert!(kept > 0 && kept <= 150_000, "{kept}");
    assert!(!s.model().exists());
    let (_, list) = s.run(&["list"]);
    assert_eq!(list[0]["partial"], kept);
    assert_eq!(list[0]["downloaded"], false);

    let (out, lines) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(0), "{lines:?}");
    // The second request asked for the rest only.
    assert_eq!(server.ranges(), [None, Some(format!("bytes={kept}-"))]);
    assert_eq!(lines[0]["done"], kept, "{}", lines[0]);
    assert_eq!(
        std::fs::read(s.model().join("model.onnx")).unwrap(),
        noise(400_000, 7)
    );
    assert_eq!(s.cache_names(), [DIR]);
}

#[test]
fn a_server_that_ignores_the_range_restarts_the_part() {
    let data = archive(200_000);
    let server = Server::start(data.clone(), vec![Mode::CutAfter(50_000), Mode::NoRanges]);
    let s = Setup::new("norange", &server.url(), &data, None);
    let (out, _) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(1));
    let (out, lines) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(0), "{lines:?}");
    assert!(server.ranges()[1].is_some());
    assert!(lines
        .iter()
        .skip(1)
        .any(|l| l["event"] == "progress" && l["done"] == 0));
    assert!(s.model().join("model.onnx").is_file());
}

#[test]
fn closing_standard_input_stops_a_download_and_leaves_a_resumable_part() {
    let data = archive(400_000);
    let server = Server::start(data.clone(), vec![Mode::Trickle]);
    let s = Setup::new("stop", &server.url(), &data, None);
    let (mut child, stdin, rx) = s.spawn(&["download", "test-model"]);
    wait_for(&rx, |v| {
        v["event"] == "progress" && v["done"].as_u64() > Some(20_000)
    });
    drop(stdin);
    let stopped = wait_for(&rx, |v| v["event"] != "progress");
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(1));
    assert_eq!(stopped["event"], "stopped", "{stopped}");
    let done = stopped["done"].as_u64().unwrap();
    assert_eq!(std::fs::metadata(s.part()).unwrap().len(), done);
    assert!(!s.model().exists());

    let (out, lines) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(0), "{lines:?}");
    assert_eq!(server.ranges()[1], Some(format!("bytes={done}-")));
    assert_eq!(s.cache_names(), [DIR]);
}

#[cfg(unix)]
#[test]
fn a_signal_stops_a_download_and_leaves_a_resumable_part() {
    let data = archive(400_000);
    let server = Server::start(data.clone(), vec![Mode::Trickle]);
    let s = Setup::new("sig", &server.url(), &data, None);
    let (mut child, _stdin, rx) = s.spawn(&["download", "test-model"]);
    wait_for(&rx, |v| {
        v["event"] == "progress" && v["done"].as_u64() > Some(20_000)
    });
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let stopped = wait_for(&rx, |v| v["event"] != "progress");
    assert_eq!(wait_exit(&mut child, Duration::from_secs(10)), Some(1));
    assert_eq!(stopped["event"], "stopped");
    assert_eq!(
        std::fs::metadata(s.part()).unwrap().len(),
        stopped["done"].as_u64().unwrap()
    );
}

#[test]
fn a_checksum_mismatch_is_refused_and_the_download_deleted() {
    let data = archive(100_000);
    let server = Server::start(data.clone(), vec![]);
    let wrong = sha256(b"something else");
    let s = Setup::new("sum", &server.url(), &data, Some(&wrong));
    let (out, lines) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(1));
    let last = lines.last().unwrap();
    assert_eq!(last["event"], "error");
    let msg = last["message"].as_str().unwrap();
    assert!(msg.contains("checksum") && msg.contains(&wrong), "{msg}");
    assert!(!events(&lines).contains(&"unpacking"));
    assert!(s.cache_names().is_empty(), "{:?}", s.cache_names());
}

#[test]
fn an_archive_that_fails_to_unpack_leaves_no_model_behind() {
    // A checked archive cut short inside its bzip2 stream: unpacking fails part-way.
    let mut data = archive(300_000);
    data.truncate(data.len() / 2);
    let server = Server::start(data.clone(), vec![]);
    let s = Setup::new("atomic", &server.url(), &data, None);
    let (out, lines) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(events(&lines).contains(&"unpacking"));
    let last = lines.last().unwrap();
    assert_eq!(last["event"], "error");
    assert!(
        last["message"].as_str().unwrap().contains("cannot unpack"),
        "{last}"
    );
    // No model directory, no half-unpacked directory.
    assert!(s.cache_names().is_empty(), "{:?}", s.cache_names());
    let (_, list) = s.run(&["list"]);
    assert_eq!(list[0]["downloaded"], false);
}

#[test]
fn a_leftover_unpacking_directory_is_not_a_model_and_is_cleared() {
    let data = archive(50_000);
    let server = Server::start(data.clone(), vec![]);
    let s = Setup::new("leftover", &server.url(), &data, None);
    let leftover = s.cache.join(format!(".unpack-{DIR}-abc123"));
    std::fs::create_dir_all(leftover.join(DIR)).unwrap();
    std::fs::write(leftover.join(DIR).join("tokens.txt"), "half").unwrap();
    let (_, list) = s.run(&["list"]);
    assert_eq!(list[0]["downloaded"], false);
    let (out, _) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(s.cache_names(), [DIR]);
}

#[test]
fn list_shows_every_entry_with_its_state() {
    let s = Setup::new("list", "http://127.0.0.1:1/x.tar.bz2", b"0123456789", None);
    let (out, lines) = s.run(&["list"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(lines.len(), 2);
    let m = &lines[0];
    assert_eq!(m["id"], "test-model");
    assert_eq!(m["kind"], "transcription");
    assert_eq!(m["name"], "Test model");
    assert_eq!(m["languages"], json!(["en", "de"]));
    assert_eq!(m["size"], 10);
    assert_eq!(m["downloaded"], false);
    assert_eq!(m["partial"], 0);
    assert_eq!(Path::new(m["path"].as_str().unwrap()), s.model());
    assert_eq!(lines[1]["kind"], "speech");
    // Listing creates nothing.
    assert!(!s.cache.exists());

    std::fs::create_dir_all(&s.cache).unwrap();
    std::fs::write(s.part(), b"0123").unwrap();
    let (_, lines) = s.run(&["list"]);
    assert_eq!(lines[0]["downloaded"], false);
    assert_eq!(lines[0]["partial"], 4);
    std::fs::create_dir_all(s.model()).unwrap();
    let (_, lines) = s.run(&["list"]);
    assert_eq!(lines[0]["downloaded"], true);
    assert_eq!(lines[1]["downloaded"], false);
}

#[test]
fn the_builtin_catalogue_lists_the_models_without_downloading() {
    let root = scratch("builtin");
    let o = Command::new(BIN)
        .args(["models", "list"])
        .env("PI_SPEECH_AUDIO_NULL", "1")
        .env("PI_SPEECH_MODELS_DIR", root.join("cache"))
        .env_remove("PI_SPEECH_MODELS_CATALOG")
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));
    let lines = parse_lines(&o.stdout);
    let ids: Vec<&str> = lines.iter().map(|l| l["id"].as_str().unwrap()).collect();
    for id in [
        "parakeet-tdt-0.6b-v3-int8",
        "whisper-small",
        "sense-voice-int8",
        "kokoro-multi-lang-v1.1-int8",
        "piper-en_US-lessac-medium",
    ] {
        assert!(ids.contains(&id), "{ids:?}");
    }
    assert!(lines.iter().all(|l| l["downloaded"] == false));
    assert!(!root.join("cache").exists());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_removes_the_model_and_any_part_and_frees_the_space() {
    let data = archive(200_000);
    let server = Server::start(data.clone(), vec![]);
    let s = Setup::new("delete", &server.url(), &data, None);
    let (out, _) = s.run(&["download", "test-model"]);
    assert_eq!(out.status.code(), Some(0));
    std::fs::write(s.part(), b"stale").unwrap();
    let (out, lines) = s.run(&["delete", "test-model"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0]["event"], "deleted");
    assert_eq!(lines[0]["id"], "test-model");
    // The model's two files and the part.
    assert_eq!(lines[0]["freed"], 200_000 + 8 + 5);
    assert!(s.cache_names().is_empty());
    let (_, list) = s.run(&["list"]);
    assert_eq!(list[0]["downloaded"], false);
    // Deleting what is not there frees nothing and is not an error.
    let (out, lines) = s.run(&["delete", "test-model"]);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(lines[0]["freed"], 0);
}

#[test]
fn unknown_ids_and_wrong_arguments_fail() {
    let s = Setup::new("unknown", "http://127.0.0.1:1/x.tar.bz2", b"x", None);
    for args in [&["download", "nope"][..], &["delete", "nope"][..]] {
        let (out, lines) = s.run(args);
        assert_eq!(out.status.code(), Some(1), "{args:?}");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0]["event"], "error");
        let msg = lines[0]["message"].as_str().unwrap();
        assert!(
            msg.contains("unknown model \"nope\"") && msg.contains("test-model"),
            "{msg}"
        );
    }
    for args in [&[][..], &["download"][..], &["list", "x"][..]] {
        let (out, lines) = s.run(args);
        assert_eq!(out.status.code(), Some(2), "{args:?}");
        assert!(lines.is_empty());
        assert!(String::from_utf8_lossy(&out.stderr).contains("usage: pi-speech-receiver models"));
    }
    let out = s.command(&["--help"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("models list"));
}

#[test]
fn plain_http_is_refused_unless_the_catalogue_is_a_test_one() {
    let root = scratch("https-only");
    let entry = Entry {
        id: "m".into(),
        kind: Kind::Speech,
        name: "M".into(),
        languages: vec!["en".into()],
        size: 10,
        url: "http://127.0.0.1:1/m.tar.bz2".into(),
        sha256: "00".into(),
        dir: "m".into(),
    };
    let stop = AtomicBool::new(false);
    match download::download(&entry, &root, false, &stop, &mut |_| {}) {
        Err(Failure::Failed(e)) => assert!(e.contains("plain HTTP"), "{e}"),
        other => panic!("{other:?}"),
    }
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn a_model_cache_that_cannot_be_found_is_named() {
    let s = Setup::new("nohome", "http://127.0.0.1:1/x.tar.bz2", b"x", None);
    let o = Command::new(BIN)
        .args(["models", "list"])
        .env_clear()
        .env("PI_SPEECH_AUDIO_NULL", "1")
        .env("PI_SPEECH_MODELS_CATALOG", &s.catalog)
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stderr).contains("cannot find the model cache"));
}
