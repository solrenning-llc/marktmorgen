"""Billable GL7 notice upper bound on a dedicated disposable loopback Redis.
Runs the actual application CAPPED_COUNT Lua; never reads app credentials.
"""
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import uuid
from test_form_opportunity_redis import Redis


def calls(client):
    return {m.group(1): int(m.group(2)) for line in client.command("INFO", "commandstats").split("\r\n")
            if (m := re.match(r"cmdstat_(\w+):calls=(\d+)", line))}


def main():
    if os.environ.get("READ_BEACON_NATIVE") != "1":
        raise RuntimeError("Explicit READ_BEACON_NATIVE=1 is required")
    source = (Path(__file__).resolve().parents[1] / "lib/capped-count.ts").read_text()
    match = re.search(r"export const CAPPED_COUNT = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected static application CAPPED_COUNT Lua")
    lua = match.group(1)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="codex-read-cost-") as tmp:
        with open(Path(tmp) / "redis.log", "wb") as log:
            proc = subprocess.Popen([os.environ.get("READ_BEACON_REDIS_BIN", "redis-server"), "--bind", "127.0.0.1", "--port", str(port), "--save", "", "--appendonly", "no", "--dir", tmp], stdout=log, stderr=log)
            client = None
            try:
                for _ in range(100):
                    try:
                        sock = socket.create_connection(("127.0.0.1", port), timeout=.1)
                        break
                    except OSError:
                        if proc.poll() is not None:
                            raise RuntimeError("Owned disposable Redis exited")
                        time.sleep(.05)
                else:
                    raise RuntimeError("Owned disposable Redis did not start")
                # Reuse only the repository's RESP encoder/decoder; its fixed
                # CI-port constructor is deliberately not invoked.
                client = Redis.__new__(Redis)
                client.sock, client.stream = sock, sock.makefile("rb")
                for label, fill, initial, expected in [("cold", False, None, 7), ("warm", False, 1, 5), ("near-cap", True, 1, 7), ("near-cap-zero", True, 0, 9), ("overflow", True, None, 7)]:
                    prefix = "marktmorgen:integration:read-cost:" + uuid.uuid4().hex
                    keys = [prefix + ":depth", prefix + ":t"]
                    for key in keys:
                        if initial is not None:
                            client.command("HSET", key, "wanted", initial)
                        if fill:
                            # A small cap exercises the exact cap branch. Its
                            # command shape is independent of the cap's size.
                            for i in range(2):
                                client.command("HSET", key, "fill" + str(i), 1)
                    before = calls(client)
                    reply = client.command("EVAL", lua, 2, *keys, 2, 2, 1, "wanted", 1, 2, "wanted", 1)
                    for key, n in zip(keys, reply):
                        if n == 1:
                            client.command("EXPIRE", key, 400 * 86400)
                    after = calls(client)
                    names = ("eval", "hlen", "hmget", "hincrby", "expire")
                    ran = {n: after.get(n, 0) - before.get(n, 0) for n in names}
                    assert sum(ran.values()) == expected, (label, ran, expected)
                    assert sum(ran.values()) <= 9, (label, ran)
                    print("PASS", label, sum(ran.values()), ran)
                    client.command("DEL", *keys)
            finally:
                if client is not None:
                    client.close()
                proc.terminate()
                proc.wait(timeout=10)


if __name__ == "__main__":
    main()
