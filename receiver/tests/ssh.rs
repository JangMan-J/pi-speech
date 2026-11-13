//! `pi-speech-receiver ssh` and `pair` with stand-in `ssh` and `sftp` scripts on PATH.
//!
//! The stand-in `ssh` writes its arguments to `ssh.args<id>` and waits for a
//! `release<id>` file (`<id>` from `STUB_ID`, empty by default). Given `-o ControlPath=<p>`
//! it plays a multiplexing master: it makes `<p>` once started (unless `STUB_MASTER` is
//! `never`), and `-O check` answers whether `<p>` exists (logged to `ssh.checks`). The
//! stand-in `sftp` writes its arguments and its batch (standard input), fails when its
//! `ControlPath` does not exist (it may not connect on its own), and otherwise copies the
//! uploaded file under `remote/`. Unix only: the stand-ins are shell scripts.
//! Every session of a test shares one receiver, which stops once the last session ends.
#![cfg(unix)]

mod support;

use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::time::Duration;
use support::*;

const BIN: &str = env!("CARGO_BIN_EXE_pi-speech-receiver");

const SSH: &str = r#"#!/bin/sh
cp=""; op=""; prev=""
for a in "$@"; do
  case "$prev" in
    -o) case "$a" in ControlPath=*) [ -z "$cp" ] && cp="${a#ControlPath=}";; esac;;
    -O) op="$a";;
  esac
  prev="$a"
done
if [ -n "$op" ] && [ -n "$cp" ]; then
  echo "$op $cp" >> "$STUB/ssh.checks"
  if [ -e "$cp" ]; then echo "Master running (pid=$$)" >&2; exit 0; fi
  echo "Control socket connect($cp): No such file or directory" >&2
  exit 255
fi
printf '%s\n' "$@" > "$STUB/ssh.args.tmp$STUB_ID"
mv "$STUB/ssh.args.tmp$STUB_ID" "$STUB/ssh.args$STUB_ID"
echo x >> "$STUB/ssh.calls"
if [ -n "$cp" ] && [ "${STUB_MASTER:-up}" = up ]; then : > "$cp"; fi
while [ ! -e "$STUB/release$STUB_ID" ]; do sleep 0.05; done
exit "${STUB_SSH_EXIT:-0}"
"#;

const SFTP: &str = r#"#!/bin/sh
printf '%s\n' "$@" > "$STUB/sftp.args"
cat > "$STUB/sftp.batch"
echo x >> "$STUB/sftp.calls"
cp=""; prev=""
for a in "$@"; do
  if [ "$prev" = -o ]; then case "$a" in ControlPath=*) cp="${a#ControlPath=}";; esac; fi
  prev="$a"
done
if [ -n "$cp" ] && [ ! -e "$cp" ]; then
  echo "Control socket connect($cp): No such file or directory" >&2
  echo "Connection closed by UNKNOWN port 65535" >&2
  exit 255
fi
if [ "${STUB_SFTP_EXIT:-0}" != 0 ]; then echo "Permission denied (publickey)." >&2; exit "$STUB_SFTP_EXIT"; fi
src=$(sed -n "s/^put '\(.*\)' .*/\1/p" "$STUB/sftp.batch")
mkdir -p "$STUB/remote/.config/pi-speech"
cp "$src" "$STUB/remote/.config/pi-speech/bridge.token"
"#;

struct Rig {
    dir: PathBuf,
    stub: PathBuf,
}

impl Rig {
    fn new(name: &str) -> Rig {
        let dir = scratch(name);
        let stub = dir.join("stub");
        std::fs::create_dir_all(&stub).unwrap();
        script(&stub.join("ssh"), SSH);
        script(&stub.join("sftp"), SFTP);
        std::fs::create_dir_all(dir.join("run")).unwrap();
        Rig { dir, stub }
    }

    fn command(&self, args: &[&str]) -> Command {
        let path = format!(
            "{}:{}",
            self.stub.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let mut c = Command::new(BIN);
        c.args(args)
            .env("PATH", path)
            .env("STUB", &self.stub)
            .env("XDG_CONFIG_HOME", self.dir.join("xdg"))
            .env("XDG_RUNTIME_DIR", self.dir.join("run"))
            .env_remove("STUB_SSH_EXIT")
            .env_remove("STUB_ID")
            .env_remove("STUB_SFTP_EXIT")
            .env_remove("PI_SPEECH_RECEIVER_STREAM_PLAYER")
            .env_remove("PI_SPEECH_RECEIVER_RECORDER")
            // Never the real speakers or microphone.
            .env("PI_SPEECH_AUDIO_NULL", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    fn file(&self, name: &str) -> PathBuf {
        self.stub.join(name)
    }

    fn lines(&self, name: &str) -> Vec<String> {
        std::fs::read_to_string(self.file(name))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    fn calls(&self, name: &str) -> usize {
        self.lines(&format!("{name}.calls")).len()
    }

    fn token_path(&self) -> PathBuf {
        self.dir.join("xdg/pi-speech/receiver.token")
    }

    fn token(&self) -> String {
        std::fs::read_to_string(self.token_path())
            .unwrap()
            .trim()
            .to_string()
    }

    fn paired(&self) -> String {
        std::fs::read_to_string(self.dir.join("xdg/pi-speech/paired-hosts")).unwrap_or_default()
    }

    fn release(&self) {
        std::fs::write(self.file("release"), "").unwrap();
    }

    /// Start a session and wait for the stand-in ssh to be running.
    fn start(&self, c: &mut Command) -> Child {
        let _ = std::fs::remove_file(self.file("ssh.args"));
        let child = c.spawn().unwrap();
        assert!(
            wait_until(Duration::from_secs(20), || self.file("ssh.args").exists()),
            "the stand-in ssh did not start"
        );
        child
    }

    /// The receiver's address from the `-R` forwards the stand-in ssh `id` was given (47613,
    /// then a spare port, to the same receiver); the spare port.
    fn forwarded_as(&self, id: &str) -> (SocketAddr, u16) {
        let args = self.lines(&format!("ssh.args{id}"));
        assert_eq!(
            (args[0].as_str(), args[2].as_str()),
            ("-R", "-R"),
            "{args:?}"
        );
        let port = args[1]
            .strip_prefix("127.0.0.1:47613:127.0.0.1:")
            .unwrap_or_else(|| panic!("unexpected forward {:?}", args[1]));
        let (spare, to) = args[3]
            .strip_prefix("127.0.0.1:")
            .and_then(|s| s.split_once(":127.0.0.1:"))
            .unwrap_or_else(|| panic!("unexpected forward {:?}", args[3]));
        assert_eq!(to, port, "both forwards lead to the one receiver");
        let spare: u16 = spare.parse().unwrap();
        assert!((47614..=47633).contains(&spare), "{spare}");
        (format!("127.0.0.1:{port}").parse().unwrap(), spare)
    }

    fn forwarded(&self) -> SocketAddr {
        self.forwarded_as("").0
    }

    /// The control socket the stand-in ssh was told to be the master on, if any.
    fn master_socket(&self) -> Option<PathBuf> {
        self.lines("ssh.args")
            .windows(2)
            .find(|w| w[0] == "-o" && w[1].starts_with("ControlPath="))
            .map(|w| PathBuf::from(&w[1]["ControlPath=".len()..]))
    }

    /// Run a session to its end; when it `pairs`, ssh exits only once sftp has run.
    fn session(&self, c: &mut Command, pairs: bool) -> Output {
        let before = self.calls("sftp");
        let child = self.start(c);
        if pairs {
            assert!(
                wait_until(Duration::from_secs(20), || self.calls("sftp") > before),
                "the session did not pair"
            );
        }
        self.release();
        let out = child.wait_with_output().unwrap();
        std::fs::remove_file(self.file("release")).unwrap();
        out
    }

    /// The token the stand-in sftp uploaded.
    fn remote_token(&self) -> String {
        std::fs::read_to_string(self.file("remote/.config/pi-speech/bridge.token"))
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    /// Whether no control socket directory is left in the runtime directory.
    fn sockets_gone(&self) -> bool {
        // The last session's socket directory, wherever it was made (not in run/ when that
        // path is too long, as on macOS), and none left in run/.
        let last_gone = self
            .master_socket()
            .is_none_or(|s| !s.parent().unwrap().exists());
        last_gone
            && std::fs::read_dir(self.dir.join("run"))
                .unwrap()
                .flatten()
                .all(|e| !e.file_name().to_string_lossy().starts_with("pisr-"))
    }

    /// Whether the receiver's private directory is gone (it may take a moment after the
    /// last session).
    fn tmp_cleaned(&self) -> bool {
        wait_until(Duration::from_secs(5), || {
            std::fs::read_dir(self.dir.join("run"))
                .unwrap()
                .flatten()
                .all(|e| {
                    !e.file_name()
                        .to_string_lossy()
                        .starts_with("pi-speech-receiver")
                })
        })
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn stderr(o: &Output) -> String {
    String::from_utf8_lossy(&o.stderr).into_owned()
}

/// Whether nothing answers at `addr` (within a few seconds: the receiver stops a moment
/// after the last session).
fn unreachable(addr: SocketAddr) -> bool {
    wait_until(Duration::from_secs(5), || {
        TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_err()
    })
}

fn health(addr: SocketAddr, token: &str) -> u16 {
    request(addr, "GET", "/v1/health", Some(token), &[], b"", None).status
}

fn batch_put(batch: &str) -> String {
    batch
        .lines()
        .find(|l| l.starts_with("put "))
        .unwrap_or_else(|| panic!("no put in {batch:?}"))
        .to_string()
}

#[test]
fn first_session_pairs_over_its_own_connection_then_serves_for_the_life_of_ssh_only() {
    let rig = Rig::new("ssh-first");
    let args = [
        "-p", "2222", "-i", "/k/id", "-o", "User=bob", "-t", "-L", "1:h:2", "box", "tmux", "-a",
    ];
    let mut c = rig.command(&["ssh"]);
    c.args(args).env("STUB_SSH_EXIT", "7");
    let child = rig.start(&mut c);

    // ssh got the forwards first, then the master options on a private socket, then the
    // user's arguments unchanged.
    let got = rig.lines("ssh.args");
    let socket = rig.master_socket().expect("no ControlPath");
    assert_eq!(
        got[4..10],
        [
            "-o".to_string(),
            "ControlMaster=yes".into(),
            "-o".into(),
            format!("ControlPath={}", socket.display()),
            "-o".into(),
            "ControlPersist=no".into(),
        ]
    );
    assert_eq!(got[10..], args.map(String::from)[..]);
    // In XDG_RUNTIME_DIR when the path fits (`/pisr-<8 hex>/cm` is 17 bytes); on macOS the
    // scratch directory is long and another place is used.
    let run = rig.dir.join("run");
    if run.as_os_str().len() + 17 <= 86 {
        assert!(socket.starts_with(&run), "{socket:?}");
    }
    assert!(socket.as_os_str().len() <= 86, "{socket:?}");
    let dir = socket.parent().unwrap();
    let mode = std::fs::metadata(dir).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o700, "{dir:?}");
    let addr = rig.forwarded();
    assert_eq!(health(addr, &rig.token()), 200);

    // Pairing ran over the session's master, once it was up: no connection of its own.
    assert!(
        wait_until(Duration::from_secs(20), || rig
            .paired()
            .contains("\tbox -p 2222\n")),
        "not paired: {}",
        rig.paired()
    );
    assert_eq!(rig.calls("sftp"), 1);
    assert_eq!(
        rig.lines("sftp.args"),
        [
            "-o".to_string(),
            format!("ControlPath={}", socket.display()),
            "-o".into(),
            "ControlMaster=no".into(),
            "-o".into(),
            "ProxyCommand=false".into(),
            "-o".into(),
            "RemoteCommand=none".into(),
            "-o".into(),
            "RequestTTY=no".into(),
            "-b".into(),
            "-".into(),
            "box".into(),
        ]
    );
    assert!(
        rig.lines("ssh.checks")
            .contains(&format!("check {}", socket.display())),
        "{:?}",
        rig.lines("ssh.checks")
    );
    let batch = std::fs::read_to_string(rig.file("sftp.batch")).unwrap();
    assert_eq!(
        batch_put(&batch),
        format!(
            "put '{}' .config/pi-speech/bridge.token",
            rig.token_path().display()
        )
    );
    assert_eq!(rig.remote_token(), rig.token(), "the token landed");

    rig.release();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(7), "ssh's status passes through");
    let err = stderr(&out);
    assert!(err.contains("paired with box -p 2222"), "{err}");
    assert!(!err.contains("cannot pair"), "{err}");
    assert!(unreachable(addr), "the receiver stops when ssh exits");
    assert!(rig.tmp_cleaned());
    assert!(!dir.exists(), "the socket's directory is gone");
    assert!(rig.sockets_gone());
}

#[test]
fn a_master_that_never_comes_up_gives_one_warning_and_the_session_goes_on() {
    let rig = Rig::new("ssh-nomaster");
    let mut c = rig.command(&["ssh", "box"]);
    c.env("STUB_MASTER", "never")
        .env("STUB_SSH_EXIT", "5")
        .env("PI_SPEECH_RECEIVER_PAIR_WAIT", "0.5");
    let child = rig.start(&mut c);
    let addr = rig.forwarded();
    let socket = rig.master_socket().expect("no ControlPath");
    std::thread::sleep(Duration::from_millis(1500));
    assert_eq!(health(addr, &rig.token()), 200, "the session still serves");
    rig.release();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(5), "ssh's status passes through");
    let err = stderr(&out);
    assert_eq!(err.matches("cannot pair").count(), 1, "{err:?}");
    assert!(
        err.contains(
            "\r\npi-speech-receiver: cannot pair with box: its connection was not up within"
        ),
        "{err:?}"
    );
    assert!(err.contains("pi-speech-receiver pair box"), "{err:?}");
    assert!(err.ends_with("\r\n"), "{err:?}");
    assert_eq!(rig.calls("sftp"), 0, "no upload without the master");
    assert_eq!(rig.paired(), "");
    assert!(unreachable(addr));
    assert!(!socket.parent().unwrap().exists());
    assert!(rig.sockets_gone());
}

#[test]
fn a_session_that_ends_before_its_master_is_seen_is_tried_again_next_time() {
    let rig = Rig::new("ssh-short");
    rig.release();
    let out = rig
        .command(&["ssh", "box", "true"])
        .env("STUB_MASTER", "never")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let err = stderr(&out);
    assert!(err.contains("not paired with box"), "{err}");
    assert_eq!(rig.calls("sftp"), 0);
    assert_eq!(rig.paired(), "");
    assert!(rig.sockets_gone());
    std::fs::remove_file(rig.file("release")).unwrap();

    let out = rig.session(&mut rig.command(&["ssh", "box"]), true);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(rig.paired().contains("\tbox\n"));
}

#[test]
fn a_paired_host_is_not_paired_again() {
    let rig = Rig::new("ssh-second");
    let out = rig.session(&mut rig.command(&["ssh", "box", "true"]), true);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(rig.master_socket().is_some());

    // Paired: no master, no checks, no upload, nothing said.
    let checks = rig.lines("ssh.checks").len();
    let out = rig.session(&mut rig.command(&["ssh", "box", "true"]), false);
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert_eq!(stderr(&out), "");
    assert_eq!(rig.master_socket(), None, "{:?}", rig.lines("ssh.args"));
    assert_eq!(rig.lines("ssh.args")[4..], ["box", "true"]);
    assert_eq!(rig.lines("ssh.checks").len(), checks);
    assert_eq!(rig.calls("ssh"), 2);
    assert_eq!(rig.calls("sftp"), 1);

    // Another host, or the same one on another port, is paired on its own.
    let out = rig.session(&mut rig.command(&["ssh", "-p", "2", "box"]), true);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(rig.calls("sftp"), 2);

    // A new token is paired again.
    std::fs::remove_file(rig.token_path()).unwrap();
    let out = rig.session(&mut rig.command(&["ssh", "box"]), true);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(rig.calls("sftp"), 3);
    assert_eq!(rig.remote_token(), rig.token());
    assert!(rig.sockets_gone());
}

#[test]
fn a_failed_pairing_lets_the_session_go_on_and_is_tried_again() {
    let rig = Rig::new("ssh-fail");
    let mut c = rig.command(&["ssh", "box"]);
    c.env("STUB_SFTP_EXIT", "1");
    let out = rig.session(&mut c, true);
    assert_eq!(out.status.code(), Some(0));
    let err = stderr(&out);
    assert!(err.contains("cannot pair with box"), "{err}");
    assert!(err.contains("Permission denied"), "{err}");
    assert!(err.contains("pi-speech-receiver pair box"), "{err}");
    assert_eq!(err.matches("cannot pair").count(), 1, "{err:?}");
    assert_eq!(rig.calls("ssh"), 1);
    assert_eq!(rig.paired(), "");

    let out = rig.session(&mut rig.command(&["ssh", "box"]), true);
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(rig.calls("sftp"), 2);
    assert!(rig.paired().contains("\tbox\n"));
}

#[test]
fn a_session_that_sets_its_own_multiplexing_pairs_before_it() {
    let rig = Rig::new("ssh-own-mux");
    // Their own master's socket, already up.
    let theirs = rig.dir.join("their-cm");
    std::fs::write(&theirs, "").unwrap();
    let theirs = theirs.to_string_lossy().into_owned();
    let mut c = rig.command(&["ssh", "-S", &theirs, "box"]);
    let child = rig.start(&mut c);
    // Paired before ssh started, the way it always was: their -S as ControlPath.
    assert_eq!(rig.calls("sftp"), 1);
    assert!(rig.lines("sftp.args").ends_with(&[
        "-o".into(),
        format!("ControlPath={theirs}"),
        "-b".into(),
        "-".into(),
        "box".into()
    ]));
    assert_eq!(
        rig.lines("ssh.args")[4..],
        ["-S".to_string(), theirs.clone(), "box".into()]
    );
    assert!(rig.sockets_gone(), "no socket of ours");
    rig.release();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(stderr(&out).contains("paired with box"));
    assert!(rig.paired().contains("\tbox\n"));
    assert_eq!(rig.remote_token(), rig.token());
}

#[test]
fn pair_uploads_every_time_and_fails_when_sftp_does() {
    let rig = Rig::new("ssh-pair");
    for _ in 0..2 {
        let out = rig
            .command(&["pair", "-J", "jump", "bob@box"])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    }
    assert_eq!(rig.calls("sftp"), 2);
    assert_eq!(rig.calls("ssh"), 0);
    assert!(rig.lines("sftp.args").ends_with(&[
        "-J".into(),
        "jump".into(),
        "-b".into(),
        "-".into(),
        "bob@box".into()
    ]));
    assert!(rig.paired().contains("\tbob@box\n"));

    let out = rig
        .command(&["pair", "other"])
        .env("STUB_SFTP_EXIT", "1")
        .output()
        .unwrap();
    assert_ne!(out.status.code(), Some(0));
    assert!(stderr(&out).contains("cannot pair with other"));
    assert!(!rig.paired().contains("other"));

    for bad in [
        &["pair"][..],
        &["pair", "box", "ls"],
        &["pair", "-Z", "box"],
    ] {
        let out = rig.command(bad).output().unwrap();
        assert_ne!(out.status.code(), Some(0), "{bad:?}");
    }
    assert_eq!(rig.calls("sftp"), 3);
}

#[test]
fn what_opens_no_session_runs_ssh_unchanged() {
    let rig = Rig::new("ssh-plain");
    rig.release();
    let out = rig.command(&["ssh", "-G", "box"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(rig.lines("ssh.args"), ["-G", "box"]);
    assert_eq!(rig.calls("sftp"), 0);
    assert!(!rig.token_path().exists(), "no token is made for it");

    let out = rig.command(&["ssh", "-f", "box"]).output().unwrap();
    assert_ne!(out.status.code(), Some(0));
    assert!(stderr(&out).contains("-f"));
    assert_eq!(rig.calls("ssh"), 1);
}

#[test]
fn sigterm_reaches_ssh_and_the_receiver_stops_after_it() {
    let rig = Rig::new("ssh-term");
    let mut c = rig.command(&["ssh", "box"]);
    let child = rig.start(&mut c);
    let addr = rig.forwarded();
    assert_eq!(health(addr, &rig.token()), 200);
    signal(&child, SIGTERM);
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(128 + SIGTERM));
    assert!(unreachable(addr));
    assert!(rig.tmp_cleaned());
}

#[test]
fn the_shared_receiver_stops_when_its_state_directory_is_removed() {
    let rig = Rig::new("ssh-gone");
    let mut c = rig.command(&["ssh", "box"]);
    let child = rig.start(&mut c);
    let addr = rig.forwarded();
    assert_eq!(health(addr, &rig.token()), 200);
    assert!(wait_until(Duration::from_secs(20), || !rig
        .paired()
        .is_empty()));
    // As when a test's scratch directory is removed: its leases go with it.
    std::fs::remove_dir_all(rig.dir.join("xdg/pi-speech")).unwrap();
    rig.release();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(unreachable(addr), "the shared receiver lingers");
}

#[test]
fn sessions_share_one_receiver_and_closing_the_first_keeps_the_second_s_audio() {
    let rig = Rig::new("ssh-two");
    let player = rig.file("player");
    script(&player, "#!/bin/sh\ncat > /dev/null\n");
    let session = |id: &str| {
        let mut c = rig.command(&["ssh", "box"]);
        c.env("STUB_ID", id)
            .env("PI_SPEECH_RECEIVER_STREAM_PLAYER", &player);
        let child = c.spawn().unwrap();
        let args = format!("ssh.args{id}");
        assert!(
            wait_until(Duration::from_secs(20), || rig.file(&args).exists()),
            "the stand-in ssh {id} did not start"
        );
        child
    };
    let first = session("1");
    let second = session("2");
    let (addr, spare1) = rig.forwarded_as("1");
    let (addr2, spare2) = rig.forwarded_as("2");
    assert_eq!(
        addr, addr2,
        "the second session reuses the first one's receiver"
    );
    assert_ne!(
        spare1, spare2,
        "each session forwards a spare port of its own"
    );
    let token = rig.token();

    // The second session's Pi plays a Stream; the first session ends meanwhile.
    let r = request(
        addr,
        "POST",
        "/v1/play/stream",
        Some(&token),
        &[("X-Pi-Speech-Client", "pi-2")],
        br#"{"format": "pcm", "rate": 24000, "channels": 1}"#,
        None,
    );
    assert_eq!(r.status, 202, "{}", r.text());
    let id = json_field(&r.text(), "id").unwrap();
    let mut upload = Upload::chunked(addr, &id, &token);
    upload.chunk(&[0u8; 4800]);
    std::fs::write(rig.file("release1"), "").unwrap();
    let out = first.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(
        health(addr, &token),
        200,
        "the receiver stays for the second session"
    );
    upload.chunk(&[0u8; 4800]);
    assert_eq!(upload.end().status, 200);
    let state = request(
        addr,
        "GET",
        &format!("/v1/play/{id}?wait=10"),
        Some(&token),
        &[],
        b"",
        None,
    );
    assert_eq!(
        json_field(&state.text(), "state").as_deref(),
        Some("completed")
    );

    // The last session's end stops it.
    std::fs::write(rig.file("release2"), "").unwrap();
    let out = second.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    assert!(
        unreachable(addr),
        "the receiver stops after the last session"
    );
    assert!(rig.tmp_cleaned());
}
