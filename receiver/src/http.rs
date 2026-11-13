//! A small HTTP/1.1 layer: one request per connection, `Connection: close`.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::{Duration, Instant};

const MAX_HEAD: u64 = 32 * 1024;
const MAX_HEADERS: usize = 100;
const IO_TIMEOUT: Duration = Duration::from_secs(15);
const DRAIN_LIMIT: u64 = 128 * 1024 * 1024;
const DRAIN_TIME: Duration = Duration::from_secs(5);
/// Longest chunk-size line (with extensions) or trailer line of a chunked body.
const MAX_CHUNK_LINE: usize = 4096;

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

    /// The handler has answered on the connection itself (a chunked body); `finish` sends nothing.
    pub fn sent() -> Response {
        Response {
            status: 0,
            content_type: "",
            body: Vec::new(),
        }
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
        403 => "Forbidden",
        404 => "Not Found",
        410 => "Gone",
        409 => "Conflict",
        408 => "Request Timeout",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        422 => "Unprocessable Entity",
        _ => "Service Unavailable",
    }
}
/// How a request body is delimited.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Framing {
    Length(u64),
    Chunked,
}

impl Framing {
    /// The framing a request declares: exactly one `Transfer-Encoding: chunked`, or
    /// exactly one `Content-Length`. Anything else (neither, both, several, another
    /// coding) is an error with a readable message.
    pub fn of(req: &Request) -> Result<Framing, &'static str> {
        match (
            req.header_count("transfer-encoding"),
            req.header_count("content-length"),
        ) {
            (0, 0) => Err("the body needs a Content-Length or Transfer-Encoding: chunked"),
            (1, 0) => match req.header("transfer-encoding") {
                Some(v) if v.eq_ignore_ascii_case("chunked") => Ok(Framing::Chunked),
                _ => Err("only Transfer-Encoding: chunked is supported"),
            },
            (0, 1) => match req.header("content-length") {
                Some(v) if !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()) => v
                    .parse()
                    .map(Framing::Length)
                    .map_err(|_| "invalid Content-Length"),
                _ => Err("invalid Content-Length"),
            },
            _ => Err("conflicting or repeated Content-Length and Transfer-Encoding"),
        }
    }
}

/// Why a body read piece by piece did not reach its end.
#[derive(Debug)]
pub enum BodyFault {
    /// More bytes than the limit.
    TooLarge,
    /// The connection closed before the end of the body.
    Ended,
    /// No byte arrived within the idle time.
    Idle,
    /// A chunked body that does not follow the format.
    Malformed(&'static str),
    Io(io::Error),
}

impl BodyFault {
    pub fn describe(&self) -> String {
        match self {
            BodyFault::TooLarge => "the body is larger than the limit".to_string(),
            BodyFault::Ended => "the connection closed before the end of the body".to_string(),
            BodyFault::Idle => "no data arrived for too long".to_string(),
            BodyFault::Malformed(m) => format!("malformed chunked body: {m}"),
            BodyFault::Io(e) => format!("the body could not be read: {e}"),
        }
    }
}

fn fault(e: io::Error) -> BodyFault {
    match e.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => BodyFault::Idle,
        io::ErrorKind::UnexpectedEof => BodyFault::Ended,
        _ => BodyFault::Io(e),
    }
}

/// Wait until `r` has buffered bytes; the end of input is [`BodyFault::Ended`].
fn fill<R: BufRead>(r: &mut R) -> Result<&[u8], BodyFault> {
    loop {
        match r.fill_buf() {
            Ok([]) => return Err(BodyFault::Ended),
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(fault(e)),
        }
    }
    // Bytes are buffered now, so this returns them without any I/O.
    r.fill_buf().map_err(fault)
}

/// Hand the next `len` bytes of `r` to `sink`, in the pieces they arrive in.
fn pass_on<R: BufRead>(r: &mut R, len: u64, sink: &mut impl FnMut(&[u8])) -> Result<(), BodyFault> {
    let mut left = len;
    while left > 0 {
        let buf = fill(r)?;
        let n = (buf.len() as u64).min(left) as usize;
        sink(&buf[..n]);
        r.consume(n);
        left -= n as u64;
    }
    Ok(())
}

/// One line of a chunked body, without its `\n` and a `\r` before it.
fn chunk_line<R: BufRead>(r: &mut R) -> Result<Vec<u8>, BodyFault> {
    let mut line = Vec::new();
    loop {
        let buf = fill(r)?;
        let found = buf.iter().position(|&b| b == b'\n');
        let take = found.map_or(buf.len(), |i| i + 1);
        line.extend_from_slice(&buf[..take]);
        r.consume(take);
        if line.len() > MAX_CHUNK_LINE + 2 {
            return Err(BodyFault::Malformed("line too long"));
        }
        if found.is_some() {
            break;
        }
    }
    line.pop();
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(line)
}

/// The size of a chunk from its size line: hexadecimal digits, then optional
/// extensions after `;` (ignored).
fn chunk_size(line: &[u8]) -> Option<u64> {
    let end = line.iter().position(|&b| b == b';').unwrap_or(line.len());
    let mut digits = &line[..end];
    while let [rest @ .., b' ' | b'\t'] = digits {
        digits = rest;
    }
    if digits.is_empty() || digits.len() > 16 || !digits.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    u64::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
}

/// Read a body of `framing` from `r`, handing each piece to `sink` as it arrives.
/// Returns the number of body bytes; more than `limit` is [`BodyFault::TooLarge`].
pub fn read_pieces_from<R: BufRead>(
    r: &mut R,
    framing: Framing,
    limit: u64,
    mut sink: impl FnMut(&[u8]),
) -> Result<u64, BodyFault> {
    let len = match framing {
        Framing::Length(n) if n > limit => return Err(BodyFault::TooLarge),
        Framing::Length(n) => {
            pass_on(r, n, &mut sink)?;
            return Ok(n);
        }
        Framing::Chunked => 0u64,
    };
    let mut total = len;
    loop {
        let size = chunk_size(&chunk_line(r)?).ok_or(BodyFault::Malformed("bad chunk size"))?;
        if size == 0 {
            break;
        }
        if size > limit - total {
            return Err(BodyFault::TooLarge);
        }
        pass_on(r, size, &mut sink)?;
        total += size;
        if !chunk_line(r)?.is_empty() {
            return Err(BodyFault::Malformed("chunk data longer than its size"));
        }
    }
    // Trailers, ignored, up to the empty line that ends the body.
    for _ in 0..=MAX_HEADERS {
        if chunk_line(r)?.is_empty() {
            return Ok(total);
        }
    }
    Err(BodyFault::Malformed("too many trailers"))
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

    /// Read the body piece by piece, handing each piece to `sink` as it arrives, with
    /// `idle` as the longest wait for any byte. See [`read_pieces_from`].
    pub fn read_pieces(
        &mut self,
        framing: Framing,
        limit: u64,
        idle: Duration,
        sink: impl FnMut(&[u8]),
    ) -> Result<u64, BodyFault> {
        let _ = self
            .stream
            .set_read_timeout(Some(idle.max(Duration::from_millis(1))));
        let r = read_pieces_from(&mut self.reader, framing, limit, sink);
        // What `finish` drains so the client sees the answer: the rest of a body that is
        // still coming, nothing when the connection is gone or the body was read.
        self.body_left = match (&r, framing) {
            (Err(BodyFault::TooLarge), Framing::Length(n)) => n,
            (Err(BodyFault::TooLarge | BodyFault::Malformed(_)), Framing::Chunked) => DRAIN_LIMIT,
            _ => 0,
        };
        r
    }

    /// Begin a `200` answer whose body follows with `Transfer-Encoding: chunked`: each
    /// [`Conn::write_chunk`] as it is produced, then [`Conn::end_chunked`]. A body that is
    /// never ended (the connection closes first) is how the client learns it broke off.
    pub fn begin_chunked(
        &mut self,
        content_type: &str,
        headers: &[(&str, String)],
    ) -> io::Result<()> {
        let mut head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nTransfer-Encoding: chunked\r\nCache-Control: no-store\r\nConnection: close\r\n"
        );
        for (k, v) in headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        self.stream.write_all(head.as_bytes())?;
        self.stream.flush()
    }

    pub fn write_chunk(&mut self, data: &[u8]) -> io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        self.stream
            .write_all(format!("{:x}\r\n", data.len()).as_bytes())?;
        self.stream.write_all(data)?;
        self.stream.write_all(b"\r\n")?;
        self.stream.flush()
    }

    pub fn end_chunked(&mut self) -> io::Result<()> {
        self.stream.write_all(b"0\r\n\r\n")?;
        self.stream.flush()
    }

    /// Whether the client has closed the connection (or it broke), looking without
    /// reading: for a request that waits before it answers.
    pub fn peer_gone(&self) -> bool {
        if self.stream.set_nonblocking(true).is_err() {
            return true;
        }
        let mut b = [0u8; 1];
        let gone = match self.stream.peek(&mut b) {
            Ok(0) => true,
            Ok(_) => false,
            Err(e) => !matches!(
                e.kind(),
                io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
            ),
        };
        let _ = self.stream.set_nonblocking(false);
        gone
    }

    /// Close the connection at once, leaving a chunked body unfinished.
    pub fn break_off(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }

    /// Send the response, then read and drop the rest of the request body (bounded) so
    /// the client sees the answer instead of a reset.
    pub fn finish(mut self, resp: Response) {
        if resp.status == 0 {
            let _ = self.stream.flush();
            let _ = self.stream.shutdown(Shutdown::Write);
            return;
        }
        let head = render_head(&resp);
        if self.stream.write_all(head.as_bytes()).is_err()
            || self.stream.write_all(&resp.body).is_err()
            || self.stream.flush().is_err()
        {
            return;
        }
        let _ = self.stream.shutdown(Shutdown::Write);
        let _ = self.stream.set_read_timeout(Some(DRAIN_TIME));
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

    /// A reader that hands out one byte per read, as a slow network might.
    struct Drip(io::Cursor<Vec<u8>>);

    impl Read for Drip {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = buf.len().min(1);
            self.0.read(&mut buf[..n])
        }
    }

    fn pieces(raw: &[u8], framing: Framing, limit: u64) -> Result<Vec<u8>, BodyFault> {
        let mut whole = Vec::new();
        let mut n_pieces = 0;
        let mut r = io::Cursor::new(raw.to_vec());
        let n = read_pieces_from(&mut r, framing, limit, |p| {
            n_pieces += 1;
            whole.extend_from_slice(p)
        })?;
        assert_eq!(n as usize, whole.len());
        // The same bytes arriving one at a time give the same body.
        let mut slow = Vec::new();
        let mut r = BufReader::new(Drip(io::Cursor::new(raw.to_vec())));
        read_pieces_from(&mut r, framing, limit, |p| slow.extend_from_slice(p))?;
        assert_eq!(slow, whole);
        Ok(whole)
    }

    fn chunked(raw: &[u8]) -> Result<Vec<u8>, BodyFault> {
        pieces(raw, Framing::Chunked, 1 << 20)
    }

    #[test]
    fn a_chunked_body_is_decoded_with_extensions_and_trailers() {
        assert_eq!(chunked(b"5\r\nhello\r\n0\r\n\r\n").unwrap(), b"hello");
        assert_eq!(
            chunked(b"3;name=val\r\nabc\r\nA \t; x ; y=\"q\"\r\n0123456789\r\n0;end\r\nX-Trailer: 1\r\nY: 2\r\n\r\n").unwrap(),
            b"abc0123456789"
        );
        assert_eq!(chunked(b"0\r\n\r\n").unwrap(), b"");
        // Upper-case hex digits, leading zeros, and bare line feeds (as in the head).
        assert_eq!(chunked(b"00B\nhello world\n0\n\n").unwrap(), b"hello world");
        // Bytes after the end of the body are not part of it.
        assert_eq!(chunked(b"1\r\nz\r\n0\r\n\r\nGET / HTTP/1.1").unwrap(), b"z");
    }

    #[test]
    fn a_content_length_body_is_passed_on_exactly() {
        assert_eq!(
            pieces(b"abcdefXYZ", Framing::Length(6), 10).unwrap(),
            b"abcdef"
        );
        assert!(matches!(
            pieces(b"abc", Framing::Length(6), 10),
            Err(BodyFault::Ended)
        ));
        assert!(matches!(
            pieces(b"abcdefghijk", Framing::Length(11), 10),
            Err(BodyFault::TooLarge)
        ));
    }

    #[test]
    fn a_malformed_chunked_body_is_refused() {
        for raw in [
            &b"x\r\nhello\r\n0\r\n\r\n"[..],
            b"\r\n",
            b";ext\r\n",
            b" 5\r\nhello\r\n0\r\n\r\n",
            b"-5\r\nhello\r\n0\r\n\r\n",
            b"0x5\r\nhello\r\n0\r\n\r\n",
            b"+5\r\nhello\r\n0\r\n\r\n",
            b"5\r\nhello world\r\n0\r\n\r\n",
            b"5\r\nhelloX\r\n0\r\n\r\n",
            b"10000000000000000\r\n",
        ] {
            assert!(
                matches!(chunked(raw), Err(BodyFault::Malformed(_))),
                "{:?}",
                String::from_utf8_lossy(raw)
            );
        }
        let long = [vec![b'1'; MAX_CHUNK_LINE + 10], b"\r\n".to_vec()].concat();
        assert!(matches!(chunked(&long), Err(BodyFault::Malformed(_))));
        let many = [b"0\r\n".to_vec(), b"T: 1\r\n".repeat(MAX_HEADERS + 5)].concat();
        assert!(matches!(chunked(&many), Err(BodyFault::Malformed(_))));
    }

    #[test]
    fn a_chunked_body_that_breaks_off_is_ended() {
        for raw in [
            &b""[..],
            b"5",
            b"5\r\nhel",
            b"5\r\nhello",
            b"5\r\nhello\r\n",
            b"5\r\nhello\r\n0\r\n",
            b"5\r\nhello\r\n0\r\nTrailer: x\r\n",
        ] {
            assert!(
                matches!(chunked(raw), Err(BodyFault::Ended)),
                "{:?}",
                String::from_utf8_lossy(raw)
            );
        }
    }

    #[test]
    fn a_chunked_body_over_the_limit_is_too_large_before_its_data_is_read() {
        let raw = b"4\r\nabcd\r\n4\r\nefgh\r\n0\r\n\r\n";
        assert_eq!(pieces(raw, Framing::Chunked, 8).unwrap(), b"abcdefgh");
        let mut seen = Vec::new();
        let r = read_pieces_from(&mut io::Cursor::new(&raw[..]), Framing::Chunked, 7, |p| {
            seen.extend_from_slice(p)
        });
        assert!(matches!(r, Err(BodyFault::TooLarge)));
        assert_eq!(seen, b"abcd");
        let huge = b"ffffffffffffffff\r\n";
        assert!(matches!(chunked(huge), Err(BodyFault::TooLarge)));
    }

    #[test]
    fn framing_comes_from_exactly_one_header() {
        let req =
            |headers: &str| complete(format!("POST / HTTP/1.1\r\n{headers}\r\n").as_bytes()).0;
        assert_eq!(
            Framing::of(&req("Content-Length: 12\r\n")),
            Ok(Framing::Length(12))
        );
        assert_eq!(
            Framing::of(&req("Transfer-Encoding: Chunked\r\n")),
            Ok(Framing::Chunked)
        );
        for bad in [
            "",
            "Content-Length: +5\r\n",
            "Content-Length: -1\r\n",
            "Content-Length: \r\n",
            "Content-Length: 5\r\nContent-Length: 5\r\n",
            "Transfer-Encoding: gzip, chunked\r\n",
            "Transfer-Encoding: chunked\r\nTransfer-Encoding: chunked\r\n",
            "Transfer-Encoding: chunked\r\nContent-Length: 5\r\n",
        ] {
            assert!(Framing::of(&req(bad)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn an_oversized_head_is_400_even_without_a_line_end() {
        let mut raw = b"GET / HTTP/1.1\r\nX: ".to_vec();
        raw.resize(MAX_HEAD as usize, b'a');
        assert!(matches!(parse_head(&raw), Head::Bad(r) if r.status == 400));
    }
}
