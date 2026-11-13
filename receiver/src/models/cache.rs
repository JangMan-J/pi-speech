//! The per-user model cache: where models are downloaded to, and what is in it.
//!
//! `PI_SPEECH_MODELS_DIR` when set; else the platform's user cache directory:
//! `$XDG_CACHE_HOME/pi-speech/models` or `~/.cache/pi-speech/models` on Linux (and other Unix),
//! `~/Library/Caches/pi-speech/models` on macOS, `%LOCALAPPDATA%\pi-speech\models` on Windows.
//!
//! Inside it, a model is the directory `<dir>` (complete: it is renamed into place only once
//! unpacked); `<dir>.part` is a download in progress or interrupted; `.unpack-<dir>-*` is a
//! directory being unpacked (left behind only by a hard kill, and removed by the next download).

use super::catalog::Entry;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub const MODELS_DIR_ENV: &str = "PI_SPEECH_MODELS_DIR";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Linux,
    MacOs,
    Windows,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_vendor = "apple") {
            Os::MacOs
        } else {
            Os::Linux
        }
    }
}

/// The model cache directory for `os`, from the environment `env` reads.
pub fn resolve(os: Os, env: impl Fn(&str) -> Option<OsString>) -> Result<PathBuf, String> {
    let set = |k: &str| env(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    if let Some(dir) = set(MODELS_DIR_ENV) {
        return Ok(dir);
    }
    let base = match os {
        Os::Linux => match set("XDG_CACHE_HOME").filter(|p| p.is_absolute()) {
            Some(p) => p,
            None => set("HOME")
                .ok_or("cannot find the model cache: neither PI_SPEECH_MODELS_DIR nor HOME is set")?
                .join(".cache"),
        },
        Os::MacOs => set("HOME")
            .ok_or("cannot find the model cache: neither PI_SPEECH_MODELS_DIR nor HOME is set")?
            .join("Library")
            .join("Caches"),
        Os::Windows => set("LOCALAPPDATA").ok_or(
            "cannot find the model cache: neither PI_SPEECH_MODELS_DIR nor LOCALAPPDATA is set",
        )?,
    };
    Ok(base.join("pi-speech").join("models"))
}

/// This machine's model cache directory.
pub fn models_dir() -> Result<PathBuf, String> {
    resolve(Os::current(), |k| std::env::var_os(k))
}

/// Where `entry` is, or will be, in the cache `root`.
pub fn model_path(root: &Path, entry: &Entry) -> PathBuf {
    root.join(&entry.dir)
}

pub fn part_path(root: &Path, entry: &Entry) -> PathBuf {
    root.join(format!("{}.part", entry.dir))
}

pub fn unpack_prefix(entry: &Entry) -> String {
    format!(".unpack-{}-", entry.dir)
}

/// Whether `entry` is downloaded: its directory is there (it appears only complete).
pub fn is_downloaded(root: &Path, entry: &Entry) -> bool {
    model_path(root, entry).is_dir()
}

/// The bytes of `entry`'s interrupted download, if any.
pub fn partial_bytes(root: &Path, entry: &Entry) -> u64 {
    fs::metadata(part_path(root, entry)).map_or(0, |m| m.len())
}

/// Leftover unpacking directories of `entry`.
pub fn unpack_leftovers(root: &Path, entry: &Entry) -> Vec<PathBuf> {
    let prefix = unpack_prefix(entry);
    let Ok(read) = fs::read_dir(root) else {
        return Vec::new();
    };
    read.flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(&prefix))
        })
        .map(|e| e.path())
        .collect()
}

/// The bytes of the files under `path` (not following links).
pub fn disk_bytes(path: &Path) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return 0;
    };
    if !meta.is_dir() {
        return meta.len();
    }
    fs::read_dir(path).map_or(0, |read| {
        read.flatten().map(|e| disk_bytes(&e.path())).sum()
    })
}

/// Remove a file or a directory tree; a missing one is fine.
pub fn remove(path: &Path) -> io::Result<()> {
    let r = match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) => Err(e),
    };
    match r {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        r => r,
    }
}

/// Delete `entry`'s model, interrupted download and leftovers; returns the bytes freed.
pub fn delete(root: &Path, entry: &Entry) -> Result<u64, String> {
    let mut paths = vec![model_path(root, entry), part_path(root, entry)];
    paths.extend(unpack_leftovers(root, entry));
    let mut freed = 0;
    for p in paths {
        let bytes = disk_bytes(&p);
        remove(&p).map_err(|e| format!("cannot delete {}: {e}", p.display()))?;
        freed += bytes;
    }
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), OsString::from(v)))
            .collect();
        move |k| map.get(k).cloned()
    }

    fn models(base: &str) -> PathBuf {
        Path::new(base).join("pi-speech").join("models")
    }

    #[test]
    fn the_environment_variable_wins_on_every_os() {
        for os in [Os::Linux, Os::MacOs, Os::Windows] {
            let e = env(&[
                ("PI_SPEECH_MODELS_DIR", "/m"),
                ("HOME", "/home/u"),
                ("XDG_CACHE_HOME", "/x"),
                ("LOCALAPPDATA", "C:\\Users\\u\\AppData\\Local"),
            ]);
            assert_eq!(resolve(os, e), Ok(PathBuf::from("/m")), "{os:?}");
        }
    }

    // "/x/cache" is an absolute path only where the Linux rule can apply.
    #[cfg(unix)]
    #[test]
    fn linux_uses_xdg_cache_home_else_dot_cache() {
        let e = env(&[("HOME", "/home/u"), ("XDG_CACHE_HOME", "/x/cache")]);
        assert_eq!(resolve(Os::Linux, e), Ok(models("/x/cache")));
        let e = env(&[("HOME", "/home/u")]);
        assert_eq!(resolve(Os::Linux, e), Ok(models("/home/u/.cache")));
        // Empty and relative values are ignored, as the XDG specification says.
        for xdg in ["", "relative/cache"] {
            let e = env(&[
                ("HOME", "/home/u"),
                ("XDG_CACHE_HOME", xdg),
                ("PI_SPEECH_MODELS_DIR", ""),
            ]);
            assert_eq!(
                resolve(Os::Linux, e),
                Ok(models("/home/u/.cache")),
                "{xdg:?}"
            );
        }
        assert!(resolve(Os::Linux, env(&[])).unwrap_err().contains("HOME"));
    }

    #[test]
    fn macos_uses_library_caches() {
        let e = env(&[("HOME", "/Users/u"), ("XDG_CACHE_HOME", "/x")]);
        assert_eq!(resolve(Os::MacOs, e), Ok(models("/Users/u/Library/Caches")));
        assert!(resolve(Os::MacOs, env(&[])).is_err());
    }

    #[test]
    fn windows_uses_local_app_data() {
        let local = "C:\\Users\\u\\AppData\\Local";
        let e = env(&[("LOCALAPPDATA", local), ("HOME", "/home/u")]);
        assert_eq!(resolve(Os::Windows, e), Ok(models(local)));
        let e = env(&[("HOME", "/home/u")]);
        assert!(resolve(Os::Windows, e)
            .unwrap_err()
            .contains("LOCALAPPDATA"));
    }
}
