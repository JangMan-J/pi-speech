//! SNAC 24 kHz neural audio codec decoder for Orpheus 3B, using the ONNX Runtime C API
//! already linked into `pi-speech-receiver` by `sherpa-onnx-sys`.
//!
//! Orpheus emits `<custom_token_N>` audio tokens; every 7 tokens form one hierarchical SNAC frame
//! (`1` coarse + `2` medium + `4` fine). Decoding a 4-frame sliding window through
//! `snac_24khz.onnx` (`decoder_model.onnx`) produces 4096 samples, of which `[2048..4096]` are the
//! newest frame's 24 kHz mono samples.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::path::Path;
use std::ptr;

const ORT_API_VERSION: u32 = 16;

#[repr(C)]
struct OrtApiBase {
    get_api: unsafe extern "C" fn(version: u32) -> *const *const c_void,
    _get_version_string: unsafe extern "C" fn() -> *const c_char,
}

extern "C" {
    fn OrtGetApiBase() -> *const OrtApiBase;
}

// Verified indices in `struct OrtApi` (frozen across ORT 1.16–1.28.2):
const IDX_GET_ERROR_MESSAGE: usize = 2;
const IDX_CREATE_ENV: usize = 3;
const IDX_CREATE_SESSION: usize = 7;
const IDX_RUN: usize = 9;
const IDX_CREATE_SESSION_OPTIONS: usize = 10;
const IDX_SET_INTRA_OP_NUM_THREADS: usize = 24;
const IDX_SESSION_GET_INPUT_COUNT: usize = 30;
const IDX_SESSION_GET_OUTPUT_COUNT: usize = 31;
const IDX_SESSION_GET_INPUT_NAME: usize = 36;
const IDX_SESSION_GET_OUTPUT_NAME: usize = 37;
const IDX_CREATE_TENSOR_WITH_DATA_AS_ORT_VALUE: usize = 49;
const IDX_GET_TENSOR_MUTABLE_DATA: usize = 51;
const IDX_GET_DIMENSIONS_COUNT: usize = 61;
const IDX_GET_DIMENSIONS: usize = 62;
const IDX_GET_TENSOR_TYPE_AND_SHAPE: usize = 65;
const IDX_CREATE_CPU_MEMORY_INFO: usize = 69;
const IDX_ALLOCATOR_FREE: usize = 76;
const IDX_GET_ALLOCATOR_WITH_DEFAULT_OPTIONS: usize = 78;
const IDX_RELEASE_ENV: usize = 92;
const IDX_RELEASE_STATUS: usize = 93;
const IDX_RELEASE_MEMORY_INFO: usize = 94;
const IDX_RELEASE_SESSION: usize = 95;
const IDX_RELEASE_VALUE: usize = 96;
const IDX_RELEASE_TENSOR_TYPE_AND_SHAPE_INFO: usize = 99;
const IDX_RELEASE_SESSION_OPTIONS: usize = 100;

const ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64: c_int = 7;

#[cfg(unix)]
type OrtChar = c_char;
#[cfg(windows)]
type OrtChar = u16;

type OrtStatusPtr = *mut c_void;

struct Api {
    table: *const *const c_void,
}

unsafe impl Send for Api {}
unsafe impl Sync for Api {}

impl Api {
    fn load() -> Result<Self, String> {
        unsafe {
            let base = OrtGetApiBase();
            if base.is_null() {
                return Err("OrtGetApiBase returned null".into());
            }
            let table = ((*base).get_api)(ORT_API_VERSION);
            if table.is_null() {
                return Err("ONNX Runtime returned no API table".into());
            }
            Ok(Self { table })
        }
    }

    unsafe fn slot<T: Copy>(&self, idx: usize) -> T {
        std::mem::transmute_copy(&*self.table.add(idx))
    }

    unsafe fn check(&self, status: OrtStatusPtr) -> Result<(), String> {
        if status.is_null() {
            return Ok(());
        }
        let msg_fn: unsafe extern "C" fn(*const c_void) -> *const c_char =
            self.slot(IDX_GET_ERROR_MESSAGE);
        let rel_fn: unsafe extern "C" fn(*mut c_void) = self.slot(IDX_RELEASE_STATUS);
        let ptr = msg_fn(status);
        let msg = if ptr.is_null() {
            "ONNX Runtime error".to_string()
        } else {
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        };
        rel_fn(status);
        Err(msg)
    }
}

/// Loaded `snac_24khz.onnx` decoder session.
pub struct SnacDecoder {
    api: Api,
    env: *mut c_void,
    session: *mut c_void,
    mem_info: *mut c_void,
    input_names: Vec<CString>,
    output_name: CString,
}

unsafe impl Send for SnacDecoder {}

impl Drop for SnacDecoder {
    fn drop(&mut self) {
        unsafe {
            let rel_mem: unsafe extern "C" fn(*mut c_void) = self.api.slot(IDX_RELEASE_MEMORY_INFO);
            let rel_sess: unsafe extern "C" fn(*mut c_void) = self.api.slot(IDX_RELEASE_SESSION);
            let rel_env: unsafe extern "C" fn(*mut c_void) = self.api.slot(IDX_RELEASE_ENV);
            if !self.mem_info.is_null() {
                rel_mem(self.mem_info);
            }
            if !self.session.is_null() {
                rel_sess(self.session);
            }
            if !self.env.is_null() {
                rel_env(self.env);
            }
        }
    }
}

#[cfg(unix)]
fn ort_path(p: &Path) -> Result<Vec<OrtChar>, String> {
    use std::os::unix::ffi::OsStrExt;
    CString::new(p.as_os_str().as_bytes())
        .map(|c| {
            c.into_bytes_with_nul()
                .into_iter()
                .map(|b| b as c_char)
                .collect()
        })
        .map_err(|_| format!("invalid path for ONNX Runtime: {}", p.display()))
}

#[cfg(windows)]
fn ort_path(p: &Path) -> Result<Vec<OrtChar>, String> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = p.as_os_str().encode_wide().collect();
    wide.push(0);
    Ok(wide)
}

impl SnacDecoder {
    pub fn load(model_path: &Path, threads: i32) -> Result<Self, String> {
        let api = Api::load()?;
        let mut env: *mut c_void = ptr::null_mut();
        let mut opts: *mut c_void = ptr::null_mut();
        let mut session: *mut c_void = ptr::null_mut();
        let mut mem_info: *mut c_void = ptr::null_mut();

        unsafe {
            let create_env: unsafe extern "C" fn(
                c_int,
                *const c_char,
                *mut *mut c_void,
            ) -> OrtStatusPtr = api.slot(IDX_CREATE_ENV);
            let log_id = CString::new("pi-speech-snac").unwrap();
            api.check(create_env(3, log_id.as_ptr(), &mut env))?;

            let create_opts: unsafe extern "C" fn(*mut *mut c_void) -> OrtStatusPtr =
                api.slot(IDX_CREATE_SESSION_OPTIONS);
            if let Err(e) = api.check(create_opts(&mut opts)) {
                let rel_env: unsafe extern "C" fn(*mut c_void) = api.slot(IDX_RELEASE_ENV);
                rel_env(env);
                return Err(e);
            }

            let set_threads: unsafe extern "C" fn(*mut c_void, c_int) -> OrtStatusPtr =
                api.slot(IDX_SET_INTRA_OP_NUM_THREADS);
            let _ = api.check(set_threads(opts, threads.max(1)));

            let create_sess: unsafe extern "C" fn(
                *const c_void,
                *const OrtChar,
                *const c_void,
                *mut *mut c_void,
            ) -> OrtStatusPtr = api.slot(IDX_CREATE_SESSION);
            let path_buf = ort_path(model_path)?;
            let res = api.check(create_sess(env, path_buf.as_ptr(), opts, &mut session));
            let rel_opts: unsafe extern "C" fn(*mut c_void) = api.slot(IDX_RELEASE_SESSION_OPTIONS);
            rel_opts(opts);
            if let Err(e) = res {
                let rel_env: unsafe extern "C" fn(*mut c_void) = api.slot(IDX_RELEASE_ENV);
                rel_env(env);
                return Err(format!(
                    "cannot load SNAC decoder {}: {e}",
                    model_path.display()
                ));
            }

            let create_mem: unsafe extern "C" fn(c_int, c_int, *mut *mut c_void) -> OrtStatusPtr =
                api.slot(IDX_CREATE_CPU_MEMORY_INFO);
            if let Err(e) = api.check(create_mem(1, 0, &mut mem_info)) {
                let rel_sess: unsafe extern "C" fn(*mut c_void) = api.slot(IDX_RELEASE_SESSION);
                let rel_env: unsafe extern "C" fn(*mut c_void) = api.slot(IDX_RELEASE_ENV);
                rel_sess(session);
                rel_env(env);
                return Err(e);
            }

            let get_alloc: unsafe extern "C" fn(*mut *mut c_void) -> OrtStatusPtr =
                api.slot(IDX_GET_ALLOCATOR_WITH_DEFAULT_OPTIONS);
            let mut alloc: *mut c_void = ptr::null_mut();
            api.check(get_alloc(&mut alloc))?;

            let get_in_count: unsafe extern "C" fn(*const c_void, *mut usize) -> OrtStatusPtr =
                api.slot(IDX_SESSION_GET_INPUT_COUNT);
            let get_out_count: unsafe extern "C" fn(*const c_void, *mut usize) -> OrtStatusPtr =
                api.slot(IDX_SESSION_GET_OUTPUT_COUNT);
            let mut in_count: usize = 0;
            let mut out_count: usize = 0;
            api.check(get_in_count(session, &mut in_count))?;
            api.check(get_out_count(session, &mut out_count))?;
            if in_count != 3 || out_count < 1 {
                return Err(format!(
                    "unexpected SNAC ONNX signature: {in_count} inputs, {out_count} outputs (expected 3 inputs)"
                ));
            }

            let get_in_name: unsafe extern "C" fn(
                *const c_void,
                usize,
                *mut c_void,
                *mut *mut c_char,
            ) -> OrtStatusPtr = api.slot(IDX_SESSION_GET_INPUT_NAME);
            let get_out_name: unsafe extern "C" fn(
                *const c_void,
                usize,
                *mut c_void,
                *mut *mut c_char,
            ) -> OrtStatusPtr = api.slot(IDX_SESSION_GET_OUTPUT_NAME);
            let alloc_free: unsafe extern "C" fn(*mut c_void, *mut c_void) -> OrtStatusPtr =
                api.slot(IDX_ALLOCATOR_FREE);

            let mut input_names = Vec::with_capacity(3);
            for i in 0..3 {
                let mut name_ptr: *mut c_char = ptr::null_mut();
                api.check(get_in_name(session, i, alloc, &mut name_ptr))?;
                let cstr = CStr::from_ptr(name_ptr).to_owned();
                let _ = api.check(alloc_free(alloc, name_ptr as *mut c_void));
                input_names.push(cstr);
            }
            let mut out_ptr: *mut c_char = ptr::null_mut();
            api.check(get_out_name(session, 0, alloc, &mut out_ptr))?;
            let output_name = CStr::from_ptr(out_ptr).to_owned();
            let _ = api.check(alloc_free(alloc, out_ptr as *mut c_void));

            Ok(Self {
                api,
                env,
                session,
                mem_info,
                input_names,
                output_name,
            })
        }
    }

    pub fn decode_frames(&self, frames: &[AudioFrame]) -> Result<Vec<f32>, String> {
        if frames.is_empty() {
            return Ok(Vec::new());
        }
        let n = frames.len();
        let mut c0 = Vec::with_capacity(n);
        let mut c1 = Vec::with_capacity(n * 2);
        let mut c2 = Vec::with_capacity(n * 4);
        for f in frames {
            c0.push(f.codes_0[0] as i64);
            c1.extend(f.codes_1.iter().map(|&x| x as i64));
            c2.extend(f.codes_2.iter().map(|&x| x as i64));
        }

        let dims0 = [1i64, c0.len() as i64];
        let dims1 = [1i64, c1.len() as i64];
        let dims2 = [1i64, c2.len() as i64];

        unsafe {
            let create_tensor: unsafe extern "C" fn(
                *const c_void,
                *mut c_void,
                usize,
                *const i64,
                usize,
                c_int,
                *mut *mut c_void,
            ) -> OrtStatusPtr = self.api.slot(IDX_CREATE_TENSOR_WITH_DATA_AS_ORT_VALUE);
            let rel_val: unsafe extern "C" fn(*mut c_void) = self.api.slot(IDX_RELEASE_VALUE);

            let mut v0: *mut c_void = ptr::null_mut();
            let mut v1: *mut c_void = ptr::null_mut();
            let mut v2: *mut c_void = ptr::null_mut();
            self.api.check(create_tensor(
                self.mem_info,
                c0.as_mut_ptr() as *mut c_void,
                c0.len() * std::mem::size_of::<i64>(),
                dims0.as_ptr(),
                2,
                ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
                &mut v0,
            ))?;
            if let Err(e) = self.api.check(create_tensor(
                self.mem_info,
                c1.as_mut_ptr() as *mut c_void,
                c1.len() * std::mem::size_of::<i64>(),
                dims1.as_ptr(),
                2,
                ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
                &mut v1,
            )) {
                rel_val(v0);
                return Err(e);
            }
            if let Err(e) = self.api.check(create_tensor(
                self.mem_info,
                c2.as_mut_ptr() as *mut c_void,
                c2.len() * std::mem::size_of::<i64>(),
                dims2.as_ptr(),
                2,
                ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,
                &mut v2,
            )) {
                rel_val(v0);
                rel_val(v1);
                return Err(e);
            }

            let in_ptrs: [*const c_char; 3] = [
                self.input_names[0].as_ptr(),
                self.input_names[1].as_ptr(),
                self.input_names[2].as_ptr(),
            ];
            let in_vals: [*const c_void; 3] = [v0, v1, v2];
            let out_ptrs: [*const c_char; 1] = [self.output_name.as_ptr()];
            let mut out_val: *mut c_void = ptr::null_mut();

            let run_fn: unsafe extern "C" fn(
                *mut c_void,
                *const c_void,
                *const *const c_char,
                *const *const c_void,
                usize,
                *const *const c_char,
                usize,
                *mut *mut c_void,
            ) -> OrtStatusPtr = self.api.slot(IDX_RUN);

            let run_res = self.api.check(run_fn(
                self.session,
                ptr::null(),
                in_ptrs.as_ptr(),
                in_vals.as_ptr(),
                3,
                out_ptrs.as_ptr(),
                1,
                &mut out_val,
            ));
            rel_val(v0);
            rel_val(v1);
            rel_val(v2);
            if let Err(e) = run_res {
                if !out_val.is_null() {
                    rel_val(out_val);
                }
                return Err(e);
            }

            let get_shape: unsafe extern "C" fn(*const c_void, *mut *mut c_void) -> OrtStatusPtr =
                self.api.slot(IDX_GET_TENSOR_TYPE_AND_SHAPE);
            let get_ndims: unsafe extern "C" fn(*const c_void, *mut usize) -> OrtStatusPtr =
                self.api.slot(IDX_GET_DIMENSIONS_COUNT);
            let get_dims: unsafe extern "C" fn(*const c_void, *mut i64, usize) -> OrtStatusPtr =
                self.api.slot(IDX_GET_DIMENSIONS);
            let rel_shape: unsafe extern "C" fn(*mut c_void) =
                self.api.slot(IDX_RELEASE_TENSOR_TYPE_AND_SHAPE_INFO);
            let get_data: unsafe extern "C" fn(*mut c_void, *mut *mut c_void) -> OrtStatusPtr =
                self.api.slot(IDX_GET_TENSOR_MUTABLE_DATA);

            let mut info: *mut c_void = ptr::null_mut();
            let shape_res = self.api.check(get_shape(out_val, &mut info));
            if let Err(e) = shape_res {
                rel_val(out_val);
                return Err(e);
            }
            let mut ndims: usize = 0;
            let _ = self.api.check(get_ndims(info, &mut ndims));
            let mut dims = vec![0i64; ndims.max(1)];
            let _ = self.api.check(get_dims(info, dims.as_mut_ptr(), ndims));
            rel_shape(info);

            let total: usize = dims.iter().map(|&d| d.max(0) as usize).product();
            let mut data_ptr: *mut c_void = ptr::null_mut();
            let data_res = self.api.check(get_data(out_val, &mut data_ptr));
            let samples = if data_res.is_ok() && !data_ptr.is_null() && total > 0 {
                std::slice::from_raw_parts(data_ptr as *const f32, total).to_vec()
            } else {
                Vec::new()
            };
            rel_val(out_val);
            data_res?;
            Ok(samples)
        }
    }
}

/// One hierarchical SNAC frame (7 Orpheus tokens: 1 coarse, 2 medium, 4 fine).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AudioFrame {
    pub codes_0: [i32; 1],
    pub codes_1: [i32; 2],
    pub codes_2: [i32; 4],
}

impl AudioFrame {
    pub fn from_tokens(t: [i32; 7]) -> Self {
        Self {
            codes_0: [t[0]],
            codes_1: [t[1], t[4]],
            codes_2: [t[2], t[3], t[5], t[6]],
        }
    }
}

/// Converts a stream of `<custom_token_N>` strings from Orpheus into 24 kHz mono PCM chunks
/// using a 4-frame SNAC sliding context window.
pub struct OrpheusStream<'a> {
    decoder: &'a SnacDecoder,
    pending_text: String,
    token_index: usize,
    cur: Vec<i32>,
    window: Vec<AudioFrame>,
    emitted_first_prefix: bool,
}

impl<'a> OrpheusStream<'a> {
    pub fn new(decoder: &'a SnacDecoder) -> Self {
        Self {
            decoder,
            pending_text: String::new(),
            token_index: 0,
            cur: Vec::with_capacity(7),
            window: Vec::with_capacity(4),
            emitted_first_prefix: false,
        }
    }

    pub fn push_text(&mut self, piece: &str) -> Result<Vec<f32>, String> {
        self.pending_text.push_str(piece);
        let mut out = Vec::new();
        while let Some(start) = self.pending_text.find("<custom_token_") {
            let after = &self.pending_text[start + "<custom_token_".len()..];
            let Some(end_rel) = after.find('>') else {
                // Keep partial `<custom_token_...` for next chunk.
                self.pending_text.drain(..start);
                return Ok(out);
            };
            let num_str = &after[..end_rel];
            let num = num_str.parse::<i32>().ok();
            let advance = start + "<custom_token_".len() + end_rel + 1;
            self.pending_text.drain(..advance);

            let Some(token_num) = num else {
                continue;
            };
            if token_num == 2 {
                self.cur.clear();
                break;
            }
            if token_num < 10 {
                continue;
            }
            let pos = (self.token_index % 7) as i32;
            let code = token_num - 10 - (pos * 4096);
            if !(0..=4096).contains(&code) {
                continue;
            }
            self.token_index += 1;
            self.cur.push(code);
            if self.cur.len() == 7 {
                let arr: [i32; 7] = self.cur.as_slice().try_into().unwrap();
                self.cur.clear();
                self.window.push(AudioFrame::from_tokens(arr));
                if self.window.len() > 4 {
                    self.window.drain(..self.window.len() - 4);
                }
                if self.window.len() == 4 {
                    let pcm = self.decoder.decode_frames(&self.window)?;
                    if !self.emitted_first_prefix && pcm.len() >= 4096 {
                        self.emitted_first_prefix = true;
                        out.extend_from_slice(&pcm[2048..4096]);
                    } else if pcm.len() >= 4096 {
                        out.extend_from_slice(&pcm[2048..4096]);
                    } else {
                        out.extend_from_slice(&pcm);
                    }
                }
            }
        }
        // Discard non-token prefix noise safely.
        if !self.pending_text.contains('<') {
            self.pending_text.clear();
        }
        Ok(out)
    }

    pub fn finish(&mut self) -> Result<Vec<f32>, String> {
        // Flush if total frames < 4 (short utterance).
        if !self.window.is_empty() && self.window.len() < 4 {
            return self.decoder.decode_frames(&self.window);
        }
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn orpheus_frame_token_mapping_matches_snac_layout() {
        let f = AudioFrame::from_tokens([10, 20, 30, 40, 50, 60, 70]);
        assert_eq!(f.codes_0, [10]);
        assert_eq!(f.codes_1, [20, 50]);
        assert_eq!(f.codes_2, [30, 40, 60, 70]);
    }

    #[test]
    fn control_tokens_below_10_do_not_shift_frame_alignment() {
        let raw = "<custom_token_5><custom_token_1><custom_token_987><custom_token_7279><custom_token_10447><custom_token_12478><custom_token_19075><custom_token_21033><custom_token_26839>";
        let mut token_index = 0usize;
        let mut cur = Vec::new();
        let mut rest = raw;
        while let Some(s) = rest.find("<custom_token_") {
            let after = &rest[s + 14..];
            let end = after.find('>').unwrap();
            let n: i32 = after[..end].parse().unwrap();
            rest = &after[end + 1..];
            if n < 10 {
                continue;
            }
            let pos = (token_index % 7) as i32;
            let code = n - 10 - pos * 4096;
            assert!((0..=4096).contains(&code), "bad code {code} at pos {pos}");
            token_index += 1;
            cur.push(code);
        }
        assert_eq!(cur, vec![977, 3173, 2245, 180, 2681, 543, 2253]);
    }
}
