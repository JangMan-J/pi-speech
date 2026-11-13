//! Bearer token handling: loading, creating, and comparing.
//!
//! On Unix the token file is created 0600 in a 0700 directory, and a token file that group
//! or others may read is refused. Windows has no such modes: the file and its directory
//! (under the user's profile) get the default ACLs of where they are made, which give
//! access to the user, administrators and the system only; no permission check is made.

use crate::private;
use std::fs::File;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub const MIN_TOKEN_LEN: usize = 32;

/// Fill `buf` from the operating system's random source.
pub fn random_bytes(buf: &mut [u8]) -> io::Result<()> {
    getrandom::fill(buf).map_err(|e| match e.raw_os_error() {
        Some(code) => io::Error::from_raw_os_error(code),
        None => io::Error::other(e.to_string()),
    })
}

/// `n` random bytes as lowercase hex.
pub fn random_hex(n: usize) -> io::Result<String> {
    let mut b = vec![0u8; n];
    random_bytes(&mut b)?;
    Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

/// Constant-time equality: the work done does not depend on where the inputs differ.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    let n = a.len().max(b.len());
    let mut diff = a.len() ^ b.len();
    for i in 0..n {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as usize;
    }
    std::hint::black_box(diff) == 0
}

/// `$XDG_CONFIG_HOME/pi-speech/receiver.token`, or `~/.config/pi-speech/receiver.token`.
pub fn default_token_path() -> io::Result<PathBuf> {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => std::env::home_dir()
            .ok_or_else(|| io::Error::other("cannot find a home directory for the token file"))?
            .join(".config"),
    };
    Ok(base.join("pi-speech").join("receiver.token"))
}

fn bad(msg: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg)
}

/// Read and validate the token in `path`. Refuses a file readable by group or others
/// (on Unix).
pub fn read_token(path: &Path) -> io::Result<String> {
    let mut f = File::open(path)
        .map_err(|e| io::Error::new(e.kind(), format!("token file {}: {e}", path.display())))?;
    let meta = f.metadata()?;
    if !meta.is_file() {
        return Err(bad(format!(
            "token file {} is not a regular file",
            path.display()
        )));
    }
    #[cfg(unix)]
    if meta.mode() & 0o077 != 0 {
        return Err(bad(format!(
            "token file {} is readable by group or others (mode {:03o}); run: chmod 600 {}",
            path.display(),
            meta.mode() & 0o777,
            path.display()
        )));
    }
    let mut s = String::new();
    (&mut f).take(4096).read_to_string(&mut s)?;
    let token = s.trim().to_string();
    if token.len() < MIN_TOKEN_LEN || !token.bytes().all(|b| b.is_ascii_graphic()) {
        return Err(bad(format!(
            "token file {} must hold a token of at least {MIN_TOKEN_LEN} printable characters",
            path.display()
        )));
    }
    Ok(token)
}

/// Create `path` (mode 0600) holding a new random token. Parent directories are made 0700.
/// (On Windows both get the default ACLs of the user's profile.)
fn create_token(path: &Path) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        private::dir().recursive(true).create(dir)?;
    }
    let mut f = private::file().write(true).create_new(true).open(path)?;
    f.write_all(random_hex(32)?.as_bytes())?;
    f.write_all(b"\n")
}

/// The token to serve with. An explicit `--token-file` must exist. The default file is
/// created with a new random token when it does not exist yet.
pub fn load_token(explicit: Option<&Path>) -> io::Result<String> {
    match explicit {
        Some(p) => read_token(p),
        None => {
            let p = default_token_path()?;
            match create_token(&p) {
                Ok(()) => eprintln!("pi-speech-receiver: created token file {}", p.display()),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                Err(e) => {
                    return Err(io::Error::new(
                        e.kind(),
                        format!("cannot create token file {}: {e}", p.display()),
                    ))
                }
            }
            read_token(&p)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pisr-token-{name}-{}", random_hex(6).unwrap()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn ct_eq_compares_whole_values() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"abcd"));
        assert!(!ct_eq(b"", b"a"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    #[cfg(unix)]
    fn group_readable_token_file_is_refused() {
        let d = scratch("mode");
        let p = d.join("t");
        std::fs::write(&p, "x".repeat(40)).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o640)).unwrap();
        assert!(read_token(&p).unwrap_err().to_string().contains("readable"));
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(read_token(&p).unwrap(), "x".repeat(40));
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn short_token_is_refused() {
        let d = scratch("short");
        let p = d.join("t");
        std::fs::write(&p, "short\n").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read_token(&p).is_err());
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn created_token_file_is_private_and_long_enough() {
        let d = scratch("create");
        let p = d.join("sub").join("receiver.token");
        create_token(&p).unwrap();
        #[cfg(unix)]
        {
            let mode = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            let dmode = std::fs::metadata(p.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(dmode, 0o700);
        }
        assert!(read_token(&p).unwrap().len() >= MIN_TOKEN_LEN);
        assert!(
            create_token(&p).is_err(),
            "never overwrites an existing token"
        );
        std::fs::remove_dir_all(d).ok();
    }

    #[test]
    fn explicit_missing_token_file_is_an_error() {
        let d = scratch("missing");
        assert!(load_token(Some(&d.join("nope"))).is_err());
        std::fs::remove_dir_all(d).ok();
    }
}
