//! The playback bridge: endpoints, playback and recording state.

use crate::front::{self, Ready};
use crate::http::{
    answer_nonblocking, json_str, BodyError, BodyFault, Conn, Framing, Request, Response,
};
use crate::private;
use crate::proc::{self, lock, start_thread, Exit, ProcCtl};
use crate::stream::{self, Format};
use crate::token::{ct_eq, random_hex};
use crate::wav::{self, Kind};
use std::fs;
use std::io::{self, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 47613;
pub const MAX_BODY: u64 = 64 * 1024 * 1024;
pub const MAX_RECORD_SECONDS: u64 = 300;
pub const PICKUP_SECONDS: u64 = 60;
const MAX_WAIT_SECONDS: f64 = 60.0;
const MIN_RECORDING_SECONDS: f64 = 0.1;
const RECORDER_START_WINDOW: Duration = Duration::from_millis(500);
const SETTLE: Duration = Duration::from_secs(6);
/// Connections being served (head complete); those still sending their head cost no thread.
const MAX_CONNECTIONS: usize = 512;
pub const HEAD_TIMEOUT: Duration = Duration::from_secs(10);
const KEPT_PLAYBACKS: usize = 64;
/// How long a Stream waits for its audio request to begin.
pub const STREAM_START: Duration = Duration::from_secs(120);
/// The longest a Stream's audio may go without any byte before it counts as broken off.
pub const STREAM_IDLE: Duration = Duration::from_secs(120);
/// The largest body of `POST /v1/play/stream`; a valid one is far smaller.
const MAX_STREAM_REQUEST: u64 = 4096;

pub const PLAYER_ENV: &str = "PI_SPEECH_RECEIVER_PLAYER";
pub const STREAM_PLAYER_ENV: &str = "PI_SPEECH_RECEIVER_STREAM_PLAYER";
pub const RECORDER_ENV: &str = "PI_SPEECH_RECEIVER_RECORDER";
const NO_ENGINE: &str =
    "the built-in audio engine is not available: the receiver cannot find its own executable";

pub struct Config {
    pub listen: SocketAddr,
    pub token: String,
    /// The receiver's private directory for audio files; removed on shutdown.
    pub tmp_dir: PathBuf,
    /// Player executable from the environment; `None` means the built-in engine.
    pub player: Option<PathBuf>,
    /// Stream player executable from the environment; `None` means the built-in engine,
    /// unless `player` is set: then there is no Stream player.
    pub stream_player: Option<PathBuf>,
    /// Recorder executable from the environment; `None` means the built-in engine.
    pub recorder: Option<PathBuf>,
    /// The built-in audio engine: this program, run as `<engine> play ...` and
    /// `<engine> record <file>`. `None` when it cannot be found.
    pub engine: Option<PathBuf>,
    pub max_body: u64,
    pub max_record_seconds: u64,
    /// How long a finished recording waits to be collected.
    pub pickup: Duration,
    /// How long a client has to send its whole request head.
    pub head_timeout: Duration,
    /// How long a Stream waits for its audio request to begin.
    pub stream_start: Duration,
    /// How long a Stream's audio may go without any byte.
    pub stream_idle: Duration,
}

impl Config {
    pub fn new(listen: SocketAddr, token: String, tmp_dir: PathBuf) -> Config {
        let from_env = |k: &str| {
            std::env::var_os(k)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        };
        Config {
            listen,
            token,
            tmp_dir,
            player: from_env(PLAYER_ENV),
            stream_player: from_env(STREAM_PLAYER_ENV),
            recorder: from_env(RECORDER_ENV),
            engine: std::env::current_exe().ok(),
            max_body: MAX_BODY,
            max_record_seconds: MAX_RECORD_SECONDS,
            pickup: Duration::from_secs(PICKUP_SECONDS),
            head_timeout: HEAD_TIMEOUT,
            stream_start: STREAM_START,
            stream_idle: STREAM_IDLE,
        }
    }
}

/// Only `127.0.0.1` and `::1` are allowed.
pub fn check_loopback(addr: &SocketAddr) -> Result<(), String> {
    match addr.ip() {
        IpAddr::V4(ip) if ip == Ipv4Addr::LOCALHOST => Ok(()),
        IpAddr::V6(ip) if ip == Ipv6Addr::LOCALHOST => Ok(()),
        ip => Err(format!(
            "refusing to listen on {ip}: only 127.0.0.1 and ::1 are allowed"
        )),
    }
}

/// Create the receiver's private (0700) temporary directory under a generated name. On
/// Windows it is made in the user's own temporary directory (`%TEMP%`, in the profile),
/// whose default ACLs keep it private; there are no modes to set.
pub fn private_tmp_dir() -> io::Result<PathBuf> {
    let base = match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(v) if !v.is_empty() && Path::new(&v).is_dir() => PathBuf::from(v),
        _ => std::env::temp_dir(),
    };
    let dir = base.join(format!(
        "pi-speech-receiver-{}-{}",
        std::process::id(),
        random_hex(8)?
    ));
    private::dir().create(&dir)?;
    Ok(dir)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PlayState {
    Playing,
    Completed,
    Failed,
    Cancelled,
}

impl PlayState {
    fn name(self) -> &'static str {
        match self {
            PlayState::Playing => "playing",
            PlayState::Completed => "completed",
            PlayState::Failed => "failed",
            PlayState::Cancelled => "cancelled",
        }
    }
}

/// Where a playback's audio comes from.
enum Feed {
    /// A file, stored before the player started.
    File,
    /// A Stream whose audio request has not begun: the player's input, kept open.
    Waiting(ChildStdin),
    /// A Stream whose input was taken: by its audio request, or closed when it ended.
    Taken,
}

struct Play {
    id: String,
    state: PlayState,
    error: Option<String>,
    ctl: Arc<ProcCtl>,
    feed: Feed,
}

impl Play {
    fn json(&self) -> Response {
        let mut s = format!(
            "{{\"id\": {}, \"state\": \"{}\"",
            json_str(&self.id),
            self.state.name()
        );
        if let (PlayState::Failed, Some(e)) = (self.state, &self.error) {
            s.push_str(&format!(", \"error\": {}", json_str(e)));
        }
        s.push('}');
        Response::json(200, s)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RecPhase {
    Recording,
    Ended,
}

struct Rec {
    id: String,
    path: PathBuf,
    ctl: Arc<ProcCtl>,
    /// The built-in recorder's input, open while it records; it stops when this closes,
    /// should the receiver go away without stopping it. (On Windows the recorder's
    /// `ProcCtl` keeps it instead, and this is `None`.)
    input: Option<ChildStdin>,
    phase: RecPhase,
    /// Set when the recorder failed while it ran; the audio is then already deleted.
    error: Option<String>,
    /// What the recorder said when it ended, for messages.
    note: String,
    finished: Option<Instant>,
}

#[derive(Default)]
struct Inner {
    plays: Vec<Play>,
    recs: Vec<Rec>,
}

struct Shared {
    cfg: Config,
    inner: Mutex<Inner>,
    cv: Condvar,
    play_lock: Mutex<()>,
    rec_lock: Mutex<()>,
    down: AtomicBool,
    conns: AtomicUsize,
}

pub struct Server {
    shared: Arc<Shared>,
    addr: SocketAddr,
}

impl Server {
    /// Bind the listener and start serving on background threads.
    pub fn start(cfg: Config) -> io::Result<Server> {
        check_loopback(&cfg.listen).map_err(io::Error::other)?;
        let listener = TcpListener::bind(cfg.listen)?;
        let addr = listener.local_addr()?;
        let shared = Arc::new(Shared {
            cfg,
            inner: Mutex::new(Inner::default()),
            cv: Condvar::new(),
            play_lock: Mutex::new(()),
            rec_lock: Mutex::new(()),
            down: AtomicBool::new(false),
            conns: AtomicUsize::new(0),
        });
        let sh = Arc::clone(&shared);
        let started = start_thread("accept", move || accept_loop(sh, listener)).and_then(|_| {
            let sh = Arc::clone(&shared);
            start_thread("janitor", move || janitor(sh))
        });
        if let Err(e) = started {
            shared.down.store(true, Ordering::SeqCst); // stops whichever thread did start
            return Err(e);
        }
        Ok(Server { shared, addr })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// Stop playback and recording, delete the temporary directory, stop accepting.
    pub fn shutdown(&self) {
        self.shared.shutdown();
        let _ = TcpStream::connect(self.addr); // wake the accept loop
    }
}

fn accept_loop(sh: Arc<Shared>, listener: TcpListener) {
    let head_timeout = sh.cfg.head_timeout;
    let stopped = Arc::clone(&sh);
    front::run(
        listener,
        head_timeout,
        move || stopped.down.load(Ordering::SeqCst),
        move |ready| hand_off(&sh, ready),
    );
}

/// Give a connection with a complete head its own thread, or turn it away politely.
fn hand_off(sh: &Arc<Shared>, ready: Ready) {
    if sh.conns.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
        sh.conns.fetch_sub(1, Ordering::SeqCst);
        let mut stream = ready.stream;
        answer_nonblocking(&mut stream, &Response::error(503, "too many connections"));
        return;
    }
    // The slot lets us get the connection back if the thread cannot start.
    let slot = Arc::new(Mutex::new(Some(ready)));
    let (theirs, shared) = (Arc::clone(&slot), Arc::clone(sh));
    let started = start_thread("conn", move || {
        if let Some(r) = lock(&theirs).take() {
            serve(&shared, r);
        }
        shared.conns.fetch_sub(1, Ordering::SeqCst);
    });
    if started.is_err() {
        sh.conns.fetch_sub(1, Ordering::SeqCst);
        if let Some(r) = lock(&slot).take() {
            let mut stream = r.stream;
            answer_nonblocking(
                &mut stream,
                &Response::error(503, "the receiver cannot start a handler right now"),
            );
        }
    }
}

/// Delete recordings nobody collected in time.
fn janitor(sh: Arc<Shared>) {
    while !sh.down.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(200));
        let mut g = lock(&sh.inner);
        let now = Instant::now();
        g.recs.retain(|r| {
            let expired = r.phase == RecPhase::Ended
                && r.finished
                    .is_some_and(|t| now.duration_since(t) >= sh.cfg.pickup);
            if expired {
                let _ = fs::remove_file(&r.path);
            }
            !expired
        });
    }
}

fn serve(sh: &Arc<Shared>, ready: Ready) {
    let Ready { stream, req, ahead } = ready;
    let Ok(mut conn) = Conn::resume(stream, ahead, &req) else {
        return;
    };
    let resp = if !sh.authorized(&req) {
        Response::error(401, "unauthorized")
    } else if sh.down.load(Ordering::SeqCst) {
        Response::error(503, "the receiver is shutting down")
    } else {
        sh.route(&mut conn, &req)
    };
    conn.finish(resp);
}

fn not_found() -> Response {
    Response::error(404, "not found")
}

/// The optional `X-Pi-Speech-Kind` header must be `message` or `sample`.
fn check_kind(req: &Request) -> Result<(), Response> {
    match req.header("x-pi-speech-kind").unwrap_or("message") {
        "message" | "sample" => Ok(()),
        _ => Err(Response::error(
            400,
            "X-Pi-Speech-Kind must be message or sample",
        )),
    }
}

/// Forget the oldest ended playbacks beyond the ones kept.
fn prune(g: &mut Inner) {
    while g.plays.len() > KEPT_PLAYBACKS {
        match g.plays.iter().position(|p| p.state != PlayState::Playing) {
            Some(i) => {
                g.plays.remove(i);
            }
            None => break,
        }
    }
}

/// Text for a failure message: the program's own words when it said any.
fn with_note(what: &str, note: &str) -> String {
    if note.is_empty() {
        what.to_string()
    } else {
        format!("{what}: {note}")
    }
}

#[cfg(unix)]
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(name))
        .find(|p| {
            p.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// Windows has no execute bit: see [`windows_program::find`]. A name found nowhere is left
/// to the system's own search, which also tries it with `.exe`.
#[cfg(windows)]
fn find_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let pathext = std::env::var_os("PATHEXT");
    windows_program::find(
        name,
        &path.to_string_lossy(),
        pathext.as_ref().map(|e| e.to_string_lossy()).as_deref(),
        |p| p.metadata().is_ok_and(|m| m.is_file()),
    )
}

/// How Windows programs are found, as the extension finds them (`findExecutable` in
/// `src/engine/env.ts`): a program is a file with an extension from PATHEXT that is `.exe`
/// or `.com` (by default `.COM;.EXE`), named with or without it; a `.cmd` or `.bat`
/// script never is. Pure, so that it is tested on every system.
#[cfg(any(windows, test))]
mod windows_program {
    use std::path::{Path, PathBuf};

    /// The extension of `name` (from its last dot, with no path separator after it), in
    /// lowercase.
    fn extension(name: &str) -> Option<String> {
        let ext = &name[name.rfind('.')?..];
        (ext.len() > 1 && !ext.contains(['\\', '/'])).then(|| ext.to_ascii_lowercase())
    }

    /// A `.cmd` or `.bat` script, which is never run as a program.
    pub fn is_script(name: &str) -> bool {
        matches!(extension(name).as_deref(), Some(".cmd" | ".bat"))
    }

    /// The directories of a Windows PATH: split at semicolons outside double quotes, the
    /// quotes removed, empty entries skipped (as `std::env::split_paths` does on Windows).
    fn dirs(path: &str) -> Vec<String> {
        let mut dirs = vec![String::new()];
        let mut quoted = false;
        for c in path.chars() {
            match c {
                '"' => quoted = !quoted,
                ';' if !quoted => dirs.push(String::new()),
                c => dirs.last_mut().unwrap().push(c),
            }
        }
        dirs.retain(|d| !d.is_empty());
        dirs
    }

    /// The program a bare `name` names on `path` (a PATH value), with `pathext` (a PATHEXT
    /// value, if set); `is_file` tells whether a file exists at a path.
    pub fn find(
        name: &str,
        path: &str,
        pathext: Option<&str>,
        is_file: impl Fn(&Path) -> bool,
    ) -> Option<PathBuf> {
        if is_script(name) {
            return None;
        }
        let exts: Vec<String> = pathext
            .unwrap_or(".COM;.EXE")
            .split(';')
            .map(|e| e.trim().to_ascii_lowercase())
            .filter(|e| e == ".exe" || e == ".com")
            .collect();
        // The name itself when it already has a program extension, else the name with each.
        let names: Vec<String> = match extension(name) {
            Some(ext) if exts.contains(&ext) => vec![name.to_string()],
            _ => exts
                .iter()
                .flat_map(|e| [format!("{name}{e}"), format!("{name}{}", e.to_uppercase())])
                .collect(),
        };
        dirs(path).iter().find_map(|d| {
            names
                .iter()
                .map(|n| Path::new(d).join(n))
                .find(|p| is_file(p))
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// `is_file` for a directory holding exactly `names`.
        fn files<'a>(dir: &'a str, names: &'a [&str]) -> impl Fn(&Path) -> bool + 'a {
            move |p| names.iter().any(|n| p == Path::new(dir).join(n))
        }

        const DIR: &str = r"C:\tools";

        #[test]
        fn finds_a_bare_name_with_the_program_extensions_of_pathext() {
            let is_file = files(DIR, &["player.EXE", "rec.com"]);
            let path = format!(r"C:\nowhere;;{DIR}");
            let pathext = Some(".COM;.EXE;.BAT;.CMD");
            let found = |name| find(name, &path, pathext, &is_file);
            let player = Some(Path::new(DIR).join("player.EXE"));
            assert_eq!(found("player"), player);
            assert_eq!(found("player.EXE"), player);
            assert_eq!(found("rec"), Some(Path::new(DIR).join("rec.com")));
            assert_eq!(found("missing"), None);
            // Only .exe and .com of PATHEXT count.
            assert_eq!(find("player", &path, Some(".BAT;.COM"), &is_file), None);
        }

        #[test]
        fn never_takes_a_cmd_or_bat_script() {
            let is_file = files(DIR, &["script.cmd", "other.bat", "other.BAT.exe"]);
            let pathext = Some(".COM;.EXE;.BAT;.CMD");
            assert_eq!(find("script", DIR, pathext, &is_file), None);
            assert_eq!(find("script.cmd", DIR, pathext, &is_file), None);
            assert_eq!(find("other.BAT", DIR, pathext, &is_file), None);
            assert!(is_script("script.cmd") && is_script(r"C:\x\OTHER.Bat"));
            assert!(!is_script("player.exe") && !is_script(r"C:\x.cmd\player"));
        }

        #[test]
        fn uses_com_and_exe_when_pathext_is_not_set() {
            let is_file = files(DIR, &["tool.exe"]);
            assert_eq!(
                find("tool", DIR, None, &is_file),
                Some(Path::new(DIR).join("tool.exe"))
            );
        }

        #[test]
        fn splits_path_at_semicolons_outside_quotes() {
            assert_eq!(
                dirs(r#"C:\a;;"C:\b;c";C:\d"#),
                [r"C:\a", r"C:\b;c", r"C:\d"]
            );
            let is_file = files(r"C:\b;c", &["tool.exe"]);
            assert_eq!(
                find("tool", r#""C:\b;c""#, None, &is_file),
                Some(Path::new(r"C:\b;c").join("tool.exe"))
            );
        }
    }
}

/// A configured program: a bare name is looked up on PATH. On Windows a `.cmd` or `.bat`
/// script is refused, as the extension refuses it, rather than run through `cmd.exe`.
fn configured_program(p: &Path) -> Result<PathBuf, String> {
    #[cfg(windows)]
    if windows_program::is_script(&p.to_string_lossy()) {
        return Err(format!(
            "cannot start {}: a program is an .exe or .com file, not a .cmd or .bat script",
            p.display()
        ));
    }
    Ok(if p.components().count() == 1 {
        find_in_path(&p.to_string_lossy()).unwrap_or_else(|| p.to_path_buf())
    } else {
        p.to_path_buf()
    })
}

/// A player or recorder to run, and the arguments it takes before its own.
struct Program {
    path: PathBuf,
    args: Vec<String>,
    /// The built-in engine rather than a configured program.
    builtin: bool,
}

impl Program {
    fn command(&self) -> Command {
        let mut cmd = Command::new(&self.path);
        cmd.args(&self.args);
        cmd
    }

    fn name(&self) -> String {
        self.path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

fn query_wait(query: Option<&str>) -> Result<f64, ()> {
    let Some(q) = query else { return Ok(0.0) };
    for pair in q.split('&') {
        if let Some(("wait", v)) = pair.split_once('=') {
            return match v.parse::<f64>() {
                Ok(w) if w.is_finite() && w >= 0.0 => Ok(w.min(MAX_WAIT_SECONDS)),
                _ => Err(()),
            };
        }
    }
    Ok(0.0)
}

impl Shared {
    /// The configured program, or the built-in engine's `subcommand`.
    fn program(&self, configured: &Option<PathBuf>, subcommand: &str) -> Result<Program, String> {
        if let Some(p) = configured {
            return Ok(Program {
                path: configured_program(p)?,
                args: Vec::new(),
                builtin: false,
            });
        }
        match &self.cfg.engine {
            Some(engine) => Ok(Program {
                path: engine.clone(),
                args: vec![subcommand.to_string()],
                builtin: true,
            }),
            None => Err(NO_ENGINE.into()),
        }
    }

    fn authorized(&self, req: &Request) -> bool {
        let presented = match (
            req.header("authorization"),
            req.header_count("authorization"),
        ) {
            (Some(v), 1) => match v.split_once(' ') {
                Some((scheme, t)) if scheme.eq_ignore_ascii_case("bearer") => t.trim(),
                _ => "",
            },
            _ => "",
        };
        let ok = ct_eq(presented.as_bytes(), self.cfg.token.as_bytes());
        ok && !presented.is_empty()
    }

    fn route(self: &Arc<Self>, conn: &mut Conn, req: &Request) -> Response {
        let segs: Vec<&str> = req.path.trim_start_matches('/').split('/').collect();
        match (req.method.as_str(), segs.as_slice()) {
            ("GET", ["v1", "health"]) => Response::json(
                200,
                format!(
                    "{{\"protocol\": 1, \"name\": \"pi-speech-receiver\", \"version\": {}, \"capabilities\": [\"play\", \"record\", \"stream\"]}}",
                    json_str(env!("CARGO_PKG_VERSION"))
                ),
            ),
            ("POST", ["v1", "play"]) => self.play(conn, req),
            ("POST", ["v1", "play", "stream"]) => self.play_stream(conn, req),
            ("POST", ["v1", "play", id, "audio"]) => self.stream_audio(conn, req, id),
            ("GET", ["v1", "play", id]) => match query_wait(req.query.as_deref()) {
                Ok(w) => self.get_play(id, w),
                Err(()) => Response::error(400, "wait must be a number of seconds"),
            },
            ("POST", ["v1", "play", id, "cancel"]) => self.cancel_play(id),
            ("POST", ["v1", "stop"]) => {
                let _p = lock(&self.play_lock);
                let n = self.stop_playing();
                Response::json(200, format!("{{\"stopped\": {n}}}"))
            }
            ("POST", ["v1", "record", "start"]) => self.start_recording(),
            ("POST", ["v1", "record", id, "stop"]) => self.stop_recording(id),
            ("POST", ["v1", "record", id, "cancel"]) => self.cancel_recording(id),
            _ => not_found(),
        }
    }

    // ---- playback ----

    fn play(self: &Arc<Self>, conn: &mut Conn, req: &Request) -> Response {
        if let Err(resp) = check_kind(req) {
            return resp;
        }
        if req.header("transfer-encoding").is_some() {
            return Response::error(400, "send the audio with Content-Length, not chunked");
        }
        let len = match (
            req.header("content-length"),
            req.header_count("content-length"),
        ) {
            (Some(v), 1) => match v.parse::<u64>() {
                Ok(n) => n,
                Err(_) => return Response::error(400, "invalid Content-Length"),
            },
            _ => return Response::error(400, "exactly one Content-Length is required"),
        };
        if len > self.cfg.max_body {
            return Response::error(
                413,
                &format!("body larger than the limit of {} bytes", self.cfg.max_body),
            );
        }
        let ctype = req.header("content-type").unwrap_or("");
        let kind = match ctype
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "audio/wav" => Kind::Wav,
            "audio/mpeg" => Kind::Mp3,
            _ => return Response::error(415, "Content-Type must be audio/wav or audio/mpeg"),
        };
        conn.send_continue(req);
        let body = match conn.read_body(len) {
            Ok(b) => b,
            Err(BodyError::Short) => {
                return Response::error(400, "body shorter than its Content-Length")
            }
            Err(BodyError::Io(_)) => return Response::error(400, "could not read the body"),
        };
        if !wav::matches(kind, &body) {
            return Response::error(415, "the body is not WAV or MP3 audio of the declared type");
        }
        self.start_playback(kind, &body)
    }

    fn store(&self, prefix: &str, ext: &str, bytes: &[u8]) -> io::Result<PathBuf> {
        let path = self
            .cfg
            .tmp_dir
            .join(format!("{prefix}-{}.{ext}", random_hex(8)?));
        // On Windows the directory's default ACLs (it is in the user's profile) keep it private.
        let mut f = private::file().write(true).create_new(true).open(&path)?;
        if let Err(e) = f.write_all(bytes).and_then(|_| f.flush()) {
            let _ = fs::remove_file(&path);
            return Err(e);
        }
        Ok(path)
    }

    fn start_playback(self: &Arc<Self>, kind: Kind, audio: &[u8]) -> Response {
        // Shutdown takes this lock before it deletes the directory, so audio is only
        // ever stored while the receiver is known to be up.
        let _p = lock(&self.play_lock);
        if self.down.load(Ordering::SeqCst) {
            return Response::error(503, "the receiver is shutting down");
        }
        let path = match self.store("play", kind.extension(), audio) {
            Ok(p) => p,
            Err(e) => return Response::error(503, &format!("cannot store the audio: {e}")),
        };
        let fail = |status: u16, msg: String| {
            let _ = fs::remove_file(&path);
            Response::error(status, &msg)
        };
        self.stop_playing();
        let program = match self.program(&self.cfg.player, "play") {
            Ok(x) => x,
            Err(e) => return fail(503, e),
        };
        let mut cmd = program.command();
        cmd.arg(&path);
        let id = match random_hex(8) {
            Ok(id) => id,
            Err(e) => return fail(503, format!("no random source: {e}")),
        };
        let sh = Arc::clone(self);
        let (done_id, done_path) = (id.clone(), path.clone());
        // Hold the lock across spawn so the exit callback cannot run before the entry exists.
        let mut g = lock(&self.inner);
        let spawned = proc::spawn(cmd, move |exit| {
            let _ = fs::remove_file(&done_path);
            sh.player_ended(&done_id, &exit);
        });
        let ctl = match spawned {
            Ok(c) => c,
            Err(e) => {
                drop(g);
                return fail(
                    503,
                    format!("cannot start the player {}: {e}", program.name()),
                );
            }
        };
        g.plays.push(Play {
            id: id.clone(),
            state: PlayState::Playing,
            error: None,
            ctl,
            feed: Feed::File,
        });
        prune(&mut g);
        Response::json(202, format!("{{\"id\": {}}}", json_str(&id)))
    }

    /// Mark playback `id` by how its player ended.
    fn player_ended(&self, id: &str, exit: &Exit) {
        let (state, error) = if let Some(why) = &exit.failure {
            (PlayState::Failed, Some(why.clone()))
        } else if exit.stop_requested {
            (PlayState::Cancelled, None)
        } else if exit.success() {
            (PlayState::Completed, None)
        } else {
            (
                PlayState::Failed,
                Some(with_note(
                    &format!("player {}", exit.describe()),
                    &exit.stderr_tail,
                )),
            )
        };
        let mut g = lock(&self.inner);
        if let Some(p) = g.plays.iter_mut().find(|p| p.id == id) {
            p.state = state;
            p.error = error;
            if let Feed::Waiting(_) = p.feed {
                p.feed = Feed::Taken; // closes the input nobody will write to now
            }
        }
        self.cv.notify_all();
    }

    // ---- Streams ----

    /// `POST /v1/play/stream`: start a player that reads a Stream from its input.
    fn play_stream(self: &Arc<Self>, conn: &mut Conn, req: &Request) -> Response {
        if let Err(resp) = check_kind(req) {
            return resp;
        }
        let framing = match Framing::of(req) {
            Ok(f) => f,
            Err(e) => return Response::error(400, e),
        };
        conn.send_continue(req);
        let mut body = Vec::new();
        let read = conn.read_pieces(framing, MAX_STREAM_REQUEST, self.cfg.stream_idle, |p| {
            body.extend_from_slice(p)
        });
        if let Err(e) = read {
            return Response::error(400, &format!("unusable Stream request: {}", e.describe()));
        }
        match Format::parse(&body) {
            Ok(format) => self.start_stream(format),
            Err(e) => Response::error(400, &e),
        }
    }

    /// The Stream player for `format`: the configured one, or the built-in engine.
    fn stream_player(&self, format: Format) -> Result<Program, String> {
        // With only a file player configured, Streams get no player: the client then
        // sends them as files, to that player.
        if self.cfg.player.is_some() && self.cfg.stream_player.is_none() {
            return Err(format!(
                "no Stream player: {PLAYER_ENV} is set and {STREAM_PLAYER_ENV} is not"
            ));
        }
        let mut program = self.program(&self.cfg.stream_player, "play")?;
        program.args.extend(stream::player_args(format));
        Ok(program)
    }

    fn start_stream(self: &Arc<Self>, format: Format) -> Response {
        let _p = lock(&self.play_lock);
        if self.down.load(Ordering::SeqCst) {
            return Response::error(503, "the receiver is shutting down");
        }
        // Without a Stream player the client sends the audio as a file later; until
        // then, what plays now keeps playing.
        let program = match self.stream_player(format) {
            Ok(x) => x,
            Err(e) => return Response::error(503, &e),
        };
        let id = match random_hex(8) {
            Ok(id) => id,
            Err(e) => return Response::error(503, &format!("no random source: {e}")),
        };
        self.stop_playing();
        let cmd = program.command();
        let sh = Arc::clone(self);
        let done_id = id.clone();
        // Hold the lock across spawn so the exit callback cannot run before the entry exists.
        let mut g = lock(&self.inner);
        let spawned = proc::spawn_with_input(cmd, move |exit| sh.player_ended(&done_id, &exit));
        let (ctl, input) = match spawned {
            Ok(x) => x,
            Err(e) => {
                drop(g);
                return Response::error(
                    503,
                    &format!("cannot start the Stream player {}: {e}", program.name()),
                );
            }
        };
        let (sh, wait_id, wait_ctl) = (Arc::clone(self), id.clone(), Arc::clone(&ctl));
        if let Err(e) = start_thread("stream-start", move || sh.await_audio(&wait_id, &wait_ctl)) {
            // Not yet listed, so the exit callback has nothing to update; the lock must be
            // released first because that callback takes it.
            drop(g);
            ctl.stop();
            drop(input);
            return Response::error(503, &format!("cannot start the Stream timer: {e}"));
        }
        g.plays.push(Play {
            id: id.clone(),
            state: PlayState::Playing,
            error: None,
            ctl,
            feed: Feed::Waiting(input),
        });
        prune(&mut g);
        Response::json(202, format!("{{\"id\": {}}}", json_str(&id)))
    }

    /// Fail Stream `id` when its audio request has not begun in time.
    fn await_audio(&self, id: &str, ctl: &ProcCtl) {
        let waiting = |g: &Inner| {
            !self.down.load(Ordering::SeqCst)
                && g.plays.iter().any(|p| {
                    p.id == id
                        && p.state == PlayState::Playing
                        && matches!(p.feed, Feed::Waiting(_))
                })
        };
        let g = lock(&self.inner);
        let (mut g, _) = self
            .cv
            .wait_timeout_while(g, self.cfg.stream_start, |g| waiting(g))
            .unwrap_or_else(|e| e.into_inner());
        if !waiting(&g) {
            return;
        }
        // Taken out under the lock, so no audio request can have it any more.
        let input = g
            .plays
            .iter_mut()
            .find(|p| p.id == id)
            .map(|p| std::mem::replace(&mut p.feed, Feed::Taken));
        drop(g);
        // Stopped before its input closes, so the player cannot end as `completed`.
        ctl.fail(&format!(
            "no audio arrived within {} s",
            self.cfg.stream_start.as_secs_f64()
        ));
        drop(input);
    }

    /// `POST /v1/play/<id>/audio`: write the body to Stream `id`'s player as it arrives.
    fn stream_audio(&self, conn: &mut Conn, req: &Request, id: &str) -> Response {
        let framing = match Framing::of(req) {
            Ok(f) => f,
            Err(e) => return Response::error(400, e),
        };
        let (ctl, input) = {
            let mut g = lock(&self.inner);
            let Some(p) = g.plays.iter_mut().find(|p| p.id == id) else {
                return Response::error(404, "unknown playback id");
            };
            let playing = p.state == PlayState::Playing && !p.ctl.stopping();
            let input = match std::mem::replace(&mut p.feed, Feed::Taken) {
                Feed::Waiting(input) if playing => input,
                other => {
                    let msg = match other {
                        _ if !playing => "the playback is no longer playing",
                        Feed::File => "the playback is not a Stream",
                        _ => "the Stream already has its audio request",
                    };
                    p.feed = other;
                    return Response::error(409, msg);
                }
            };
            let ctl = Arc::clone(&p.ctl);
            self.cv.notify_all(); // the start timer stops waiting
            (ctl, input)
        };
        let limit = self.cfg.max_body;
        let too_large = format!("the audio is larger than the limit of {limit} bytes");
        if matches!(framing, Framing::Length(n) if n > limit) {
            self.fail_stream(id, &ctl, Some(input), &too_large);
            return Response::error(413, &too_large);
        }
        conn.send_continue(req);
        // `None` once the player takes no more: a stop was asked for, or it closed its
        // input (`lost`). The rest of the body is then read and dropped.
        let mut input = Some(input);
        let mut lost = false;
        let read = conn.read_pieces(framing, limit, self.cfg.stream_idle, |piece| {
            if let Some(w) = input.as_mut() {
                if ctl.stopping() {
                    input = None;
                } else if w.write_all(piece).is_err() {
                    // EPIPE from a player that has gone (SIGPIPE is ignored).
                    input = None;
                    lost = true;
                }
            }
        });
        match read {
            Ok(_) => {
                // Closing the input lets the player play the rest and exit.
                drop(input);
            }
            Err(BodyFault::TooLarge) => {
                self.fail_stream(id, &ctl, input, &too_large);
                return Response::error(413, &too_large);
            }
            Err(fault) => {
                let why = format!("the audio broke off: {}", fault.describe());
                self.fail_stream(id, &ctl, input, &why);
                return Response::error(400, &why);
            }
        }
        if lost || ctl.stopping() {
            // Ending or being stopped: answer with the state that results.
            self.settle_play(id);
        }
        match lock(&self.inner).plays.iter().find(|p| p.id == id) {
            Some(p) => p.json(),
            None => Response::error(404, "unknown playback id"),
        }
    }

    /// Stop Stream `id` as failed, unless it was already stopped or ended, then close its
    /// input and wait until it is marked.
    fn fail_stream(&self, id: &str, ctl: &ProcCtl, input: Option<ChildStdin>, why: &str) {
        // Stopped before its input closes, so the player cannot end as `completed`.
        ctl.fail(why);
        drop(input);
        self.settle_play(id);
    }

    /// Wait (bounded) until playback `id` is no longer playing.
    fn settle_play(&self, id: &str) {
        self.settle(|g| {
            g.plays
                .iter()
                .all(|p| p.id != id || p.state != PlayState::Playing)
        });
    }

    /// Stop every playback in progress and wait until they are marked. The caller holds
    /// `play_lock`. Returns how many were playing.
    fn stop_playing(&self) -> usize {
        let ctls: Vec<Arc<ProcCtl>> = lock(&self.inner)
            .plays
            .iter()
            .filter(|p| p.state == PlayState::Playing)
            .map(|p| Arc::clone(&p.ctl))
            .collect();
        let stopped = stop_all(&ctls);
        self.settle(|g| g.plays.iter().all(|p| p.state != PlayState::Playing));
        stopped
    }

    /// Wait (bounded) until `done` holds for the shared state.
    fn settle(&self, done: impl Fn(&Inner) -> bool) {
        let g = lock(&self.inner);
        let _ = self.cv.wait_timeout_while(g, SETTLE, |g| !done(g));
    }

    fn get_play(&self, id: &str, wait: f64) -> Response {
        let end = Instant::now() + Duration::from_secs_f64(wait);
        let mut g = lock(&self.inner);
        loop {
            let Some(p) = g.plays.iter().find(|p| p.id == id) else {
                return Response::error(404, "unknown playback id");
            };
            let left = end.saturating_duration_since(Instant::now());
            if p.state != PlayState::Playing || left.is_zero() || self.down.load(Ordering::SeqCst) {
                return p.json();
            }
            g = self
                .cv
                .wait_timeout(g, left)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    fn cancel_play(&self, id: &str) -> Response {
        let ctl = match lock(&self.inner).plays.iter().find(|p| p.id == id) {
            Some(p) => Arc::clone(&p.ctl),
            None => return Response::error(404, "unknown playback id"),
        };
        ctl.stop();
        self.settle_play(id);
        match lock(&self.inner).plays.iter().find(|p| p.id == id) {
            Some(p) => p.json(),
            None => Response::error(404, "unknown playback id"),
        }
    }

    // ---- recording ----

    fn start_recording(self: &Arc<Self>) -> Response {
        let _r = lock(&self.rec_lock);
        if self.down.load(Ordering::SeqCst) {
            return Response::error(503, "the receiver is shutting down");
        }
        if lock(&self.inner)
            .recs
            .iter()
            .any(|r| r.phase == RecPhase::Recording)
        {
            return Response::error(409, "a recording is already active");
        }
        let program = match self.program(&self.cfg.recorder, "record") {
            Ok(x) => x,
            Err(e) => return Response::error(503, &e),
        };
        let (id, name) = match (random_hex(8), random_hex(8)) {
            (Ok(a), Ok(b)) => (a, format!("rec-{b}.wav")),
            _ => return Response::error(503, "no random source"),
        };
        let path = self.cfg.tmp_dir.join(name);
        let mut cmd = program.command();
        cmd.arg(&path);

        let sh = Arc::clone(self);
        let done_id = id.clone();
        let mut g = lock(&self.inner);
        let on_exit = move |exit: Exit| sh.recorder_ended(&done_id, &exit);
        // The built-in recorder also ends when its input closes; a configured one keeps
        // the closed input it always had (on Unix; see `proc::spawn_recorder`).
        let spawned = proc::spawn_recorder(cmd, program.builtin, on_exit);
        let (ctl, input) = match spawned {
            Ok(x) => x,
            Err(e) => {
                drop(g);
                return Response::error(
                    503,
                    &format!("cannot start the recorder {}: {e}", program.name()),
                );
            }
        };
        let limit = Duration::from_secs(self.cfg.max_record_seconds);
        let limiter = Arc::clone(&ctl);
        let started = start_thread("rec-limit", move || {
            if !limiter.wait_exit(limit) {
                limiter.stop();
            }
        });
        if let Err(e) = started {
            // Not yet listed, so the exit callback has nothing to update; the lock must be
            // released first because that callback takes it.
            drop(g);
            ctl.stop();
            let _ = fs::remove_file(&path);
            return Response::error(503, &format!("cannot start the recording timer: {e}"));
        }
        g.recs.push(Rec {
            id: id.clone(),
            path: path.clone(),
            ctl: Arc::clone(&ctl),
            input,
            phase: RecPhase::Recording,
            error: None,
            note: String::new(),
            finished: None,
        });

        // A recorder that ends within the start window has no usable microphone.
        let running = |g: &Inner| {
            g.recs
                .iter()
                .any(|r| r.id == id && r.phase == RecPhase::Recording)
        };
        let (mut g, _) = self
            .cv
            .wait_timeout_while(g, RECORDER_START_WINDOW, |g| running(g))
            .unwrap_or_else(|e| e.into_inner());
        if running(&g) {
            return Response::json(
                201,
                format!(
                    "{{\"id\": {}, \"max_seconds\": {}}}",
                    json_str(&id),
                    self.cfg.max_record_seconds
                ),
            );
        }
        let rec = g
            .recs
            .iter()
            .position(|r| r.id == id)
            .map(|i| g.recs.remove(i));
        drop(g);
        let _ = fs::remove_file(&path);
        let note = rec.map(|r| r.note).unwrap_or_default();
        Response::error(
            503,
            &with_note(
                "the microphone is not available: the recorder ended at once",
                &note,
            ),
        )
    }

    fn recorder_ended(&self, id: &str, exit: &Exit) {
        let failed = exit.killed || (!exit.stop_requested && !exit.success());
        let note = with_note(&format!("recorder {}", exit.describe()), &exit.stderr_tail);
        let error = if exit.killed {
            Some("the recorder did not stop when asked and was killed".to_string())
        } else if failed {
            Some(note.clone())
        } else {
            None
        };
        let mut g = lock(&self.inner);
        if let Some(r) = g.recs.iter_mut().find(|r| r.id == id) {
            r.phase = RecPhase::Ended;
            r.input = None;
            r.finished = Some(Instant::now());
            if error.is_some() {
                let _ = fs::remove_file(&r.path);
            }
            r.error = error;
            // At start-up the recorder's own words are the reason; keep just those.
            r.note = if exit.stderr_tail.is_empty() {
                exit.describe()
            } else {
                exit.stderr_tail.clone()
            };
        }
        self.cv.notify_all();
    }

    /// Stop the recorder of recording `id`, wait for it to end, and take the entry out.
    fn finish_recording(&self, id: &str) -> Option<Result<Rec, Response>> {
        let ctl = lock(&self.inner)
            .recs
            .iter()
            .find(|r| r.id == id)
            .map(|r| Arc::clone(&r.ctl))?;
        ctl.stop();
        let g = lock(&self.inner);
        let (mut g, _) = self
            .cv
            .wait_timeout_while(g, SETTLE, |g| {
                g.recs
                    .iter()
                    .any(|r| r.id == id && r.phase == RecPhase::Recording)
            })
            .unwrap_or_else(|e| e.into_inner());
        let i = g.recs.iter().position(|r| r.id == id)?;
        if g.recs[i].phase == RecPhase::Recording {
            return Some(Err(Response::error(503, "the recorder did not stop")));
        }
        Some(Ok(g.recs.remove(i)))
    }

    fn stop_recording(&self, id: &str) -> Response {
        let rec = match self.finish_recording(id) {
            None => return Response::error(404, "unknown recording id"),
            Some(Err(resp)) => return resp,
            Some(Ok(r)) => r,
        };
        if let Some(e) = &rec.error {
            return Response::error(503, e);
        }
        let bytes = fs::read(&rec.path);
        let _ = fs::remove_file(&rec.path);
        let Ok(bytes) = bytes else {
            return Response::error(
                503,
                &with_note("the recorder produced no audio file", &rec.note),
            );
        };
        match wav::wav_seconds(&bytes) {
            None => Response::error(
                503,
                &with_note("the recorder did not produce a valid WAV file", &rec.note),
            ),
            Some(s) if s < MIN_RECORDING_SECONDS => {
                Response::error(422, "the recording holds less than 0.1 s of audio")
            }
            Some(_) => Response::wav(bytes),
        }
    }

    fn cancel_recording(&self, id: &str) -> Response {
        match self.finish_recording(id) {
            None => Response::error(404, "unknown recording id"),
            Some(Err(resp)) => resp,
            Some(Ok(rec)) => {
                let _ = fs::remove_file(&rec.path);
                Response::json(
                    200,
                    format!("{{\"id\": {}, \"state\": \"cancelled\"}}", json_str(id)),
                )
            }
        }
    }

    // ---- shutdown ----

    fn shutdown(&self) {
        self.down.store(true, Ordering::SeqCst);
        let _p = lock(&self.play_lock);
        let _r = lock(&self.rec_lock);
        let ctls: Vec<Arc<ProcCtl>> = {
            let g = lock(&self.inner);
            g.plays
                .iter()
                .map(|p| Arc::clone(&p.ctl))
                .chain(g.recs.iter().map(|r| Arc::clone(&r.ctl)))
                .collect()
        };
        stop_all(&ctls);
        self.settle(|g| {
            g.plays.iter().all(|p| p.state != PlayState::Playing)
                && g.recs.iter().all(|r| r.phase != RecPhase::Recording)
        });
        let _ = fs::remove_dir_all(&self.cfg.tmp_dir);
        self.cv.notify_all();
    }
}

/// Stop all of `ctls` at once; returns how many were still running. Where a thread
/// cannot start, that child is stopped on the calling thread instead.
fn stop_all(ctls: &[Arc<ProcCtl>]) -> usize {
    thread::scope(|s| {
        let mut handles = Vec::new();
        let mut inline = 0;
        for c in ctls {
            let b = thread::Builder::new().name("stop".into());
            match b.spawn_scoped(s, || c.stop()) {
                Ok(h) => handles.push(h),
                Err(_) => inline += usize::from(c.stop()),
            }
        }
        inline
            + handles
                .into_iter()
                .filter_map(|h| h.join().ok())
                .filter(|&was| was)
                .count()
    })
}
