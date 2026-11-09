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
    set_aside_if = script(root / "lib/reviews.ts", "SET_ASIDE_IF")
    made = []
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

        # SET_ASIDE_IF (pre-review of a8737e12a6): damaged records moved in one step, only while still the text read.
        base = "marktmorgen:integration:review-aside:" + uuid.uuid4().hex
        keys = [base + ":records", base + ":aside", base + ":vis", base + ":all", base + ":new"]
        made.extend(keys)
        records, aside, vis, every, queue = keys

        def set_aside(*pairs):
            return redis.command("EVAL", set_aside_if, 5, *keys, "prod0009", 10, *pairs)

        redis.command("HSET", records, "a" * 24, "{not json", "b" * 24, '{"fresh":1}', "c" * 24, '{"ok":1}')
        redis.command("ZADD", vis, 1, "a" * 24, 2, "b" * 24, 3, "c" * 24)
        for key in (every, queue):
            redis.command("ZADD", key, 1, "prod0009|" + "a" * 24, 2, "prod0009|" + "b" * 24)
        assert set_aside("a" * 24, "{not json", "b" * 24, "{not json either") == 1
        assert redis.command("HGET", aside, "a" * 24) == "{not json"
        assert redis.command("HEXISTS", records, "a" * 24) == 0
        assert redis.command("HGET", records, "b" * 24) == '{"fresh":1}' and redis.command("HEXISTS", aside, "b" * 24) == 0
        assert redis.command("ZSCORE", vis, "a" * 24) is None and redis.command("ZSCORE", vis, "b" * 24) is not None
        assert redis.command("ZSCORE", every, "prod0009|" + "a" * 24) is None and redis.command("ZSCORE", queue, "prod0009|" + "a" * 24) is None
        assert redis.command("ZSCORE", every, "prod0009|" + "b" * 24) is not None
        assert redis.command("TTL", aside) == -1
        print("PASS: a record still as read is moved with its list entries; one written since stays where it is")

        assert set_aside("a" * 24, "{not json") == 0 and redis.command("HGET", aside, "a" * 24) == "{not json"
        print("PASS: moving again finds nothing and changes nothing")

        # v2 (second pre-review of fc75f6a256): a second record of the same review goes to a field of its own.
        redis.command("HSET", records, "a" * 24, "{damaged again")
        assert set_aside("a" * 24, "{damaged again") == 1
        assert redis.command("HGET", aside, "a" * 24) == "{not json"
        assert redis.command("HGET", aside, "a" * 24 + ":1") == "{damaged again"
        for n in range(2, 10):
            redis.command("HSET", aside, "a" * 24 + ":" + str(n), "older")
        redis.command("HSET", records, "a" * 24, "{one too many")
        assert set_aside("a" * 24, "{one too many") == 0
        assert redis.command("HGET", records, "a" * 24) == "{one too many" and redis.command("HLEN", aside) == 10
        print("PASS: each record of a review set aside keeps its own field, never over another; none free, not moved")
    finally:
        for key in [numbers, *made]:
            redis.command("DEL", key)
        redis.close()


if __name__ == "__main__":
    main()
