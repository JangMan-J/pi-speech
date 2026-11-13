//! `pi-speech-receiver ssh` and `pi-speech-receiver pair`: the bridge for one SSH session.
//!
//! `ssh [ssh-args...] <host> [cmd...]` runs the user's own `ssh` with a receiver behind it:
//! it joins the user's shared receiver (starting it if none runs, see `shared.rs`), runs
//! `ssh -R 127.0.0.1:47613:127.0.0.1:<port> -R 127.0.0.1:<spare>:127.0.0.1:<port>
//! [<master options>] <ssh-args...>`, and when `ssh` exits gives up its lease and exits with
//! `ssh`'s status. `pair [ssh-args...] <host>` uploads the token again, with `sftp -b`.
//!
//! Pairing (uploading the bridge token) happens on the first connection to a host (one not
//! in `paired-hosts` with this token). On Unix it goes over the session's own connection:
//! the session's `ssh` runs as a multiplexing master on a private socket (`-o
//! ControlMaster=yes -o ControlPath=<dir>/cm -o ControlPersist=no`, `<dir>` a new 0700
//! directory in `$XDG_RUNTIME_DIR`, the temporary directory or `/tmp`, whichever gives a
//! socket path short enough), so the user answers any host-key or password prompt in the
//! session as usual. Meanwhile a thread waits for the master (the socket, then `ssh -O
//! check`), at most `PI_SPEECH_RECEIVER_PAIR_WAIT` seconds (default 300), and uploads
//! the token with `sftp -o ControlPath=<socket> -o ControlMaster=no -o
//! ProxyCommand=false -b -`: it rides the master, needs no authentication, and cannot
//! open a connection of its own (the `false` proxy fails at once if the master is gone).
//! These helpers run in their own process group, so the terminal's Ctrl+C is not theirs.
//! Success is reported after the session (`paired with <host>`, as before); a failure
//! during the session is one line, ended with `\r\n` for a terminal in raw mode; a session
//! that ends before its master was seen is reported after it. The directory is removed
//! when the session ends.
//!
//! The pre-session upload (`sftp -b` before `ssh` starts, which needs key or agent
//! authentication and a known host key) is kept where the master cannot be ours: on
//! Windows (its OpenSSH has no ControlMaster), when the user's arguments set the
//! multiplexing themselves (`-M`, `-S`, or `-o ControlMaster`, `ControlPath` or
//! `ControlPersist`; the upload then gets their `-S` as `ControlPath`, so a master of
//! theirs is used), or when no private directory can be made. A ControlMaster or
//! ControlPath in the user's ssh_config is overridden for the session (command-line
//! options come first), so it neither reuses nor serves a master of theirs. ProxyJump and
//! ProxyCommand need nothing special: the master is above them.
//!
//! The ssh arguments are read the way OpenSSH's `ssh` reads them (getopt, then the
//! destination, then options again until the first word of the command), so the options
//! that only shape the connection can be handed to `sftp` and the rest left out.

use crate::proc::start_thread;
use crate::server::DEFAULT_PORT;
use crate::{private, shared, signals, token};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
#[cfg(unix)]
use std::time::{Duration, Instant};

pub const USAGE: &str = "pi-speech-receiver ssh [ssh-args...] <host> [command...]";
pub const PAIR_USAGE: &str = "pi-speech-receiver pair [ssh-args...] <host>";

/// Where the token goes on the remote host, relative to the directory `sftp` starts in
/// (the user's home, on Windows OpenSSH too). The extension reads it there.
pub const REMOTE_TOKEN_PATH: &str = ".config/pi-speech/bridge.token";

/// The file, next to the token file, that lists the hosts the token was uploaded to.
pub const PAIRED_FILE: &str = "paired-hosts";

/// `ssh` options that take a value (OpenSSH's getopt string, including `-B` and `-P`).
const VALUE_OPTS: &str = "BbcDEeFIiJLlmOoPpQRSWw";
/// `ssh` options that take none.
const FLAG_OPTS: &str = "1246AaCfGgKkMNnqsTtVvXxYy";

/// `-o` keywords that shape the session, not the connection: never handed to `sftp`.
const SESSION_KEYWORDS: &[&str] = &[
    "clearallforwardings",
    "dynamicforward",
    "escapechar",
    "exitonforwardfailure",
    "forkafterauthentication",
    "forwardagent",
    "forwardx11",
    "forwardx11timeout",
    "forwardx11trusted",
    "localcommand",
    "localforward",
    "permitlocalcommand",
    "remotecommand",
    "remoteforward",
    "requesttty",
    "sessiontype",
    "stdinnull",
    "tunnel",
    "tunneldevice",
];

/// One ssh option as given: its letter and, for options that take one, its value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opt {
    pub letter: char,
    pub value: Option<String>,
}

/// An ssh command line, read as `ssh` reads it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SshArgs {
    pub opts: Vec<Opt>,
    /// The destination: `[user@]host` or `ssh://[user@]host[:port]`.
    pub host: Option<String>,
    /// The remote command, word for word.
    pub command: Vec<String>,
}

impl SshArgs {
    fn first(&self, letter: char) -> Option<&str> {
        self.opts
            .iter()
            .find(|o| o.letter == letter)
            .and_then(|o| o.value.as_deref())
    }

    fn has(&self, letter: char) -> bool {
        self.opts.iter().any(|o| o.letter == letter)
    }
}

/// Read ssh arguments: options (clustered flags, `-p22` and `-p 22` alike), the
/// destination, more options, then the command. `--` ends the options.
pub fn parse(args: &[String]) -> Result<SshArgs, String> {
    let mut out = SshArgs::default();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        i += 1;
        if a == "--" {
            if out.host.is_none() {
                out.host = args.get(i).cloned();
                i += 1;
            }
            out.command = args.get(i..).unwrap_or_default().to_vec();
            break;
        }
        if a.len() > 1 && a.starts_with('-') {
            let body: Vec<char> = a[1..].chars().collect();
            let mut k = 0;
            while k < body.len() {
                let c = body[k];
                k += 1;
                if FLAG_OPTS.contains(c) {
                    out.opts.push(Opt {
                        letter: c,
                        value: None,
                    });
                } else if VALUE_OPTS.contains(c) {
                    let value = if k < body.len() {
                        body[k..].iter().collect()
                    } else {
                        let v = args
                            .get(i)
                            .cloned()
                            .ok_or_else(|| format!("ssh option -{c} needs a value"))?;
                        i += 1;
                        v
                    };
                    out.opts.push(Opt {
                        letter: c,
                        value: Some(value),
                    });
                    break;
                } else {
                    return Err(format!("unknown ssh option -{c}"));
                }
            }
            continue;
        }
        if out.host.is_none() {
            out.host = Some(a.clone());
        } else {
            out.command = args[i - 1..].to_vec();
            break;
        }
    }
    Ok(out)
}

/// The keyword of an `-o` value (`Key=Value`, `Key Value`), in lower case.
fn keyword(option: &str) -> String {
    option
        .trim_start()
        .split(|c: char| c == '=' || c.is_whitespace())
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn yes(option: &str) -> bool {
    let value = option
        .trim_start()
        .split_once(|c: char| c == '=' || c.is_whitespace())
        .map(|(_, v)| v.trim_start_matches(|c: char| c == '=' || c.is_whitespace()))
        .unwrap_or("");
    value.trim().eq_ignore_ascii_case("yes")
}

/// What to do with an ssh command line.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    /// A session: pair if needed, then run it with the bridge forwarded.
    Bridge,
    /// No session to bridge (`-V`, `-G`, `-Q`, `-O`, `-W`, or no destination): run `ssh`
    /// as it is.
    PassThrough,
}

/// Decide what `ssh` would do with these arguments. A session that goes to the
/// background (`-f`) is refused: the receiver lives only as long as the `ssh` process.
pub fn plan(a: &SshArgs) -> Result<Plan, String> {
    if a.host.is_none() || "VGQOW".chars().any(|c| a.has(c)) {
        return Ok(Plan::PassThrough);
    }
    let forks = a.has('f')
        || a.opts.iter().any(|o| {
            o.letter == 'o'
                && o.value
                    .as_deref()
                    .is_some_and(|v| keyword(v) == "forkafterauthentication" && yes(v))
        });
    if forks {
        return Err("ssh -f (ForkAfterAuthentication) is not supported: the receiver runs only as long as the ssh process, which would exit at once".into());
    }
    Ok(Plan::Bridge)
}

/// The destination for `sftp`: an `ssh://` URI becomes `sftp://`, and a host with colons
/// (an IPv6 address) is put in brackets so `sftp` does not read it as `host:path`.
fn sftp_destination(host: &str) -> String {
    if let Some(rest) = host.strip_prefix("ssh://") {
        return format!("sftp://{rest}");
    }
    let (user, name) = match host.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, host),
    };
    let name = if name.contains(':') && !name.starts_with('[') {
        format!("[{name}]")
    } else {
        name.to_string()
    };
    match user {
        Some(u) => format!("{u}@{name}"),
        None => name,
    }
}

/// The `sftp` options and destination that reach the same host the same way as these ssh
/// arguments: connection options are kept (`-p` becomes `-P`, `-l` becomes `-o User=`),
/// session options are left out, and a `RemoteCommand` or `RequestTTY` from the user's
/// configuration is turned off (they break `sftp`).
pub fn sftp_args(a: &SshArgs) -> Result<Vec<String>, String> {
    let host = a
        .host
        .as_deref()
        .ok_or("no host to pair with: give the ssh destination")?;
    let mut out: Vec<String> = ["-o", "RemoteCommand=none", "-o", "RequestTTY=no"]
        .map(String::from)
        .to_vec();
    let mut push = |xs: &[&str]| out.extend(xs.iter().map(|s| s.to_string()));
    for o in &a.opts {
        let v = o.value.as_deref().unwrap_or("");
        match o.letter {
            '4' | '6' | 'C' | 'q' | 'v' => push(&[&format!("-{}", o.letter)]),
            'K' => push(&[
                "-o",
                "GSSAPIAuthentication=yes",
                "-o",
                "GSSAPIDelegateCredentials=yes",
            ]),
            'k' => push(&["-o", "GSSAPIDelegateCredentials=no"]),
            'B' => push(&["-o", &format!("BindInterface={v}")]),
            'b' => push(&["-o", &format!("BindAddress={v}")]),
            'c' => push(&["-c", v]),
            'F' => push(&["-F", v]),
            'I' => push(&["-o", &format!("PKCS11Provider={v}")]),
            'i' => push(&["-i", v]),
            'J' => push(&["-J", v]),
            'l' => push(&["-o", &format!("User={v}")]),
            'm' => push(&["-o", &format!("MACs={v}")]),
            'o' if !SESSION_KEYWORDS.contains(&keyword(v).as_str()) => push(&["-o", v]),
            'P' => push(&["-o", &format!("Tag={v}")]),
            'p' => push(&["-P", v]),
            'S' => push(&["-o", &format!("ControlPath={v}")]),
            // Session only: agent and X11 forwarding, port forwarding, tunnels, tty,
            // background, multiplexing master, logging, escape character, subsystem.
            _ => {}
        }
    }
    out.push(sftp_destination(host));
    Ok(out)
}

/// The name a pairing is remembered by: the destination as given, with `-l` and `-p` when
/// they were given.
pub fn pair_key(a: &SshArgs) -> String {
    let mut key = a.host.clone().unwrap_or_default();
    if let Some(l) = a.first('l') {
        key.push_str(&format!(" -l {l}"));
    }
    if let Some(p) = a.first('p') {
        key.push_str(&format!(" -p {p}"));
    }
    key
}

/// Quote a path for an `sftp` batch file.
fn sftp_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The `sftp` batch that uploads the token file: directories made if missing, the file
/// made private before and after the upload. Commands prefixed with `-` may fail (the
/// directory exists, or the server has no modes, as on Windows).
pub fn batch(local_token: &Path) -> String {
    let file = REMOTE_TOKEN_PATH;
    let dir = file.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
    let parent = dir.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
    format!(
        "-mkdir {parent}\n-mkdir {dir}\n-chmod 700 {dir}\n-chmod 600 {file}\nput {} {file}\n-chmod 600 {file}\n",
        sftp_quote(&local_token.to_string_lossy())
    )
}

/// A short, non-secret mark of the token, so a new token means pairing again.
fn fingerprint(token: &str) -> String {
    let d = Sha256::digest(token.as_bytes());
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn paired_path() -> io::Result<PathBuf> {
    let t = token::default_token_path()?;
    Ok(t.with_file_name(PAIRED_FILE))
}

/// Lines `<fingerprint>\t<key>`.
fn read_paired(path: &Path) -> Vec<(String, String)> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('\t'))
        .map(|(f, k)| (f.to_string(), k.to_string()))
        .collect()
}

fn is_paired(path: &Path, key: &str, fp: &str) -> bool {
    read_paired(path).iter().any(|(f, k)| k == key && f == fp)
}

fn record_paired(path: &Path, key: &str, fp: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        private::dir().recursive(true).create(dir)?;
    }
    // Sessions that pair at once each keep the others' lines.
    let lock = private::file()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))?;
    lock.lock()?;
    let mut entries: Vec<_> = read_paired(path)
        .into_iter()
        .filter(|(_, k)| k != key)
        .collect();
    entries.push((fp.to_string(), key.to_string()));
    let text: String = entries.iter().map(|(f, k)| format!("{f}\t{k}\n")).collect();
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let written = private::file()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .and_then(|mut f| f.write_all(text.as_bytes()));
    written
        .and_then(|()| std::fs::rename(&tmp, path))
        .inspect_err(|_| {
            let _ = std::fs::remove_file(&tmp);
        })
}

fn say(msg: &str) {
    eprintln!("pi-speech-receiver: {msg}");
}

/// Upload the token with `sftp -b -`. Its output is shown only when it fails.
fn upload(a: &SshArgs, local_token: &Path) -> Result<(), String> {
    let mut args = sftp_args(a)?;
    let dest = args.pop().unwrap_or_default();
    args.extend(["-b".into(), "-".into(), dest]);
    run_sftp(Command::new("sftp").args(&args), local_token)
}

/// Run `sftp` with the upload batch on its standard input.
fn run_sftp(cmd: &mut Command, local_token: &Path) -> Result<(), String> {
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run sftp: {e}"))?;
    let script = batch(local_token);
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(script.as_bytes());
    }
    let mut err = String::new();
    let out_thread = child.stdout.take().map(|mut o| {
        std::thread::spawn(move || {
            let mut sink = Vec::new();
            let _ = o.read_to_end(&mut sink);
        })
    });
    if let Some(mut e) = child.stderr.take() {
        let _ = e.read_to_string(&mut err);
    }
    if let Some(t) = out_thread {
        let _ = t.join();
    }
    let status = child.wait().map_err(|e| format!("sftp: {e}"))?;
    if status.success() {
        return Ok(());
    }
    let tail: Vec<&str> = err.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(4)..].join("\n  ");
    Err(format!(
        "sftp {}{}",
        describe(status),
        if tail.is_empty() {
            String::new()
        } else {
            format!(":\n  {tail}")
        }
    ))
}

fn describe(status: ExitStatus) -> String {
    match status.code() {
        Some(c) => format!("exited with status {c}"),
        None => format!("ended by {status}"),
    }
}

/// Pair with the host: upload the token and remember it.
fn pair_with(a: &SshArgs, token: &str) -> Result<(), String> {
    let path = token::default_token_path().map_err(|e| e.to_string())?;
    upload(a, &path)?;
    remember(&pair_key(a), token, say);
    Ok(())
}

/// Record a pairing in `paired-hosts`, telling `tell` when that fails.
fn remember(key: &str, token: &str, tell: fn(&str)) {
    if let Err(e) = paired_path().and_then(|p| record_paired(&p, key, &fingerprint(token))) {
        tell(&format!("paired with {key}, but cannot remember it: {e}"));
    }
}

/// Say one line into a live session, whose terminal may be in raw mode.
#[cfg(unix)]
fn say_live(msg: &str) {
    let line = format!("\r\npi-speech-receiver: {}\r\n", msg.replace('\n', " "));
    let _ = io::stderr().lock().write_all(line.as_bytes());
}

/// Whether the user's arguments set up multiplexing themselves.
pub fn sets_multiplexing(a: &SshArgs) -> bool {
    a.opts.iter().any(|o| match o.letter {
        'M' | 'S' => true,
        'o' => o.value.as_deref().is_some_and(|v| {
            matches!(
                keyword(v).as_str(),
                "controlmaster" | "controlpath" | "controlpersist"
            )
        }),
        _ => false,
    })
}

/// The private directory of one session's master socket, removed with it.
#[cfg(unix)]
struct Master {
    dir: PathBuf,
    socket: PathBuf,
}

/// The longest socket path accepted: Unix socket paths have 104 bytes on macOS (108 on
/// Linux), and `ssh` binds a temporary name 17 bytes longer before renaming it.
#[cfg(unix)]
const SOCKET_PATH_MAX: usize = 104 - 1 - 17;

#[cfg(unix)]
impl Master {
    /// Make a new 0700 directory for the socket, under the first base that gives a path
    /// short enough and plain enough (no `%`, spaces or quotes, which `ssh` would read).
    fn new() -> io::Result<Master> {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
        let bases = runtime
            .into_iter()
            .chain([std::env::temp_dir(), PathBuf::from("/tmp")])
            .filter(|b| b.is_absolute() && b.is_dir());
        let mut last = io::Error::other("no directory for the control socket");
        for base in bases {
            let dir = base.join(format!("pisr-{}", token::random_hex(4)?));
            let socket = dir.join("cm");
            let plain = socket.to_str().is_some_and(|s| {
                s.bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"/._-".contains(&c))
            });
            if !plain || socket.as_os_str().len() > SOCKET_PATH_MAX {
                continue;
            }
            match private::dir().create(&dir) {
                Ok(()) => return Ok(Master { dir, socket }),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    fn control_path(&self) -> String {
        format!("ControlPath={}", self.socket.display())
    }

    /// The options that make the session's `ssh` the master.
    fn options(&self) -> Vec<String> {
        [
            "-o",
            "ControlMaster=yes",
            "-o",
            &self.control_path(),
            "-o",
            "ControlPersist=no",
        ]
        .map(String::from)
        .to_vec()
    }

    /// Whether the master answers on the socket.
    fn up(&self, a: &SshArgs) -> bool {
        use std::os::unix::process::CommandExt;
        if !self.socket.exists() {
            return false;
        }
        let mut cmd = Command::new("ssh");
        cmd.args(["-o", &self.control_path()]);
        if let Some(f) = a.first('F') {
            cmd.args(["-F", f]);
        }
        cmd.args(["-O", "check", a.host.as_deref().unwrap_or_default()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .status()
            .is_ok_and(|s| s.success())
    }

    /// Upload the token through the master: no authentication, no connection of its own.
    fn upload(&self, a: &SshArgs, local_token: &Path) -> Result<(), String> {
        use std::os::unix::process::CommandExt;
        let host = a.host.as_deref().ok_or("no host")?;
        let mut cmd = Command::new("sftp");
        cmd.args([
            "-o",
            &self.control_path(),
            "-o",
            "ControlMaster=no",
            "-o",
            "ProxyCommand=false",
            "-o",
            "RemoteCommand=none",
            "-o",
            "RequestTTY=no",
        ]);
        if let Some(f) = a.first('F') {
            cmd.args(["-F", f]);
        }
        cmd.args(["-b", "-", &sftp_destination(host)])
            .process_group(0);
        run_sftp(&mut cmd, local_token)
    }
}

#[cfg(unix)]
impl Drop for Master {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// How pairing over the master went.
#[cfg(unix)]
enum Paired {
    Yes,
    /// Failed, and said so.
    Failed,
    /// The session ended before its master was seen.
    Ended,
}

/// How long to wait for the master: `PI_SPEECH_RECEIVER_PAIR_WAIT` seconds, or 300.
#[cfg(unix)]
fn pair_wait() -> Duration {
    std::env::var("PI_SPEECH_RECEIVER_PAIR_WAIT")
        .ok()
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(Duration::from_secs_f64)
        .unwrap_or(Duration::from_secs(300))
}

/// Wait for the session's master while it runs, then pair through it.
#[cfg(unix)]
fn pair_over(master: &Master, a: &SshArgs, token: &str, key: &str, ended: &AtomicBool) -> Paired {
    let fail = |why: &str| {
        say_live(&format!(
            "cannot pair with {key}: {why}; the session goes on without the token: run `{}` to try again",
            PAIR_USAGE.replace("[ssh-args...] <host>", key)
        ));
        Paired::Failed
    };
    let wait = pair_wait();
    let end = Instant::now() + wait;
    while !master.up(a) {
        if ended.load(Ordering::SeqCst) {
            return Paired::Ended;
        }
        if Instant::now() >= end {
            return fail(&format!(
                "its connection was not up within {} s",
                wait.as_secs_f64().round()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let uploaded = token::default_token_path()
        .map_err(|e| e.to_string())
        .and_then(|path| master.upload(a, &path));
    match uploaded {
        Ok(()) => {
            remember(key, token, say_live);
            Paired::Yes
        }
        Err(e) => {
            let e: Vec<&str> = e.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
            fail(&e.join(" "))
        }
    }
}

const BATCH_HINT: &str =
    "sftp runs in batch mode, so it needs key or agent authentication and a host key already known";

/// `pi-speech-receiver pair [ssh-args...] <host>`.
pub fn pair_main(args: &[String]) -> ExitCode {
    if matches!(args, [h] if h == "-h" || h == "--help") {
        println!("usage: {PAIR_USAGE}");
        return ExitCode::SUCCESS;
    }
    let run = || -> Result<String, String> {
        let a = parse(args)?;
        if a.host.is_none() {
            return Err(format!("no host given\nusage: {PAIR_USAGE}"));
        }
        if !a.command.is_empty() {
            return Err(format!("pair takes no command\nusage: {PAIR_USAGE}"));
        }
        if plan(&a)? != Plan::Bridge {
            return Err("these ssh options open no session to pair through".into());
        }
        let token = token::load_token(None).map_err(|e| e.to_string())?;
        pair_with(&a, &token)
            .map_err(|e| format!("cannot pair with {}: {e}\n({BATCH_HINT})", pair_key(&a)))?;
        Ok(pair_key(&a))
    };
    match run() {
        Ok(key) => {
            say(&format!(
                "paired with {key}: the bridge token is in ~/{REMOTE_TOKEN_PATH} there"
            ));
            ExitCode::SUCCESS
        }
        Err(e) => {
            say(&e);
            ExitCode::from(2)
        }
    }
}

/// `ssh`'s exit status as this program's: its code, or 128 + the signal that ended it.
fn pass_status(status: ExitStatus) -> ExitCode {
    if let Some(c) = status.code() {
        return ExitCode::from(c as u8);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return ExitCode::from((128 + sig) as u8);
        }
    }
    ExitCode::from(255)
}

fn run_plain(args: &[String]) -> ExitCode {
    match Command::new("ssh").args(args).status() {
        Ok(s) => pass_status(s),
        Err(e) => {
            say(&format!("cannot run ssh: {e}"));
            ExitCode::from(255)
        }
    }
}

/// `pi-speech-receiver ssh [ssh-args...] <host> [command...]`.
pub fn ssh_main(args: &[String]) -> ExitCode {
    if matches!(args, [h] if h == "-h" || h == "--help") {
        println!("usage: {USAGE}");
        return ExitCode::SUCCESS;
    }
    let a = match parse(args).and_then(|a| plan(&a).map(|p| (a, p))) {
        Ok((_, Plan::PassThrough)) => return run_plain(args),
        Ok((a, Plan::Bridge)) => a,
        Err(e) => {
            say(&e);
            return ExitCode::from(255);
        }
    };
    match session(&a, args) {
        Ok(status) => pass_status(status),
        Err(e) => {
            say(&e);
            ExitCode::from(255)
        }
    }
}

/// The `-R` forwards of a session to the receiver at `port`: 47613, and `spare` when it has
/// one (a Pi whose 47613 belongs to another session finds this one there).
pub fn forwards(port: u16, spare: Option<u16>) -> Vec<String> {
    std::iter::once(DEFAULT_PORT)
        .chain(spare)
        .flat_map(|p| ["-R".to_string(), format!("127.0.0.1:{p}:127.0.0.1:{port}")])
        .collect()
}

/// Pair if needed, then run `ssh` with the shared receiver behind its forwards, holding a
/// lease on it for as long as `ssh` runs.
fn session(a: &SshArgs, args: &[String]) -> Result<ExitStatus, String> {
    let token = token::load_token(None).map_err(|e| e.to_string())?;
    let key = pair_key(a);
    let paired = paired_path()
        .map(|p| is_paired(&p, &key, &fingerprint(&token)))
        .unwrap_or(false);
    #[cfg(unix)]
    let master = if paired || sets_multiplexing(a) {
        None
    } else {
        Master::new()
            .map(Arc::new)
            .inspect_err(|e| say(&format!("cannot make a control socket directory: {e}")))
            .ok()
    };
    #[cfg(unix)]
    let pre_session = !paired && master.is_none();
    #[cfg(not(unix))]
    let pre_session = !paired;
    if pre_session {
        match pair_with(a, &token) {
            Ok(()) => say(&format!("paired with {key}")),
            Err(e) => say(&format!(
                "cannot pair with {key}: {e}\n({BATCH_HINT}; the session goes on without the token: run `{}` to try again)",
                PAIR_USAGE.replace("[ssh-args...] <host>", &key)
            )),
        }
    }

    // From here SIGINT and SIGTERM come to the pipe: Ctrl+C is for ssh, and a SIGTERM is
    // passed on to it, so the receiver is always stopped after ssh has exited.
    let mut signals = signals::pipe().map_err(|e| format!("cannot handle signals: {e}"))?;
    let dir = token::default_token_path()
        .map_err(|e| e.to_string())?
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let program = std::env::current_exe().map_err(|e| format!("cannot find this program: {e}"))?;
    let lease = shared::join(&dir, &program)?;
    if lease.spare.is_none() {
        say("every spare port is taken by another session: this one forwards 47613 only");
    }
    let mut cmd = Command::new("ssh");
    cmd.args(forwards(lease.port, lease.spare));
    #[cfg(unix)]
    if let Some(m) = &master {
        cmd.args(m.options());
    }
    let result = cmd.args(args).spawn();
    let status = match result {
        Ok(mut child) => {
            let done = Arc::new(AtomicBool::new(false));
            #[cfg(unix)]
            let pairing = master.as_ref().map(|m| {
                let (m, a, token, key, ended) = (
                    Arc::clone(m),
                    a.clone(),
                    token.clone(),
                    key.clone(),
                    Arc::clone(&done),
                );
                start_thread("ssh-pair", move || pair_over(&m, &a, &token, &key, &ended))
            });
            let pid = child.id();
            let watching = Arc::clone(&done);
            let _ = start_thread("ssh-signals", move || {
                let mut b = [0u8; 1];
                while let Ok(1) = signals.read(&mut b) {
                    if b[0] == 15 && !watching.load(Ordering::SeqCst) {
                        terminate(pid);
                    }
                }
            });
            let s = child.wait();
            done.store(true, Ordering::SeqCst);
            #[cfg(unix)]
            if let Some(t) = pairing {
                let joined = t
                    .map_err(|e| e.to_string())
                    .and_then(|t| t.join().map_err(|_| "it panicked".to_string()));
                match joined {
                    Ok(Paired::Failed) => {}
                    Ok(Paired::Yes) => say(&format!("paired with {key}")),
                    Ok(Paired::Ended) => say(&format!(
                        "not paired with {key}: the session ended before its connection was up; the next session tries again"
                    )),
                    Err(e) => say(&format!("cannot pair with {key}: {e}")),
                }
            }
            s.map_err(|e| format!("ssh: {e}"))
        }
        Err(e) => Err(format!("cannot run ssh: {e}")),
    };
    // The socket's directory goes once ssh has exited (ssh would complain if it went
    // before ssh made the socket).
    #[cfg(unix)]
    drop(master);
    drop(lease);
    status
}

#[cfg(unix)]
fn terminate(pid: u32) {
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}

/// On Windows the console's close event reaches ssh as well.
#[cfg(windows)]
fn terminate(_pid: u32) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    fn p(xs: &[&str]) -> SshArgs {
        parse(&v(xs)).unwrap()
    }

    fn o(letter: char, value: Option<&str>) -> Opt {
        Opt {
            letter,
            value: value.map(String::from),
        }
    }

    #[test]
    fn host_then_command() {
        let a = p(&["box", "ls", "-la"]);
        assert_eq!(a.host.as_deref(), Some("box"));
        assert_eq!(a.command, v(&["ls", "-la"]));
        assert!(a.opts.is_empty());
    }

    #[test]
    fn values_attached_or_separate_and_clustered_flags() {
        let a = p(&["-p22", "-i", "k", "-vCp", "2222", "-oUser=bob", "box"]);
        assert_eq!(
            a.opts,
            vec![
                o('p', Some("22")),
                o('i', Some("k")),
                o('v', None),
                o('C', None),
                o('p', Some("2222")),
                o('o', Some("User=bob")),
            ]
        );
        assert_eq!(a.host.as_deref(), Some("box"));
        assert!(a.command.is_empty());
    }

    #[test]
    fn options_after_the_host_until_the_command() {
        let a = p(&["box", "-p", "2", "-t", "tmux", "-p", "x"]);
        assert_eq!(a.host.as_deref(), Some("box"));
        assert_eq!(a.opts, vec![o('p', Some("2")), o('t', None)]);
        assert_eq!(a.command, v(&["tmux", "-p", "x"]));
    }

    #[test]
    fn double_dash_ends_options() {
        let a = p(&["-v", "--", "box", "-p", "1"]);
        assert_eq!(a.host.as_deref(), Some("box"));
        assert_eq!(a.command, v(&["-p", "1"]));
        let a = p(&["box", "--", "-p", "1"]);
        assert_eq!(a.host.as_deref(), Some("box"));
        assert_eq!(a.command, v(&["-p", "1"]));
    }

    #[test]
    fn every_value_option_takes_the_next_word() {
        for c in VALUE_OPTS.chars() {
            let a = p(&[&format!("-{c}"), "value", "box"]);
            assert_eq!(a.opts, vec![o(c, Some("value"))], "-{c}");
            assert_eq!(a.host.as_deref(), Some("box"), "-{c}");
        }
        for c in FLAG_OPTS.chars() {
            let a = p(&[&format!("-{c}"), "box"]);
            assert_eq!(a.opts, vec![o(c, None)], "-{c}");
            assert_eq!(a.host.as_deref(), Some("box"), "-{c}");
        }
    }

    #[test]
    fn missing_value_and_unknown_options_are_errors() {
        assert!(parse(&v(&["box", "-p"])).unwrap_err().contains("-p"));
        assert!(parse(&v(&["-Z", "box"])).unwrap_err().contains("-Z"));
    }

    #[test]
    fn plan_passes_through_what_opens_no_session() {
        for xs in [
            &["-V"][..],
            &["-G", "box"],
            &["-Q", "cipher"],
            &["-O", "check", "box"],
            &["-W", "h:22", "box"],
            &[],
        ] {
            assert_eq!(plan(&p(xs)).unwrap(), Plan::PassThrough, "{xs:?}");
        }
        assert_eq!(plan(&p(&["-N", "box"])).unwrap(), Plan::Bridge);
        assert!(plan(&p(&["-f", "box"])).is_err());
        assert!(plan(&p(&["-o", "ForkAfterAuthentication yes", "box"])).is_err());
        assert!(plan(&p(&["-oforkafterauthentication=YES", "box"])).is_err());
        assert_eq!(
            plan(&p(&["-o", "ForkAfterAuthentication=no", "box"])).unwrap(),
            Plan::Bridge
        );
    }

    #[test]
    fn sftp_gets_the_connection_options_only() {
        let a = p(&[
            "-p",
            "2222",
            "-i",
            "~/.ssh/k",
            "-J",
            "jump",
            "-F",
            "cfg",
            "-l",
            "bob",
            "-A",
            "-X",
            "-t",
            "-L",
            "1:h:2",
            "-R",
            "3:h:4",
            "-D",
            "5",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "RemoteCommand=tmux",
            "-o",
            "LocalForward 1 h:2",
            "-4",
            "-v",
            "-E",
            "log",
            "box",
            "-C",
            "tmux",
            "attach",
        ]);
        assert_eq!(
            sftp_args(&a).unwrap(),
            v(&[
                "-o",
                "RemoteCommand=none",
                "-o",
                "RequestTTY=no",
                "-P",
                "2222",
                "-i",
                "~/.ssh/k",
                "-J",
                "jump",
                "-F",
                "cfg",
                "-o",
                "User=bob",
                "-o",
                "StrictHostKeyChecking=yes",
                "-4",
                "-v",
                "-C",
                "box",
            ])
        );
    }

    #[test]
    fn options_sftp_spells_differently() {
        let a = p(&[
            "-b",
            "10.0.0.1",
            "-B",
            "eth0",
            "-c",
            "aes128-ctr",
            "-m",
            "hmac-sha2-256",
            "-I",
            "p11.so",
            "-S",
            "/tmp/ctl",
            "-P",
            "work",
            "-K",
            "box",
        ]);
        assert_eq!(
            sftp_args(&a).unwrap()[4..],
            v(&[
                "-o",
                "BindAddress=10.0.0.1",
                "-o",
                "BindInterface=eth0",
                "-c",
                "aes128-ctr",
                "-o",
                "MACs=hmac-sha2-256",
                "-o",
                "PKCS11Provider=p11.so",
                "-o",
                "ControlPath=/tmp/ctl",
                "-o",
                "Tag=work",
                "-o",
                "GSSAPIAuthentication=yes",
                "-o",
                "GSSAPIDelegateCredentials=yes",
                "box",
            ])[..]
        );
    }

    #[test]
    fn destinations_sftp_can_read() {
        assert_eq!(sftp_destination("bob@box"), "bob@box");
        assert_eq!(
            sftp_destination("ssh://bob@box:2222"),
            "sftp://bob@box:2222"
        );
        assert_eq!(sftp_destination("fe80::1"), "[fe80::1]");
        assert_eq!(sftp_destination("bob@::1"), "bob@[::1]");
        assert_eq!(sftp_destination("[::1]"), "[::1]");
    }

    #[test]
    fn pair_key_names_host_user_and_port() {
        assert_eq!(pair_key(&p(&["box"])), "box");
        assert_eq!(
            pair_key(&p(&["-p", "22", "-l", "u", "box"])),
            "box -l u -p 22"
        );
        assert_eq!(pair_key(&p(&["bob@box", "-v", "ls"])), "bob@box");
    }

    #[test]
    fn batch_quotes_the_local_path_and_may_fail_only_where_harmless() {
        let b = batch(Path::new("/home/o'neil/.config/pi-speech/receiver.token"));
        assert_eq!(
            b,
            "-mkdir .config\n-mkdir .config/pi-speech\n-chmod 700 .config/pi-speech\n\
             -chmod 600 .config/pi-speech/bridge.token\n\
             put '/home/o'\\''neil/.config/pi-speech/receiver.token' .config/pi-speech/bridge.token\n\
             -chmod 600 .config/pi-speech/bridge.token\n"
        );
    }

    #[test]
    fn paired_hosts_are_remembered_per_token() {
        let d = std::env::temp_dir().join(format!("pisr-paired-{}", token::random_hex(6).unwrap()));
        let f = d.join("sub").join(PAIRED_FILE);
        assert!(!is_paired(&f, "box", "aa"));
        record_paired(&f, "box", "aa").unwrap();
        record_paired(&f, "other -p 2", "aa").unwrap();
        assert!(is_paired(&f, "box", "aa"));
        assert!(!is_paired(&f, "box", "bb"));
        record_paired(&f, "box", "bb").unwrap();
        assert!(is_paired(&f, "box", "bb"));
        assert!(is_paired(&f, "other -p 2", "aa"));
        assert_eq!(read_paired(&f).len(), 2);
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn fingerprint_is_short_and_stable() {
        assert_eq!(fingerprint("x"), fingerprint("x"));
        assert_ne!(fingerprint("x"), fingerprint("y"));
        assert_eq!(fingerprint("x").len(), 16);
    }
}
