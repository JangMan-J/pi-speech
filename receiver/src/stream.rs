//! Streams: the formats a Stream may have and how a Stream player is told the format.

pub const MIN_RATE: u32 = 8000;
pub const MAX_RATE: u32 = 192000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    /// Raw signed 16-bit little-endian PCM.
    Pcm {
        rate: u32,
        channels: u8,
    },
    Mp3,
    Wav,
}

impl Format {
    /// Parse the body of `POST /v1/play/stream`: `{"format": "pcm", "rate": <Hz>,
    /// "channels": 1 | 2}`, `{"format": "mp3"}` or `{"format": "wav"}`, and nothing else.
    pub fn parse(body: &[u8]) -> Result<Format, String> {
        let text = std::str::from_utf8(body).map_err(|_| "the body is not UTF-8".to_string())?;
        let fields = flat_object(text).ok_or("the body must be a flat JSON object")?;
        for (i, (k, _)) in fields.iter().enumerate() {
            if fields[..i].iter().any(|(earlier, _)| earlier == k) {
                return Err(format!("{k:?} is given twice"));
            }
        }
        let get = |k: &str| fields.iter().find(|(name, _)| name == k).map(|(_, v)| v);
        let allowed: &[&str] = match get("format") {
            Some(Value::Str(f)) if f == "pcm" => &["format", "rate", "channels"],
            Some(Value::Str(f)) if f == "mp3" || f == "wav" => &["format"],
            _ => return Err("format must be \"pcm\", \"mp3\" or \"wav\"".to_string()),
        };
        if let Some((k, _)) = fields.iter().find(|(k, _)| !allowed.contains(&k.as_str())) {
            return Err(format!("unexpected field {k:?} for this format"));
        }
        match get("format") {
            Some(Value::Str(f)) if f == "mp3" => return Ok(Format::Mp3),
            Some(Value::Str(f)) if f == "wav" => return Ok(Format::Wav),
            _ => {}
        }
        let rate = match get("rate") {
            Some(Value::Int(r)) if (MIN_RATE as u64..=MAX_RATE as u64).contains(r) => *r as u32,
            _ => {
                return Err(format!(
                    "rate must be a whole number of Hz from {MIN_RATE} to {MAX_RATE}"
                ))
            }
        };
        let channels = match get("channels") {
            Some(Value::Int(c @ (1 | 2))) => *c as u8,
            _ => return Err("channels must be 1 or 2".to_string()),
        };
        Ok(Format::Pcm { rate, channels })
    }
}

/// The arguments that tell a Stream player the format: `s16le <rate> <channels>`, `mp3`
/// or `wav`. A configured Stream player gets these; the built-in one gets them after
/// `play`.
pub fn player_args(f: Format) -> Vec<String> {
    match f {
        Format::Pcm { rate, channels } => {
            vec!["s16le".into(), rate.to_string(), channels.to_string()]
        }
        Format::Mp3 => vec!["mp3".into()],
        Format::Wav => vec!["wav".into()],
    }
}

/// A value of a flat JSON object; only strings and whole numbers matter here.
#[derive(Debug, PartialEq)]
enum Value {
    Str(String),
    Int(u64),
    /// Any other number, `true`, `false` or `null`.
    Other,
}

/// The fields of a JSON object whose values are all scalars; `None` for anything else.
fn flat_object(text: &str) -> Option<Vec<(String, Value)>> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
    };
    let mut fields = Vec::new();
    p.ws();
    p.eat(b'{')?;
    p.ws();
    if p.peek() == Some(b'}') {
        p.i += 1;
    } else {
        loop {
            p.ws();
            let key = p.string()?;
            p.ws();
            p.eat(b':')?;
            p.ws();
            let value = p.value()?;
            fields.push((key, value));
            p.ws();
            match p.next()? {
                b',' => {}
                b'}' => break,
                _ => return None,
            }
        }
    }
    p.ws();
    (p.i == p.s.len()).then_some(fields)
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn next(&mut self) -> Option<u8> {
        let b = self.peek()?;
        self.i += 1;
        Some(b)
    }

    fn eat(&mut self, b: u8) -> Option<()> {
        (self.next()? == b).then_some(())
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn string(&mut self) -> Option<String> {
        self.eat(b'"')?;
        let mut out = Vec::new();
        loop {
            match self.next()? {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => {
                    let c = match self.next()? {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hex = self.s.get(self.i..self.i + 4)?;
                            self.i += 4;
                            let code = u32::from_str_radix(std::str::from_utf8(hex).ok()?, 16);
                            // Surrogate pairs never occur in the values that matter here.
                            char::from_u32(code.ok()?)?
                        }
                        _ => return None,
                    };
                    out.extend_from_slice(c.encode_utf8(&mut [0; 4]).as_bytes());
                }
                b if b < 0x20 => return None,
                b => out.push(b),
            }
        }
    }

    fn value(&mut self) -> Option<Value> {
        match self.peek()? {
            b'"' => self.string().map(Value::Str),
            b'-' | b'0'..=b'9' => {
                let start = self.i;
                while matches!(
                    self.peek(),
                    Some(b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9')
                ) {
                    self.i += 1;
                }
                let num = std::str::from_utf8(&self.s[start..self.i]).ok()?;
                let whole = num.bytes().all(|b| b.is_ascii_digit());
                if whole && (num == "0" || !num.starts_with('0')) {
                    return Some(num.parse().map_or(Value::Other, Value::Int));
                }
                // Not a whole number: still valid JSON, just never an acceptable value.
                num.parse::<f64>().ok().map(|_| Value::Other)
            }
            _ => {
                for word in ["true", "false", "null"] {
                    if self.s[self.i..].starts_with(word.as_bytes()) {
                        self.i += word.len();
                        return Some(Value::Other);
                    }
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Result<Format, String> {
        Format::parse(s.as_bytes())
    }

    #[test]
    fn the_three_formats_parse() {
        assert_eq!(
            parse(r#"{"format": "pcm", "rate": 24000, "channels": 1}"#),
            Ok(Format::Pcm {
                rate: 24000,
                channels: 1
            })
        );
        assert_eq!(
            parse("\n{ \"channels\":2,\"rate\":8000 , \"format\":\"pcm\"}\r\n"),
            Ok(Format::Pcm {
                rate: 8000,
                channels: 2
            })
        );
        assert_eq!(
            parse(r#"{"format":"pcm","rate":192000,"channels":2}"#).unwrap(),
            Format::Pcm {
                rate: 192000,
                channels: 2
            }
        );
        assert_eq!(parse(r#"{"format": "mp3"}"#), Ok(Format::Mp3));
        assert_eq!(parse(r#"{"format":"w\u0061v"}"#), Ok(Format::Wav));
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "",
            "{}",
            "[]",
            "null",
            r#"{"format": "ogg"}"#,
            r#"{"format": "PCM", "rate": 24000, "channels": 1}"#,
            r#"{"format": "pcm"}"#,
            r#"{"format": "pcm", "rate": 24000}"#,
            r#"{"format": "pcm", "channels": 1}"#,
            r#"{"format": "pcm", "rate": 7999, "channels": 1}"#,
            r#"{"format": "pcm", "rate": 192001, "channels": 1}"#,
            r#"{"format": "pcm", "rate": 24000.0, "channels": 1}"#,
            r#"{"format": "pcm", "rate": 2.4e4, "channels": 1}"#,
            r#"{"format": "pcm", "rate": "24000", "channels": 1}"#,
            r#"{"format": "pcm", "rate": -24000, "channels": 1}"#,
            r#"{"format": "pcm", "rate": 024000, "channels": 1}"#,
            r#"{"format": "pcm", "rate": 99999999999999999999999, "channels": 1}"#,
            r#"{"format": "pcm", "rate": 24000, "channels": 0}"#,
            r#"{"format": "pcm", "rate": 24000, "channels": 3}"#,
            r#"{"format": "pcm", "rate": 24000, "channels": true}"#,
            r#"{"format": "pcm", "rate": 24000, "channels": 1, "bits": 24}"#,
            r#"{"format": "mp3", "rate": 24000}"#,
            r#"{"format": "mp3", "format": "wav"}"#,
            r#"{"format": "mp3"} x"#,
            r#"{"format": "mp3",}"#,
            r#"{"format": {"name": "mp3"}}"#,
            r#"{"format": ["mp3"]}"#,
            r#"{"format": "mp3""#,
            "{\"format\": \"mp\n3\"}",
            "{'format': 'mp3'}",
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
        assert!(Format::parse(b"{\"format\": \"mp3\xff\"}").is_err());
    }

    #[test]
    fn a_stream_player_gets_the_format_only() {
        let pcm = Format::Pcm {
            rate: 24000,
            channels: 1,
        };
        assert_eq!(player_args(pcm), ["s16le", "24000", "1"]);
        assert_eq!(player_args(Format::Mp3), ["mp3"]);
        assert_eq!(player_args(Format::Wav), ["wav"]);
    }
}
