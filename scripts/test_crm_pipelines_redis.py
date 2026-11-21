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
        crm_person_scripts(redis, source, prefix)
    finally:
        assert all(key.startswith(prefix) for key in keys)
        redis.command("DEL", *keys)
        redis.close()


def static_script(source, name):
    match = re.search(r"export const " + name + r" = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected one static script " + name)
    return match.group(1)


def crm_person_scripts(redis, source, prefix):
    """The CRM scripts of #2287 against real Redis (Codex X6 on #2287), where the in-memory stand-in
    (lib/redis-memory.ts) models them: a deletion mark, a generation, a run's take of the lease at its fractional
    score (lib/flows.ts leaseScore), and lengths measured in UTF-8 bytes, as Lua's string.len counts them."""
    mark_returned = static_script(source, "MARK_RETURNED")
    set_value = static_script(source, "SET_CRM_VALUE")
    move_deal = static_script(source, "MOVE_CRM_DEAL")
    save_deal = static_script(source, "SAVE_CRM_DEAL")
    erased, generation, values = prefix + "erased", prefix + "generation", prefix + "values"
    lease, deals = prefix + "lease", prefix + "deals"
    take, other = "1700000900.0000004768371582", "1700000900.0000009536743164"
    accented = "Café"  # 4 characters, 5 bytes in UTF-8
    try:
        # A deletion mark goes only for an act after the deletion; one that is not a time stays.
        redis.command("SET", erased, "1000")
        assert redis.command("EVAL", mark_returned, 1, erased, "1000") == 0 and redis.command("GET", erased) == "1000"
        assert redis.command("EVAL", mark_returned, 1, erased, "1001") == 1 and redis.command("EXISTS", erased) == 0
        redis.command("SET", erased, "soon")
        assert redis.command("EVAL", mark_returned, 1, erased, "9999") == 0 and redis.command("GET", erased) == "soon"
        redis.command("DEL", erased)
        print("PASS: a deletion mark goes only for a later act, and one that is not a time stays")
        # A value: refused while marked or for another generation; written for this generation, answering what it replaced.
        redis.command("SET", erased, "1")
        assert redis.command("EVAL", set_value, 3, values, erased, generation, "p1", accented, 0) == 2
        assert redis.command("HEXISTS", values, "p1") == 0
        redis.command("DEL", erased)
        redis.command("SET", generation, "1731000000123")
        assert redis.command("EVAL", set_value, 3, values, erased, generation, "p1", accented, 0) == 2
        assert redis.command("EVAL", set_value, 3, values, erased, generation, "p1", accented, "1731000000123") == [1]
        assert redis.command("EVAL", set_value, 3, values, erased, generation, "p1", "Tea", "1731000000123") == [1, accented]
        # A workflow step writes only at its own take of the lease.
        redis.command("ZADD", lease, take, "g|p1")
        assert redis.command("EVAL", set_value, 4, values, erased, generation, lease, "p1", "Juice", "1731000000123", "g|p1", other) == 2
        assert redis.command("EVAL", set_value, 4, values, erased, generation, lease, "p1", "Juice", "1731000000123", "g|p1", take) == [1, "Tea"]
        assert redis.command("EVAL", set_value, 3, values, erased, generation, "p1", "", "1731000000123") == [1, "Juice"]
        assert redis.command("HEXISTS", values, "p1") == 0
        print("PASS: a value is written only unmarked, at the person's generation and at the run's own take")
        # A deal: lengths are UTF-8 bytes; a run not holding its take answers 3 with the record kept, writing nothing.
        assert redis.command("EVAL", save_deal, 1, deals, "d1", accented, 10, "new") == [1]
        assert redis.command("EVAL", save_deal, 1, deals, "d1", "Tea", 10, "edit") == [1, len(accented.encode("utf-8"))]
        assert redis.command("EVAL", save_deal, 1, deals, "gone", "x", 10, "edit") == 2
        assert redis.command("EVAL", save_deal, 2, deals, lease, "d1", accented, 10, "edit", "g|p1", other) == [3, 3]
        assert redis.command("EVAL", save_deal, 2, deals, lease, "nope", accented, 10, "edit", "g|p1", other) == [3]
        assert redis.command("HGET", deals, "d1") == "Tea"
        assert redis.command("EVAL", save_deal, 2, deals, lease, "d1", accented, 10, "edit", "g|p1", take) == [1, 3]
        redis.command("HSET", deals, "d2", "x")
        assert redis.command("EVAL", save_deal, 1, deals, "d3", "y", 2, "new") == 0
        print("PASS: a deal is saved within its cap, edited only while there, at the run's own take, measured in bytes")
        # A move: only the exact snapshot; a changed one answers its length in bytes; nothing comes back once deleted.
        assert redis.command("EVAL", move_deal, 1, deals, "d1", "stale", "moved") == [-1, len(accented.encode("utf-8"))]
        assert redis.command("EVAL", move_deal, 1, deals, "d1", accented, "moved") == 1 and redis.command("HGET", deals, "d1") == "moved"
        assert redis.command("EVAL", move_deal, 1, deals, "deleted", "a", "b") == 0 and redis.command("HEXISTS", deals, "deleted") == 0
        assert redis.command("EVAL", move_deal, 2, deals, lease, "d1", "moved", "again", "g|p1", other) == [3, 5]
        assert redis.command("EVAL", move_deal, 2, deals, lease, "d1", "moved", "again", "g|p1", take) == 1
        print("PASS: a deal moves only from the exact snapshot and at the run's own take, against real Redis")
    finally:
        redis.command("DEL", erased, generation, values, lease, deals)


if __name__ == "__main__":
    main()
