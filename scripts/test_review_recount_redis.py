"""Run the actual review numbers script (lib/reviews.ts, WRITE_NUMBERS_IF) against disposable local CI Redis.
No application credentials or production host configuration are read.

A product's numbers are written over its recount mark only while the mark is still the one the recount counted for,
so a recount from before another change never writes what it counted over that change's mark (pre-review of
claude5/reviews-recount-exact, 9 November 2026). lib/redis-memory.ts models the same script for the unit tests.
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


def inside_calls(redis):
    """Commands the server ran, by name: Upstash bills an EVAL as one command plus one
    for every redis.call it runs (upstash.com/docs/redis/overall/billing, read 31/10/2026)."""
    stats = {}
    for line in redis.command("INFO", "commandstats").split("\r\n"):
        match = re.match(r"cmdstat_(\w+):calls=(\d+)", line)
        if match:
            stats[match.group(1)] = int(match.group(2))
    return stats


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    write_if = script(root / "lib/reviews.ts", "WRITE_NUMBERS_IF")
    numbers = "marktmorgen:integration:review-numbers:" + uuid.uuid4().hex
    mine, newer = "recount:" + "a" * 24, "recount:" + "b" * 24
    counted = '{"count":2,"stars":6,"visible":1,"hidden":1,"refunded":0,"dist":[1,0,0,0,1]}'
    redis = Redis()

    def run(mark, value):
        return redis.command("EVAL", write_if, 1, numbers, "prod0009", mark, value)

    try:
        assert redis.command("PING") == "PONG"
        redis.command("HSET", numbers, "prod0009", mine)
        assert run(mine, counted) == 1
        assert redis.command("HGET", numbers, "prod0009") == counted
        print("PASS: the numbers are written over the recount's own mark")

        redis.command("HSET", numbers, "prod0009", newer)
        assert run(mine, counted) == 0
        assert redis.command("HGET", numbers, "prod0009") == newer
        print("PASS: a newer change's mark is never written over")

        assert run(mine, counted) == 0 and run(newer, "") == 1
        assert redis.command("HEXISTS", numbers, "prod0009") == 0
        print("PASS: a product with no reviews left has its numbers deleted, only over its own mark")

        assert run(mine, counted) == 0 and redis.command("HEXISTS", numbers, "prod0009") == 0
        redis.command("HSET", numbers, "prod0009", counted)
        assert run(mine, '{"other":1}') == 0 and redis.command("HGET", numbers, "prod0009") == counted
        print("PASS: numbers gone or already counted are never written over")

        redis.command("HSET", numbers, "prod0009", mine)
        before = inside_calls(redis)
        assert run(mine, counted) == 1
        after = inside_calls(redis)
        ran = {name: after.get(name, 0) - before.get(name, 0) for name in ("eval", "hget", "hset", "hdel")}
        assert ran == {"eval": 1, "hget": 1, "hset": 1, "hdel": 0}, ran
        print("PASS: billed as the EVAL, its HGET and its HSET (three)")
    finally:
        redis.command("DEL", numbers)
        redis.close()


if __name__ == "__main__":
    main()
