"""Shared helpers for the receiver acceptance checks."""
import http.client, json, math, os, select, shutil, signal, socket, struct, subprocess, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.environ["RECEIVER_BIN"]
FAILS = []


def check(cond, name, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"  [{detail}]"), flush=True)
    if not cond:
        FAILS.append(name)


def finish():
    if FAILS:
        print(f"{len(FAILS)} failed: {', '.join(FAILS)}")
        raise SystemExit(1)
    print("all passed")


def wav_bytes(seconds=0.5, rate=16000):
    n = int(seconds * rate)
    data = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(n))
    return (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt "
            + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data)) + data)


def wav_seconds(b):
    """Duration of a PCM WAV by walking its chunks; None if not a WAV."""
    if len(b) < 12 or b[:4] != b"RIFF" or b[8:12] != b"WAVE":
        return None
    pos, rate, block = 12, None, None
    while pos + 8 <= len(b):
        cid, size = b[pos:pos + 4], struct.unpack("<I", b[pos + 4:pos + 8])[0]
        if cid == b"fmt ":
            ch, rate = struct.unpack("<HI", b[pos + 10:pos + 16])
            block = struct.unpack("<H", b[pos + 20:pos + 22])[0]
        if cid == b"data" and rate and block:
            return min(size, len(b) - pos - 8) / (rate * block)
        pos += 8 + size + (size & 1)
    return None


class Receiver:
    def __init__(self, args=None, token=None, token_mode=0o600, use_token_file=True, env=None, wait_listen=True):
        self.dir = tempfile.mkdtemp(prefix="recv-accept-")
        self.fake = os.path.join(self.dir, "fake")
        os.mkdir(self.fake)
        self.token = token or ("tok" + os.urandom(20).hex())
        self.token_file = os.path.join(self.dir, "token")
        with open(self.token_file, "w") as f:
            f.write(self.token + "\n")
        os.chmod(self.token_file, token_mode)
        e = dict(os.environ, PI_SPEECH_RECEIVER_PLAYER=os.path.join(HERE, "fake-player"),
                 PI_SPEECH_RECEIVER_RECORDER=os.path.join(HERE, "fake-recorder"), FAKE_DIR=self.fake,
                 XDG_CONFIG_HOME=os.path.join(self.dir, "xdg"))
        e.update(env or {})
        argv = [BIN] + (args if args is not None else ["--listen", "127.0.0.1:0"])
        if use_token_file:
            argv += ["--token-file", self.token_file]
        self.out_path = os.path.join(self.dir, "stdout")
        self.err_path = os.path.join(self.dir, "stderr")
        self.proc = subprocess.Popen(argv, env=e, stdout=subprocess.PIPE, stderr=open(self.err_path, "wb"))
        self.port, self.host, self.stdout_text = None, None, ""
        if wait_listen:
            self._await_listen()

    def _await_listen(self, timeout=15):
        end = time.time() + timeout
        buf = b""
        while time.time() < end and b"\n" not in buf:
            r, _, _ = select.select([self.proc.stdout], [], [], 0.2)
            if r:
                chunk = os.read(self.proc.stdout.fileno(), 4096)
                if not chunk:
                    break
                buf += chunk
        self.stdout_text = buf.decode(errors="replace")
        line = self.stdout_text.split("\n")[0].strip()
        if not line.startswith("listening "):
            raise RuntimeError(f"no 'listening' line; got {line!r}; stderr: {self.stderr()[-500:]}")
        addr = line.split(" ", 1)[1]
        host, port = addr.rsplit(":", 1)
        self.host, self.port = host.strip("[]"), int(port)

    def stderr(self):
        try:
            return open(self.err_path, "rb").read().decode(errors="replace")
        except OSError:
            return ""

    def all_output(self):
        rest = b""
        try:
            while True:
                r, _, _ = select.select([self.proc.stdout], [], [], 0)
                if not r:
                    break
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                rest += chunk
        except (OSError, ValueError):
            pass
        self.stdout_text += rest.decode(errors="replace")
        return self.stdout_text + self.stderr()

    def req(self, method, path, body=None, headers=None, token=True, timeout=20):
        h = dict(headers or {})
        if token is True:
            h["Authorization"] = f"Bearer {self.token}"
        elif isinstance(token, str):
            h["Authorization"] = token
        c = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, data

    def json(self, method, path, **kw):
        s, h, d = self.req(method, path, **kw)
        try:
            return s, json.loads(d.decode() or "null")
        except ValueError:
            return s, {"_raw": d[:200]}

    def mode(self, who, mode):
        with open(os.path.join(self.fake, f"{who}-mode"), "w") as f:
            f.write(mode)

    def log(self, who):
        p = os.path.join(self.fake, f"{who}.log")
        return open(p).read().splitlines() if os.path.exists(p) else []

    def play(self, audio=None, ctype="audio/wav", kind=None):
        h = {"Content-Type": ctype}
        if kind:
            h["X-Pi-Speech-Kind"] = kind
        return self.json("POST", "/v1/play", body=audio if audio is not None else wav_bytes(), headers=h)

    def wait_state(self, pid, seconds=10):
        s, j = self.json("GET", f"/v1/play/{pid}?wait={seconds}", timeout=seconds + 10)
        return j.get("state") if isinstance(j, dict) else None

    def stop(self, sig=signal.SIGTERM, timeout=8):
        if self.proc.poll() is None:
            self.proc.send_signal(sig)
            try:
                self.proc.wait(timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
                return False
        return True

    def close(self):
        self.stop()
        subprocess.run(["pkill", "-f", self.fake], capture_output=True)
        shutil.rmtree(self.dir, ignore_errors=True)


def wait_until(fn, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(0.05)
    return fn()


def started_paths(rcv, who):
    return [ln.split(" ", 2)[2] for ln in rcv.log(who) if ln.startswith("start ")]
