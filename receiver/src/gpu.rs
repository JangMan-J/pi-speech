//! `gpu`: what this machine has for running models on an NVIDIA GPU, as one JSON line:
//!
//! `{"driver":true,"cuda":13,"cudnn":true,"runtime":"gpu-runtime-cuda13","downloaded":true,
//!   "lib":"/…/lib","usable":true,"why":null}`
//!
//! - `driver`: the NVIDIA driver library (`libcuda.so.1`) loads.
//! - `cuda`: the newest CUDA runtime (`libcudart.so.13`, `.12`) that loads, or null.
//! - `cudnn`: cuDNN 9 (`libcudnn.so.9`) loads.
//! - `runtime`: the catalogue's GPU runtime for that CUDA (null when there is none, or this build
//!   cannot use one); `downloaded` whether it is in the model cache, and `lib` its library
//!   directory, which a GPU run puts first on the library path.
//! - `usable`: all of it is there; else `why` says what is missing.
//!
//! Nothing is installed or changed; the libraries are only opened and closed again.

use crate::models::cache;
use crate::models::catalog::{Catalog, Kind};
use serde_json::json;
use std::process::ExitCode;

/// Whether the shared library `name` loads (found by the system's loader).
#[cfg(unix)]
fn loads(name: &str) -> bool {
    let Ok(c) = std::ffi::CString::new(name) else {
        return false;
    };
    // SAFETY: dlopen takes a NUL-terminated name; the handle is closed at once.
    unsafe {
        let h = libc::dlopen(c.as_ptr(), libc::RTLD_LAZY | libc::RTLD_LOCAL);
        if h.is_null() {
            return false;
        }
        libc::dlclose(h);
    }
    true
}

#[cfg(not(unix))]
fn loads(_name: &str) -> bool {
    false
}

/// The probe, as `gpu` prints it.
pub fn probe() -> serde_json::Value {
    let driver = loads("libcuda.so.1");
    let cuda = [13u32, 12]
        .into_iter()
        .find(|v| loads(&format!("libcudart.so.{v}")));
    let cudnn = loads("libcudnn.so.9");
    let catalog = Catalog::load().ok();
    let runtime = cuda.and_then(|v| {
        catalog.as_ref().and_then(|c| {
            c.entries
                .iter()
                .find(|e| e.kind == Kind::Runtime && e.id == format!("gpu-runtime-cuda{v}"))
                .cloned()
        })
    });
    let root = cache::models_dir().ok();
    let downloaded = match (&runtime, &root) {
        (Some(e), Some(r)) => cache::is_downloaded(r, e),
        _ => false,
    };
    let lib = match (&runtime, &root) {
        (Some(e), Some(r)) => Some(cache::model_path(r, e).join("lib")),
        _ => None,
    };
    let has_runtimes = catalog
        .as_ref()
        .is_some_and(|c| c.entries.iter().any(|e| e.kind == Kind::Runtime));
    let why = if !has_runtimes {
        Some("this build of pi-speech-receiver runs models on the CPU only".to_string())
    } else if !driver {
        Some("no NVIDIA driver (libcuda.so.1 does not load)".into())
    } else if cuda.is_none() {
        Some("no CUDA 12 or 13 runtime (libcudart.so.12 or .13 does not load)".into())
    } else if !cudnn {
        Some("no cuDNN 9 (libcudnn.so.9 does not load)".into())
    } else if !downloaded {
        runtime.as_ref().map(|e| {
            format!(
                "the GPU runtime is not downloaded: pi-speech-receiver models download {}",
                e.id
            )
        })
    } else {
        None
    };
    json!({
        "driver": driver,
        "cuda": cuda,
        "cudnn": cudnn,
        "runtime": runtime.as_ref().map(|e| e.id.clone()),
        "downloaded": downloaded,
        "lib": lib.map(|p| p.to_string_lossy().into_owned()),
        "usable": why.is_none(),
        "why": why,
    })
}

pub fn main(args: &[String]) -> ExitCode {
    if !args.is_empty() {
        println!("usage: pi-speech-receiver gpu");
        return if matches!(args, [a] if a == "-h" || a == "--help") {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(2)
        };
    }
    println!("{}", probe());
    ExitCode::SUCCESS
}
