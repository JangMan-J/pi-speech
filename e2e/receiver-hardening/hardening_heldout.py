"""Held-out hardening checks for pi-speech-receiver."""
import os, socket, time
from common import Receiver, check, finish, wav_seconds

r = Receiver()
try:
    r.mode("recorder", "slowstop")
    with open(os.path.join(r.fake, "slowstop"), "w") as f:
        f.write("1.95")
    ok = 0
    for _ in range(3):
        s, j = r.json("POST", "/v1/record/start")
        time.sleep(0.2)
        s, h, body = r.req("POST", f"/v1/record/{j.get('id')}/stop", timeout=20)
        ok += s == 200 and (wav_seconds(body) or 0) >= 0.9
    check(ok == 3, "a recorder finishing just before the grace period ends is never reported as killed", ok)

    with open(os.path.join(r.fake, "slowstop"), "w") as f:
        f.write("8")
    s, j = r.json("POST", "/v1/record/start")
    time.sleep(0.2)
    t0 = time.time()
    s, h, body = r.req("POST", f"/v1/record/{j.get('id')}/stop", timeout=30)
    check(s == 503 and time.time() - t0 < 6, "a recorder that ignores SIGINT is killed after the grace period and reported", f"{s} {time.time()-t0:.1f}s")
    r.mode("recorder", "ok")

    idle = [socket.create_connection((r.host, r.port)) for _ in range(500)]
    time.sleep(0.5)
    t0 = time.time()
    s, _, _ = r.req("GET", "/v1/health", timeout=10)
    check(s == 200 and time.time() - t0 < 3, "500 idle connections do not delay a request", f"{s} {time.time()-t0:.1f}s")
    t0 = time.time()
    for c in idle[:5]:
        c.settimeout(15)
    closed = 0
    for c in idle[:5]:
        try:
            d = c.recv(100)
            closed += d == b"" or d.startswith(b"HTTP/1.1 408")
        except OSError:
            closed += 1
    check(closed == 5 and time.time() - t0 < 14, "idle connections are closed by the head deadline", f"{closed} {time.time()-t0:.1f}s")
    for c in idle:
        c.close()

    sock = socket.create_connection((r.host, r.port))
    sock.sendall(f"GET /v1/health HTTP/1.1\r\nAuthorization: Bearer {r.token}\r\n".encode())
    time.sleep(3)
    sock.sendall(b"Host: x\r\n\r\n")
    sock.settimeout(5)
    data = sock.recv(200)
    sock.close()
    check(data.startswith(b"HTTP/1.1 200"), "a head completed within the deadline is served", data[:30])
finally:
    r.close()
finish()
