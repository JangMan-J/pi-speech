//! Downloading a model into the cache: resumable, checked, and unpacked atomically.
//!
//! 1. The archive is fetched into `<dir>.part`; when the file is already partly there, the
//!    request asks for the rest (HTTP `Range`) and appends to it. A server that answers with the
//!    whole file instead restarts it.
//! 2. Its SHA-256 (computed as it arrives, over any earlier part as well) must be the
//!    catalogue's; else the part is deleted.
//! 3. It is unpacked into `.unpack-<dir>-<random>` and the model directory is renamed into
//!    place, so a model directory in the cache is always complete. The part is deleted last.
//!
//! A stop (the `stop` flag) leaves the `.part` as it is, to be resumed by the next download.

use super::cache;
use super::catalog::Entry;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// What a download reports as it goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// `done` of `total` archive bytes are in the cache.
    Progress {
        done: u64,
        total: u64,
    },
    Verifying,
    Unpacking,
    /// The model is at `path`.
    Done {
        path: PathBuf,
    },
}

/// Why a download ended without the model.
#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    /// Stopped on request; `.part` keeps `done` bytes for the next download.
    Stopped {
        done: u64,
    },
    Failed(String),
}

impl From<String> for Failure {
    fn from(s: String) -> Self {
        Failure::Failed(s)
    }
}

/// How often progress is reported, at most (the last byte is always reported).
const PROGRESS_EVERY: Duration = Duration::from_millis(200);
const CHUNK: usize = 64 * 1024;

/// Download `entry` into the cache at `root`. Plain `http://` only when `allow_http`.
pub fn download(
    entry: &Entry,
    root: &Path,
    allow_http: bool,
    stop: &AtomicBool,
    emit: &mut dyn FnMut(Event),
) -> Result<PathBuf, Failure> {
    let target = cache::model_path(root, entry);
    if target.is_dir() {
        emit(Event::Progress {
            done: entry.size,
            total: entry.size,
        });
        emit(Event::Done {
            path: target.clone(),
        });
        return Ok(target);
    }
    if !allow_http && !entry.url.starts_with("https://") {
        return Err(Failure::Failed(format!(
            "refusing to download {} over plain HTTP: {}",
            entry.id, entry.url
        )));
    }
    fs::create_dir_all(root)
        .map_err(|e| format!("cannot create the model cache {}: {e}", root.display()))?;
    for leftover in cache::unpack_leftovers(root, entry) {
        let _ = cache::remove(&leftover);
    }
    let part = cache::part_path(root, entry);
    fetch(entry, &part, allow_http, stop, emit)?;

    emit(Event::Verifying);
    // `fetch` checked the size and the checksum as the bytes arrived.

    emit(Event::Unpacking);
    let path = match unpack(entry, root, &part, stop) {
        Ok(p) => p,
        Err(Failure::Failed(e)) => {
            // A checked archive that does not unpack would fail the same way again.
            let _ = fs::remove_file(&part);
            return Err(Failure::Failed(format!("{e}; the download was deleted")));
        }
        Err(stopped) => return Err(stopped),
    };
    let _ = fs::remove_file(&part);
    emit(Event::Done { path: path.clone() });
    Ok(path)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The part file, opened for appending, with the hash of what it already holds.
fn open_part(part: &Path, size: u64, stop: &AtomicBool) -> Result<(File, u64, Sha256), Failure> {
    let shown = part.display();
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(part)
        .map_err(|e| format!("cannot open {shown}: {e}"))?;
    let mut len = file
        .metadata()
        .map_err(|e| format!("cannot read {shown}: {e}"))?
        .len();
    let mut hasher = Sha256::new();
    if len > size {
        file.set_len(0)
            .map_err(|e| format!("cannot truncate {shown}: {e}"))?;
        len = 0;
    }
    if len > 0 {
        let mut buf = vec![0u8; CHUNK];
        let mut read = 0;
        while read < len {
            if stop.load(Ordering::SeqCst) {
                return Err(Failure::Stopped { done: len });
            }
            let n = file
                .read(&mut buf)
                .map_err(|e| format!("cannot read {shown}: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            read += n as u64;
        }
        len = read;
    }
    file.seek(SeekFrom::Start(len))
        .map_err(|e| format!("cannot read {shown}: {e}"))?;
    Ok((file, len, hasher))
}

/// The response to a request for the archive from byte `from`: its body, and the byte it
/// starts at (`from`, or 0 when the server sends the whole file).
fn request(
    entry: &Entry,
    from: u64,
    allow_http: bool,
) -> Result<(Box<dyn Read + Send>, u64), Failure> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(30))
        .timeout_read(Duration::from_secs(60))
        .https_only(!allow_http)
        .user_agent(concat!("pi-speech-receiver/", env!("CARGO_PKG_VERSION")))
        .build();
    let mut req = agent.get(&entry.url);
    if from > 0 {
        req = req.set("Range", &format!("bytes={from}-"));
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(ureq::Error::Status(code, _)) => {
            return Err(Failure::Failed(format!(
                "cannot download {}: the server answered {code} for {}",
                entry.id, entry.url
            )))
        }
        Err(e) => {
            return Err(Failure::Failed(format!(
                "cannot download {}: {e}",
                entry.id
            )))
        }
    };
    let start = match resp.status() {
        206 => content_range_start(resp.header("Content-Range")).ok_or_else(|| {
            format!(
                "cannot download {}: the server sent part of the file without saying which",
                entry.id
            )
        })?,
        _ => 0,
    };
    Ok((Box::new(resp.into_reader()), start))
}

/// The first byte of a `Content-Range: bytes <first>-<last>/<total>` header.
fn content_range_start(header: Option<&str>) -> Option<u64> {
    let range = header?.trim().strip_prefix("bytes ")?;
    range.split('-').next()?.trim().parse().ok()
}

fn fetch(
    entry: &Entry,
    part: &Path,
    allow_http: bool,
    stop: &AtomicBool,
    emit: &mut dyn FnMut(Event),
) -> Result<(), Failure> {
    let total = entry.size;
    let shown = part.display();
    let (mut file, mut done, mut hasher) = open_part(part, total, stop)?;
    emit(Event::Progress { done, total });
    if done < total {
        let (mut body, start) = request(entry, done, allow_http)?;
        if start != done {
            // The server sent the file from its start (or from elsewhere): begin again.
            if start != 0 {
                return Err(Failure::Failed(format!(
                    "cannot download {}: the server sent bytes from {start}, not {done}",
                    entry.id
                )));
            }
            file.set_len(0)
                .and_then(|()| file.seek(SeekFrom::Start(0)).map(drop))
                .map_err(|e| format!("cannot truncate {shown}: {e}"))?;
            done = 0;
            hasher = Sha256::new();
            emit(Event::Progress { done, total });
        }
        let mut buf = vec![0u8; CHUNK];
        let mut last = Instant::now();
        loop {
            if stop.load(Ordering::SeqCst) {
                let _ = file.flush();
                return Err(Failure::Stopped { done });
            }
            let n = match body.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    let _ = file.flush();
                    return Err(Failure::Failed(format!(
                        "the download of {} broke off at {done} of {total} bytes ({e}); \
                         run it again to resume",
                        entry.id
                    )));
                }
            };
            if done + n as u64 > total {
                drop(file);
                let _ = fs::remove_file(part);
                return Err(Failure::Failed(format!(
                    "the archive of {} is larger than the catalogue's {total} bytes; \
                     the download was deleted",
                    entry.id
                )));
            }
            file.write_all(&buf[..n])
                .map_err(|e| format!("cannot write {shown}: {e}"))?;
            hasher.update(&buf[..n]);
            done += n as u64;
            if done == total || last.elapsed() >= PROGRESS_EVERY {
                emit(Event::Progress { done, total });
                last = Instant::now();
            }
        }
        file.flush()
            .map_err(|e| format!("cannot write {shown}: {e}"))?;
        if done < total {
            return Err(Failure::Failed(format!(
                "the download of {} broke off at {done} of {total} bytes; run it again to resume",
                entry.id
            )));
        }
    }
    drop(file);
    let got = hex(&hasher.finalize());
    if got != entry.sha256 {
        let _ = fs::remove_file(part);
        return Err(Failure::Failed(format!(
            "the archive of {} does not match the catalogue's checksum (SHA-256 {got}, \
             expected {}); the download was deleted",
            entry.id, entry.sha256
        )));
    }
    Ok(())
}

/// Unpack the checked archive at `part` and rename the model into place.
fn unpack(entry: &Entry, root: &Path, part: &Path, stop: &AtomicBool) -> Result<PathBuf, Failure> {
    let suffix = crate::token::random_hex(6)
        .map_err(|e| format!("cannot name a temporary directory: {e}"))?;
    let tmp = root.join(format!("{}{suffix}", cache::unpack_prefix(entry)));
    let result = unpack_into(entry, part, &tmp, stop).and_then(|()| {
        let target = cache::model_path(root, entry);
        let from = model_root(&tmp, &entry.dir);
        match fs::rename(&from, &target) {
            Ok(()) => Ok(target),
            // Another download got there first.
            Err(_) if target.is_dir() => Ok(target),
            Err(e) => Err(Failure::Failed(format!(
                "cannot move {} into place at {}: {e}",
                entry.id,
                target.display()
            ))),
        }
    });
    let _ = cache::remove(&tmp);
    result
}

fn unpack_into(entry: &Entry, part: &Path, tmp: &Path, stop: &AtomicBool) -> Result<(), Failure> {
    let failed = |e: io::Error| {
        Failure::Failed(format!(
            "cannot unpack {} into {}: {e}",
            entry.id,
            tmp.display()
        ))
    };
    fs::create_dir(tmp).map_err(failed)?;
    let file = File::open(part).map_err(failed)?;
    let bz = bzip2::read::MultiBzDecoder::new(BufReader::new(file));
    let mut archive = tar::Archive::new(bz);
    for item in archive.entries().map_err(failed)? {
        if stop.load(Ordering::SeqCst) {
            return Err(Failure::Stopped { done: entry.size });
        }
        let mut item = item.map_err(failed)?;
        item.unpack_in(tmp).map_err(failed)?;
    }
    Ok(())
}

/// The model's directory in an unpacked archive: the directory named as in the catalogue,
/// else its only top-level directory, else the whole of it.
fn model_root(tmp: &Path, dir: &str) -> PathBuf {
    let named = tmp.join(dir);
    if named.is_dir() {
        return named;
    }
    let tops: Vec<_> = fs::read_dir(tmp)
        .map(|r| r.flatten().map(|e| e.path()).collect())
        .unwrap_or_default();
    match tops.as_slice() {
        [only] if only.is_dir() => only.clone(),
        _ => tmp.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_gives_the_first_byte() {
        assert_eq!(content_range_start(Some("bytes 100-199/200")), Some(100));
        assert_eq!(content_range_start(Some("bytes 0-0/1")), Some(0));
        assert_eq!(content_range_start(Some("bytes */200")), None);
        assert_eq!(content_range_start(None), None);
    }

    #[test]
    fn hex_is_lowercase_and_padded() {
        assert_eq!(hex(&[0, 15, 255]), "000fff");
    }

    #[test]
    fn the_model_root_is_the_named_or_only_directory() {
        let tmp = std::env::temp_dir().join(format!(
            "pisr-root-{}",
            crate::token::random_hex(6).unwrap()
        ));
        fs::create_dir_all(tmp.join("other")).unwrap();
        assert_eq!(model_root(&tmp, "m"), tmp.join("other"));
        fs::create_dir_all(tmp.join("m")).unwrap();
        assert_eq!(model_root(&tmp, "m"), tmp.join("m"));
        fs::remove_dir_all(tmp.join("m")).unwrap();
        fs::write(tmp.join("loose.txt"), "x").unwrap();
        assert_eq!(model_root(&tmp, "m"), tmp);
        fs::remove_dir_all(&tmp).unwrap();
    }
}
