"""Held-out acceptance for pi-speech-receiver."""
import os, signal, socket, stat, subprocess, tempfile, time, shutil
from common import Receiver, check, finish, wait_until, wav_bytes, wav_seconds, started_paths, BIN

r = Receiver()
try:
    # authentication variants
    for name, tok in [("query token", None), ("token with suffix", f"Bearer {r.token}x"), ("token prefix", f"Bearer {r.token[:-4]}"),
                      ("basic scheme", "Basic " + r.token), ("bare token", r.token)]:
        path = f"/v1/health?token={r.token}" if name == "query token" else "/v1/health"
        s, _, _ = r.req("GET", path, token=tok)
        check(s == 401, f"401 for {name}", s)
    s, _, _ = r.req("POST", "/v1/record/start", token=None)
    check(s == 401 and not r.log("recorder"), "unauthenticated record start never starts the recorder", s)
    s, _, _ = r.req("POST", "/v1/play/stream", body=b'{"format": "wav"}', headers={"Content-Type": "application/json"}, token="Bearer nope")
    check(s == 401 and not r.log("player"), "unauthenticated play never starts the player", s)

    s, j = r.json("GET", "/v1/nowhere")
    check(s == 404 and "error" in j, "unknown endpoint is 404 with error body", f"{s} {j}")
    s, j = r.json("GET", "/v1/play/does-not-exist")
    check(s == 404, "unknown playback id is 404", s)
    s, j = r.json("POST", "/v1/record/does-not-exist/stop")
    check(s == 404, "unknown recording id is 404", s)

    # truncated upload never plays
    sock = socket.create_connection((r.host, r.port))
    head = (f"POST /v1/play HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {r.token}\r\nContent-Type: audio/wav\r\n"
            f"Content-Length: 200000\r\n\r\n").encode()
    sock.sendall(head + wav_bytes(1.0)[:5000])
    sock.shutdown(socket.SHUT_WR)
    sock.settimeout(5)
    try:
        sock.recv(4096)
    except OSError:
        pass
    sock.close()
    time.sleep(1.0)
    check(not r.log("player"), "truncated upload never plays", r.log("player"))

    # oversize body is 413
    sock = socket.create_connection((r.host, r.port))
    size = 70 * 1024 * 1024
    sock.sendall((f"POST /v1/play HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {r.token}\r\nContent-Type: audio/wav\r\n"
                  f"Content-Length: {size}\r\n\r\n").encode())
    chunk = wav_bytes(0.1) + b"\0" * (1024 * 1024)
    sent = 0
    try:
        sock.settimeout(10)
        while sent < size:
            sock.sendall(chunk[: min(len(chunk), size - sent)])
            sent += len(chunk)
    except OSError:
        pass
    sock.settimeout(10)
    resp = b""
    try:
        while b"\r\n" not in resp:
            d = sock.recv(4096)
            if not d:
                break
            resp += d
    except OSError:
        pass
    sock.close()
    check(resp.startswith(b"HTTP/1.1 413") or resp.startswith(b"HTTP/1.0 413"), "oversize body is 413", resp[:40])
    check(not r.log("player"), "oversize body never plays")

    # MP3 forms
    mp3_id3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + bytes([0xFF, 0xFB, 0x90, 0x64]) + b"\x00" * 600
    s, j = r.play(mp3_id3, ctype="audio/mpeg")
    check(s == 202, "MP3 with ID3 tag accepted", s)
    r.wait_state(j.get("id"), 5)
    mp3_sync = bytes([0xFF, 0xFB, 0x90, 0x64]) + b"\x00" * 600
    s, j = r.play(mp3_sync, ctype="audio/mpeg")
    check(s == 202, "MP3 frame sync accepted", s)
    r.wait_state(j.get("id"), 5)

    # new play replaces the old one; stop endpoint
    r.mode("player", "long")
    s, a = r.play(kind="sample")
    time.sleep(0.4)
    r.mode("player", "ok")
    s, b = r.play(kind="sample")
    check(r.wait_state(a.get("id"), 3) == "cancelled", "a new play cancels the previous one")
    check(r.wait_state(b.get("id"), 5) == "completed", "the replacing play completes")
    r.mode("player", "long")
    s, c = r.play()
    time.sleep(0.4)
    t0 = time.time()
    st = r.wait_state(c.get("id"), 1)
    check(st == "playing" and time.time() - t0 < 3, "wait returns at its deadline while playing", f"{st} {time.time()-t0:.1f}s")
    s, j = r.json("POST", "/v1/stop")
    check(s == 200 and j.get("stopped") == 1, "stop stops the playback in progress", f"{s} {j}")
    check(r.wait_state(c.get("id"), 2) == "cancelled", "stopped playback is cancelled")
    r.mode("player", "ok")

    # recorder dies, busy device
    r.mode("recorder", "die")
    s, j = r.json("POST", "/v1/record/start")
    rid = j.get("id")
    time.sleep(1.3)
    s, h, body = r.req("POST", f"/v1/record/{rid}/stop")
    check(s == 503 and b"stream error" in body, "recorder crash is 503 with its message", f"{s} {body[:120]}")
    r.mode("recorder", "busy")
    s, j = r.json("POST", "/v1/record/start")
    check(s == 503 and "busy" in j.get("error", ""), "busy microphone is 503", f"{s} {j}")
    r.mode("recorder", "ok")
    s, j = r.json("POST", "/v1/record/start")
    check(s == 201, "recording works again after failures", f"{s} {j}")
    rid = j.get("id")
    time.sleep(0.2)
    s, j = r.json("POST", f"/v1/record/{rid}/cancel")
    s, h, body = r.req("POST", f"/v1/record/{rid}/stop")
    check(s == 404, "a cancelled recording cannot be collected", s)

    # nothing secret in output
    out = r.all_output()
    check(r.token not in out and r.token[:-4] not in out, "token never printed")
finally:
    r.close()

# SIGINT while recording stops the recorder and removes the file
r = Receiver()
try:
    s, j = r.json("POST", "/v1/record/start")
    time.sleep(0.3)
    paths = started_paths(r, "recorder")
    check(r.stop(signal.SIGINT), "receiver exits on SIGINT while recording")
    check(wait_until(lambda: any(l.startswith("signal") for l in r.log("recorder")), 3), "SIGINT stops the recorder")
    time.sleep(0.5)
    check(paths and not os.path.exists(paths[0]), "no recording left after shutdown", paths)
finally:
    r.close()

# default token file
d = tempfile.mkdtemp(prefix="recv-xdg-")
r = Receiver(use_token_file=False, env={"XDG_CONFIG_HOME": d})
try:
    tf = os.path.join(d, "pi-speech", "receiver.token")
    ok = os.path.exists(tf)
    check(ok, "default token file created", tf)
    if ok:
        mode = stat.S_IMODE(os.stat(tf).st_mode)
        tok = open(tf).read().strip()
        check(mode & 0o077 == 0 and len(tok) >= 32, "default token file is private and long", f"{oct(mode)} {len(tok)}")
        r.token = tok
        s, _, _ = r.req("GET", "/v1/health")
        check(s == 200, "default token authenticates", s)
finally:
    r.close()
    shutil.rmtree(d, ignore_errors=True)

# IPv6 loopback when the host has it
try:
    probe = socket.socket(socket.AF_INET6)
    probe.bind(("::1", 0))
    probe.close()
    has6 = True
except OSError:
    has6 = False
if has6:
    r = Receiver(args=["--listen", "[::1]:0"])
    try:
        s, _, _ = r.req("GET", "/v1/health")
        check(s == 200, "listens on ::1", s)
    finally:
        r.close()

for addr in ["192.0.2.1:0", "localhost.example:0"]:
    bad = Receiver(args=["--listen", addr], wait_listen=False)
    try:
        try:
            rc = bad.proc.wait(8)
        except subprocess.TimeoutExpired:
            rc = None
        check(rc not in (None, 0), f"refuses {addr}", rc)
    finally:
        bad.close()

finish()
