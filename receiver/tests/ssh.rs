//! `pi-speech-receiver ssh` and `pair` with stand-in `ssh` and `sftp` scripts on PATH.
//!
//! The stand-in `ssh` writes its arguments to `ssh.args<id>` and waits for a
//! `release<id>` file (`<id>` from `STUB_ID`, empty by default); the stand-in `sftp` writes
//! its arguments and its batch (standard input). Unix only: the stand-ins are shell scripts.
//! Every session of a test shares one receiver, which stops once the last session ends.
#![cfg(unix)]

mod support;

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::time::Duration;
use support::*;

const BIN: &str = env!("CARGO_BIN_EXE_pi-speech-receiver");

const SSH: &str = r#"#!/bin/sh
printf '%s\n' "$@" > "$STUB/ssh.args.tmp$STUB_ID"
mv "$STUB/ssh.args.tmp$STUB_ID" "$STUB/ssh.args$STUB_ID"
echo x >> "$STUB/ssh.calls"
while [ ! -e "$STUB/release$STUB_ID" ]; do sleep 0.05; done
exit "${STUB_SSH_EXIT:-0}"
"#;

const SFTP: &str = r#"#!/bin/sh
printf '%s\n' "$@" > "$STUB/sftp.args"
cat > "$STUB/sftp.batch"
echo x >> "$STUB/sftp.calls"
if [ "${STUB_SFTP_EXIT:-0}" != 0 ]; then echo "Permission denied (publickey)." >&2; fi
exit "${STUB_SFTP_EXIT:-0}"
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
fn first_session_pairs_then_serves_for_the_life_of_ssh_only() {
    let rig = Rig::new("ssh-first");
    let args = [
        "-p", "2222", "-i", "/k/id", "-o", "User=bob", "-t", "-L", "1:h:2", "box", "tmux", "-a",
    ];
    let mut c = rig.command(&["ssh"]);
    c.args(args).env("STUB_SSH_EXIT", "7");
    let child = rig.start(&mut c);

    // ssh got the forward first, then the user's arguments unchanged.
    let got = rig.lines("ssh.args");
    assert_eq!(got[4..], args.map(String::from)[..]);
    let addr = rig.forwarded();
    assert_eq!(health(addr, &rig.token()), 200);

    // Pairing ran before ssh, with the connection options only.
    assert_eq!(rig.calls("sftp"), 1);
    assert_eq!(
        rig.lines("sftp.args"),
        [
            "-o",
            "RemoteCommand=none",
            "-o",
            "RequestTTY=no",
            "-P",
            "2222",
            "-i",
            "/k/id",
            "-o",
            "User=bob",
            "-b",
            "-",
            "box"
        ]
    );
    let batch = std::fs::read_to_string(rig.file("sftp.batch")).unwrap();
    assert_eq!(
        batch_put(&batch),
        format!(
            "put '{}' .config/pi-speech/bridge.token",
            rig.token_path().display()
        )
    );

    rig.release();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(7), "ssh's status passes through");
    assert!(
        stderr(&out).contains("paired with box -p 2222"),
        "{}",
        stderr(&out)
    );
    assert!(unreachable(addr), "the receiver stops when ssh exits");
    assert!(rig.tmp_cleaned());
    assert!(rig.paired().contains("\tbox -p 2222\n"), "{}", rig.paired());
}

#[test]
fn a_paired_host_is_not_paired_again() {
    let rig = Rig::new("ssh-second");
    rig.release();
    for _ in 0..2 {
        let out = rig.command(&["ssh", "box", "true"]).output().unwrap();
        assert_eq!(out.status.code(), Some(0), "{}", stderr(&out));
    }
    assert_eq!(rig.calls("ssh"), 2);
    assert_eq!(rig.calls("sftp"), 1);

    // Another host, or the same one on another port, is paired on its own.
    let out = rig.command(&["ssh", "-p", "2", "box"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(rig.calls("sftp"), 2);

    // A new token is paired again.
    std::fs::remove_file(rig.token_path()).unwrap();
    let out = rig.command(&["ssh", "box"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(rig.calls("sftp"), 3);
}

#[test]
fn a_failed_pairing_lets_the_session_go_on_and_is_tried_again() {
    let rig = Rig::new("ssh-fail");
    rig.release();
    let out = rig
        .command(&["ssh", "box"])
        .env("STUB_SFTP_EXIT", "1")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    let err = stderr(&out);
    assert!(err.contains("cannot pair with box"), "{err}");
    assert!(err.contains("Permission denied"), "{err}");
    assert!(err.contains("pi-speech-receiver pair box"), "{err}");
    assert_eq!(rig.calls("ssh"), 1);
    assert_eq!(rig.paired(), "");

    let out = rig.command(&["ssh", "box"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert_eq!(rig.calls("sftp"), 2);
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
