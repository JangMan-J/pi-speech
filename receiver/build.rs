//! A `shared` build finds sherpa-onnx's and ONNX Runtime's shared libraries beside the binary:
//! sherpa-onnx-sys's own rpath arguments reach only its own targets, not this binary.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let shared = std::env::var_os("CARGO_FEATURE_SHARED").is_some();
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") if shared => println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN"),
        Ok("macos") if shared => println!("cargo:rustc-link-arg-bins=-Wl,-rpath,@loader_path"),
        _ => {}
    }
}
