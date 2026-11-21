"""Exercise the actual Store assistant pool Lua (lib/store-assistant.ts, ASSISTANT_POOL) against disposable local CI Redis.
No application credentials or production host configuration are read.
"""
import concurrent.futures
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
    lua = script(root / "lib/store-assistant.ts", "ASSISTANT_POOL")
    key = "marktmorgen:integration:assist:" + uuid.uuid4().hex
    redis = Redis()

    def run(client, *args):
        return client.command("EVAL", lua, 2, key, key + ":opened", *[str(a) for a in args])

    def fields():
        flat = redis.command("HGETALL", key)
        return {flat[i]: int(flat[i + 1]) for i in range(0, len(flat), 2)}

    try:
        assert redis.command("PING") == "PONG"
        assert run(redis, "reserve", 300, 1000, 3600) == 1
        assert fields() == {"held": 300, "cap": 1000}
        ttl = int(redis.command("TTL", key))
        assert 3500 < ttl <= 3600
        assert run(redis, "settle", 300, 120) == 1
        assert fields() == {"held": 0, "cap": 1000, "spent": 120, "n": 1}
        print("PASS: a reservation is settled at what was billed, and the rest given back")

        assert run(redis, "reserve", 400, 1000, 3600) == 1
        assert run(redis, "release", 400) == 1
        assert fields()["held"] == 0 and fields()["spent"] == 120 and fields()["n"] == 1
        print("PASS: a reservation released whole leaves nothing spent and no reply counted")

        assert run(redis, "reserve", 881, 1000, 3600) == 0
        assert run(redis, "reserve", 880, 1000, 3600) == 1
        assert run(redis, "reserve", 1, 1000, 3600) == 0
        assert run(redis, "settle", 880, 880) == 1
        print("PASS: past the cap nothing is reserved; a full month refuses even one micro-dollar")

        # A later, higher cap does not raise the month it opened with; a lower one wins.
        assert run(redis, "reserve", 1, 5000, 3600) == 0
        assert int(redis.command("HGET", key, "cap")) == 1000
        # The TTL set when the month opened is kept.
        assert int(redis.command("TTL", key)) <= ttl
        lower = key + ":lower"
        assert redis.command("EVAL", lua, 2, lower, lower + ":opened", "reserve", "100", "1000", "3600") == 1
        assert redis.command("EVAL", lua, 2, lower, lower + ":opened", "reserve", "450", "500", "3600") == 0
        assert redis.command("EVAL", lua, 2, lower, lower + ":opened", "reserve", "400", "500", "3600") == 1
        assert int(redis.command("HGET", lower, "cap")) == 500
        assert redis.command("EVAL", lua, 2, lower, lower + ":opened", "reserve", "1", "5000", "3600") == 0
        redis.command("DEL", lower, lower + ":opened")
        print("PASS: the cap a month opened with is kept, and only ever lowered")

        before = redis.command("HGETALL", key)
        for bad in [("settle", 5, 1), ("release", 5), ("settle", 0, 0), ("reserve", -1, 10, 10), ("reserve", 1, "x", 10), ("reserve", 1, 10, 0), ("other", 1), ("settle", 1, "01")]:
            assert run(redis, *bad) == -1, bad
        assert redis.command("HGETALL", key) == before
        assert run(redis, "reserve", 0, 10, 10) == -1
        assert redis.command("HGETALL", key) == before
        print("PASS: a malformed call, or a settle with nothing held, writes nothing")

        redis.command("DEL", key)
        assert run(redis, "reserve", 1, 10, 10) == -1
        assert redis.command("EXISTS", key) == 0
        print("PASS: a month's pool gone while its month is marked opened reserves nothing, never a fresh pool")

        redis.command("DEL", key, key + ":opened")

        def one(_):
            client = Redis()
            try:
                return run(client, "reserve", 100, 1000, 3600)
            finally:
                client.close()

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(one, range(40)))
        assert sum(1 for r in results if r == 1) == 10 and sum(1 for r in results if r == 0) == 30
        assert fields()["held"] == 1000
        print("PASS: forty at once on a pool of ten: exactly ten are reserved")

        redis.command("DEL", key, key + ":opened")
        redis.command("SET", key, "not a hash")
        assert run(redis, "reserve", 1, 10, 10) == -1
        print("PASS: a key of another kind is never written")
    finally:
        redis.command("DEL", key, key + ":opened")
        redis.close()


if __name__ == "__main__":
    main()
