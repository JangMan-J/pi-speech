//! pi-speech-receiver: the playback-machine side of the playback bridge.
//! The wire contract is `protocol/bridge.md`.

pub mod audio;
pub mod front;
pub mod http;
pub mod proc;
pub mod server;
pub mod signals;
pub mod stream;
pub mod token;
pub mod wav;
