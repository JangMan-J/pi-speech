//! Files and directories for their owner only: mode 0600 and 0700 on Unix. Windows has no
//! such modes: they get the default ACLs of where they are made (the receiver makes them
//! in the user's profile, whose ACLs give access to the user, administrators and the
//! system only).

use std::fs::{DirBuilder, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

/// Options that create a file only its owner may read and write; the caller adds how to
/// open it.
pub(crate) fn file() -> OpenOptions {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    options.mode(0o600);
    options
}

/// A builder that creates directories only their owner may use.
pub(crate) fn dir() -> DirBuilder {
    #[cfg_attr(not(unix), allow(unused_mut))]
    let mut builder = DirBuilder::new();
    #[cfg(unix)]
    builder.mode(0o700);
    builder
}
