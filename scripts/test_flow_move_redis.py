"""Exercise the actual sequence-queue move Lua (lib/flows.ts, FLOW_MOVE) against disposable local CI Redis.

A run taken off the queue is written to the lease in the same step, only by whoever took it off, and is never in
both or in neither. No application credentials or production host configuration are read.
"""
import os
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis


def script(path, name):
    source = Path(path).read_text(encoding="utf-8")
    match = re.search(r"export const " + name + r" = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected static application script " + name)
    return match.group(1)


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    move = script(root / "lib/flows.ts", "FLOW_MOVE")
    base = "marktmorgen:integration:flowq:" + uuid.uuid4().hex
    queue, lease = base + ":queue", base + ":lease"
    redis = Redis()
    try:
        assert redis.command("PING") == "PONG"
        a, b, c = "list|h|f|0|a@example.com", "list|h|f|0|b@example.com", "list|h|f|0|c@example.com"
        redis.command("ZADD", queue, 10, a, 10, b)
        # Taken off the queue into the lease at once; a member not in the queue is not written to the lease.
        assert redis.command("EVAL", move, 2, queue, lease, 900, a, b, c) == [1, 1, 0]
        assert redis.command("ZRANGE", queue, 0, -1) == []
        assert redis.command("ZRANGE", lease, 0, -1, "WITHSCORES") == [a, "900", b, "900"]
        # A second taker of the same members moves nothing: nobody sends twice.
        assert redis.command("EVAL", move, 2, queue, lease, 1800, a, b) == [0, 0]
        assert redis.command("ZSCORE", lease, a) == "900"
        # Back to the queue, the same way: only what is held in the lease.
        assert redis.command("EVAL", move, 2, lease, queue, 20, a, c) == [1, 0]
        assert redis.command("ZRANGE", queue, 0, -1, "WITHSCORES") == [a, "20"]
        assert redis.command("ZRANGE", lease, 0, -1) == [b]
        # Never in both, never in neither.
        for member in (a, b):
            places = [redis.command("ZSCORE", queue, member) is not None, redis.command("ZSCORE", lease, member) is not None]
            assert places.count(True) == 1, (member, places)
        print("PASS: the sequence queue move is atomic, owner-only and never leaves a run in neither set")
    finally:
        redis.command("DEL", queue, lease)


if __name__ == "__main__":
    main()
