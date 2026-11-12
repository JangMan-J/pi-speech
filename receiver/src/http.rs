//! A small HTTP/1.1 layer: one request per connection, `Connection: close`.

use std::io::{self, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::{Duration, Instant};

const MAX_HEAD: u64 = 32 * 1024;
const MAX_HEADERS: usize = 100;
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const DRAIN_LIMIT: u64 = 128 * 1024 * 1024;
const DRAIN_TIME: Duration = Duration::from_secs(5);

pub struct Request {
    pub method: String,
    pub path: String,
    pub query: Option<String>,
    headers: Vec<(String, String)>,
}

impl Request {
    /// The value of a header (names compare case-insensitively); `None` when absent.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    pub fn header_count(&self, name: &str) -> usize {
        self.headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            .count()
    }
}

pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
}

/// JSON string literal for `s`.
pub fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn render_head(resp: &Response) -> String {
    format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        resp.status,
        reason(resp.status),
        resp.content_type,
        resp.body.len()
    )
}

/// Answer without ever blocking: one best-effort write of a small response, then close
/// the sending side. For connections that are not worth a thread.
pub fn answer_nonblocking(stream: &mut TcpStream, resp: &Response) {
    let mut out = render_head(resp).into_bytes();
    out.extend_from_slice(&resp.body);
    let _ = stream.set_nonblocking(true);
    let _ = stream.write(&out);
    let _ = stream.shutdown(Shutdown::Write);
}

impl Response {
    pub fn json(status: u16, body: String) -> Response {
        Response {
            status,
            content_type: "application/json",
            body: body.into_bytes(),
        }
    }

    pub fn error(status: u16, msg: &str) -> Response {
        Response::json(status, format!("{{\"error\": {}}}", json_str(msg)))
    }

    pub fn wav(body: Vec<u8>) -> Response {
        Response {
            status: 200,
            content_type: "audio/wav",
            body,
        }
    }
}

fn reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        409 => "Conflict",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        _ => "Service Unavailable",
    }
}

pub enum BodyError {
    /// The peer sent fewer bytes than its Content-Length.
    Short,
    Io(io::Error),
}

/// The result of parsing the bytes received so far.
pub enum Head {
    /// The head is not complete yet.
    Incomplete,
    /// A complete head; `used` bytes of the buffer belong to it.
    Complete { req: Request, used: usize },
    /// The head is unusable; the peer gets this answer.
    Bad(Response),
}

fn bad(msg: &str) -> Head {
    Head::Bad(Response::error(400, msg))
}

/// Parse a request line and headers from `buf` without doing any I/O. Lines end in
/// `\n` (a `\r` before it is dropped); an empty line ends the head.
pub fn parse_head(buf: &[u8]) -> Head {
    let mut pos = 0;
    let mut lines: Vec<&[u8]> = Vec::new();
    loop {
        let rest = &buf[pos..];
        let Some(nl) = rest.iter().position(|&b| b == b'\n') else {
            return if buf.len() as u64 >= MAX_HEAD {
                bad("malformed or oversized request head")
            } else {
                Head::Incomplete
            };
        };
        if (pos + nl + 1) as u64 > MAX_HEAD {
            return bad("malformed or oversized request head");
        }
        let mut line = &rest[..nl];
        if line.last() == Some(&b'\r') {
            line = &line[..line.len() - 1];
        }
        pos += nl + 1;
        if line.is_empty() && !lines.is_empty() {
            break;
        }
        lines.push(line);
        // An empty first line is not a request line; do not wait for more.
        if lines.len() == 1 && line.is_empty() {
            break;
        }
    }
    let text = |l: &[u8]| String::from_utf8(l.to_vec()).ok();
    let Some(line) = text(lines[0]) else {
        return bad("request head is not UTF-8");
    };
    let mut parts = line.split(' ');
    let (method, target, version) = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v), None) if !m.is_empty() => (m, t, v),
        _ => return bad("malformed request line"),
    };
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return bad("unsupported HTTP version");
    }
    if !target.starts_with('/') {
        return bad("malformed request target");
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), Some(q.to_string())),
        None => (target.to_string(), None),
    };
    let mut headers = Vec::new();
    for raw in &lines[1..] {
        let Some(h) = text(raw) else {
            return bad("request head is not UTF-8");
        };
        let Some((k, v)) = h.split_once(':') else {
            return bad("malformed header");
        };
        if k.is_empty() || k.contains(char::is_whitespace) || headers.len() >= MAX_HEADERS {
            return bad("malformed header");
        }
        headers.push((k.to_string(), v.trim().to_string()));
    }
    Head::Complete {
        req: Request {
            method: method.to_string(),
            path,
            query,
            headers,
        },
        used: pos,
    }
}

pub struct Conn {
    reader: BufReader<io::Chain<io::Cursor<Vec<u8>>, TcpStream>>,
    stream: TcpStream,
    body_left: u64,
    /// Body length announced together with `Expect: 100-continue`, not yet invited.
    held: u64,
}

impl Conn {
    /// Continue a connection whose head `req` has been read. `ahead` holds the bytes
    /// that arrived after the head (the start of the body).
    pub fn resume(stream: TcpStream, ahead: Vec<u8>, req: &Request) -> io::Result<Conn> {
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(IO_TIMEOUT))?;
        stream.set_write_timeout(Some(IO_TIMEOUT))?;
        let reader = BufReader::new(io::Cursor::new(ahead).chain(stream.try_clone()?));
        let announced = match req.header("content-length") {
            Some(v) if req.header_count("content-length") == 1 => v.parse::<u64>().unwrap_or(0),
            _ => 0,
        };
        let (held, body_left) = if req.header("expect").is_some() {
            (announced, 0)
        } else {
            (0, announced)
        };
        Ok(Conn {
            reader,
            stream,
            body_left,
            held,
        })
    }

    /// Ask the client to go ahead when it sent `Expect: 100-continue`.
    pub fn send_continue(&mut self, req: &Request) {
        if req
            .header("expect")
            .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
        {
            let _ = self.stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n");
            self.body_left = self.held;
        }
    }

    /// Read exactly `len` body bytes (the request's Content-Length).
    pub fn read_body(&mut self, len: u64) -> Result<Vec<u8>, BodyError> {
        let mut body = Vec::with_capacity(len.min(1 << 20) as usize);
        let mut buf = vec![0u8; 64 * 1024];
        while (body.len() as u64) < len {
            let want = ((len - body.len() as u64) as usize).min(buf.len());
            match self.reader.read(&mut buf[..want]) {
                Ok(0) => return Err(BodyError::Short),
                Ok(n) => body.extend_from_slice(&buf[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    return Err(BodyError::Short)
                }
                Err(e) => return Err(BodyError::Io(e)),
            }
        }
        self.body_left = self.body_left.saturating_sub(len);
        Ok(body)
    }

    /// Send the response, then read and drop the rest of the request body (bounded) so
    /// the client sees the answer instead of a reset.
    pub fn finish(mut self, resp: Response) {
        let head = render_head(&resp);
        if self.stream.write_all(head.as_bytes()).is_err()
            || self.stream.write_all(&resp.body).is_err()
            || self.stream.flush().is_err()
        {
            return;
        }
        let _ = self.stream.shutdown(Shutdown::Write);
        let end = Instant::now() + DRAIN_TIME;
        let mut left = self.body_left.min(DRAIN_LIMIT);
        let mut buf = vec![0u8; 64 * 1024];
        while left > 0 && Instant::now() < end {
            match self.reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => left = left.saturating_sub(n as u64),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete(buf: &[u8]) -> (Request, usize) {
        match parse_head(buf) {
            Head::Complete { req, used } => (req, used),
            Head::Incomplete => panic!("incomplete"),
            Head::Bad(r) => panic!("bad: {}", r.status),
        }
    }

    #[test]
    fn a_head_is_incomplete_until_its_empty_line() {
        assert!(matches!(parse_head(b""), Head::Incomplete));
        assert!(matches!(
            parse_head(b"GET / HTTP/1.1\r\n"),
            Head::Incomplete
        ));
        assert!(matches!(
            parse_head(b"GET / HTTP/1.1\r\nHost: x"),
            Head::Incomplete
        ));
    }

    #[test]
    fn a_complete_head_reports_how_much_it_used() {
        let raw = b"POST /v1/play?wait=3 HTTP/1.1\r\nContent-Length: 4\r\nX-A:  b \r\n\r\nBODY";
        let (req, used) = complete(raw);
        assert_eq!(
            (req.method.as_str(), req.path.as_str()),
            ("POST", "/v1/play")
        );
        assert_eq!(req.query.as_deref(), Some("wait=3"));
        assert_eq!(req.header("x-a"), Some("b"));
        assert_eq!(&raw[used..], b"BODY");
        // Bare line feeds end lines too.
        assert_eq!(complete(b"GET / HTTP/1.0\n\n").1, 16);
    }

    #[test]
    fn unusable_heads_are_400() {
        for raw in [
            &b"GET /\r\n\r\n"[..],
            b"GET / HTTP/2\r\n\r\n",
            b"GET x HTTP/1.1\r\n\r\n",
            b"GET / HTTP/1.1\r\nno colon\r\n\r\n",
            b"\r\n",
        ] {
            assert!(
                matches!(parse_head(raw), Head::Bad(r) if r.status == 400),
                "{:?}",
                String::from_utf8_lossy(raw)
            );
        }
    }

    #[test]
    fn an_oversized_head_is_400_even_without_a_line_end() {
        let mut raw = b"GET / HTTP/1.1\r\nX: ".to_vec();
        raw.resize(MAX_HEAD as usize, b'a');
        assert!(matches!(parse_head(&raw), Head::Bad(r) if r.status == 400));
    }
}
