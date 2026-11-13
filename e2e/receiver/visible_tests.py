"""Visible acceptance for pi-speech-receiver (see protocol/bridge.md)."""
import json, os, signal, subprocess, time
from common import Receiver, check, finish, wait_until, wav_bytes, wav_seconds, started_paths, BIN

r = Receiver()
try:
    s, j = r.json("GET", "/v1/health")
    check(s == 200 and j.get("protocol") == 1 and j.get("name") == "pi-speech-receiver"
          and {"play", "record"} <= set(j.get("capabilities", [])), "health with token", f"{s} {j}")
    s, j = r.json("GET", "/v1/health", token=None)
    check(s == 401 and isinstance(j, dict) and "error" in j, "health without token is 401 with an error body", f"{s} {j}")
    s, j = r.json("GET", "/v1/health", token="Bearer wrong" + r.token[5:])
    check(s == 401, "wrong token is 401", s)

    audio = wav_bytes()
    s, j = r.play(audio)
    check(s == 202 and isinstance(j, dict) and j.get("id"), "play WAV accepted", f"{s} {j}")
    pid = j.get("id")
    st = r.wait_state(pid, 10)
    check(st == "completed", "playback completes when the player exits 0", st)
    paths = started_paths(r, "player")
    check(len(paths) == 1, "player started once with one file", r.log("player"))
    if paths:
        check(open(os.path.join(r.fake, "last-played"), "rb").read() == audio, "player received the uploaded bytes")
        check(wait_until(lambda: not os.path.exists(paths[0]), 3), "played file deleted afterwards", paths[0])

    s, j = r.json("POST", "/v1/play/stream", body=json.dumps({"format": "ogg"}), headers={"Content-Type": "application/json"})
    check(s == 400, "a Stream in a format it does not play is 400", s)
    check(len(started_paths(r, "player")) == 1, "player not started for a rejected Stream")

    r.mode("player", "long")
    s, j = r.play()
    pid = j.get("id")
    time.sleep(0.4)
    s2, j2 = r.json("POST", f"/v1/play/{pid}/cancel")
    check(s2 == 200 and j2.get("state") == "cancelled", "cancel answers cancelled", f"{s2} {j2}")
    check(r.wait_state(pid, 2) == "cancelled", "cancelled state is kept")
    check(wait_until(lambda: any(l.startswith("signal") for l in r.log("player")), 4), "player got a signal on cancel", r.log("player"))

    r.mode("player", "fail")
    s, j = r.play()
    if s == 202:
        s3, j3 = r.json("GET", f"/v1/play/{j['id']}?wait=5")
        check(j3.get("state") == "failed" and j3.get("error"), "player failure is reported as failed with an error", j3)
    else:
        check(s == 503 and j.get("error"), "player failure is reported", f"{s} {j}")

    s, j = r.json("POST", "/v1/record/start")
    check(s == 201 and j.get("id") and isinstance(j.get("max_seconds"), (int, float)), "record start", f"{s} {j}")
    rid = j.get("id")
    s2, j2 = r.json("POST", "/v1/record/start")
    check(s2 == 409, "second start while recording is 409", s2)
    time.sleep(0.3)
    s, h, body = r.req("POST", f"/v1/record/{rid}/stop")
    secs = wav_seconds(body)
    check(s == 200 and h.get("content-type", "").startswith("audio/wav") and secs and secs >= 0.9,
          "stop returns the recording as WAV", f"{s} {h.get('content-type')} {secs}")
    rpaths = started_paths(r, "recorder")
    check(rpaths and wait_until(lambda: not os.path.exists(rpaths[-1]), 3), "recording deleted after it is returned", rpaths)
    s, h, body = r.req("POST", f"/v1/record/{rid}/stop")
    check(s == 404, "second stop is 404", s)

    s, j = r.json("POST", "/v1/record/start")
    rid = j.get("id")
    time.sleep(0.3)
    s, j = r.json("POST", f"/v1/record/{rid}/cancel")
    check(s == 200 and j.get("state") == "cancelled", "record cancel", f"{s} {j}")
    rpaths = started_paths(r, "recorder")
    check(wait_until(lambda: not os.path.exists(rpaths[-1]), 3), "cancelled recording deleted", rpaths)

    r.mode("recorder", "fail")
    s, j = r.json("POST", "/v1/record/start")
    check(s == 503 and "no such audio device" in j.get("error", ""), "missing microphone is 503 with the recorder's message", f"{s} {j}")

    r.mode("recorder", "empty")
    s, j = r.json("POST", "/v1/record/start")
    rid = j.get("id")
    time.sleep(0.3)
    s, h, body = r.req("POST", f"/v1/record/{rid}/stop")
    check(s == 422, "empty recording is 422", s)

    r.mode("player", "long")
    s, j = r.play()
    time.sleep(0.4)
    ok = r.stop(signal.SIGTERM)
    check(ok, "receiver exits on SIGTERM")
    check(wait_until(lambda: any(l.startswith("signal") for l in r.log("player")), 4), "SIGTERM stops the player", r.log("player"))
finally:
    r.close()

bad = Receiver(args=["--listen", "0.0.0.0:0"], wait_listen=False)
try:
    try:
        rc = bad.proc.wait(8)
    except subprocess.TimeoutExpired:
        rc = None
    check(rc not in (None, 0) and "listening" not in bad.all_output(), "refuses a non-loopback address", rc)
finally:
    bad.close()

loose = Receiver(token_mode=0o644, wait_listen=False)
try:
    try:
        rc = loose.proc.wait(8)
    except subprocess.TimeoutExpired:
        rc = None
    check(rc not in (None, 0), "refuses a token file readable by others", rc)
finally:
    loose.close()

finish()
