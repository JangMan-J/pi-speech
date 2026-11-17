//! Managed `llama-server` runner for heavyweight GGUF TTS models (`ZONOS3-Mini`, `Qwen3-TTS`,
//! and `Orpheus 3B`), downloaded on demand from `ggml-org/llama.cpp` releases (`b12438`).

use super::snac::{OrpheusStream, SnacDecoder};
use crate::gpu;
use crate::models::{cache, download};
use flate2::read::GzDecoder;
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

pub const LLAMA_SERVER_ENV: &str = "PI_SPEECH_LLAMA_SERVER";
pub const LLAMA_TAG: &str = "b12438";
const LLAMA_RELEASE_BASE: &str = "https://github.com/ggml-org/llama.cpp/releases/download/b12438/";

pub const ORPHEUS_VOICES: &[&str] = &["tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"];

struct LlamaArchive {
    file: &'static str,
    size: u64,
    sha256: &'static str,
}

fn archive_for_host() -> Result<LlamaArchive, String> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Ok(LlamaArchive {
            file: "llama-b12438-bin-macos-arm64.tar.gz",
            size: 17_011_862,
            sha256: "9ba4c834da156d08d6d81438c479c337b20cb723d7639164e602d93811a9f49b",
        });
    }
    if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        return Ok(LlamaArchive {
            file: "llama-b12438-bin-macos-x64.tar.gz",
            size: 12_769_119,
            sha256: "2dd6e22e57812fb92a655dec3651a9de7bedbba03cc46b9bb68ac521ad06d0a0",
        });
    }
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        let info = gpu::probe();
        if info["driver"].as_bool() == Some(true) && info["cuda"].as_u64() == Some(13) {
            return Ok(LlamaArchive {
                file: "llama-b12438-bin-ubuntu-cuda-13.5-x64.tar.gz",
                size: 202_488_268,
                sha256: "29da9c1207c18c04c16f42420fdaf587230635d0f041de4cf70ca1e5ef68270a",
            });
        }
        if info["driver"].as_bool() == Some(true) && info["cuda"].as_u64() == Some(12) {
            return Ok(LlamaArchive {
                file: "llama-b12438-bin-ubuntu-cuda-12.8-x64.tar.gz",
                size: 200_105_858,
                sha256: "900a740fd3e30d04e9378e3eab9e11865337f8bdc6eb33c85c8749468cebe5c8",
            });
        }
        if has_vulkan() {
            return Ok(LlamaArchive {
                file: "llama-b12438-bin-ubuntu-vulkan-x64.tar.gz",
                size: 36_399_490,
                sha256: "0109ce3095b14adc6d8bf4326725638c164ee05f0d140b558a6d6c3f032032f5",
            });
        }
        return Ok(LlamaArchive {
            file: "llama-b12438-bin-ubuntu-x64.tar.gz",
            size: 23_466_824,
            sha256: "8210f3f746e70ebfd2b79c6b76ffc3d76c8fd272d822cf766691bdc789063949",
        });
    }
    if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        return Ok(LlamaArchive {
            file: "llama-b12438-bin-ubuntu-arm64.tar.gz",
            size: 19_096_355,
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
        });
    }
    if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        return Ok(LlamaArchive {
            file: "llama-b12438-bin-win-vulkan-x64.zip",
            size: 38_302_698,
            sha256: "726d07e26dcc57325bb249bf804669916b02470ab0078b2ed9741a0c48bdd04f",
        });
    }
    Err("no prebuilt llama-server binary is configured for this OS/architecture".into())
}

#[cfg(unix)]
fn has_vulkan() -> bool {
    let Ok(c) = std::ffi::CString::new("libvulkan.so.1") else {
        return false;
    };
    unsafe {
        let h = libc::dlopen(c.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
        if h.is_null() {
            return false;
        }
        libc::dlclose(h);
    }
    true
}

#[cfg(not(unix))]
fn has_vulkan() -> bool {
    false
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

/// Whether an external `llama-server` binary supports `/tts` (build >= 12438).
fn supports_tts(bin: &Path) -> bool {
    let Ok(out) = Command::new(bin).arg("--version").output() else {
        return false;
    };
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    // e.g. `version: 12438 (abcd)` or `build 12438`
    for tok in text.split(|c: char| !c.is_ascii_digit()) {
        if tok.len() >= 5 {
            if let Ok(n) = tok.parse::<u32>() {
                if n >= 12438 {
                    return true;
                }
            }
        }
    }
    false
}

/// Locate an existing `llama-server` (`PI_SPEECH_LLAMA_SERVER`, cache `b12438`, or compatible `PATH`).
pub fn find_server(models_root: &Path) -> Option<PathBuf> {
    if let Some(p) = std::env::var_os(LLAMA_SERVER_ENV).filter(|v| !v.is_empty()) {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    let cache_dir = models_root
        .parent()
        .unwrap_or(models_root)
        .join("llama")
        .join(LLAMA_TAG);
    let cached = cache_dir.join(exe_name());
    if cached.is_file() {
        return Some(cached);
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let p = dir.join(exe_name());
            if p.is_file() && supports_tts(&p) {
                return Some(p);
            }
        }
    }
    None
}

/// Ensure `llama-server` is available, downloading it from `ggml-org/llama.cpp` if missing.
pub fn ensure_server(
    models_root: &Path,
    stop: &AtomicBool,
    emit: &mut dyn FnMut(download::Event),
) -> Result<PathBuf, download::Failure> {
    if let Some(p) = find_server(models_root) {
        return Ok(p);
    }
    let arch = archive_for_host().map_err(download::Failure::Failed)?;
    if arch.sha256.chars().all(|c| c == '0') {
        return Err(download::Failure::Failed(format!(
            "please install llama-server on PATH or set {LLAMA_SERVER_ENV} for this platform"
        )));
    }
    let base = models_root.parent().unwrap_or(models_root).join("llama");
    let dest_dir = base.join(LLAMA_TAG);
    fs::create_dir_all(&base)
        .map_err(|e| download::Failure::Failed(format!("cannot create {}: {e}", base.display())))?;
    let archive_path = base.join(format!("{}.part", arch.file));
    let lock_path = base.join(format!("{}.lock", arch.file));
    let url = format!("{LLAMA_RELEASE_BASE}{}", arch.file);
    download::fetch_verified(
        "llama-server",
        arch.file,
        &url,
        arch.size,
        arch.sha256,
        &archive_path,
        &lock_path,
        false,
        stop,
        &mut |done, total| {
            emit(download::Event::LexiconProgress {
                name: arch.file.to_string(),
                done,
                total,
            });
        },
    )?;
    let stage = base.join(format!(
        ".unpack-{}",
        crate::token::random_hex(4).unwrap_or_else(|_| "0".into())
    ));
    let unpack_res = if arch.file.ends_with(".zip") {
        unpack_zip(&archive_path, &stage)
    } else {
        unpack_targz(&archive_path, &stage)
    };
    let _ = fs::remove_file(&archive_path);
    unpack_res.map_err(download::Failure::Failed)?;

    let _ = fs::remove_dir_all(&dest_dir);
    fs::rename(&stage, &dest_dir)
        .map_err(|e| download::Failure::Failed(format!("cannot install llama-server: {e}")))?;
    let bin = dest_dir.join(exe_name());
    if !bin.is_file() {
        return Err(download::Failure::Failed(format!(
            "{} did not contain {}",
            arch.file,
            exe_name()
        )));
    }
    Ok(bin)
}

fn unpack_targz(archive: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
    let file =
        File::open(archive).map_err(|e| format!("cannot open {}: {e}", archive.display()))?;
    let gz = GzDecoder::new(BufReader::new(file));
    let mut tar = tar::Archive::new(gz);
    let mut symlinks: Vec<(String, PathBuf)> = Vec::new();
    for entry in tar
        .entries()
        .map_err(|e| format!("bad llama archive: {e}"))?
    {
        let mut entry = entry.map_err(|e| format!("bad llama entry: {e}"))?;
        let kind = entry.header().entry_type();
        let Some(name) = entry
            .path()
            .map_err(|e| format!("bad entry path: {e}"))?
            .file_name()
            .and_then(|n| n.to_str())
            .map(String::from)
        else {
            continue;
        };
        if kind.is_symlink() {
            if let Ok(Some(target)) = entry.link_name() {
                if let Some(target_name) = target.file_name().map(PathBuf::from) {
                    symlinks.push((name, target_name));
                }
            }
            continue;
        }
        if !kind.is_file() {
            continue;
        }
        let out = dest.join(&name);
        entry
            .unpack(&out)
            .map_err(|e| format!("cannot unpack {name}: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = if name == "llama-server" || name == "llama-tts" || name.contains(".so") {
                0o755
            } else {
                0o644
            };
            let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode));
        }
    }
    #[cfg(unix)]
    for (name, target_name) in symlinks {
        let link_path = dest.join(&name);
        let _ = fs::remove_file(&link_path);
        let _ = std::os::unix::fs::symlink(&target_name, &link_path);
    }
    Ok(())
}

fn unpack_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
    let file =
        File::open(archive).map_err(|e| format!("cannot open {}: {e}", archive.display()))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("bad zip archive: {e}"))?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("bad zip entry: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let Ok(raw_name) = entry.name() else {
            continue;
        };
        let Some(name) = Path::new(raw_name.as_ref())
            .file_name()
            .and_then(|n| n.to_str())
            .map(String::from)
        else {
            continue;
        };
        let mut out =
            File::create(dest.join(&name)).map_err(|e| format!("cannot create {name}: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("cannot unpack {name}: {e}"))?;
    }
    Ok(())
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("cannot pick a local port for llama-server: {e}"))?;
    Ok(listener
        .local_addr()
        .map_err(|e| format!("cannot read local port: {e}"))?
        .port())
}

pub struct LlamaServer {
    child: Child,
    base_url: String,
    agent: ureq::Agent,
}

impl Drop for LlamaServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl LlamaServer {
    pub fn start(model: &Path, mmproj: Option<&Path>) -> Result<Self, String> {
        let root = cache::models_dir()?;
        let stop = AtomicBool::new(false);
        let bin = ensure_server(&root, &stop, &mut |_| {})
            .map_err(|e| format!("llama-server unavailable: {e:?}"))?;
        let port = free_port()?;
        let base_url = format!("http://127.0.0.1:{port}");
        let mut cmd = Command::new(&bin);
        cmd.args([
            "-m",
            &model.to_string_lossy(),
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "-ngl",
            "99",
            "-c",
            "4096",
        ]);
        if let Some(mm) = mmproj {
            cmd.args(["--mmproj", &mm.to_string_lossy()]);
        }
        if let Some(dir) = bin.parent() {
            #[cfg(target_os = "linux")]
            {
                let prior = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
                let next = if prior.is_empty() {
                    dir.to_string_lossy().into_owned()
                } else {
                    format!("{}:{prior}", dir.display())
                };
                cmd.env("LD_LIBRARY_PATH", next);
            }
            #[cfg(target_os = "macos")]
            {
                let prior = std::env::var("DYLD_LIBRARY_PATH").unwrap_or_default();
                let next = if prior.is_empty() {
                    dir.to_string_lossy().into_owned()
                } else {
                    format!("{}:{prior}", dir.display())
                };
                cmd.env("DYLD_LIBRARY_PATH", next);
            }
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            let parent_pid = unsafe { libc::getpid() };
            // Guarantee llama-server exits if pi-speech-receiver dies (SIGKILL, SIGTERM, or exit()).
            unsafe {
                cmd.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::getppid() != parent_pid {
                        libc::_exit(1);
                    }
                    Ok(())
                });
            }
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("cannot start llama-server {}: {e}", bin.display()))?;

        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(5))
            .timeout_read(Duration::from_secs(120))
            .build();
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            if let Some(status) = child
                .try_wait()
                .map_err(|e| format!("llama-server status error: {e}"))?
            {
                let mut err = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut err);
                }
                let tail = err
                    .lines()
                    .rev()
                    .take(4)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>()
                    .join(" | ");
                return Err(format!("llama-server exited ({status}): {tail}"));
            }
            if agent.get(&format!("{base_url}/health")).call().is_ok() {
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                return Err("timed out waiting for llama-server to load the model".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(Self {
            child,
            base_url,
            agent,
        })
    }

    pub fn voices(&self) -> Vec<String> {
        let Ok(resp) = self.agent.get(&format!("{}/props", self.base_url)).call() else {
            return Vec::new();
        };
        let Ok(v) = serde_json::from_reader::<_, Value>(resp.into_reader()) else {
            return Vec::new();
        };
        v["voices"]
            .as_array()
            .or_else(|| v["tts_voices"].as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Stream `POST /tts` (`pcm16`, `stream: true`), returning `(sample_rate, pcm16)` chunks.
    pub fn speak_tts(
        &self,
        text: &str,
        voice: Option<&str>,
        speed: f32,
        language: Option<&str>,
        on_pcm: &mut dyn FnMut(u32, &[f32]) -> bool,
    ) -> Result<(), String> {
        let mut body = serde_json::json!({
            "input": text,
            "response_format": "pcm16",
            "stream": true,
        });
        if let Some(v) = voice.filter(|s| !s.is_empty() && *s != "default") {
            body["voice"] = Value::String(v.to_string());
        }
        if let Some(l) = language {
            body["lang"] = Value::String(l.to_string());
        }
        if (speed - 1.0).abs() > 0.01 {
            body["speed"] = serde_json::json!(speed);
        }
        let resp = self
            .agent
            .post(&format!("{}/tts", self.base_url))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())
            .map_err(|e| format!("llama-server /tts failed: {e}"))?;
        let ct = resp.header("content-type").unwrap_or("");
        let rate = parse_rate(ct).unwrap_or(24_000);
        let mut reader = resp.into_reader();
        let mut buf = [0u8; 8192];
        let mut leftover: Option<u8> = None;
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| format!("llama-server audio stream failed: {e}"))?;
            if n == 0 {
                break;
            }
            let mut bytes = Vec::with_capacity(n + 1);
            if let Some(b) = leftover.take() {
                bytes.push(b);
            }
            bytes.extend_from_slice(&buf[..n]);
            if bytes.len() % 2 == 1 {
                leftover = bytes.pop();
            }
            if bytes.is_empty() {
                continue;
            }
            let samples: Vec<f32> = bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| i16::from_le_bytes(*c) as f32 / 32768.0)
                .collect();
            if !on_pcm(rate, &samples) {
                break;
            }
        }
        Ok(())
    }

    /// Stream Orpheus 3B tokens via `POST /v1/completions` and decode through `snac_24khz.onnx`.
    pub fn speak_orpheus(
        &self,
        snac: &SnacDecoder,
        text: &str,
        voice: &str,
        on_pcm: &mut dyn FnMut(&[f32]) -> bool,
    ) -> Result<(), String> {
        let prompt = format!("<|audio|>{voice}: {text}<|eot_id|><custom_token_4>");
        let body = serde_json::json!({
            "prompt": prompt,
            "stream": true,
            "temperature": 0.6,
            "top_p": 0.95,
            "repeat_penalty": 1.1,
            "max_tokens": 4096,
            "stop": ["<custom_token_2>"],
        });
        let resp = self
            .agent
            .post(&format!("{}/v1/completions", self.base_url))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())
            .map_err(|e| format!("llama-server Orpheus completion failed: {e}"))?;
        let mut stream = OrpheusStream::new(snac);
        let reader = BufReader::new(resp.into_reader());
        for line in reader.lines() {
            let line = line.map_err(|e| format!("Orpheus stream failed: {e}"))?;
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                break;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(piece) = v["choices"][0]["text"].as_str() {
                let pcm = stream.push_text(piece)?;
                if !pcm.is_empty() && !on_pcm(&pcm) {
                    return Ok(());
                }
            }
        }
        let tail = stream.finish()?;
        if !tail.is_empty() {
            let _ = on_pcm(&tail);
        }
        Ok(())
    }
}

fn parse_rate(ct: &str) -> Option<u32> {
    for part in ct.split(';') {
        if let Some(v) = part.trim().strip_prefix("rate=") {
            if let Ok(r) = v.trim().parse::<u32>() {
                if r > 0 {
                    return Some(r);
                }
            }
        }
    }
    None
}
