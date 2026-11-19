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

pub const USAGE: &str = "pi-speech-receiver ctl [--url URL] [--token-file PATH] <status|stop|record <start|stop [ID]|cancel [ID]>|dictate stop [ID]|speak [--model ID] [--voice ID] [--speed F] [--text TEXT]>";

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
    DictateStop(Option<String>),
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
        Some("dictate") => match rest.get(1).map(String::as_str) {
            Some("stop") if rest.len() <= 3 => Command::DictateStop(rest.get(2).cloned()),
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

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct PiSettings {
    bridge_address: Option<String>,
    token_file: Option<String>,
    local_speech_model: Option<String>,
    local_speech_voice: Option<String>,
    local_transcription_model: Option<String>,
}

fn zellij_config_path() -> Option<PathBuf> {
    let config = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => std::env::home_dir()?.join(".config"),
    };
    Some(config.join("zellij").join("pi-speech.json"))
}

fn pi_settings_path() -> Option<PathBuf> {
    let agent_dir = match std::env::var_os("PI_CODING_AGENT_DIR") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => std::env::home_dir()?.join(".pi").join("agent"),
    };
    Some(agent_dir.join("pi-speech").join("settings.json"))
}

fn read_pi_settings(path: Option<&Path>) -> PiSettings {
    let Some(path) = path else {
        return PiSettings::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return PiSettings::default();
    };
    let Ok(v) = serde_json::from_str::<Value>(&text) else {
        return PiSettings::default();
    };
    let str_of = |keys: &[&str]| {
        keys.iter().find_map(|k| {
            v.get(*k)
                .and_then(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
    };
    PiSettings {
        bridge_address: str_of(&["url", "bridgeAddress", "speech_url"]),
        token_file: str_of(&["tokenFile", "token_file", "speech_token_file"]),
        local_speech_model: str_of(&["model", "localSpeechModel", "speech_model"]),
        local_speech_voice: str_of(&["voice", "localSpeechVoice", "speech_voice"]),
        local_transcription_model: str_of(&[
            "sttModel",
            "localTranscriptionModel",
            "speech_stt_model",
        ]),
    }
}

fn merge_settings(primary: PiSettings, fallback: PiSettings) -> PiSettings {
    PiSettings {
        bridge_address: primary.bridge_address.or(fallback.bridge_address),
        token_file: primary.token_file.or(fallback.token_file),
        local_speech_model: primary.local_speech_model.or(fallback.local_speech_model),
        local_speech_voice: primary.local_speech_voice.or(fallback.local_speech_voice),
        local_transcription_model: primary
            .local_transcription_model
            .or(fallback.local_transcription_model),
    }
}

fn address_url(raw: &str) -> String {
    let a = raw.trim().trim_end_matches('/');
    let with_scheme = if a.starts_with("http://") || a.starts_with("https://") {
        a.to_string()
    } else {
        format!("http://{a}")
    };
    let after_scheme = with_scheme
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(&with_scheme);
    let has_port = if let Some((_, rest)) = after_scheme.rsplit_once("]:") {
        !rest.is_empty()
    } else if after_scheme.contains('[') {
        false
    } else {
        after_scheme.contains(':')
    };
    if has_port {
        with_scheme
    } else {
        format!("{with_scheme}:{DEFAULT_PORT}")
    }
}

fn bridge_token_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("PI_SPEECH_BRIDGE_TOKEN_FILE").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(p));
    }
    let config = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => std::env::home_dir()?.join(".config"),
    };
    Some(config.join("pi-speech").join("bridge.token"))
}

fn resolve_target(
    url_opt: Option<String>,
    token_file_opt: Option<PathBuf>,
    state_path: Option<&Path>,
    pi: &PiSettings,
) -> Result<(String, Vec<String>), String> {
    let state = state_path.and_then(read_serve_state);
    let env_url = std::env::var("PI_SPEECH_BRIDGE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let paired_url = pi.bridge_address.as_deref().map(address_url);
    let has_local_state = state.is_some();
    let url = url_opt
        .or(paired_url)
        .or(env_url)
        .or_else(|| state.as_ref().map(|s| s.url.clone()))
        .unwrap_or_else(|| format!("http://127.0.0.1:{DEFAULT_PORT}"));
    let url = url.trim_end_matches('/').to_string();

    if let Some(p) = token_file_opt.or_else(|| pi.token_file.as_ref().map(PathBuf::from)) {
        let tok = token::read_token(&p).map_err(|e| e.to_string())?;
        return Ok((url, vec![tok]));
    }
    if let Some(direct) = std::env::var("PI_SPEECH_BRIDGE_TOKEN")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return Ok((url, vec![direct]));
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if has_local_state {
        if let Some(p) = state.and_then(|s| s.token_file) {
            candidates.push(PathBuf::from(p));
        }
        if let Ok(r) = token::default_token_path() {
            candidates.push(r);
        }
        if let Some(b) = bridge_token_path() {
            candidates.push(b);
        }
    } else {
        // SSH forwards and paired bridges authenticate with bridge.token first.
        if let Some(b) = bridge_token_path() {
            candidates.push(b);
        }
        if let Ok(r) = token::default_token_path() {
            candidates.push(r);
        }
    }
    let mut tokens = Vec::new();
    let mut last_err = None;
    for path in candidates {
        match token::read_token(&path) {
            Ok(tok) => {
                if !tokens.contains(&tok) {
                    tokens.push(tok);
                }
            }
            Err(e) => last_err = Some(e.to_string()),
        }
    }
    if tokens.is_empty() {
        return Err(last_err.unwrap_or_else(|| "no receiver or bridge token found".to_string()));
    }
    Ok((url, tokens))
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

fn request_bytes(
    agent: &ureq::Agent,
    method: &str,
    url: &str,
    token: &str,
    content_type: Option<&str>,
    body: Option<&[u8]>,
) -> Result<(u16, Vec<u8>), String> {
    let auth = format!("Bearer {token}");
    let res = match (method, body) {
        ("GET", _) => agent.get(url).set("Authorization", &auth).call(),
        ("POST", Some(b)) => {
            let mut req = agent.post(url).set("Authorization", &auth);
            if let Some(ct) = content_type {
                req = req.set("Content-Type", ct);
            }
            req.send_bytes(b)
        }
        ("POST", None) => agent.post(url).set("Authorization", &auth).call(),
        _ => return Err(format!("unsupported method {method}")),
    };
    let read_body = |resp: ureq::Response| -> Result<Vec<u8>, String> {
        let mut buf = Vec::new();
        resp.into_reader()
            .read_to_end(&mut buf)
            .map_err(|e| format!("cannot read response from {url}: {e}"))?;
        Ok(buf)
    };
    match res {
        Ok(resp) => {
            let status = resp.status();
            Ok((status, read_body(resp)?))
        }
        Err(ureq::Error::Status(status, resp)) => Ok((status, read_body(resp).unwrap_or_default())),
        Err(e) => Err(format!("request to {url} failed: {e}")),
    }
}

fn recording_id_path() -> Option<PathBuf> {
    let config = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => std::env::home_dir()?.join(".config"),
    };
    Some(config.join("pi-speech").join("recording.id"))
}

fn save_recording_id(id: &str) {
    let Some(path) = recording_id_path() else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = private::dir().recursive(true).create(dir);
    }
    if let Ok(mut f) = private::file().write(true).create(true).truncate(true).open(&path) {
        let _ = f.write_all(id.as_bytes());
    }
}

fn read_saved_recording_id() -> Option<String> {
    let path = recording_id_path()?;
    let s = fs::read_to_string(path).ok()?;
    let id = s.trim().to_string();
    (!id.is_empty()).then_some(id)
}

fn clear_recording_id() {
    if let Some(path) = recording_id_path() {
        let _ = fs::remove_file(path);
    }
}

fn default_model_of_kind(
    agent: &ureq::Agent,
    base: &str,
    token: &str,
    kind: &str,
) -> Result<String, String> {
    let (status, body) = request(agent, "GET", &format!("{base}/v1/models"), token, None)?;
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}: {body}"));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("invalid models JSON: {e}"))?;
    v.get("models")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .find(|m| {
            let k = m.get("kind").and_then(|k| k.as_str());
            let kind_ok = if kind == "stt" {
                matches!(k, Some("stt" | "transcription"))
            } else {
                matches!(k, Some("tts" | "speech"))
            };
            kind_ok && m.get("downloaded").and_then(|d| d.as_bool()) == Some(true)
        })
        .and_then(|m| m.get("id").and_then(|id| id.as_str()))
        .map(str::to_string)
        .ok_or_else(|| {
            format!("no downloaded local {kind} model; choose one in Pi or pass --model")
        })
}

fn default_tts_model(agent: &ureq::Agent, base: &str, token: &str) -> Result<String, String> {
    default_model_of_kind(agent, base, token, "tts")
}

fn fetch_status(agent: &ureq::Agent, base: &str, tok: &str) -> Result<(u16, String), String> {
    let (status, body) = request(agent, "GET", &format!("{base}/v1/status"), tok, None)?;
    if status != 404 {
        return Ok((status, body));
    }
    // Older receivers (0.3.0 / 0.3.1) lack /v1/status; fall back to /v1/health + /v1/levels.
    let (h_status, h_body) = request(agent, "GET", &format!("{base}/v1/health"), tok, None)?;
    if !(200..300).contains(&h_status) {
        return Ok((h_status, h_body));
    }
    let (l_status, l_body) = request(agent, "GET", &format!("{base}/v1/levels"), tok, None)?;
    let health: Value =
        serde_json::from_str(&h_body).map_err(|e| format!("invalid health JSON: {e}"))?;
    let levels: Value = if (200..300).contains(&l_status) {
        serde_json::from_str(&l_body).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    let playing = levels
        .get("playing")
        .and_then(|x| x.as_array())
        .is_some();
    let recording = levels
        .get("recording")
        .and_then(|x| x.as_array())
        .is_some();
    let version = health
        .get("version")
        .and_then(|x| x.as_str())
        .unwrap_or("");
    let edition = health
        .get("edition")
        .and_then(|x| x.as_str())
        .unwrap_or("cpu");
    let rec_json = if recording { "{\"id\":\"active\"}" } else { "null" };
    let synthesized = format!(
        "{{\"protocol\":1,\"name\":\"pi-speech-receiver\",\"version\":{},\"edition\":{},\"playing\":{playing},\"playingCount\":{},\"recording\":{rec_json},\"levels\":{}}}",
        json_str(version),
        json_str(edition),
        usize::from(playing),
        levels
    );
    Ok((200, synthesized))
}

fn active_recording_id(agent: &ureq::Agent, base: &str, token: &str) -> Result<String, String> {
    let (status, body) = fetch_status(agent, base, token)?;
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}: {body}"));
    }
    let v: Value =
        serde_json::from_str(&body).map_err(|e| format!("invalid status JSON: {e}"))?;
    if let Some(id) = v
        .get("recording")
        .and_then(|r| r.get("id"))
        .and_then(|id| id.as_str())
        .filter(|id| !id.is_empty() && *id != "active")
    {
        return Ok(id.to_string());
    }
    read_saved_recording_id()
        .ok_or_else(|| "no saved recording id (older receiver does not expose active recording id)".to_string())
}

fn run_with_token(
    a: &ureq::Agent,
    base: &str,
    tok: &str,
    pi: &PiSettings,
    command: &Command,
) -> Result<(u16, String), String> {
    match command {
        Command::Status => fetch_status(a, base, tok),
        Command::Stop => request(a, "POST", &format!("{base}/v1/stop"), tok, None),
        Command::RecordStart => {
            let (status, body) = request(a, "POST", &format!("{base}/v1/record/start"), tok, None)?;
            if (200..300).contains(&status) {
                if let Ok(v) = serde_json::from_str::<Value>(&body) {
                    if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
                        save_recording_id(id);
                    }
                }
            }
            Ok((status, body))
        }
        Command::RecordStop(id) => {
            let id = match id {
                Some(id) => id.clone(),
                None => active_recording_id(a, base, tok)?,
            };
            let (status, wav) = request_bytes(
                a,
                "POST",
                &format!("{base}/v1/record/{id}/stop"),
                tok,
                None,
                None,
            )?;
            clear_recording_id();
            if !(200..300).contains(&status) {
                return Ok((status, String::from_utf8_lossy(&wav).into_owned()));
            }
            Ok((status, format!("{{\"stopped\":true,\"bytes\":{}}}", wav.len())))
        }
        Command::RecordCancel(id) => {
            let id = match id {
                Some(id) => id.clone(),
                None => active_recording_id(a, base, tok)?,
            };
            let res = request(
                a,
                "POST",
                &format!("{base}/v1/record/{id}/cancel"),
                tok,
                None,
            )?;
            clear_recording_id();
            Ok(res)
        }
        Command::DictateStop(id) => {
            let id = match id {
                Some(id) => id.clone(),
                None => active_recording_id(a, base, tok)?,
            };
            let (status, wav) = request_bytes(
                a,
                "POST",
                &format!("{base}/v1/record/{id}/stop"),
                tok,
                None,
                None,
            )?;
            clear_recording_id();
            if !(200..300).contains(&status) {
                return Ok((status, String::from_utf8_lossy(&wav).into_owned()));
            }
            let stt_model = match pi.local_transcription_model.clone() {
                Some(m) => m,
                None => default_model_of_kind(a, base, tok, "stt")?,
            };
            let (t_status, t_body) = request_bytes(
                a,
                "POST",
                &format!("{base}/v1/transcribe?model={stt_model}"),
                tok,
                Some("audio/wav"),
                Some(&wav),
            )?;
            Ok((t_status, String::from_utf8_lossy(&t_body).into_owned()))
        }
        Command::Speak {
            model,
            voice,
            speed,
            text,
        } => {
            let text = match text {
                Some(t) => t.clone(),
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
            let model = match model.clone().or_else(|| pi.local_speech_model.clone()) {
                Some(m) => m,
                None => default_tts_model(a, base, tok)?,
            };
            let voice = voice.clone().or_else(|| pi.local_speech_voice.clone());
            let mut fields = vec![
                format!("\"model\":{}", json_str(&model)),
                format!("\"text\":{}", json_str(&text)),
            ];
            if let Some(v) = voice {
                fields.push(format!("\"voice\":{}", json_str(&v)));
            }
            if let Some(s) = speed {
                fields.push(format!("\"speed\":{s}"));
            }
            let payload = format!("{{{}}}", fields.join(","));
            request(a, "POST", &format!("{base}/v1/speak"), tok, Some(&payload))
        }
    }
}

fn run(args: &[String]) -> Result<String, String> {
    let parsed = parse_args(args)?;
    let state_path = default_state_path().ok();
    let zellij_cfg = read_pi_settings(zellij_config_path().as_deref());
    let pi_cfg = read_pi_settings(pi_settings_path().as_deref());
    let pi = merge_settings(zellij_cfg, pi_cfg);
    let (base, tokens) = resolve_target(parsed.url, parsed.token_file, state_path.as_deref(), &pi)?;
    let a = agent();
    let mut last = None;
    for tok in &tokens {
        let (status, body) = run_with_token(&a, &base, tok, &pi, &parsed.command)?;
        if status == 401 {
            last = Some((status, body));
            continue;
        }
        if !(200..300).contains(&status) {
            return Err(format!("HTTP {status}: {body}"));
        }
        return Ok(body);
    }
    let (status, body) = last.unwrap_or((401, "unauthorized".to_string()));
    Err(format!("HTTP {status}: {body}"))
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

    #[test]
    fn reads_pi_settings_and_normalizes_bridge_address() {
        let dir = temp_dir("pi-cfg");
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("settings.json");
        fs::write(
            &p,
            r#"{"version":1,"bridgeAddress":"100.64.0.2","localSpeechModel":"kokoro","localSpeechVoice":"af_heart"}"#,
        )
        .unwrap();
        let pi = read_pi_settings(Some(&p));
        assert_eq!(pi.bridge_address.as_deref(), Some("100.64.0.2"));
        assert_eq!(pi.local_speech_model.as_deref(), Some("kokoro"));
        assert_eq!(pi.local_speech_voice.as_deref(), Some("af_heart"));
        assert_eq!(address_url("100.64.0.2"), "http://100.64.0.2:47613");
        assert_eq!(address_url("http://100.64.0.2:9000/"), "http://100.64.0.2:9000");

        let zellij_p = dir.join("pi-speech.json");
        fs::write(&zellij_p, r#"{"url":"10.0.0.5:48000","model":"piper"}"#).unwrap();
        let merged = merge_settings(read_pi_settings(Some(&zellij_p)), pi);
        assert_eq!(merged.bridge_address.as_deref(), Some("10.0.0.5:48000"));
        assert_eq!(merged.local_speech_model.as_deref(), Some("piper"));
        assert_eq!(merged.local_speech_voice.as_deref(), Some("af_heart"));
        let _ = fs::remove_dir_all(&dir);
    }
}
