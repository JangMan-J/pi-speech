//! `gpu`: what this machine has for running models on an NVIDIA GPU, as one JSON line:
//!
//! `{"driver":true,"cuda":13,"cudnn":true,"hardware":true,"edition":"cpu",
//!   "target":"linux-x64-cuda13","usable":false,"why":"this receiver is the CPU edition"}`
//!
//! - `driver`: the NVIDIA driver library (`libcuda.so.1` on Linux, `nvcuda.dll` on Windows) loads.
//! - `cuda`: the newest CUDA runtime (`libcudart.so.13`/`.12`, or `cudart64_13.dll`/`12`) that loads, or null.
//! - `cudnn`: cuDNN 9 (`libcudnn.so.9` or `cudnn64_9.dll`) loads.
//! - `hardware`: driver, CUDA 12/13 and cuDNN 9 are all present.
//! - `edition`: `"gpu"` (linked with CUDA ONNX Runtime) or `"cpu"`.
//! - `target`: the GPU receiver target that fits this machine (`linux-x64-cuda13` / `-cuda12`, `win32-x64-cuda13` / `-cuda12`), or null.
//! - `usable`: hardware is present and this binary is the GPU edition; else `why` says what is missing.
//!
//! Nothing is installed or changed; the libraries are only opened and closed again.

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

#[cfg(windows)]
fn loads(name: &str) -> bool {
    let Ok(c) = std::ffi::CString::new(name) else {
        return false;
    };
    // SAFETY: LoadLibraryA takes a NUL-terminated ASCII/ANSI name; a non-null HMODULE is freed at once.
    unsafe {
        let h = windows_sys::Win32::System::LibraryLoader::LoadLibraryA(c.as_ptr() as *const u8);
        if h.is_null() {
            return false;
        }
        windows_sys::Win32::Foundation::FreeLibrary(h);
    }
    true
}

#[cfg(all(not(unix), not(windows)))]
fn loads(_name: &str) -> bool {
    false
}

fn gpu_target(cuda: Option<u32>) -> Option<String> {
    let v = cuda?;
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some(format!("linux-x64-cuda{v}"))
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some(format!("win32-x64-cuda{v}"))
    } else {
        None
    }
}

/// The probe, as `gpu` prints it.
pub fn probe() -> serde_json::Value {
    #[cfg(windows)]
    let (driver_lib, cudnn_lib, no_driver, no_cuda, no_cudnn) = (
        "nvcuda.dll",
        "cudnn64_9.dll",
        "no NVIDIA driver (nvcuda.dll does not load)",
        "no CUDA 12 or 13 runtime (cudart64_12.dll or cudart64_13.dll does not load)",
        "no cuDNN 9 (cudnn64_9.dll does not load)",
    );
    #[cfg(not(windows))]
    let (driver_lib, cudnn_lib, no_driver, no_cuda, no_cudnn) = (
        "libcuda.so.1",
        "libcudnn.so.9",
        "no NVIDIA driver (libcuda.so.1 does not load)",
        "no CUDA 12 or 13 runtime (libcudart.so.12 or .13 does not load)",
        "no cuDNN 9 (libcudnn.so.9 does not load)",
    );

    let driver = loads(driver_lib);
    let cuda = [13u32, 12].into_iter().find(|v| {
        #[cfg(windows)]
        let lib = format!("cudart64_{v}.dll");
        #[cfg(not(windows))]
        let lib = format!("libcudart.so.{v}");
        loads(&lib)
    });
    let cudnn = loads(cudnn_lib);
    let hardware = driver && cuda.is_some() && cudnn;
    let target = if hardware { gpu_target(cuda) } else { None };
    let gpu_build = cfg!(feature = "shared");
    let why: Option<&'static str> = if !driver {
        Some(no_driver)
    } else if cuda.is_none() {
        Some(no_cuda)
    } else if !cudnn {
        Some(no_cudnn)
    } else if target.is_none() {
        Some("no GPU receiver build is available for this platform")
    } else if !gpu_build {
        Some("this receiver is the CPU edition")
    } else {
        None
    };
    json!({
        "driver": driver,
        "cuda": cuda,
        "cudnn": cudnn,
        "hardware": hardware,
        "edition": crate::EDITION,
        "target": target,
        "usable": hardware && gpu_build,
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
