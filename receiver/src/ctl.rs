//! Local control client (`pi-speech-receiver ctl`) for the HTTP bridge.
//!
//! Intended for child-process integrations like Zellij sidebar plugins (`jing.wasm` via
//! `run_command`), which need one-shot JSON commands to query status/levels, control
//! dictation recording, or trigger/stop playback without managing raw TCP sockets.

use crate::http::json_str;
use crate::private;
use crate::server::DEFAULT_PORT;
use crate::token;
use serde_json::Value;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

pub const USAGE: &str = "pi-speech-receiver ctl [--url URL] [--token-file PATH] <status|stop|record <start|stop [ID]|cancel [ID]>|speak [--model ID] [--voice ID] [--speed F] [--text TEXT]>";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeState {
    pub pid: u32,
    pub url: String,
    pub token_file: Option<String>,
}

/// `$XDG_CONFIG_HOME/pi-speech/receiver.state.json`, or `~/.config/pi-speech/receiver.state.json`.
pub fn default_state_path() -> io::Result<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => std::env::home_dir()
            .ok_or_else(|| io::Error::other("cannot find a home directory for the state file"))?
            .join(".config"),
    };
    Ok(base.join("pi-speech").join("receiver.state.json"))
}

pub fn write_serve_state(path: &Path, state: &ServeState) -> io::Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    private::dir().recursive(true).create(dir)?;
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    let tf = match &state.token_file {
        Some(p) => json_str(p),
        None => "null".to_string(),
    };
    let body = format!(
        "{{\"pid\":{},\"url\":{},\"token_file\":{tf}}}\n",
        state.pid,
        json_str(&state.url)
    );
    let mut f = private::file()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)?;
    f.write_all(body.as_bytes())?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)
}

pub fn read_serve_state(path: &Path) -> Option<ServeState> {
    let text = fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let pid = v.get("pid")?.as_u64()? as u32;
    let url = v.get("url")?.as_str()?.to_string();
    let token_file = v
        .get("token_file")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    Some(ServeState {
        pid,
        url,
        token_file,
    })
}

pub struct StateGuard {
    path: Option<PathBuf>,
    pid: u32,
}

impl StateGuard {
    pub fn register(url: &str, token_file: Option<&Path>) -> Self {
        let pid = std::process::id();
        let path = default_state_path().ok();
        if let Some(ref p) = path {
            let state = ServeState {
                pid,
                url: url.to_string(),
                token_file: token_file.map(|t| t.display().to_string()),
            };
            let _ = write_serve_state(p, &state);
        }
        Self { path, pid }
    }
}

impl Drop for StateGuard {
    fn drop(&mut self) {
        if let Some(ref p) = self.path {
            if read_serve_state(p).is_some_and(|s| s.pid == self.pid) {
                let _ = fs::remove_file(p);
            }
        }
    }
}

#[derive(Debug, PartialEq)]
enum Command {
    Status,
    Stop,
    RecordStart,
    RecordStop(Option<String>),
    RecordCancel(Option<String>),
    Speak {
        model: Option<String>,
        voice: Option<String>,
        speed: Option<f64>,
        text: Option<String>,
    },
}

struct ParsedArgs {
    url: Option<String>,
    token_file: Option<PathBuf>,
    command: Command,
}

fn parse_args(args: &[String]) -> Result<ParsedArgs, String> {
    let mut url = None;
    let mut token_file = None;
    let mut rest = Vec::new();
    let mut it = args.iter().cloned();
    while let Some(a) = it.next() {
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(v.to_string())),
            _ => (a.clone(), None),
        };
        match name.as_str() {
            "--url" => {
                let v = inline
                    .or_else(|| it.next())
                    .ok_or_else(|| "--url needs a value".to_string())?;
                url = Some(v);
            }
            "--token-file" => {
                let v = inline
                    .or_else(|| it.next())
                    .ok_or_else(|| "--token-file needs a value".to_string())?;
                token_file = Some(PathBuf::from(v));
            }
            "-h" | "--help" => return Err(format!("usage: {USAGE}")),
            _ => {
                rest.push(a);
                rest.extend(it);
                break;
            }
        }
    }
    let command = match rest.first().map(String::as_str) {
        Some("status") if rest.len() == 1 => Command::Status,
        Some("stop") if rest.len() == 1 => Command::Stop,
        Some("record") => match rest.get(1).map(String::as_str) {
            Some("start") if rest.len() == 2 => Command::RecordStart,
            Some("stop") if rest.len() <= 3 => Command::RecordStop(rest.get(2).cloned()),
            Some("cancel") if rest.len() <= 3 => Command::RecordCancel(rest.get(2).cloned()),
            _ => return Err(format!("usage: {USAGE}")),
        },
        Some("speak") => parse_speak(&rest[1..])?,
        _ => return Err(format!("usage: {USAGE}")),
    };
    Ok(ParsedArgs {
        url,
        token_file,
        command,
    })
}

fn parse_speak(args: &[String]) -> Result<Command, String> {
    let mut model = None;
    let mut voice = None;
    let mut speed = None;
    let mut text = None;
    let mut it = args.iter().cloned();
    while let Some(a) = it.next() {
        let (name, inline) = match a.split_once('=') {
            Some((n, v)) if n.starts_with("--") => (n.to_string(), Some(v.to_string())),
            _ => (a, None),
        };
        let mut val = |what: &str| {
            inline
                .clone()
                .or_else(|| it.next())
                .ok_or_else(|| format!("{what} needs a value"))
        };
        match name.as_str() {
            "--model" => model = Some(val("--model")?),
            "--voice" => voice = Some(val("--voice")?),
            "--speed" => {
                let s = val("--speed")?;
                let f: f64 = s
                    .parse()
                    .map_err(|_| format!("--speed must be a number, got {s:?}"))?;
                if !f.is_finite() || f <= 0.0 {
                    return Err("--speed must be positive".to_string());
                }
                speed = Some(f);
            }
            "--text" => text = Some(val("--text")?),
            other => return Err(format!("unknown speak option {other:?}\nusage: {USAGE}")),
        }
    }
    Ok(Command::Speak {
        model,
        voice,
        speed,
        text,
    })
}

fn resolve_target(
    url_opt: Option<String>,
    token_file_opt: Option<PathBuf>,
    state_path: Option<&Path>,
) -> Result<(String, String), String> {
    let state = state_path.and_then(read_serve_state);
    let env_url = std::env::var("PI_SPEECH_BRIDGE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let url = url_opt
        .or(env_url)
        .or_else(|| state.as_ref().map(|s| s.url.clone()))
        .unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}"));
    let url = url.trim_end_matches('/').to_string();

    let token_path = match token_file_opt {
        Some(p) => p,
        None => match state.and_then(|s| s.token_file) {
            Some(p) => PathBuf::from(p),
            None => token::default_token_path().map_err(|e| e.to_string())?,
        },
    };
    let tok = token::read_token(&token_path).map_err(|e| e.to_string())?;
    Ok((url, tok))
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(30))
        .build()
}

fn request(
    agent: &ureq::Agent,
    method: &str,
    url: &str,
    token: &str,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let auth = format!("Bearer {token}");
    let res = match (method, body) {
        ("GET", _) => agent.get(url).set("Authorization", &auth).call(),
        ("POST", Some(b)) => agent
            .post(url)
            .set("Authorization", &auth)
            .set("Content-Type", "application/json")
            .send_string(b),
        ("POST", None) => agent.post(url).set("Authorization", &auth).call(),
        _ => return Err(format!("unsupported method {method}")),
    };
    match res {
        Ok(resp) => {
            let status = resp.status();
            let text = resp
                .into_string()
                .map_err(|e| format!("cannot read response from {url}: {e}"))?;
            Ok((status, text))
        }
        Err(ureq::Error::Status(status, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Ok((status, text))
        }
        Err(e) => Err(format!("request to {url} failed: {e}")),
    }
}

fn active_recording_id(agent: &ureq::Agent, base: &str, token: &str) -> Result<String, String> {
    let (status, body) = request(agent, "GET", &format!("{base}/v1/status"), token, None)?;
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}: {body}"));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("invalid status JSON: {e}"))?;
    v.get("recording")
        .and_then(|r| r.get("id"))
        .and_then(|id| id.as_str())
        .map(str::to_string)
        .ok_or_else(|| "no active recording".to_string())
}

fn run(args: &[String]) -> Result<String, String> {
    let parsed = parse_args(args)?;
    let state_path = default_state_path().ok();
    let (base, tok) = resolve_target(parsed.url, parsed.token_file, state_path.as_deref())?;
    let a = agent();
    let (status, body) = match parsed.command {
        Command::Status => request(&a, "GET", &format!("{base}/v1/status"), &tok, None)?,
        Command::Stop => request(&a, "POST", &format!("{base}/v1/stop"), &tok, None)?,
        Command::RecordStart => {
            request(&a, "POST", &format!("{base}/v1/record/start"), &tok, None)?
        }
        Command::RecordStop(id) => {
            let id = match id {
                Some(id) => id,
                None => active_recording_id(&a, &base, &tok)?,
            };
            request(
                &a,
                "POST",
                &format!("{base}/v1/record/{id}/stop"),
                &tok,
                None,
            )?
        }
        Command::RecordCancel(id) => {
            let id = match id {
                Some(id) => id,
                None => active_recording_id(&a, &base, &tok)?,
            };
            request(
                &a,
                "POST",
                &format!("{base}/v1/record/{id}/cancel"),
                &tok,
                None,
            )?
        }
        Command::Speak {
            model,
            voice,
            speed,
            text,
        } => {
            let text = match text {
                Some(t) => t,
                None => {
                    let mut buf = String::new();
                    io::stdin()
                        .read_to_string(&mut buf)
                        .map_err(|e| format!("cannot read stdin: {e}"))?;
                    buf
                }
            };
            if text.trim().is_empty() {
                return Err("speak text cannot be empty".to_string());
            }
            let mut fields = vec![format!("\"text\":{}", json_str(&text))];
            if let Some(m) = model {
                fields.push(format!("\"model\":{}", json_str(&m)));
            }
            if let Some(v) = voice {
                fields.push(format!("\"voice\":{}", json_str(&v)));
            }
            if let Some(s) = speed {
                fields.push(format!("\"speed\":{s}"));
            }
            let payload = format!("{{{}}}", fields.join(","));
            request(&a, "POST", &format!("{base}/v1/speak"), &tok, Some(&payload))?
        }
    };
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}: {body}"));
    }
    Ok(body)
}

pub fn main(args: &[String]) -> ExitCode {
    match run(args) {
        Ok(body) => {
            println!("{body}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("pi-speech-receiver ctl: {e}");
            ExitCode::from(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{Config, Server};
    use std::net::SocketAddr;

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("pisr-ctl-{name}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn parses_ctl_subcommands() {
        let s = |xs: &[&str]| xs.iter().map(|s| (*s).to_string()).collect::<Vec<_>>();
        assert_eq!(parse_args(&s(&["status"])).unwrap().command, Command::Status);
        assert_eq!(parse_args(&s(&["stop"])).unwrap().command, Command::Stop);
        assert_eq!(
            parse_args(&s(&["record", "start"])).unwrap().command,
            Command::RecordStart
        );
        assert_eq!(
            parse_args(&s(&["record", "stop"])).unwrap().command,
            Command::RecordStop(None)
        );
        assert_eq!(
            parse_args(&s(&["record", "stop", "rec-1"])).unwrap().command,
            Command::RecordStop(Some("rec-1".into()))
        );
        assert_eq!(
            parse_args(&s(&["record", "cancel", "rec-2"]))
                .unwrap()
                .command,
            Command::RecordCancel(Some("rec-2".into()))
        );
        assert_eq!(
            parse_args(&s(&["speak", "--voice", "af_heart", "--speed", "1.2", "--text", "hi"]))
                .unwrap()
                .command,
            Command::Speak {
                model: None,
                voice: Some("af_heart".into()),
                speed: Some(1.2),
                text: Some("hi".into()),
            }
        );
        assert!(parse_args(&s(&["bogus"])).is_err());
    }

    #[test]
    fn state_file_round_trip() {
        let dir = temp_dir("state");
        let path = dir.join("receiver.state.json");
        let state = ServeState {
            pid: 42,
            url: "http://127.0.0.1:47613".to_string(),
            token_file: Some("/tmp/receiver.token".to_string()),
        };
        write_serve_state(&path, &state).unwrap();
        assert_eq!(read_serve_state(&path), Some(state));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn ctl_status_and_stop_against_live_server() {
        let dir = temp_dir("live");
        fs::create_dir_all(&dir).unwrap();
        let token_path = dir.join("receiver.token");
        let tok = "a".repeat(40);
        private::file()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&token_path)
            .unwrap()
            .write_all(tok.as_bytes())
            .unwrap();

        let tmp = dir.join("tmp");
        fs::create_dir_all(&tmp).unwrap();
        let addr: SocketAddr = "127.0.0.1:0".parse().unwrap();
        let srv = Server::start(Config::new(addr, tok, tmp)).unwrap();
        let url = format!("http://{}", srv.local_addr());

        let args = vec![
            "--url".to_string(),
            url.clone(),
            "--token-file".to_string(),
            token_path.display().to_string(),
            "status".to_string(),
        ];
        let body = run(&args).unwrap();
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["protocol"], 1);
        assert_eq!(v["name"], "pi-speech-receiver");
        assert_eq!(v["playing"], false);
        assert!(v["recording"].is_null());

        let stop_args = vec![
            "--url".to_string(),
            url,
            "--token-file".to_string(),
            token_path.display().to_string(),
            "stop".to_string(),
        ];
        let stop_body = run(&stop_args).unwrap();
        let sv: Value = serde_json::from_str(&stop_body).unwrap();
        assert_eq!(sv["stopped"], 0);

        srv.shutdown();
        let _ = fs::remove_dir_all(&dir);
    }
}
