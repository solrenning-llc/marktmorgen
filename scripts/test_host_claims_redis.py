"""Exercise the actual host claim Lua (lib/host-claims.ts) against disposable local CI Redis.

No application credentials or production host configuration are read.
"""
import concurrent.futures
import os
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis

HOUR = 3_600_000
DAY = 24 * HOUR


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    source = (root / "lib/host-claims.ts").read_text(encoding="utf-8")
    match = re.search(r"export const CLAIM_HOST_TIMES = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected one static host claim script")
    script = match.group(1)
    prefix = "marktmorgen:integration:host-claims:" + uuid.uuid4().hex + ":"
    keys = [prefix + name for name in ["a", "b", "c", "d", "e", "f", "g", "h"]]
    redis = Redis()
    now = 1_900_000_000_000
    day = (now, now + DAY)

    def claim(client, hosts, start, end, claim_id, hold=0, gap=0, cap=10, at=now):
        args = [at, start, end, claim_id, hold, "calls1:prod1"]
        for _ in hosts:
            args += [gap, day[0], day[1], cap]
        reply = client.command("EVAL", script, len(hosts), *hosts, *args)
        return reply[0]

    def race(work, count=64):
        def one(index):
            client = Redis()
            try:
                return work(client, index)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            return list(pool.map(one, range(count)))

    try:
        assert redis.command("PING") == "PONG"
        start = now + 2 * HOUR
        results = race(lambda client, i: claim(client, [keys[0]], start, start + HOUR, "k%024x" % i, hold=now + HOUR))
        assert results.count(1) == 1 and results.count(-1) == 63, results
        assert redis.command("HLEN", keys[0]) == 1
        print("PASS: 64 concurrent holds of one host's hour leave exactly one claim")

        assert claim(redis, [keys[1]], start, start + HOUR, "k" + "1" * 24) == 1
        assert claim(redis, [keys[1]], start + HOUR + 5 * 60_000, start + 2 * HOUR, "k" + "2" * 24, gap=10 * 60_000) == -1
        assert claim(redis, [keys[1]], start + HOUR + 5 * 60_000, start + 2 * HOUR, "k" + "2" * 24, gap=0) == 1
        print("PASS: a host's gap between calls is enforced atomically")

        assert claim(redis, [keys[2]], start, start + HOUR, "k" + "3" * 24) == 1
        before = redis.command("HGETALL", keys[3])
        assert claim(redis, [keys[3], keys[2]], start + 30 * 60_000, start + 90 * 60_000, "k" + "4" * 24) == -1
        assert redis.command("HGETALL", keys[3]) == before == []
        print("PASS: a collective claim takes every host's time or none")

        for i in range(2):
            assert claim(redis, [keys[4]], start + i * 2 * HOUR, start + i * 2 * HOUR + HOUR, "k%024x" % (100 + i), cap=2) == 1
        assert claim(redis, [keys[4]], start + 5 * HOUR, start + 6 * HOUR, "k%024x" % 102, cap=2) == -2
        assert redis.command("HLEN", keys[4]) == 2
        print("PASS: the host's daily cap refuses the next team call without writing")

        assert claim(redis, [keys[5]], start, start + HOUR, "k" + "5" * 24, hold=now + 60_000) == 1
        assert claim(redis, [keys[5]], start, start + HOUR, "k" + "6" * 24, at=now + 120_000) == 1
        assert redis.command("HKEYS", keys[5]) == ["k" + "6" * 24]
        assert claim(redis, [keys[5]], start + 30 * 60_000, start + 90 * 60_000, "k" + "6" * 24, at=now + 120_000) == 1
        assert redis.command("HGET", keys[5], "k" + "6" * 24).startswith(str(start + 30 * 60_000) + "|")
        assert 0 < redis.command("PTTL", keys[5]) <= start + 90 * 60_000 - now - 120_000 + 2 * DAY
        print("PASS: an expired hold gives its time back; a booking moves onto its own time; the list expires")

        assert claim(redis, [keys[3]], start + 4 * HOUR, start + 5 * HOUR, "k" + "a" * 24) == 1
        assert claim(redis, [keys[3]], start + 4 * HOUR, start + 5 * HOUR, "k" + "a" * 24, hold=now + 60_000) == 1
        assert redis.command("HGET", keys[3], "k" + "a" * 24).split("|")[2] == "0"
        print("PASS: a hold written over the same claim kept for good never downgrades it")

        pairs = [(keys[6], keys[7]), (keys[7], keys[6])]
        results = race(lambda client, i: claim(client, list(pairs[i % 2]), start, start + HOUR, "k%024x" % (500 + i)), 32)
        assert results.count(1) == 1, results
        assert redis.command("HLEN", keys[6]) == 1 and redis.command("HLEN", keys[7]) == 1
        assert redis.command("HKEYS", keys[6]) == redis.command("HKEYS", keys[7])
        print("PASS: racing collective claims over shared hosts never double-book either host")

        redis.command("DEL", keys[0])
        redis.command("SET", keys[0], "wrong-type")
        assert claim(redis, [keys[0]], start, start + HOUR, "k" + "7" * 24) == -3
        assert redis.command("GET", keys[0]) == "wrong-type"
        redis.command("HSET", keys[1], "corrupt", "not-a-claim")
        held = redis.command("HLEN", keys[1])
        assert claim(redis, [keys[1]], start + 10 * HOUR, start + 11 * HOUR, "k" + "8" * 24) == -3
        assert redis.command("HLEN", keys[1]) == held
        assert claim(redis, [keys[2]], start + HOUR, start, "k" + "9" * 24) == -3
        print("PASS: malformed claims, wrong-type storage and an inverted time refuse without writes")
    finally:
        assert all(key.startswith(prefix) for key in keys)
        redis.command("DEL", *keys)
        redis.close()


if __name__ == "__main__":
    main()
