//! A `shared` build finds sherpa-onnx's and ONNX Runtime's shared libraries beside the binary:
//! sherpa-onnx-sys's own rpath arguments reach only its own targets, not this binary.
//! Also embeds the package version from `../package.json` when present (falling back to Cargo's).

fn package_version() -> Option<String> {
    let text = std::fs::read_to_string("../package.json").ok()?;
    let key = "\"version\"";
    let at = text.find(key)?;
    let rest = text[at + key.len()..].trim_start();
    let rest = rest.strip_prefix(':')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    let end = rest.find('"')?;
    let ver = rest[..end].trim();
    (!ver.is_empty()).then(|| ver.to_string())
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../package.json");
    let version =
        package_version().unwrap_or_else(|| std::env::var("CARGO_PKG_VERSION").unwrap_or_default());
    println!("cargo:rustc-env=PI_SPEECH_VERSION={version}");
    let shared = std::env::var_os("CARGO_FEATURE_SHARED").is_some();
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") if shared => println!("cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN"),
        Ok("macos") if shared => println!("cargo:rustc-link-arg-bins=-Wl,-rpath,@loader_path"),
        _ => {}
    }
}
