"""Execute the actual CRM pipelines compare-and-set Lua script against an isolated local CI Redis.
No application credentials or production host configuration are read.
"""
import concurrent.futures
import os
from pathlib import Path
import re
import socket
import uuid


class Redis:
    def __init__(self):
        self.sock = socket.create_connection(("127.0.0.1", 16379), timeout=10)
        self.stream = self.sock.makefile("rb")

    def close(self):
        self.stream.close()
        self.sock.close()

    def command(self, *parts):
        encoded = [str(part).encode() for part in parts]
        payload = b"*" + str(len(encoded)).encode() + b"\r\n"
        for part in encoded:
            payload += b"$" + str(len(part)).encode() + b"\r\n" + part + b"\r\n"
        self.sock.sendall(payload)
        return self.read()

    def read(self):
        line = self.stream.readline()
        if not line.endswith(b"\r\n"):
            raise RuntimeError("Incomplete Redis reply")
        kind, value = line[:1], line[1:-2]
        if kind == b"+":
            return value.decode()
        if kind == b"-":
            raise RuntimeError(value.decode())
        if kind == b":":
            return int(value)
        if kind == b"$":
            length = int(value)
            if length == -1:
                return None
            raw = self.stream.read(length + 2)
            if len(raw) != length + 2 or not raw.endswith(b"\r\n"):
                raise RuntimeError("Incomplete Redis bulk reply")
            return raw[:-2].decode()
        if kind == b"*":
            return [self.read() for _ in range(int(value))]
        raise RuntimeError("Unsupported Redis reply")


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against the dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    source = (root / "lib/crm.ts").read_text(encoding="utf-8")
    match = re.search(r"export const SAVE_CRM_PIPELINES = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected one static CRM pipelines script")
    script = match.group(1)
    prefix = "marktmorgen:integration:crm-pipelines:" + uuid.uuid4().hex + ":"
    keys = [prefix + suffix for suffix in ("first", "race", "stale", "wrongtype")]
    redis = Redis()
    try:
        assert redis.command("PING") == "PONG"
        # A store that never saved pipelines: the snapshot is the empty string.
        assert redis.command("EVAL", script, 1, keys[0], "", "pipelines-v1") == 1
        assert redis.command("GET", keys[0]) == "pipelines-v1"
        # A refusal answers -1 and the size of the record kept (crm-pipelines-save:v2), so the data room is sized in one step.
        assert redis.command("EVAL", script, 1, keys[0], "", "pipelines-again") == [-1, len("pipelines-v1")]
        assert redis.command("GET", keys[0]) == "pipelines-v1"
        print("PASS: the first save needs an absent record, and a second first save is refused")
        redis.command("SET", keys[1], "snapshot")
        def save(index):
            client = Redis()
            try:
                return client.command("EVAL", script, 1, keys[1], "snapshot", "writer-" + str(index))
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            replies = list(pool.map(save, range(64)))
        refused = [r for r in replies if isinstance(r, list) and r[0] == -1 and r[1] == len(redis.command("GET", keys[1]))]
        assert replies.count(1) == 1 and len(refused) == 63, replies
        winner = redis.command("GET", keys[1])
        assert winner.startswith("writer-")
        print("PASS: 64 concurrent saves over one snapshot: exactly one is written")
        redis.command("SET", keys[2], "edited-by-another-session")
        assert redis.command("EVAL", script, 1, keys[2], "stale-snapshot", "stale-write") == [-1, len("edited-by-another-session")]
        assert redis.command("GET", keys[2]) == "edited-by-another-session"
        assert redis.command("EVAL", script, 1, keys[2], "edited-by-another-session", "fresh-write") == 1
        assert redis.command("GET", keys[2]) == "fresh-write"
        print("PASS: a stale snapshot preserves the concurrent change; a fresh one saves")
        redis.command("HSET", keys[3], "field", "value")
        try:
            redis.command("EVAL", script, 1, keys[3], "", "not-saved")
        except RuntimeError as error:
            assert "WRONGTYPE" in str(error)
        else:
            raise AssertionError("Wrong-type storage must refuse the script")
        assert redis.command("HGET", keys[3], "field") == "value"
        print("PASS: wrong-type storage is preserved and refuses the save")
    finally:
        assert all(key.startswith(prefix) for key in keys)
        redis.command("DEL", *keys)
        redis.close()


if __name__ == "__main__":
    main()
