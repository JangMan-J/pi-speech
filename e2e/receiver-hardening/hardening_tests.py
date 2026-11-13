"""Visible hardening checks for pi-speech-receiver."""
import os, resource, socket, subprocess, time
from common import HERE, BIN, Receiver, check, finish, wav_seconds

def head_drip(r, interval=2.0, limit=25.0):
    s = socket.create_connection((r.host, r.port))
    s.sendall(b"GET /v1/health HTTP/1.1\r\n")
    t0 = time.time()
    s.settimeout(0.2)
    data = b""
    while time.time() - t0 < limit:
        try:
            d = s.recv(4096)
            if not d:
                break
            data += d
        except socket.timeout:
            pass
        except OSError:
            break
        if int((time.time() - t0) / interval) != int((time.time() - t0 - 0.2) / interval):
            try:
                s.sendall(b"X")
            except OSError:
                break
    s.close()
    return time.time() - t0, data

def timed_health(r):
    t0 = time.time()
    try:
        s, _, _ = r.req("GET", "/v1/health", timeout=10)
    except Exception as e:
        s = repr(e)
    return s, time.time() - t0

r = Receiver()
try:
    took, data = head_drip(r)
    check(5 <= took <= 14, "a dripped request head is cut off near 10 s", f"{took:.1f}s")
    check(data == b"" or data.startswith(b"HTTP/1.1 408") or data.startswith(b"HTTP/1.0 408"), "the cut-off answer is 408 or a close", data[:40])

    idle = [socket.create_connection((r.host, r.port)) for _ in range(200)]
    drip = [socket.create_connection((r.host, r.port)) for _ in range(20)]
    for d in drip:
        d.sendall(b"GET /v1/health HTTP/1.1\r\nHost: x\r\n")
    time.sleep(0.5)
    st, dt = timed_health(r)
    check(st == 200 and dt < 3, "220 idle or slow connections do not delay a request", f"{st} {dt:.1f}s")
    for c in idle + drip:
        c.close()

    r.mode("recorder", "slowstop")
    with open(os.path.join(r.fake, "slowstop"), "w") as f:
        f.write("1.8")
    s, j = r.json("POST", "/v1/record/start")
    time.sleep(0.3)
    s, h, body = r.req("POST", f"/v1/record/{j.get('id')}/stop", timeout=20)
    secs = wav_seconds(body)
    check(s == 200 and secs and secs >= 0.9, "a recorder that finishes 1.8 s after SIGINT is a clean stop", f"{s} {secs} {body[:80]}")
finally:
    r.close()

# file-descriptor exhaustion: no busy loop, recovery afterwards
import tempfile
d = tempfile.mkdtemp(prefix="recv-fd-")
tok = "fdtok" + os.urandom(20).hex()
tf = os.path.join(d, "token")
open(tf, "w").write(tok)
os.chmod(tf, 0o600)
env = dict(os.environ, PI_SPEECH_RECEIVER_STREAM_PLAYER=os.path.join(HERE, "fake-player"), PI_SPEECH_RECEIVER_RECORDER=os.path.join(HERE, "fake-recorder"), FAKE_DIR=d)
proc = subprocess.Popen([BIN, "--listen", "127.0.0.1:0", "--token-file", tf], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                        preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (48, 48)))
line = proc.stdout.readline().decode().strip()
port = int(line.rsplit(":", 1)[1])
conns = []
for _ in range(90):
    try:
        conns.append(socket.create_connection(("127.0.0.1", port), timeout=2))
    except OSError:
        pass
time.sleep(1.0)
def cpu(pid):
    f = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    return (int(f[11]) + int(f[12])) / os.sysconf("SC_CLK_TCK")
c0 = cpu(proc.pid); time.sleep(3); c1 = cpu(proc.pid)
check(c1 - c0 < 0.6, "out of file descriptors the receiver does not spin", f"{c1 - c0:.2f}s CPU in 3s")
for c in conns:
    c.close()
import http.client
ok = False
t0 = time.time()
while time.time() - t0 < 15 and not ok:
    try:
        hc = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        hc.request("GET", "/v1/health", headers={"Authorization": f"Bearer {tok}"})
        ok = hc.getresponse().status == 200
        hc.close()
    except Exception:
        time.sleep(0.3)
check(ok, "after descriptors are free again the receiver answers", f"{time.time()-t0:.1f}s")
proc.terminate()
try:
    proc.wait(8)
except subprocess.TimeoutExpired:
    proc.kill()
finish()
