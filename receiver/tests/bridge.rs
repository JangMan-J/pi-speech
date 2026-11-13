//! The bridge, end to end over HTTP, with fake player and recorder programs.
//!
//! The fake programs are Unix shell scripts that log the SIGINT they get, so the tests
//! that run them are Unix only. The rest (authentication, request checks, the front
//! door's deadlines and fairness, shutdown) run everywhere; on Windows the players and
//! recorders are covered with the built-in engine in `cli.rs`.

mod support;

use pi_speech_receiver::server::{Config, Server};
use std::fs;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;
use support::*;

const TOKEN: &str = "test-token-0123456789abcdef0123456789abcdef";

struct Rig {
    srv: Server,
    addr: SocketAddr,
    dir: PathBuf,
    tmp: PathBuf,
}

// Some helpers serve only the tests that run the fake programs, which are Unix only.
#[cfg_attr(windows, allow(dead_code))]
impl Rig {
    fn new() -> Rig {
        Rig::with(|_| {})
    }

    fn with(tweak: impl FnOnce(&mut Config)) -> Rig {
        let dir = scratch("rig");
        let tmp = dir.join("tmp");
        fs::create_dir(&tmp).unwrap();
        let fake_wav = dir.join("fixture.wav");
        fs::write(&fake_wav, wav(1.0)).unwrap();
        let d = dir.display();
        script(
            &dir.join("player"),
            &format!(
                r#"#!/bin/bash
trap 'echo "signal INT" >> {d}/player.log; kill $c 2>/dev/null; exit 130' INT
echo "start $1" >> {d}/player.log
cp "$1" {d}/last-played
mode=$(cat {d}/player-mode 2>/dev/null || echo ok)
case "$mode" in
  ok) sleep 0.2 & c=$!; wait $c; exit 0;;
  long) sleep 30 & c=$!; wait $c; exit 0;;
  fail) echo "no audio device here" >&2; exit 3;;
esac
"#
            ),
        );
        script(
            &dir.join("recorder"),
            &format!(
                r#"#!/bin/bash
mode=$(cat {d}/recorder-mode 2>/dev/null || echo ok)
trap 'echo "signal INT" >> {d}/recorder.log; [ "$mode" = slowstop ] && sleep 1.7; if [ "$mode" = empty ]; then cp {d}/empty.wav "$1"; else cp {d}/fixture.wav "$1"; fi; exit 0' INT
echo "start $1" >> {d}/recorder.log
case "$mode" in
  fail) echo "no such audio device" >&2; exit 1;;
  die) sleep 0.8; echo "stream error" >&2; exit 2;;
esac
while :; do sleep 0.05 & wait $!; done
"#
            ),
        );
        fs::write(dir.join("empty.wav"), wav(0.0)).unwrap();
        // Plays a Stream: appends its input to `streamed` as it arrives.
        script(
            &dir.join("streamer"),
            &format!(
                r#"#!/bin/bash
echo "start $*" >> {d}/streamer.log
echo $$ >> {d}/streamer.pids
trap 'echo "signal INT" >> {d}/streamer.log; kill $c 2>/dev/null; exit 130' INT
mode=$(cat {d}/streamer-mode 2>/dev/null || echo ok)
case "$mode" in
  ok) cat <&0 >> {d}/streamed & c=$!;;
  early) head -c 4 <&0 >> {d}/streamed & c=$!;;
  fail) cat <&0 > /dev/null & c=$!;;
  deaf) sleep 30 & c=$!;;
esac
echo $c >> {d}/streamer.pids
wait $c
[ "$mode" = fail ] && {{ echo "no audio device here" >&2; exit 3; }}
exit 0
"#
            ),
        );
        let mut cfg = Config::new("127.0.0.1:0".parse().unwrap(), TOKEN.into(), tmp.clone());
        cfg.player = Some(dir.join("player"));
        cfg.stream_player = Some(dir.join("streamer"));
        cfg.recorder = Some(dir.join("recorder"));
        tweak(&mut cfg);
        let srv = Server::start(cfg).unwrap();
        let addr = srv.local_addr();
        Rig {
            srv,
            addr,
            dir,
            tmp,
        }
    }

    fn mode(&self, who: &str, mode: &str) {
        fs::write(self.dir.join(format!("{who}-mode")), mode).unwrap();
    }

    fn log(&self, who: &str) -> Vec<String> {
        fs::read_to_string(self.dir.join(format!("{who}.log")))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    fn started(&self, who: &str) -> Vec<PathBuf> {
        self.log(who)
            .iter()
            .filter_map(|l| l.strip_prefix("start ").map(PathBuf::from))
            .collect()
    }

    fn call(&self, method: &str, path: &str) -> Reply {
        request(self.addr, method, path, Some(TOKEN), &[], &[], None)
    }

    fn play_with(&self, ctype: &str, body: &[u8]) -> Reply {
        request(
            self.addr,
            "POST",
            "/v1/play",
            Some(TOKEN),
            &[("Content-Type", ctype)],
            body,
            None,
        )
    }

    fn play(&self) -> String {
        let r = self.play_with("audio/wav", &wav(0.2));
        assert_eq!(r.status, 202, "{}", r.text());
        json_field(&r.text(), "id").unwrap()
    }

    fn state(&self, id: &str, wait: u32) -> String {
        let r = self.call("GET", &format!("/v1/play/{id}?wait={wait}"));
        assert_eq!(r.status, 200, "{}", r.text());
        json_field(&r.text(), "state").unwrap()
    }

    fn record_start(&self) -> Reply {
        self.call("POST", "/v1/record/start")
    }

    fn files_in_tmp(&self) -> usize {
        fs::read_dir(&self.tmp).map(|d| d.count()).unwrap_or(0)
    }

    fn stream_with(&self, body: &str) -> Reply {
        request(
            self.addr,
            "POST",
            "/v1/play/stream",
            Some(TOKEN),
            &[("Content-Type", "application/json")],
            body.as_bytes(),
            None,
        )
    }

    /// Start a 24 kHz mono PCM Stream; its id.
    fn stream(&self) -> String {
        let r = self.stream_with(PCM);
        assert_eq!(r.status, 202, "{}", r.text());
        json_field(&r.text(), "id").unwrap()
    }

    /// What the Stream players have received so far.
    fn streamed(&self) -> Vec<u8> {
        fs::read(self.dir.join("streamed")).unwrap_or_default()
    }

    /// Processes of the Stream players started so far (the script and its child).
    fn stream_pids(&self) -> Vec<u32> {
        fs::read_to_string(self.dir.join("streamer.pids"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| l.trim().parse().ok())
            .collect()
    }

    #[cfg(unix)]
    fn no_stream_player_left(&self) -> bool {
        wait_until(Duration::from_secs(5), || {
            self.stream_pids().into_iter().all(gone)
        })
    }

    fn upload(&self, id: &str) -> Upload {
        Upload::chunked(self.addr, id, TOKEN)
    }

    fn state_and_error(&self, id: &str, wait: u32) -> (String, String) {
        let t = self
            .call("GET", &format!("/v1/play/{id}?wait={wait}"))
            .text();
        (json_field(&t, "state").unwrap(), t)
    }
}

const PCM: &str = r#"{"format": "pcm", "rate": 24000, "channels": 1}"#;

impl Drop for Rig {
    fn drop(&mut self) {
        self.srv.shutdown();
        fs::remove_dir_all(&self.dir).ok();
    }
}

#[test]
fn every_endpoint_rejects_a_missing_or_wrong_token_without_effect() {
    let r = Rig::new();
    let wrong = format!("{}x", TOKEN);
    for tok in [None, Some("wrong"), Some(wrong.as_str()), Some("")] {
        for (m, p) in [
            ("GET", "/v1/health"),
            ("POST", "/v1/play"),
            ("POST", "/v1/stop"),
            ("POST", "/v1/record/start"),
            ("GET", "/v1/nothing"),
        ] {
            let ct = [("Content-Type", "audio/wav")];
            let rep = request(r.addr, m, p, tok, &ct, &wav(0.2), None);
            assert_eq!(rep.status, 401, "{m} {p} {tok:?}");
            assert!(rep.text().contains("\"error\""));
        }
    }
    assert!(r.log("player").is_empty());
    assert!(r.log("recorder").is_empty());
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
fn health_reports_protocol_and_capabilities() {
    let r = Rig::new();
    let rep = r.call("GET", "/v1/health");
    assert_eq!(rep.status, 200);
    let t = rep.text();
    assert!(t.contains("\"protocol\": 1"));
    assert!(t.contains("\"name\": \"pi-speech-receiver\""));
    assert!(t.contains("\"capabilities\": [\"play\", \"record\", \"stream\"]"));
}

#[test]
fn unknown_endpoint_is_404_with_error_body() {
    let r = Rig::new();
    let rep = r.call("GET", "/v1/nope");
    assert_eq!(rep.status, 404);
    assert!(rep.text().contains("\"error\""));
    assert_eq!(r.call("GET", "/v1/play/deadbeef").status, 404);
    assert_eq!(r.call("POST", "/v1/play/deadbeef/cancel").status, 404);
    assert_eq!(r.call("POST", "/v1/record/deadbeef/stop").status, 404);
    assert_eq!(r.call("POST", "/v1/record/deadbeef/cancel").status, 404);
}

#[test]
#[cfg(unix)]
fn completed_only_when_the_player_exits_zero_and_the_file_is_deleted() {
    let r = Rig::new();
    let audio = wav(0.2);
    let rep = r.play_with("audio/wav", &audio);
    assert_eq!(rep.status, 202);
    let id = json_field(&rep.text(), "id").unwrap();
    assert_eq!(r.state(&id, 10), "completed");
    assert_eq!(fs::read(r.dir.join("last-played")).unwrap(), audio);
    let paths = r.started("player");
    assert_eq!(paths.len(), 1);
    assert!(paths[0].starts_with(&r.tmp));
    assert!(wait_until(Duration::from_secs(3), || !paths[0].exists()));
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
#[cfg(unix)]
fn mp3_is_accepted_and_kind_header_is_checked() {
    let r = Rig::new();
    let mp3 = [b"ID3\x04\0\0\0\0\0\0".as_slice(), &[0u8; 64]].concat();
    let ok = request(
        r.addr,
        "POST",
        "/v1/play",
        Some(TOKEN),
        &[
            ("Content-Type", "audio/mpeg"),
            ("X-Pi-Speech-Kind", "sample"),
        ],
        &mp3,
        None,
    );
    assert_eq!(ok.status, 202, "{}", ok.text());
    let id = json_field(&ok.text(), "id").unwrap();
    assert_eq!(r.state(&id, 10), "completed");
    let bad = request(
        r.addr,
        "POST",
        "/v1/play",
        Some(TOKEN),
        &[("Content-Type", "audio/wav"), ("X-Pi-Speech-Kind", "shell")],
        &wav(0.2),
        None,
    );
    assert_eq!(bad.status, 400);
}

#[test]
fn bytes_that_are_not_the_declared_audio_are_415_and_never_play() {
    let r = Rig::new();
    assert_eq!(
        r.play_with("audio/wav", b"hello world, not audio").status,
        415
    );
    assert_eq!(r.play_with("audio/mpeg", &wav(0.2)).status, 415);
    let empty = request(
        r.addr,
        "POST",
        "/v1/play",
        Some(TOKEN),
        &[("Content-Type", "audio/wav")],
        b"",
        Some(0),
    );
    assert_eq!(empty.status, 415);
    assert_eq!(r.play_with("text/plain", &wav(0.2)).status, 415);
    assert!(r.log("player").is_empty());
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
fn a_truncated_upload_is_400_and_never_plays() {
    let r = Rig::new();
    let audio = wav(0.5);
    let rep = request(
        r.addr,
        "POST",
        "/v1/play",
        Some(TOKEN),
        &[("Content-Type", "audio/wav")],
        &audio[..audio.len() / 2],
        Some(audio.len()),
    );
    assert_eq!(rep.status, 400);
    assert!(r.log("player").is_empty());
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
fn missing_content_length_is_400() {
    let r = Rig::new();
    let rep = request(
        r.addr,
        "POST",
        "/v1/play",
        Some(TOKEN),
        &[("Content-Type", "audio/wav")],
        b"",
        None,
    );
    assert_eq!(rep.status, 400);
    assert!(r.log("player").is_empty());
}

#[test]
#[cfg(unix)]
fn oversized_body_is_413_and_never_plays() {
    let r = Rig::with(|c| c.max_body = 1000);
    let big = [wav(0.2), vec![0u8; 5000]].concat();
    assert_eq!(r.play_with("audio/wav", &big).status, 413);
    assert!(r.log("player").is_empty());
    assert_eq!(r.play_with("audio/wav", &wav(0.01)).status, 202);
}

#[test]
#[cfg(unix)]
fn a_new_play_cancels_the_one_in_progress() {
    let r = Rig::new();
    r.mode("player", "long");
    let first = r.play();
    assert!(wait_until(Duration::from_secs(3), || r
        .started("player")
        .len()
        == 1));
    r.mode("player", "ok");
    let second = r.play();
    assert_eq!(r.state(&first, 0), "cancelled");
    assert_eq!(r.state(&second, 10), "completed");
    assert!(r.log("player").iter().any(|l| l == "signal INT"));
}

#[test]
#[cfg(unix)]
fn player_failure_is_failed_with_its_error_text() {
    let r = Rig::new();
    r.mode("player", "fail");
    let id = r.play();
    let rep = r.call("GET", &format!("/v1/play/{id}?wait=10"));
    let t = rep.text();
    assert_eq!(json_field(&t, "state").unwrap(), "failed");
    assert!(t.contains("status 3"), "{t}");
    assert!(t.contains("no audio device here"), "{t}");
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
fn missing_player_is_503() {
    let r = Rig::with(|c| c.player = Some("/nonexistent/player".into()));
    let rep = r.play_with("audio/wav", &wav(0.2));
    assert_eq!(rep.status, 503);
    assert!(rep.text().contains("\"error\""));
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
#[cfg(unix)]
fn cancel_and_stop_mark_playback_cancelled() {
    let r = Rig::new();
    r.mode("player", "long");
    let id = r.play();
    assert!(wait_until(Duration::from_secs(3), || r
        .started("player")
        .len()
        == 1));
    let rep = r.call("POST", &format!("/v1/play/{id}/cancel"));
    assert_eq!(rep.status, 200);
    assert_eq!(json_field(&rep.text(), "state").unwrap(), "cancelled");
    assert_eq!(r.state(&id, 0), "cancelled");

    let id2 = r.play();
    assert!(wait_until(Duration::from_secs(3), || r
        .started("player")
        .len()
        == 2));
    let rep = r.call("POST", "/v1/stop");
    assert_eq!(rep.status, 200);
    assert!(rep.text().contains("\"stopped\": 1"), "{}", rep.text());
    assert_eq!(r.state(&id2, 0), "cancelled");
    assert!(r.call("POST", "/v1/stop").text().contains("\"stopped\": 0"));
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
#[cfg(unix)]
fn wait_returns_at_the_deadline_while_still_playing() {
    let r = Rig::new();
    r.mode("player", "long");
    let id = r.play();
    let t = std::time::Instant::now();
    assert_eq!(r.state(&id, 1), "playing");
    assert!(t.elapsed() >= Duration::from_millis(900));
    assert_eq!(
        r.call("GET", &format!("/v1/play/{id}?wait=abc")).status,
        400
    );
}

#[test]
#[cfg(unix)]
fn record_start_stop_returns_wav_and_deletes_it() {
    let r = Rig::new();
    let rep = r.record_start();
    assert_eq!(rep.status, 201, "{}", rep.text());
    let id = json_field(&rep.text(), "id").unwrap();
    assert!(rep.text().contains("\"max_seconds\": 300"));
    assert_eq!(r.record_start().status, 409);
    let stop = r.call("POST", &format!("/v1/record/{id}/stop"));
    assert_eq!(stop.status, 200);
    assert!(stop
        .head
        .to_ascii_lowercase()
        .contains("content-type: audio/wav"));
    assert_eq!(wav_len(&stop.body), 16000);
    let path = &r.started("recorder")[0];
    assert!(path.starts_with(&r.tmp));
    assert!(!path.exists());
    assert_eq!(r.call("POST", &format!("/v1/record/{id}/stop")).status, 404);
    // A new recording may start once the previous one is collected.
    assert_eq!(r.record_start().status, 201);
}

#[test]
#[cfg(unix)]
fn record_cancel_deletes_the_recording() {
    let r = Rig::new();
    let id = json_field(&r.record_start().text(), "id").unwrap();
    let rep = r.call("POST", &format!("/v1/record/{id}/cancel"));
    assert_eq!(rep.status, 200);
    assert_eq!(json_field(&rep.text(), "state").unwrap(), "cancelled");
    assert!(!r.started("recorder")[0].exists());
    assert_eq!(r.call("POST", &format!("/v1/record/{id}/stop")).status, 404);
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
#[cfg(unix)]
fn recorder_that_cannot_start_is_503_with_its_message() {
    let r = Rig::new();
    r.mode("recorder", "fail");
    let rep = r.record_start();
    assert_eq!(rep.status, 503);
    assert!(
        rep.text().contains("no such audio device"),
        "{}",
        rep.text()
    );
    r.mode("recorder", "ok");
    assert_eq!(
        r.record_start().status,
        201,
        "a failed start leaves nothing active"
    );

    let r = Rig::with(|c| c.recorder = Some("/nonexistent/recorder".into()));
    assert_eq!(r.record_start().status, 503);
}

#[test]
#[cfg(unix)]
fn empty_recording_is_422_and_deleted() {
    let r = Rig::new();
    r.mode("recorder", "empty");
    let id = json_field(&r.record_start().text(), "id").unwrap();
    let rep = r.call("POST", &format!("/v1/record/{id}/stop"));
    assert_eq!(rep.status, 422);
    assert!(!r.started("recorder")[0].exists());
    assert_eq!(r.call("POST", &format!("/v1/record/{id}/stop")).status, 404);
}

#[test]
#[cfg(unix)]
fn recorder_crash_while_recording_is_503_with_its_message() {
    let r = Rig::new();
    r.mode("recorder", "die");
    let rep = r.record_start();
    assert_eq!(rep.status, 201, "{}", rep.text());
    let id = json_field(&rep.text(), "id").unwrap();
    std::thread::sleep(Duration::from_millis(1300));
    let stop = r.call("POST", &format!("/v1/record/{id}/stop"));
    assert_eq!(stop.status, 503);
    assert!(stop.text().contains("stream error"), "{}", stop.text());
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
#[cfg(unix)]
fn recording_stops_itself_at_the_time_limit_and_is_dropped_if_uncollected() {
    let r = Rig::with(|c| {
        c.max_record_seconds = 1;
        c.pickup = Duration::from_millis(1500);
    });
    let rep = r.record_start();
    assert!(rep.text().contains("\"max_seconds\": 1"));
    let first = json_field(&rep.text(), "id").unwrap();
    assert!(wait_until(Duration::from_secs(5), || r
        .log("recorder")
        .iter()
        .any(|l| l == "signal INT")));
    // Collected after the automatic stop: still returned.
    let stop = r.call("POST", &format!("/v1/record/{first}/stop"));
    assert_eq!(stop.status, 200);
    assert_eq!(wav_len(&stop.body), 16000);

    // Never collected: deleted after the pickup time.
    let second = json_field(&r.record_start().text(), "id").unwrap();
    let path = r.started("recorder")[1].clone();
    assert!(wait_until(Duration::from_secs(5), || path.exists()));
    assert!(wait_until(Duration::from_secs(6), || !path.exists()));
    assert_eq!(
        r.call("POST", &format!("/v1/record/{second}/stop")).status,
        404
    );
}

#[test]
#[cfg(unix)]
fn shutdown_stops_players_and_recorders_and_removes_the_directory() {
    let r = Rig::new();
    r.mode("player", "long");
    r.play();
    assert!(wait_until(Duration::from_secs(3), || r
        .started("player")
        .len()
        == 1));
    assert_eq!(r.record_start().status, 201);
    r.srv.shutdown();
    let log = r.log("player");
    assert!(log.iter().any(|l| l == "signal INT"), "{log:?}");
    assert!(r.log("recorder").iter().any(|l| l == "signal INT"));
    assert!(!r.tmp.exists());
}

#[test]
fn only_loopback_addresses_are_accepted() {
    for a in ["0.0.0.0:0", "192.168.1.5:0", "127.0.0.2:0", "[::]:0"] {
        let cfg = Config::new(a.parse().unwrap(), TOKEN.into(), scratch("lb"));
        assert!(Server::start(cfg).is_err(), "{a}");
    }
}

// ---- hardening ----

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Instant;

fn health_within(addr: SocketAddr, secs: u64) -> (u16, Duration) {
    let t0 = Instant::now();
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(secs))).unwrap();
    write!(
        s,
        "GET /v1/health HTTP/1.1\r\nAuthorization: Bearer {TOKEN}\r\n\r\n"
    )
    .unwrap();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let status = if raw.is_empty() {
        0
    } else {
        parse_reply(raw).status
    };
    (status, t0.elapsed())
}

#[test]
fn a_request_head_dripped_byte_by_byte_is_cut_off_at_the_deadline_with_408() {
    let r = Rig::with(|c| c.head_timeout = Duration::from_millis(600));
    let mut s = TcpStream::connect(r.addr).unwrap();
    s.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
    s.write_all(b"GET /v1/health HTTP/1.1\r\n").unwrap();
    let t0 = Instant::now();
    let mut raw = Vec::new();
    let mut buf = [0u8; 512];
    loop {
        // Each byte arrives well inside any per-read timeout; only a whole-head deadline stops it.
        let _ = s.write_all(b"X");
        match s.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
            Err(_) => {}
        }
        assert!(t0.elapsed() < Duration::from_secs(5), "never cut off");
    }
    let took = t0.elapsed();
    assert!(took >= Duration::from_millis(500), "{took:?}");
    assert!(took < Duration::from_secs(3), "{took:?}");
    assert_eq!(parse_reply(raw).status, 408);
}

#[test]
fn an_idle_connection_gets_408_when_the_head_deadline_passes() {
    let r = Rig::with(|c| c.head_timeout = Duration::from_millis(300));
    let mut s = TcpStream::connect(r.addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut raw = Vec::new();
    let _ = s.read_to_end(&mut raw);
    let rep = parse_reply(raw);
    assert_eq!(rep.status, 408);
    assert!(rep.text().contains("\"error\""));
}

#[test]
fn many_idle_and_slow_connections_do_not_delay_a_request() {
    let r = Rig::new();
    let idle: Vec<TcpStream> = (0..300)
        .map(|_| TcpStream::connect(r.addr).unwrap())
        .collect();
    let slow: Vec<TcpStream> = (0..20)
        .map(|_| {
            let mut s = TcpStream::connect(r.addr).unwrap();
            s.write_all(b"GET /v1/health HTTP/1.1\r\nHost: x\r\n")
                .unwrap();
            s
        })
        .collect();
    std::thread::sleep(Duration::from_millis(300));
    let (status, took) = health_within(r.addr, 10);
    assert_eq!(status, 200);
    assert!(took < Duration::from_secs(2), "{took:?}");
    drop((idle, slow));
}

#[test]
fn a_slow_request_does_not_hold_up_another_and_still_completes() {
    let r = Rig::new();
    let mut s = TcpStream::connect(r.addr).unwrap();
    s.write_all(format!("GET /v1/health HTTP/1.1\r\nAuthorization: Bearer {TOKEN}\r\n").as_bytes())
        .unwrap();
    assert_eq!(health_within(r.addr, 10).0, 200);
    s.write_all(b"\r\n").unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    assert_eq!(parse_reply(raw).status, 200);
}

#[test]
#[cfg(unix)]
fn a_body_that_arrives_with_the_head_is_not_lost() {
    let r = Rig::new();
    let audio = wav(0.2);
    let mut req = format!(
        "POST /v1/play HTTP/1.1\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\n\r\n",
        audio.len()
    )
    .into_bytes();
    req.extend_from_slice(&audio);
    let mut s = TcpStream::connect(r.addr).unwrap();
    s.write_all(&req).unwrap(); // head and body in one segment
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    assert_eq!(parse_reply(raw).status, 202);
    assert!(wait_until(Duration::from_secs(5), || r
        .dir
        .join("last-played")
        .exists()));
    assert_eq!(fs::read(r.dir.join("last-played")).unwrap(), audio);
}

// Unix only: it times uploads against the deletion of 50,000 files, far slower on NTFS.
#[test]
#[cfg(unix)]
fn no_audio_is_stored_once_shutdown_is_deleting_the_directory() {
    const FILLER: usize = 50_000;
    let r = Rig::new();
    // Many files make the directory's removal slow, so uploads can finish while it runs.
    for i in 0..FILLER {
        fs::write(r.tmp.join(format!("filler-{i}")), b"").unwrap();
    }
    let audio = wav(0.1);
    // Uploads whose head passed the receiver's checks and whose bodies are still to come.
    let mut uploads: Vec<TcpStream> = (0..6)
        .map(|_| {
            let mut s = TcpStream::connect(r.addr).unwrap();
            let head = format!(
                "POST /v1/play HTTP/1.1\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: audio/wav\r\nContent-Length: {}\r\n\r\n",
                audio.len()
            );
            s.write_all(head.as_bytes()).unwrap();
            s.write_all(&audio[..10]).unwrap();
            s
        })
        .collect();
    std::thread::sleep(Duration::from_millis(300));
    let names = |tmp: &PathBuf| -> Option<Vec<String>> {
        Some(
            fs::read_dir(tmp)
                .ok()?
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
        )
    };
    let mut late = std::collections::BTreeSet::new();
    std::thread::scope(|s| {
        let down = s.spawn(|| r.srv.shutdown());
        // Once fillers start disappearing, shutdown holds its locks and is deleting.
        let mut snapshot: Option<Vec<String>> = None;
        let mut sent = false;
        while let Some(now) = names(&r.tmp) {
            let fillers = now.iter().filter(|n| n.starts_with("filler-")).count();
            match &snapshot {
                None if fillers < FILLER => snapshot = Some(now),
                None => {}
                Some(before) => {
                    if !sent {
                        sent = true;
                        for u in &mut uploads {
                            u.write_all(&audio[10..]).unwrap();
                        }
                    }
                    late.extend(
                        now.into_iter()
                            .filter(|n| n.starts_with("play-") && !before.contains(n)),
                    );
                }
            }
            if down.is_finished() {
                break;
            }
        }
        down.join().unwrap();
    });
    assert!(late.is_empty(), "audio stored during shutdown: {late:?}");
    assert!(!r.tmp.exists() || r.files_in_tmp() == 0);
    assert!(r.log("player").is_empty(), "a player was started");
}

#[test]
fn a_play_after_shutdown_is_503_and_stores_nothing() {
    let r = Rig::new();
    r.srv.shutdown();
    // The listener may already be closed; either way nothing may be stored.
    let res = std::panic::catch_unwind(|| r.play_with("audio/wav", &wav(0.2)).status);
    if let Ok(status) = res {
        assert_eq!(status, 503);
    }
    assert!(!r.tmp.exists() || r.files_in_tmp() == 0);
}

#[test]
#[cfg(unix)]
fn a_recorder_that_finishes_just_inside_the_grace_period_is_a_clean_stop() {
    let r = Rig::new();
    r.mode("recorder", "slowstop");
    let rep = r.record_start();
    assert_eq!(rep.status, 201, "{}", rep.text());
    let id = json_field(&rep.text(), "id").unwrap();
    let rep = r.call("POST", &format!("/v1/record/{id}/stop"));
    assert_eq!(rep.status, 200, "{}", rep.text());
    assert!(wav_len(&rep.body) > 0);
}

// ---- Streams ----

#[test]
#[cfg(unix)]
fn a_stream_player_gets_each_piece_before_the_client_has_sent_the_rest() {
    let r = Rig::new();
    let id = r.stream();
    assert_eq!(r.state(&id, 0), "playing");
    let mut up = r.upload(&id);
    up.chunk(b"first piece|");
    // The key check: the first piece is played while the request is still open.
    assert!(
        wait_until(Duration::from_secs(5), || r.streamed() == b"first piece|"),
        "the player did not get the first piece before the rest was sent"
    );
    up.chunk(b"second|");
    up.chunk(&[7u8; 100_000]);
    let rep = up.end();
    assert_eq!(rep.status, 200, "{}", rep.text());
    assert_eq!(json_field(&rep.text(), "id").unwrap(), id);
    assert!(["playing", "completed"].contains(&json_field(&rep.text(), "state").unwrap().as_str()));
    assert_eq!(r.state(&id, 10), "completed");
    let want = [b"first piece|second|".to_vec(), vec![7u8; 100_000]].concat();
    assert_eq!(r.streamed(), want);
    assert!(r.no_stream_player_left());
    assert_eq!(r.files_in_tmp(), 0);
}

#[test]
#[cfg(unix)]
fn a_stream_player_gets_the_format_as_its_arguments() {
    let r = Rig::new();
    for (body, args) in [
        (PCM, "s16le 24000 1"),
        (
            r#"{"format": "pcm", "rate": 48000, "channels": 2}"#,
            "s16le 48000 2",
        ),
        (r#"{"format": "mp3"}"#, "mp3"),
        (r#"{"format": "wav"}"#, "wav"),
    ] {
        let rep = request(
            r.addr,
            "POST",
            "/v1/play/stream",
            Some(TOKEN),
            &[("X-Pi-Speech-Kind", "sample")],
            body.as_bytes(),
            None,
        );
        assert_eq!(rep.status, 202, "{body}: {}", rep.text());
        let id = json_field(&rep.text(), "id").unwrap();
        assert_eq!(r.upload(&id).end().status, 200);
        assert_eq!(r.state(&id, 10), "completed");
        assert_eq!(r.log("streamer").last().unwrap(), &format!("start {args}"));
    }
    assert!(
        r.log("player").is_empty(),
        "the file player is never used for a Stream"
    );
}

#[test]
#[cfg(unix)]
fn a_content_length_audio_body_also_plays_as_it_arrives() {
    let r = Rig::new();
    let id = r.stream();
    let audio = b"0123456789abcdefghij";
    let mut up = Upload::open_with(
        r.addr,
        &id,
        Some(TOKEN),
        &format!("Content-Length: {}\r\n", audio.len()),
    );
    up.0.write_all(&audio[..8]).unwrap();
    assert!(wait_until(Duration::from_secs(5), || r.streamed() == audio[..8]));
    up.0.write_all(&audio[8..]).unwrap();
    let rep = up.reply();
    assert_eq!(rep.status, 200, "{}", rep.text());
    assert_eq!(r.state(&id, 10), "completed");
    assert_eq!(r.streamed(), audio);
}

#[test]
#[cfg(unix)]
fn a_stop_cancel_or_newer_play_during_the_upload_ends_the_stream_cancelled() {
    for how in ["stop", "cancel", "file play", "stream"] {
        let r = Rig::new();
        let id = r.stream();
        let mut up = r.upload(&id);
        up.chunk(b"piece one");
        assert!(wait_until(Duration::from_secs(5), || r.streamed() == b"piece one"));
        let pids = r.stream_pids();
        match how {
            "stop" => {
                let rep = r.call("POST", "/v1/stop");
                assert!(rep.text().contains("\"stopped\": 1"), "{}", rep.text());
            }
            "cancel" => {
                let rep = r.call("POST", &format!("/v1/play/{id}/cancel"));
                assert_eq!(json_field(&rep.text(), "state").unwrap(), "cancelled");
            }
            "file play" => {
                r.play();
            }
            _ => {
                r.stream();
            }
        }
        assert_eq!(r.state(&id, 0), "cancelled", "{how}");
        assert!(r.log("streamer").iter().any(|l| l == "signal INT"), "{how}");
        assert!(
            wait_until(Duration::from_secs(5), || pids.iter().all(|&p| gone(p))),
            "{how}: the player is still running"
        );
        // The rest of the body is read and dropped; the answer is the cancelled state.
        up.chunk(b"piece two");
        up.chunk(&[0u8; 300_000]);
        let rep = up.end();
        assert_eq!(rep.status, 200, "{how}: {}", rep.text());
        assert_eq!(
            json_field(&rep.text(), "state").unwrap(),
            "cancelled",
            "{how}"
        );
        assert_eq!(r.streamed(), b"piece one", "{how}");
    }
}

#[test]
#[cfg(unix)]
fn a_stop_frees_an_upload_held_up_by_a_player_that_does_not_read() {
    let r = Rig::new();
    r.mode("streamer", "deaf");
    let id = r.stream();
    let addr = r.addr;
    let sender = std::thread::spawn(move || {
        let mut up = Upload::chunked(addr, &id, TOKEN);
        // Far more than a pipe holds: the receiver is soon stuck writing to the player.
        up.chunk(&vec![1u8; 4 << 20]);
        (id, up.end())
    });
    std::thread::sleep(Duration::from_millis(500));
    let t0 = Instant::now();
    assert!(r.call("POST", "/v1/stop").text().contains("\"stopped\": 1"));
    let (id, rep) = sender.join().unwrap();
    assert_eq!(rep.status, 200, "{}", rep.text());
    assert_eq!(json_field(&rep.text(), "state").unwrap(), "cancelled");
    assert!(t0.elapsed() < Duration::from_secs(10), "{:?}", t0.elapsed());
    assert_eq!(r.state(&id, 0), "cancelled");
    assert!(r.no_stream_player_left());
}

#[test]
#[cfg(unix)]
fn an_upload_that_breaks_off_fails_the_stream_and_leaves_no_player() {
    for how in ["closed mid-chunk", "malformed chunk", "no byte in time"] {
        let r = Rig::with(|c| c.stream_idle = Duration::from_millis(700));
        let id = r.stream();
        let mut up = r.upload(&id);
        up.0.write_all(b"20\r\nonly part of it").unwrap();
        assert!(wait_until(Duration::from_secs(5), || r.streamed()
            == b"only part of it"));
        match how {
            "closed mid-chunk" => drop(up),
            "malformed chunk" => {
                up.0.write_all(b" and the rest!!\r\nzz\r\n").unwrap();
                let rep = up.reply();
                assert_eq!(rep.status, 400, "{}", rep.text());
            }
            _ => {
                let t0 = Instant::now();
                let rep = up.reply();
                assert_eq!(rep.status, 400, "{}", rep.text());
                assert!(
                    t0.elapsed() >= Duration::from_millis(600),
                    "{:?}",
                    t0.elapsed()
                );
            }
        }
        let (state, text) = r.state_and_error(&id, 10);
        assert_eq!(state, "failed", "{how}: {text}");
        assert!(text.contains("\"error\""), "{how}: {text}");
        assert!(r.no_stream_player_left(), "{how}");
        assert_eq!(r.files_in_tmp(), 0);
    }
}

#[test]
#[cfg(unix)]
fn audio_past_the_body_limit_is_413_and_fails_the_stream() {
    let r = Rig::with(|c| c.max_body = 1000);
    let id = r.stream();
    let mut up = r.upload(&id);
    up.chunk(&[1u8; 600]);
    up.chunk(&[2u8; 600]);
    let rep = up.reply();
    assert_eq!(rep.status, 413, "{}", rep.text());
    assert_eq!(r.state(&id, 10), "failed");
    assert!(r.streamed().len() <= 600);

    let id = r.stream();
    let rep = Upload::open_with(r.addr, &id, Some(TOKEN), "Content-Length: 1001\r\n").reply();
    assert_eq!(rep.status, 413, "{}", rep.text());
    assert_eq!(r.state(&id, 10), "failed");
    assert!(r.no_stream_player_left());
}

#[test]
#[cfg(unix)]
fn a_stream_whose_audio_never_begins_fails() {
    let r = Rig::with(|c| c.stream_start = Duration::from_millis(600));
    let id = r.stream();
    let (state, text) = r.state_and_error(&id, 10);
    assert_eq!(state, "failed", "{text}");
    assert!(text.contains("no audio"), "{text}");
    assert!(r.no_stream_player_left());
    assert_eq!(r.upload(&id).reply().status, 409);

    // Audio that begins in time may take longer than that in all.
    let id = r.stream();
    let mut up = r.upload(&id);
    for _ in 0..5 {
        up.chunk(b"x");
        std::thread::sleep(Duration::from_millis(250));
    }
    assert_eq!(up.end().status, 200);
    assert_eq!(r.state(&id, 10), "completed");
}

#[test]
#[cfg(unix)]
fn a_player_that_ends_early_does_not_upset_the_upload() {
    let r = Rig::new();
    r.mode("streamer", "early");
    let id = r.stream();
    let mut up = r.upload(&id);
    up.chunk(b"abcdefgh");
    // The player takes 4 bytes and exits; writing the rest meets a closed pipe.
    up.chunk(&[0u8; 1 << 20]);
    up.chunk(b"more");
    let rep = up.end();
    assert_eq!(rep.status, 200, "{}", rep.text());
    assert_eq!(json_field(&rep.text(), "state").unwrap(), "completed");
    assert_eq!(r.streamed(), b"abcd");
    assert_eq!(r.call("GET", "/v1/health").status, 200);
}

#[test]
#[cfg(unix)]
fn a_stream_player_failure_is_failed_with_its_error_text() {
    let r = Rig::new();
    r.mode("streamer", "fail");
    let id = r.stream();
    let mut up = r.upload(&id);
    up.chunk(b"audio");
    assert_eq!(up.end().status, 200);
    let (state, text) = r.state_and_error(&id, 10);
    assert_eq!(state, "failed");
    assert!(
        text.contains("status 3") && text.contains("no audio device here"),
        "{text}"
    );
}

#[test]
#[cfg(unix)]
fn stream_requests_are_checked() {
    let r = Rig::new();
    // Without the right token: 401 and no effect.
    for tok in [None, Some("wrong")] {
        let rep = request(
            r.addr,
            "POST",
            "/v1/play/stream",
            tok,
            &[],
            PCM.as_bytes(),
            None,
        );
        assert_eq!(rep.status, 401);
    }
    assert!(r.log("streamer").is_empty());
    let id = r.stream();
    for tok in [None, Some("wrong")] {
        let up = Upload::open_with(r.addr, &id, tok, "Transfer-Encoding: chunked\r\n");
        assert_eq!(up.reply().status, 401);
    }
    // Unknown ids, a body without framing, and a coding other than chunked.
    assert_eq!(r.upload("deadbeefdeadbeef").reply().status, 404);
    assert_eq!(
        Upload::open_with(r.addr, &id, Some(TOKEN), "")
            .reply()
            .status,
        400
    );
    let gz = Upload::open_with(r.addr, &id, Some(TOKEN), "Transfer-Encoding: gzip\r\n");
    assert_eq!(gz.reply().status, 400);
    // None of that used up the Stream: its audio request works, and only once.
    let mut first = r.upload(&id);
    first.chunk(b"abc");
    assert!(wait_until(Duration::from_secs(5), || r.streamed() == b"abc"));
    let second = r.upload(&id).reply();
    assert_eq!(second.status, 409, "{}", second.text());
    assert!(second.text().contains("\"error\""));
    assert_eq!(first.end().status, 200);
    assert_eq!(r.state(&id, 10), "completed");
    assert_eq!(r.upload(&id).reply().status, 409, "no longer playing");
    // A file playback takes no audio request.
    r.mode("player", "long");
    let file = r.play();
    assert_eq!(r.upload(&file).reply().status, 409);

    for body in [
        "",
        "{}",
        r#"{"format": "ogg"}"#,
        r#"{"format": "pcm", "rate": 7999, "channels": 1}"#,
        r#"{"format": "pcm", "rate": 192001, "channels": 1}"#,
        r#"{"format": "pcm", "rate": 24000, "channels": 3}"#,
        r#"{"format": "pcm", "rate": 24000}"#,
        r#"{"format": "mp3", "command": "rm"}"#,
        "not json",
    ] {
        let rep = r.stream_with(body);
        assert_eq!(rep.status, 400, "{body:?}: {}", rep.text());
        assert!(rep.text().contains("\"error\""));
    }
    let kind = request(
        r.addr,
        "POST",
        "/v1/play/stream",
        Some(TOKEN),
        &[("X-Pi-Speech-Kind", "shell")],
        PCM.as_bytes(),
        None,
    );
    assert_eq!(kind.status, 400);
    assert_eq!(
        r.log("streamer")
            .iter()
            .filter(|l| l.starts_with("start"))
            .count(),
        1
    );
    assert_eq!(
        r.state(&file, 0),
        "playing",
        "refused requests stop nothing"
    );
}

#[test]
#[cfg(unix)]
fn a_chunked_stream_request_body_is_accepted() {
    let r = Rig::new();
    let mut s = TcpStream::connect(r.addr).unwrap();
    let mut req = format!(
        "POST /v1/play/stream HTTP/1.1\r\nAuthorization: Bearer {TOKEN}\r\nTransfer-Encoding: chunked\r\n\r\n"
    )
    .into_bytes();
    req.extend(chunk_frame(&PCM.as_bytes()[..10]));
    req.extend(chunk_frame(&PCM.as_bytes()[10..]));
    req.extend(b"0\r\n\r\n");
    s.write_all(&req).unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    assert_eq!(parse_reply(raw).status, 202);
}

#[test]
#[cfg(unix)]
fn no_stream_player_when_only_the_file_player_is_configured() {
    let r = Rig::with(|c| c.stream_player = None);
    let rep = r.stream_with(PCM);
    assert_eq!(rep.status, 503, "{}", rep.text());
    assert!(
        rep.text().contains("PI_SPEECH_RECEIVER_STREAM_PLAYER"),
        "{}",
        rep.text()
    );
    // The file player still works, and the 503 stopped nothing.
    r.mode("player", "long");
    let id = r.play();
    assert_eq!(r.stream_with(r#"{"format": "mp3"}"#).status, 503);
    assert_eq!(r.state(&id, 0), "playing");

    let r = Rig::with(|c| c.stream_player = Some("/nonexistent/streamer".into()));
    let rep = r.stream_with(PCM);
    assert_eq!(rep.status, 503);
    assert!(rep.text().contains("\"error\""));
}

#[test]
#[cfg(unix)]
fn a_stream_stops_the_file_playback_in_progress() {
    let r = Rig::new();
    r.mode("player", "long");
    let file = r.play();
    assert!(wait_until(Duration::from_secs(3), || r
        .started("player")
        .len()
        == 1));
    let id = r.stream();
    assert_eq!(r.state(&file, 0), "cancelled");
    assert!(r.log("player").iter().any(|l| l == "signal INT"));
    assert_eq!(r.state(&id, 0), "playing");
}

#[test]
#[cfg(unix)]
fn shutdown_stops_stream_players_and_leaves_no_files() {
    for uploading in [false, true] {
        let r = Rig::new();
        let id = r.stream();
        // The script and its child are listed once its INT trap is set.
        assert!(wait_until(Duration::from_secs(5), || r.stream_pids().len() == 2));
        let mut up = r.upload(&id);
        if uploading {
            up.chunk(b"something");
            assert!(wait_until(Duration::from_secs(5), || r.streamed() == b"something"));
        }
        r.srv.shutdown();
        let ints = r
            .log("streamer")
            .iter()
            .filter(|l| *l == "signal INT")
            .count();
        assert_eq!(ints, 1, "uploading: {uploading}");
        assert!(r.no_stream_player_left(), "uploading: {uploading}");
        assert!(!r.tmp.exists());
        drop(up);
    }
}

#[test]
fn without_a_configured_program_or_the_built_in_engine_everything_is_503() {
    let r = Rig::with(|c| {
        c.player = None;
        c.stream_player = None;
        c.recorder = None;
        c.engine = None;
    });
    for rep in [
        r.play_with("audio/wav", &wav(0.2)),
        r.stream_with(PCM),
        r.record_start(),
    ] {
        assert_eq!(rep.status, 503, "{}", rep.text());
        assert!(
            rep.text().contains("built-in audio engine"),
            "{}",
            rep.text()
        );
    }
    assert_eq!(r.files_in_tmp(), 0);
}
