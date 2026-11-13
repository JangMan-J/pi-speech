//! `POST /v1/pair`: hand the bridge token to a Pi that does not have it, once the user has
//! typed the code this receiver shows on its own terminal. The code never travels to the
//! client: the receiver only prints it (through [`Notice`]).
//!
//! An empty body (or `{}`) asks for a new code: six digits, valid for the configured time
//! (2 minutes by default), replacing any earlier code. `{"code": "123456"}` answers with
//! the token when it matches. Each code takes a few wrong attempts, then it is void.

use crate::http::{json_str, Response};
use crate::proc::lock;
use crate::token::{ct_eq, random_bytes};
use serde_json::Value;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a code is valid.
pub const PAIR_TTL: Duration = Duration::from_secs(120);
/// Wrong attempts a code takes before it is void.
pub const PAIR_ATTEMPTS: u32 = 5;

/// Where a message for the user at this receiver goes: its terminal.
pub type Notice = Arc<dyn Fn(&str) + Send + Sync + std::panic::RefUnwindSafe>;

/// The receiver's own terminal (standard error). A terminal that has gone is not an error.
pub fn stderr_notice() -> Notice {
    Arc::new(|msg: &str| {
        let _ = write!(std::io::stderr(), "\r\npi-speech-receiver: {msg}\r\n");
    })
}

struct Code {
    digits: String,
    until: Instant,
    left: u32,
}

pub struct Pairing {
    code: Mutex<Option<Code>>,
    ttl: Duration,
    notice: Notice,
}

fn six_digits() -> Option<String> {
    let mut b = [0u8; 4];
    random_bytes(&mut b).ok()?;
    Some(format!("{:06}", u32::from_le_bytes(b) % 1_000_000))
}

impl Pairing {
    pub fn new(ttl: Duration, notice: Notice) -> Pairing {
        Pairing {
            code: Mutex::new(None),
            ttl,
            notice,
        }
    }

    /// Answer `POST /v1/pair` with `body`; `token` is what a right code earns.
    pub fn answer(&self, body: &[u8], token: &str) -> Response {
        let v: Value = if body.iter().all(u8::is_ascii_whitespace) {
            Value::Object(Default::default())
        } else {
            match serde_json::from_slice(body) {
                Ok(v @ Value::Object(_)) => v,
                _ => return Response::error(400, "the body must be a JSON object"),
            }
        };
        match &v["code"] {
            Value::Null => self.new_code(),
            Value::String(c) if c.len() == 6 && c.bytes().all(|b| b.is_ascii_digit()) => {
                self.check(c, token)
            }
            _ => Response::error(400, "code must be the six digits the receiver shows"),
        }
    }

    fn new_code(&self) -> Response {
        let Some(digits) = six_digits() else {
            return Response::error(503, "no random source");
        };
        let secs = self.ttl.as_secs();
        (self.notice)(&format!(
            "pairing code {digits}: type it into Pi's /speech panel (Bridge connection, Pairing); it expires in {}",
            if secs >= 60 && secs.is_multiple_of(60) { format!("{} min", secs / 60) } else { format!("{secs} s") }
        ));
        *lock(&self.code) = Some(Code {
            digits,
            until: Instant::now() + self.ttl,
            left: PAIR_ATTEMPTS,
        });
        Response::json(
            202,
            format!("{{\"expires_in\": {secs}, \"attempts\": {PAIR_ATTEMPTS}}}"),
        )
    }

    fn check(&self, given: &str, token: &str) -> Response {
        let mut g = lock(&self.code);
        let live = g
            .as_ref()
            .is_some_and(|c| Instant::now() < c.until && c.left > 0);
        if !live {
            *g = None;
            return Response::error(
                410,
                "no pairing code is active (it expired, was used, or ran out of attempts): ask for a new one",
            );
        }
        let code = g.as_mut().expect("live code");
        if ct_eq(given.as_bytes(), code.digits.as_bytes()) {
            *g = None;
            return Response::json(200, format!("{{\"token\": {}}}", json_str(token)));
        }
        code.left -= 1;
        let left = code.left;
        if left == 0 {
            *g = None;
        }
        Response::json(
            403,
            format!(
                "{{\"error\": {}, \"attempts_left\": {left}}}",
                json_str(if left == 0 {
                    "wrong pairing code, and no attempts are left: ask for a new code"
                } else {
                    "wrong pairing code"
                })
            ),
        )
    }
}
