//! Local speech models, run in-process by sherpa-onnx / ptts or via an on-demand llama-server.

pub mod llama;
pub mod model;
pub mod recognize;
pub mod snac;
pub mod synthesize;
