//! pi-speech-receiver: the playback-machine side of the playback bridge.
//! The wire contract is `protocol/bridge.md`.

pub mod audio;
pub mod engines;
pub mod front;
pub mod http;
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
