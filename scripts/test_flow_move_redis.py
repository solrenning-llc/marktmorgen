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
    match = re.search(r"(?:export )?const " + name + r" = `([^`]+)`;", source)
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
        own_take_scripts(redis, root, base)
    finally:
        redis.command("DEL", queue, lease)


def own_take_scripts(redis, root, base):
    """The lease scripts of #2287 against real Redis, at a take's real score: a whole second plus k/2^21 (leaseScore).

    Each acts only while the lease holds the member at exactly this take's score, read back from Redis as text and
    compared with tonumber, as the in-memory stand-in (lib/redis-memory.ts) models it (Codex X6 on #2287)."""
    move_own = script(root / "lib/flows.ts", "FLOW_MOVE_OWN")
    queue_if = script(root / "lib/flows.ts", "QUEUE_IF_LEASED")
    drop_own = script(root / "lib/flows.ts", "DROP_OWN_LEASES")
    claim_if = script(root / "lib/flow-runs.ts", "CLAIM_IF_LEASED")
    lease, queue = base + ":own:lease", base + ":own:queue"
    run, log, runs = base + ":own:run", base + ":own:log", base + ":own:runs"
    take, other = "1700000900.0000004768371582", "1700000900.0000009536743164"
    a, b = "g|a@example.com", "g|b@example.com"
    try:
        # The score written by a take reads back equal to itself, and a later take's score never does.
        redis.command("ZADD", lease, take, a, other, b)
        assert redis.command("EVAL", queue_if, 2, lease, queue, a, 50, "qa", take) == 1
        assert redis.command("ZSCORE", queue, "qa") == "50"
        assert redis.command("EVAL", queue_if, 2, lease, queue, b, 60, "qb", take) == 0
        assert redis.command("ZSCORE", queue, "qb") is None
        # Back to the queue only what this take holds; a member taken over stays with its new take.
        assert redis.command("EVAL", move_own, 2, lease, queue, take, 70, a, b) == [1, 0]
        assert redis.command("ZSCORE", queue, a) == "70" and redis.command("ZSCORE", lease, a) is None
        assert redis.command("ZSCORE", lease, b) is not None
        # Dropped only at this take's score.
        redis.command("ZADD", lease, take, a)
        assert redis.command("EVAL", drop_own, 1, lease, take, a, b, "g|nobody@example.com") == [1, 0, 0]
        assert redis.command("ZSCORE", lease, a) is None and redis.command("ZSCORE", lease, b) is not None
        # A claim needs the lease at this take's score and the run still there; it writes once, and renews the run.
        redis.command("ZADD", lease, take, a)
        redis.command("HSET", run, "email", "a@example.com")
        argv = [a, take, "open-1", "{}", 1000, "person-a", 1700000901]
        assert redis.command("EVAL", claim_if, 4, lease, run, log, runs, *argv) == 1
        assert redis.command("HGET", run, "open") == "open-1"
        assert redis.command("LRANGE", log, 0, -1) == ["{}"]
        assert 0 < int(redis.command("TTL", run)) <= 1000 and 0 < int(redis.command("TTL", log)) <= 1000
        assert redis.command("ZSCORE", runs, "person-a") == "1700000901"
        # Already open: not claimed again, nothing more written.
        assert redis.command("EVAL", claim_if, 4, lease, run, log, runs, a, take, "open-2", "{}", 1000, "person-a", 1700000902) == 0
        assert redis.command("HGET", run, "open") == "open-1" and redis.command("LLEN", log) == 1
        # Taken over (another score) or erased (no run): gone, nothing written.
        assert redis.command("EVAL", claim_if, 4, lease, run, log, runs, a, other, "open-3", "{}", 1000, "person-a", 1) == -1
        redis.command("DEL", run)
        assert redis.command("EVAL", claim_if, 4, lease, run, log, runs, a, take, "open-4", "{}", 1000, "person-a", 1) == -1
        assert redis.command("EXISTS", run) == 0 and redis.command("LLEN", log) == 1
        print("PASS: the lease scripts of #2287 act only at the take's own fractional score, against real Redis")
    finally:
        redis.command("DEL", lease, queue, run, log, runs)


if __name__ == "__main__":
    main()
