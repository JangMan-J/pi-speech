//! The per-user model cache: where models are downloaded to, and what is in it.
//!
//! `PI_SPEECH_MODELS_DIR` when set; else the platform's user cache directory:
//! `$XDG_CACHE_HOME/pi-speech/models` or `~/.cache/pi-speech/models` on Linux (and other Unix),
//! `~/Library/Caches/pi-speech/models` on macOS, `%LOCALAPPDATA%\pi-speech\models` on Windows.
//!
//! Inside it, a model is the directory `<dir>` (complete: it is renamed into place only once
//! unpacked); `<dir>.part` is a download in progress or interrupted; `.unpack-<dir>-*` is a
//! directory being unpacked (left behind only by a hard kill, and removed by the next download).
//! `<dir>.lock` is an empty file that a download of the model holds locked (the system's file
//! lock) from before it fetches `<dir>.part` until the model is in place or the download ends,
//! so that two downloads of the same model (say from two Pi sessions sharing one receiver) never
//! write the same part or unpack at once: the second waits, then finds the model in place or
//! resumes the part.
//! A shared lexicon (a Piper voice's) is the file `<name>` in the cache root, and `<name>.part`
//! while it is being downloaded. `<name>.lock` is the same kind of lock for a download of the
//! lexicon, so that two downloads of voices that share it never write the same `<name>.part` at
//! once.
//!
//! The lock files stay in the cache, also after `delete` (deleting one could let two locks
//! coexist: one on the deleted file, one on a new file of the same name). Nothing scans the
//! cache directory for models (a model is found by its catalogue `dir`), so they are never
//! taken for one.

use super::catalog::{Entry, Lexicon};
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

/// The file a download of `entry` holds locked from before it fetches the archive until the
/// model is in place or the download ends.
pub fn model_lock_path(root: &Path, entry: &Entry) -> PathBuf {
    root.join(format!("{}.lock", entry.dir))
}

pub fn unpack_prefix(entry: &Entry) -> String {
    format!(".unpack-{}-", entry.dir)
}

/// Whether `entry` is downloaded: its directory is there (it appears only complete).
pub fn is_downloaded(root: &Path, entry: &Entry) -> bool {
    model_path(root, entry).is_dir()
}

/// Where the shared `lexicon` is, or will be, in the cache `root`.
pub fn lexicon_path(root: &Path, lexicon: &Lexicon) -> PathBuf {
    root.join(&lexicon.name)
}

pub fn lexicon_part_path(root: &Path, lexicon: &Lexicon) -> PathBuf {
    root.join(format!("{}.part", lexicon.name))
}

/// The file a download of the shared `lexicon` holds locked while it fetches it.
pub fn lexicon_lock_path(root: &Path, lexicon: &Lexicon) -> PathBuf {
    root.join(format!("{}.lock", lexicon.name))
}

/// Whether `entry` can be used: it is downloaded, and so is the lexicon it needs, if any.
pub fn is_ready(root: &Path, entry: &Entry, lexicon: Option<&Lexicon>) -> bool {
    is_downloaded(root, entry) && lexicon.is_none_or(|l| lexicon_path(root, l).is_file())
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

/// Delete `entry`'s model, interrupted download and leftovers; returns the bytes freed. A shared
/// lexicon stays, even after the last voice that needs it: other voices (and voices put in the
/// cache by hand) may use it, and the next download of such a voice finds it there.
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
    fn a_voice_that_needs_a_lexicon_is_ready_only_with_it() {
        let root = std::env::temp_dir().join(format!(
            "pisr-ready-{}",
            crate::token::random_hex(6).unwrap()
        ));
        let entry = Entry {
            id: "v".into(),
            kind: super::super::catalog::Kind::Speech,
            name: "V".into(),
            languages: vec!["en".into()],
            size: 1,
            url: "https://x/v.tar.bz2".into(),
            sha256: "00".into(),
            dir: "v".into(),
        };
        let lexicon = Lexicon {
            name: "lexicon-en-us.txt".into(),
            url: "https://x/lexicon-en-us.txt".into(),
            size: 1,
            sha256: "00".into(),
        };
        assert!(!is_ready(&root, &entry, None));
        fs::create_dir_all(root.join("v")).unwrap();
        assert!(is_ready(&root, &entry, None));
        assert!(!is_ready(&root, &entry, Some(&lexicon)));
        fs::write(lexicon_part_path(&root, &lexicon), "x").unwrap();
        assert!(!is_ready(&root, &entry, Some(&lexicon)));
        fs::write(lexicon_path(&root, &lexicon), "x").unwrap();
        assert!(is_ready(&root, &entry, Some(&lexicon)));
        fs::write(model_lock_path(&root, &entry), "").unwrap();
        // Deleting the voice leaves the shared lexicon, and its lock file.
        delete(&root, &entry).unwrap();
        assert!(lexicon_path(&root, &lexicon).is_file());
        assert!(model_lock_path(&root, &entry).is_file());
        assert!(!is_ready(&root, &entry, None));
        fs::remove_dir_all(&root).unwrap();
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
