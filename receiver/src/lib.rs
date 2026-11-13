//! pi-speech-receiver: the playback-machine side of the playback bridge.
//! The wire contract is `protocol/bridge.md`.

pub mod audio;
pub mod engines;
pub mod front;
pub mod http;
mod private;
pub mod proc;
pub mod server;
pub mod signals;
pub mod stream;
pub mod token;
pub mod transcribe;
pub mod wav;
