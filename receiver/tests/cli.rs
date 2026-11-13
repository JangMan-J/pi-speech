//! The binary: command line, token file rules, output, and signals.

mod support;

use std::io::{BufRead, BufReader, Read};
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use support::*;

const BIN: &str = env!("CARGO_BIN_EXE_pi-speech-receiver");
const TOKEN: &str = "cli-token-0123456789abcdef0123456789abcdef";

fn token_file(dir: &Path, mode: u32) -> PathBuf {
    let p = dir.join("token");
    std::fs::write(&p, format!("{TOKEN}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
    p
}

fn command(dir: &Path, args: &[&str]) -> Command {
    let mut c = Command::new(BIN);
    c.args(args)
        .env("XDG_CONFIG_HOME", dir.join("xdg"))
        .env("XDG_RUNTIME_DIR", dir)
        .env_remove("PI_SPEECH_RECEIVER_PLAYER")
        .env_remove("PI_SPEECH_RECEIVER_STREAM_PLAYER")
        .env_remove("PI_SPEECH_RECEIVER_RECORDER")
        // Never the real speakers or microphone.
        .env("PI_SPEECH_AUDIO_NULL", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}

struct Running {
    child: Child,
    addr: SocketAddr,
    first_line: String,
}

fn start(mut c: Command) -> Running {
    let mut child = c.spawn().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    let addr = line
        .trim()
        .strip_prefix("listening ")
        .unwrap_or_else(|| panic!("no listening line: {line:?}"))
        .parse()
        .unwrap();
    // Keep the pipe open and drained so the receiver never blocks on it.
    std::mem::forget(out);
    Running {
        child,
        addr,
        first_line: line,
    }
}

fn signal(child: &Child, sig: i32) {
    unsafe { libc::kill(child.id() as i32, sig) };
}

fn exit_code_within(child: &mut Child, secs: u64) -> Option<i32> {
    let mut code = None;
    wait_until(Duration::from_secs(secs), || {
        code = child.try_wait().unwrap().map(|s| s.code().unwrap_or(-1));
        code.is_some()
    });
    code
}

fn temp_entries(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("pi-speech-receiver-"))
        .collect()
}

#[test]
fn prints_one_listening_line_and_stops_cleanly_on_sigterm_and_sigint() {
    for sig in [15, 2] {
        let dir = scratch("cli-sig");
        let tf = token_file(&dir, 0o600);
        let mut r = start(command(
            &dir,
            &[
                "--listen",
                "127.0.0.1:0",
                "--token-file",
                tf.to_str().unwrap(),
            ],
        ));
        assert!(r.first_line.starts_with("listening 127.0.0.1:"));
        assert_ne!(r.addr.port(), 0);
        let dirs = temp_entries(&dir);
        assert_eq!(dirs.len(), 1, "private temp directory exists while running");
        let mode = std::fs::metadata(dir.join(&dirs[0]))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);

        let rep = request(r.addr, "GET", "/v1/health", Some(TOKEN), &[], &[], None);
        assert_eq!(rep.status, 200);
        signal(&r.child, sig);
        assert_eq!(exit_code_within(&mut r.child, 8), Some(0), "signal {sig}");
        assert!(temp_entries(&dir).is_empty(), "temp directory removed");

        let mut rest = String::new();
        r.child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut rest)
            .unwrap();
        assert!(!rest.contains(TOKEN), "token never reaches output");
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[test]
fn refuses_non_loopback_listen_addresses() {
    let dir = scratch("cli-lb");
    let tf = token_file(&dir, 0o600);
    for a in [
        "0.0.0.0:0",
        "192.168.1.2:0",
        "[::]:0",
        "localhost:0",
        "garbage",
    ] {
        let out = command(&dir, &["--listen", a, "--token-file", tf.to_str().unwrap()])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{a}");
        assert!(out.stdout.is_empty(), "{a}: nothing on stdout");
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn accepts_ipv6_loopback() {
    let dir = scratch("cli-v6");
    let tf = token_file(&dir, 0o600);
    let mut r = start(command(
        &dir,
        &["--listen", "[::1]:0", "--token-file", tf.to_str().unwrap()],
    ));
    assert!(r.first_line.starts_with("listening [::1]:"));
    signal(&r.child, 15);
    assert_eq!(exit_code_within(&mut r.child, 8), Some(0));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn refuses_a_token_file_readable_by_group_or_others() {
    let dir = scratch("cli-mode");
    for mode in [0o640, 0o604, 0o644, 0o660] {
        let tf = token_file(&dir, mode);
        let out = command(
            &dir,
            &[
                "--listen",
                "127.0.0.1:0",
                "--token-file",
                tf.to_str().unwrap(),
            ],
        )
        .output()
        .unwrap();
        assert_eq!(out.status.code(), Some(2), "{mode:o}");
        assert!(out.stdout.is_empty());
        assert!(!String::from_utf8_lossy(&out.stderr).contains(TOKEN));
    }
    assert!(temp_entries(&dir).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn default_token_file_is_created_private_and_works() {
    let dir = scratch("cli-default");
    let mut r = start(command(&dir, &["--listen", "127.0.0.1:0"]));
    let tf = dir.join("xdg/pi-speech/receiver.token");
    assert_eq!(
        std::fs::metadata(&tf).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let token = std::fs::read_to_string(&tf).unwrap().trim().to_string();
    assert!(token.len() >= 32);
    assert_eq!(
        request(r.addr, "GET", "/v1/health", Some(&token), &[], &[], None).status,
        200
    );
    assert_eq!(
        request(r.addr, "GET", "/v1/health", Some(TOKEN), &[], &[], None).status,
        401
    );
    signal(&r.child, 15);
    assert_eq!(exit_code_within(&mut r.child, 8), Some(0));

    // A second start reuses the same token.
    let mut r2 = start(command(&dir, &["--listen", "127.0.0.1:0"]));
    assert_eq!(
        request(r2.addr, "GET", "/v1/health", Some(&token), &[], &[], None).status,
        200
    );
    signal(&r2.child, 15);
    assert_eq!(exit_code_within(&mut r2.child, 8), Some(0));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn sigterm_stops_a_running_player_and_removes_its_file() {
    let dir = scratch("cli-play");
    let tf = token_file(&dir, 0o600);
    let log = dir.join("player.log");
    let player = dir.join("player");
    script(
        &player,
        &format!(
            "#!/bin/bash\ntrap 'echo INT >> {l}; kill $c; exit 130' INT\necho \"$1\" > {l}.path\nsleep 30 & c=$!; wait $c\n",
            l = log.display()
        ),
    );
    let mut c = command(
        &dir,
        &[
            "--listen",
            "127.0.0.1:0",
            "--token-file",
            tf.to_str().unwrap(),
        ],
    );
    c.env("PI_SPEECH_RECEIVER_PLAYER", &player);
    let mut r = start(c);
    let rep = request(
        r.addr,
        "POST",
        "/v1/play",
        Some(TOKEN),
        &[("Content-Type", "audio/wav")],
        &wav(0.2),
        None,
    );
    assert_eq!(rep.status, 202);
    let pathfile = dir.join("player.log.path");
    assert!(wait_until(Duration::from_secs(3), || pathfile.exists()
        && !std::fs::read_to_string(&pathfile).unwrap().is_empty()));
    signal(&r.child, 15);
    assert_eq!(exit_code_within(&mut r.child, 8), Some(0));
    assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "INT");
    assert!(temp_entries(&dir).is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

fn listening(dir: &Path, env: &[(&str, &Path)]) -> Running {
    let tf = token_file(dir, 0o600);
    let mut c = command(
        dir,
        &[
            "--listen",
            "127.0.0.1:0",
            "--token-file",
            tf.to_str().unwrap(),
        ],
    );
    for (k, v) in env {
        c.env(k, v);
    }
    start(c)
}

const PCM: &[u8] = br#"{"format": "pcm", "rate": 24000, "channels": 1}"#;

#[test]
fn with_only_the_file_player_set_there_is_no_stream_player() {
    let dir = scratch("cli-nostream");
    let player = dir.join("player");
    script(&player, "#!/bin/sh\nexit 0\n");
    let mut r = listening(&dir, &[("PI_SPEECH_RECEIVER_PLAYER", &player)]);
    let rep = request(
        r.addr,
        "POST",
        "/v1/play/stream",
        Some(TOKEN),
        &[],
        PCM,
        None,
    );
    assert_eq!(rep.status, 503, "{}", rep.text());
    assert!(rep.text().contains("PI_SPEECH_RECEIVER_STREAM_PLAYER"));
    signal(&r.child, 15);
    assert_eq!(exit_code_within(&mut r.child, 8), Some(0));
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn sigterm_stops_a_stream_player_during_its_upload() {
    let dir = scratch("cli-stream");
    let log = dir.join("streamer.log");
    let out = dir.join("streamed");
    let streamer = dir.join("streamer");
    script(
        &streamer,
        &format!(
            "#!/bin/bash\ntrap 'echo INT >> {l}; kill $c; exit 130' INT\necho \"$*\" > {l}.args\ncat <&0 > {o} & c=$!; wait $c\n",
            l = log.display(),
            o = out.display()
        ),
    );
    let player = dir.join("player");
    script(&player, "#!/bin/sh\nexit 0\n");
    let mut r = listening(
        &dir,
        &[
            ("PI_SPEECH_RECEIVER_STREAM_PLAYER", &streamer),
            ("PI_SPEECH_RECEIVER_PLAYER", &player),
        ],
    );
    let rep = request(
        r.addr,
        "POST",
        "/v1/play/stream",
        Some(TOKEN),
        &[],
        PCM,
        None,
    );
    assert_eq!(rep.status, 202, "{}", rep.text());
    let id = json_field(&rep.text(), "id").unwrap();
    let mut up = Upload::chunked(r.addr, &id, TOKEN);
    up.chunk(b"spoken words");
    assert!(wait_until(Duration::from_secs(5), || {
        std::fs::read(&out).unwrap_or_default() == b"spoken words"
    }));
    let args = std::fs::read_to_string(dir.join("streamer.log.args")).unwrap();
    assert_eq!(args.trim(), "s16le 24000 1");
    signal(&r.child, 15);
    assert_eq!(exit_code_within(&mut r.child, 8), Some(0));
    assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), "INT");
    assert!(temp_entries(&dir).is_empty());
    drop(up);
    std::fs::remove_dir_all(&dir).ok();
}

fn cpu_seconds(pid: u32) -> f64 {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let f: Vec<&str> = stat
        .rsplit_once(')')
        .unwrap()
        .1
        .split_whitespace()
        .collect();
    let ticks: f64 = f[11].parse::<f64>().unwrap() + f[12].parse::<f64>().unwrap();
    ticks / unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64
}

#[test]
fn out_of_descriptors_the_receiver_backs_off_and_recovers() {
    use std::os::unix::process::CommandExt;
    let dir = scratch("fds");
    let tf = token_file(&dir, 0o600);
    let mut cmd = command(
        &dir,
        &[
            "--listen",
            "127.0.0.1:0",
            "--token-file",
            tf.to_str().unwrap(),
        ],
    );
    unsafe {
        cmd.pre_exec(|| {
            let lim = libc::rlimit {
                rlim_cur: 40,
                rlim_max: 40,
            };
            if libc::setrlimit(libc::RLIMIT_NOFILE, &lim) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut run = start(cmd);
    // More connections than descriptors: the receiver runs dry.
    let hold: Vec<_> = (0..80)
        .filter_map(|_| {
            std::net::TcpStream::connect_timeout(&run.addr, Duration::from_secs(2)).ok()
        })
        .collect();
    std::thread::sleep(Duration::from_millis(800));
    let before = cpu_seconds(run.child.id());
    std::thread::sleep(Duration::from_secs(3));
    let spent = cpu_seconds(run.child.id()) - before;
    assert!(spent < 0.5, "spun for {spent:.2}s of CPU in 3 s");
    drop(hold);
    let mut answered = false;
    wait_until(Duration::from_secs(15), || {
        let r = std::panic::catch_unwind(|| {
            request(run.addr, "GET", "/v1/health", Some(TOKEN), &[], &[], None).status
        });
        answered = matches!(r, Ok(200));
        answered
    });
    assert!(answered, "no answer after the descriptors were free again");
    signal(&run.child, libc::SIGTERM);
    assert_eq!(exit_code_within(&mut run.child, 10), Some(0));
    std::fs::remove_dir_all(dir).ok();
}

// ---- the built-in audio engine, through `serve` ----

/// A receiver with no player or recorder configured and nothing on PATH: whatever plays
/// or records is the receiver itself, on the null audio device.
fn self_contained(dir: &Path, args: &[&str]) -> Running {
    let tf = token_file(dir, 0o600);
    let mut all = args.to_vec();
    all.extend([
        "--listen",
        "127.0.0.1:0",
        "--token-file",
        tf.to_str().unwrap(),
    ]);
    let mut c = command(dir, &all);
    c.env("PATH", "");
    start(c)
}

/// The processes whose parent is `pid`: their ids and command lines.
fn children_of(pid: u32) -> Vec<(u32, Vec<String>)> {
    std::fs::read_dir("/proc")
        .unwrap()
        .filter_map(|e| {
            let e = e.ok()?;
            let child: u32 = e.file_name().to_str()?.parse().ok()?;
            let p = e.path();
            let stat = std::fs::read_to_string(p.join("stat")).ok()?;
            let ppid: u32 = stat
                .rsplit_once(')')?
                .1
                .split_whitespace()
                .nth(1)?
                .parse()
                .ok()?;
            if ppid != pid {
                return None;
            }
            let cmdline = std::fs::read(p.join("cmdline")).ok()?;
            let args = cmdline
                .split(|&b| b == 0)
                .filter(|a| !a.is_empty())
                .map(|a| String::from_utf8_lossy(a).into_owned())
                .collect();
            Some((child, args))
        })
        .collect()
}

fn call(addr: SocketAddr, method: &str, path: &str) -> Reply {
    request(addr, method, path, Some(TOKEN), &[], &[], None)
}

fn final_state(addr: SocketAddr, id: &str) -> String {
    let r = call(addr, "GET", &format!("/v1/play/{id}?wait=10"));
    assert_eq!(r.status, 200, "{}", r.text());
    assert_eq!(json_field(&r.text(), "error"), None, "{}", r.text());
    json_field(&r.text(), "state").unwrap()
}

/// 24 kHz mono s16le PCM.
fn pcm(seconds: f64) -> Vec<u8> {
    (0..(seconds * 24000.0) as usize)
        .flat_map(|i| (((i % 100) as i16 - 50) * 40).to_le_bytes())
        .collect()
}

#[test]
fn with_nothing_configured_and_an_empty_path_serve_plays_and_records_through_itself() {
    let dir = scratch("cli-builtin");
    // Also the explicit `serve` subcommand.
    for args in [&[][..], &["serve"]] {
        let mut r = self_contained(&dir, args);

        // A file.
        let t = std::time::Instant::now();
        let rep = request(
            r.addr,
            "POST",
            "/v1/play",
            Some(TOKEN),
            &[("Content-Type", "audio/wav")],
            &wav(0.4),
            None,
        );
        assert_eq!(rep.status, 202, "{}", rep.text());
        let id = json_field(&rep.text(), "id").unwrap();
        assert_eq!(final_state(r.addr, &id), "completed");
        assert!(
            t.elapsed() >= Duration::from_millis(400),
            "{:?}",
            t.elapsed()
        );

        // A Stream, which plays while its audio is still arriving.
        let rep = request(
            r.addr,
            "POST",
            "/v1/play/stream",
            Some(TOKEN),
            &[],
            PCM,
            None,
        );
        assert_eq!(rep.status, 202, "{}", rep.text());
        let id = json_field(&rep.text(), "id").unwrap();
        let me = BIN.to_string();
        let player = ["play", "s16le", "24000", "1"].map(String::from);
        assert!(wait_until(Duration::from_secs(5), || {
            children_of(r.child.id())
                .iter()
                .any(|(_, c)| c[0] == me && c[1..] == player)
        }));
        let mut up = Upload::chunked(r.addr, &id, TOKEN);
        let audio = pcm(0.6);
        for piece in audio.chunks(4800) {
            up.chunk(piece);
            std::thread::sleep(Duration::from_millis(50));
        }
        let rep = up.end();
        assert_eq!(rep.status, 200, "{}", rep.text());
        assert_eq!(final_state(r.addr, &id), "completed");

        // An MP3 Stream.
        let rep = request(
            r.addr,
            "POST",
            "/v1/play/stream",
            Some(TOKEN),
            &[],
            br#"{"format": "mp3"}"#,
            None,
        );
        assert_eq!(rep.status, 202, "{}", rep.text());
        let id = json_field(&rep.text(), "id").unwrap();
        let mut up = Upload::chunked(r.addr, &id, TOKEN);
        let mp3 = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/fixtures/tone-0.5s-24k.mp3"
        ))
        .unwrap();
        for piece in mp3.chunks(500) {
            up.chunk(piece);
        }
        assert_eq!(up.end().status, 200);
        assert_eq!(final_state(r.addr, &id), "completed");

        // A recording.
        let rep = call(r.addr, "POST", "/v1/record/start");
        assert_eq!(rep.status, 201, "{}", rep.text());
        let id = json_field(&rep.text(), "id").unwrap();
        let recorder = children_of(r.child.id());
        assert!(
            recorder.iter().any(|(_, c)| c[0] == me && c[1] == "record"),
            "{recorder:?}"
        );
        std::thread::sleep(Duration::from_millis(800));
        let rep = call(r.addr, "POST", &format!("/v1/record/{id}/stop"));
        assert_eq!(rep.status, 200, "{}", rep.text());
        let secs = pi_speech_receiver::wav::wav_seconds(&rep.body).unwrap();
        // The receiver answers the start once the recorder has run for 0.5 s.
        assert!((1.2..2.5).contains(&secs), "{secs}");
        assert_eq!(&rep.body[22..24], &1u16.to_le_bytes(), "mono");

        signal(&r.child, 15);
        assert_eq!(exit_code_within(&mut r.child, 8), Some(0));
        assert!(temp_entries(&dir).is_empty());
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_built_in_stream_player_stopped_mid_upload_is_cancelled_and_gone_within_the_grace() {
    let dir = scratch("cli-builtin-stop");
    let mut r = self_contained(&dir, &[]);
    let rep = request(
        r.addr,
        "POST",
        "/v1/play/stream",
        Some(TOKEN),
        &[],
        PCM,
        None,
    );
    let id = json_field(&rep.text(), "id").unwrap();
    let mut up = Upload::chunked(r.addr, &id, TOKEN);
    up.chunk(&pcm(0.3));
    std::thread::sleep(Duration::from_millis(200));
    let players = children_of(r.child.id());
    assert_eq!(players.len(), 1, "one player: {players:?}");
    assert_eq!(players[0].1[..2], [BIN, "play"]);
    let t = std::time::Instant::now();
    let rep = call(r.addr, "POST", "/v1/stop");
    assert!(rep.text().contains("\"stopped\": 1"), "{}", rep.text());
    // Well inside the 2 s grace: it stopped on SIGINT, it was not killed.
    assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
    assert!(wait_until(Duration::from_secs(2), || gone(players[0].0)));
    up.chunk(&pcm(0.3));
    let rep = up.end();
    assert_eq!(json_field(&rep.text(), "state").unwrap(), "cancelled");
    let rep = call(r.addr, "GET", &format!("/v1/play/{id}"));
    assert_eq!(json_field(&rep.text(), "state").unwrap(), "cancelled");
    signal(&r.child, 15);
    assert_eq!(exit_code_within(&mut r.child, 8), Some(0));
    std::fs::remove_dir_all(&dir).ok();
}
