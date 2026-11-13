//! Local models run on this machine for a Pi on the other end of the bridge: `GET
//! /v1/models`, `GET /v1/voices`, `POST /v1/transcribe` and `POST /v1/speak`, with a
//! stand-in models program (a Unix shell script, so Unix only). With `PI_SPEECH_TEST_MODELS`
//! set, one more test runs the real receiver with the real models of the user's cache:
//!
//! PI_SPEECH_AUDIO_NULL=1 PI_SPEECH_TEST_MODELS=~/.cache/pi-speech/models cargo test --test remote_models -- --nocapture
#![cfg(unix)]

mod support;

use pi_speech_receiver::server::{Config, Server};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;
use support::*;

const TOKEN: &str = "test-token-0123456789abcdef0123456789abcdef";

struct Rig {
    _srv: Server,
    addr: SocketAddr,
    dir: PathBuf,
    tmp: PathBuf,
}

impl Rig {
    fn new(max_body: u64) -> Rig {
        let dir = scratch("models");
        let tmp = dir.join("tmp");
        fs::create_dir(&tmp).unwrap();
        let d = dir.display();
        // `speak kokoro` says the format, then "AAAA" and "BBBB"; with "hold" in the text it
        // writes "CC" every 0.1 s until it is killed.
        script(
            &dir.join("models"),
            &format!(
                r#"#!/bin/bash
echo "$*" >> {d}/calls.log
echo $$ > {d}/pid
case "$1" in
  models)
    echo '{{"id":"parakeet","kind":"transcription","downloaded":true}}'
    echo 'not json';;
  transcribe)
    [ "$2" = parakeet ] || {{ echo "pi-speech-receiver: $2 is not downloaded" >&2; exit 1; }}
    echo "$3" > {d}/audio-path
    echo "heard $(wc -c < "$3") bytes";;
  speak)
    if [ "$3" = --list-voices ]; then echo '{{"name":"af_sol","number":0}}'; exit 0; fi
    [ "$2" = kokoro ] || {{ echo '{{"event":"error","message":"the model '"$2"' is not downloaded"}}' >&2; exit 1; }}
    text=$(cat)
    echo "$text" > {d}/spoken
    echo 'a library warning' >&2
    echo '{{"event":"format","rate":24000,"channels":1}}' >&2
    printf AAAA
    case "$text" in *hold*) while :; do printf CC; sleep 0.1; done;; esac
    printf BBBB
    echo '{{"event":"done"}}' >&2;;
esac
"#
            ),
        );
        let mut cfg = Config::new("127.0.0.1:0".parse().unwrap(), TOKEN.into(), tmp.clone());
        cfg.models = Some(dir.join("models"));
        cfg.max_body = max_body;
        let srv = Server::start(cfg).unwrap();
        let addr = srv.local_addr();
        Rig {
            _srv: srv,
            addr,
            dir,
            tmp,
        }
    }

    fn call(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Reply {
        request(self.addr, method, path, Some(TOKEN), headers, body, None)
    }

    fn speak_json(&self, body: &str) -> Reply {
        let r = self.call(
            "POST",
            "/v1/speak",
            &[("Content-Type", "application/json")],
            body.as_bytes(),
        );
        Reply {
            body: if r.head.contains("chunked") {
                dechunk(&r.body).unwrap_or_default()
            } else {
                r.body.clone()
            },
            ..r
        }
    }

    fn pid(&self) -> u32 {
        fs::read_to_string(self.dir.join("pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }
}

/// The data of a chunked body; `None` when it has no terminating chunk (it broke off).
fn dechunk(mut b: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = b.windows(2).position(|w| w == b"\r\n")?;
        let n = usize::from_str_radix(std::str::from_utf8(&b[..line_end]).ok()?, 16).ok()?;
        b = &b[line_end + 2..];
        if n == 0 {
            return Some(out);
        }
        out.extend_from_slice(b.get(..n)?);
        b = b.get(n + 2..)?;
    }
}

/// Start `POST /v1/speak` and read until the answer's head has arrived; the connection.
fn open_speak(addr: SocketAddr, body: &str) -> (TcpStream, String) {
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let req = format!(
        "POST /v1/speak HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(req.as_bytes()).unwrap();
    let mut got = Vec::new();
    let mut buf = [0u8; 256];
    while !got.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = s.read(&mut buf).unwrap();
        assert!(n > 0, "closed before the head");
        got.extend_from_slice(&buf[..n]);
    }
    (s, String::from_utf8_lossy(&got).into_owned())
}

#[test]
fn speak_streams_the_pcm_as_generated_with_its_rate_in_a_header() {
    let r = Rig::new(1 << 20);
    let rep =
        r.speak_json(r#"{"model":"kokoro","voice":"af_sol","speed":1.5,"text":"Hello there."}"#);
    assert_eq!(rep.status, 200, "{}", rep.text());
    assert!(
        rep.head.contains("Transfer-Encoding: chunked"),
        "{}",
        rep.head
    );
    assert!(rep.head.contains("X-Pi-Speech-Rate: 24000"), "{}", rep.head);
    assert!(rep.head.contains("X-Pi-Speech-Channels: 1"), "{}", rep.head);
    assert_eq!(rep.body, b"AAAABBBB");
    assert_eq!(
        fs::read_to_string(r.dir.join("spoken")).unwrap().trim(),
        "Hello there."
    );
    let calls = fs::read_to_string(r.dir.join("calls.log")).unwrap();
    assert!(
        calls.contains("speak kokoro --voice af_sol --speed 1.5"),
        "{calls}"
    );
}

#[test]
fn a_model_that_cannot_run_is_an_error_in_its_own_words_before_any_audio() {
    let r = Rig::new(1 << 20);
    let rep = r.speak_json(r#"{"model":"missing","text":"Hi."}"#);
    assert_eq!(rep.status, 422);
    assert!(
        rep.text().contains("the model missing is not downloaded"),
        "{}",
        rep.text()
    );
    // Ids never reach the program as an option or a path.
    let rep = r.speak_json(r#"{"model":"--list-voices","text":"Hi."}"#);
    assert_eq!(rep.status, 400);
    let rep = r.call(
        "POST",
        "/v1/transcribe?model=whisper",
        &[("Content-Type", "audio/wav")],
        &wav(0.2),
    );
    assert_eq!(rep.status, 422);
    assert!(
        rep.text().contains("whisper is not downloaded"),
        "{}",
        rep.text()
    );
}

#[test]
fn transcribe_runs_the_model_on_the_audio_and_deletes_it() {
    let r = Rig::new(1 << 20);
    let audio = wav(0.5);
    let rep = r.call(
        "POST",
        "/v1/transcribe?model=parakeet",
        &[("Content-Type", "audio/wav")],
        &audio,
    );
    assert_eq!(rep.status, 200, "{}", rep.text());
    assert_eq!(
        json_field(&rep.text(), "text").unwrap(),
        format!("heard {} bytes", audio.len())
    );
    let kept = fs::read_to_string(r.dir.join("audio-path")).unwrap();
    assert!(kept.trim().ends_with(".wav"));
    assert_eq!(fs::read_dir(&r.tmp).unwrap().count(), 0);
    // Audio of another kind, and audio over the body limit, are refused.
    let rep = r.call(
        "POST",
        "/v1/transcribe?model=parakeet",
        &[("Content-Type", "audio/ogg")],
        &audio,
    );
    assert_eq!(rep.status, 415);
    let rep = r.call(
        "POST",
        "/v1/transcribe?model=parakeet",
        &[("Content-Type", "audio/mpeg")],
        &vec![0u8; 2 << 20],
    );
    assert_eq!(rep.status, 413);
}

#[test]
fn one_model_runs_at_a_time_and_a_client_that_leaves_stops_it() {
    let r = Rig::new(1 << 20);
    let (held, head) = open_speak(r.addr, r#"{"model":"kokoro","text":"hold on"}"#);
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    let busy = r.speak_json(r#"{"model":"kokoro","text":"Next."}"#);
    assert_eq!(busy.status, 409, "{}", busy.text());
    let busy = r.call(
        "POST",
        "/v1/transcribe?model=parakeet",
        &[("Content-Type", "audio/wav")],
        &wav(0.2),
    );
    assert_eq!(busy.status, 409);
    // Listing is not a model run.
    assert_eq!(r.call("GET", "/v1/models", &[], &[]).status, 200);
    let pid = r.pid();
    drop(held);
    assert!(
        wait_until(Duration::from_secs(5), || gone(pid)),
        "the speech still runs"
    );
    assert!(wait_until(Duration::from_secs(5), || {
        r.speak_json(r#"{"model":"kokoro","text":"Again."}"#).status == 200
    }));
}

#[test]
fn models_and_voices_list_this_machine_s_models_and_need_the_token() {
    let r = Rig::new(1 << 20);
    let rep = r.call("GET", "/v1/models", &[], &[]);
    assert_eq!(rep.status, 200);
    let v: serde_json::Value = serde_json::from_slice(&rep.body).unwrap();
    assert_eq!(v["models"][0]["id"], "parakeet");
    assert_eq!(v["models"].as_array().unwrap().len(), 1);
    let rep = r.call("GET", "/v1/voices?model=kokoro", &[], &[]);
    let v: serde_json::Value = serde_json::from_slice(&rep.body).unwrap();
    assert_eq!(v["voices"][0]["name"], "af_sol");
    for (method, path) in [
        ("GET", "/v1/models"),
        ("POST", "/v1/speak"),
        ("POST", "/v1/transcribe?model=parakeet"),
    ] {
        let rep = request(r.addr, method, path, Some("wrong"), &[], b"{}", None);
        assert_eq!(rep.status, 401, "{path}");
    }
    assert!(!r.dir.join("spoken").exists());
}

/// The real receiver, with the real models in the user's cache: Piper speaks a sentence
/// over the bridge, and Parakeet transcribes it back.
#[test]
fn real_models_speak_and_transcribe_over_the_bridge() {
    let Some(models) = std::env::var_os("PI_SPEECH_TEST_MODELS") else {
        eprintln!("skipped: PI_SPEECH_TEST_MODELS is not set");
        return;
    };
    let dir = scratch("real-models");
    let token_file = dir.join("token");
    fs::write(&token_file, format!("{TOKEN}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&token_file, fs::Permissions::from_mode(0o600)).unwrap();
    }
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_pi-speech-receiver"))
        .args(["--listen", "127.0.0.1:0", "--token-file"])
        .arg(&token_file)
        .env("PI_SPEECH_MODELS_DIR", &models)
        .env("PI_SPEECH_AUDIO_NULL", "1")
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(child.stdout.take().unwrap()),
        &mut line,
    )
    .unwrap();
    let addr: SocketAddr = line
        .trim()
        .trim_start_matches("listening ")
        .parse()
        .unwrap();
    let call = |method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]| {
        request(addr, method, path, Some(TOKEN), headers, body, None)
    };
    let rep = call(
        "POST",
        "/v1/speak",
        &[],
        br#"{"model":"piper-en_US-lessac-medium","text":"The weather is lovely today."}"#,
    );
    assert_eq!(rep.status, 200, "{}", rep.text());
    let rate: u32 = rep
        .head
        .lines()
        .find_map(|l| l.strip_prefix("X-Pi-Speech-Rate: "))
        .unwrap()
        .parse()
        .unwrap();
    let pcm = dechunk(&rep.body).expect("the speech ended properly");
    assert!(pcm.len() > rate as usize, "under 0.5 s of speech");
    let mut w = b"RIFF".to_vec();
    w.extend((36 + pcm.len() as u32).to_le_bytes());
    w.extend(b"WAVEfmt ");
    w.extend(16u32.to_le_bytes());
    w.extend(1u16.to_le_bytes());
    w.extend(1u16.to_le_bytes());
    w.extend(rate.to_le_bytes());
    w.extend((rate * 2).to_le_bytes());
    w.extend(2u16.to_le_bytes());
    w.extend(16u16.to_le_bytes());
    w.extend(b"data");
    w.extend((pcm.len() as u32).to_le_bytes());
    w.extend(&pcm);
    let rep = call(
        "POST",
        "/v1/transcribe?model=parakeet-tdt-0.6b-v3-int8",
        &[("Content-Type", "audio/wav")],
        &w,
    );
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(rep.status, 200, "{}", rep.text());
    let text = json_field(&rep.text(), "text").unwrap().to_lowercase();
    eprintln!("heard: {text}");
    assert!(text.contains("weather"), "{text}");
}
