//! pi-speech-receiver: the playback-machine side of the playback bridge.
//! The wire contract is `protocol/bridge.md`.

/// The receiver version (`package.json` when built in the repository, else Cargo's).
pub const VERSION: &str = env!("PI_SPEECH_VERSION");
/// Whether this build is the GPU (`shared`) or CPU (`static`) edition.
pub const EDITION: &str = if cfg!(feature = "shared") {
    "gpu"
} else {
    "cpu"
};

pub mod audio;
pub mod engines;
pub mod front;
pub mod gpu;
pub mod http;
pub mod lease;
pub mod models;
pub mod pair;
mod private;
pub mod proc;
pub mod remote_models;
pub mod server;
pub mod shared;
pub mod signals;
pub mod speak;
pub mod ssh;
pub mod stream;
pub mod token;
pub mod transcribe;
pub mod wav;
