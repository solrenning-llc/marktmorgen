"""Exercise the actual capped count Lua (lib/capped-count.ts) against disposable local CI Redis.
No application credentials or production host configuration are read.
"""
import concurrent.futures
import os
from pathlib import Path
import random
import re
import uuid
from test_form_opportunity_redis import Redis


def script(path, name):
    source = Path(path).read_text(encoding="utf-8")
    match = re.search(r"export const " + name + r" = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected static application script " + name)
    return match.group(1)


# Version 1 of the script, as it was on main until 31 October 2026, kept here
# word for word so version 2 is compared with it on a real server.
VERSION_1 = """-- marktmorgen:capped-count:v1
local n = #KEYS
if n < 1 or #ARGV < n or (#ARGV - n) % 3 ~= 0 then return redis.error_reply('capped-count: arguments') end
local caps = {}
for i = 1, n do
  local cap = tonumber(ARGV[i])
  if not cap or cap < 1 or cap ~= math.floor(cap) then return redis.error_reply('capped-count: most') end
  caps[i] = cap
end
for i = n + 1, #ARGV, 3 do
  local k = tonumber(ARGV[i])
  local by = tonumber(ARGV[i + 2])
  if not k or k < 1 or k > n or k ~= math.floor(k) or not by or by ~= math.floor(by) or ARGV[i + 1] == '' or ARGV[i + 1] == '~' then return redis.error_reply('capped-count: count') end
end
local out = {}
for i = n + 1, #ARGV, 3 do
  local k = tonumber(ARGV[i])
  local field = ARGV[i + 1]
  local by = tonumber(ARGV[i + 2])
  if redis.call('HEXISTS', KEYS[k], field) == 1 or redis.call('HLEN', KEYS[k]) < caps[k] then
    out[#out + 1] = redis.call('HINCRBY', KEYS[k], field, by)
  else
    redis.call('HINCRBY', KEYS[k], '~', by)
    out[#out + 1] = 0
  end
end
return out"""


def reference(hashes, caps, counts):
    """What the script answered before 31 October 2026, re-reading the hash for every count:
    a name already there always counts, a new one only while the hash has fewer fields
    than its most ("~" among them once it is there), the rest under "~"."""
    out = []
    for k, field, by in counts:
        held = hashes[k - 1]
        if field in held or len(held) < caps[k - 1]:
            held[field] = held.get(field, 0) + by
            out.append(held[field])
        else:
            held["~"] = held.get("~", 0) + by
            out.append(0)
    return out


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
    count = script(root / "lib/capped-count.ts", "CAPPED_COUNT")
    prefix = "marktmorgen:integration:capped:" + uuid.uuid4().hex + ":"
    day, life = prefix + "day", prefix + "life"
    redis = Redis()

    def run(client, caps, *counts):
        keys = [day, life][: len(caps)]
        flat = [str(part) for c in counts for part in c]
        return client.command("EVAL", count, len(keys), *keys, *caps, *flat)

    try:
        assert redis.command("PING") == "PONG"
        assert run(redis, [3, 5], (1, "v", 1), (1, "r:a", 1), (2, "r:a", 1)) == [1, 1, 1]
        assert run(redis, [3, 5], (1, "v", 1), (1, "k:x", 1), (1, "k:y", 1)) == [2, 1, 0]
        assert redis.command("HLEN", day) == 4 and int(redis.command("HGET", day, "~")) == 1
        assert run(redis, [3, 5], (1, "k:x", 5), (1, "k:z", 2)) == [6, 0]
        assert int(redis.command("HGET", day, "~")) == 3
        print("PASS: a field there always counts, a new one only below the most, the rest under ~")

        try:
            run(redis, [0], (1, "v", 1))
            raise AssertionError("a most of nothing was taken")
        except RuntimeError:
            pass
        for bad in [[(3, "v", 1)], [(1, "~", 1)], [(1, "", 1)], [(1, "v", "x")], [(1, "v", 1.5)]]:
            before = redis.command("HGETALL", day)
            try:
                run(redis, [3], *bad)
                raise AssertionError("malformed count taken: %r" % (bad,))
            except RuntimeError:
                pass
            assert redis.command("HGETALL", day) == before
        print("PASS: a malformed count writes nothing")

        rng = random.Random(20261031)
        names = ["v", "r:a", "r:b", "k:US", "k:BR", "d:mobile", "m:x", "g:y", "pv:1"]
        old_day, old_life = prefix + "v1day", prefix + "v1life"

        def hgetall(key):
            held = redis.command("HGETALL", key) or []
            return {held[i]: int(held[i + 1]) for i in range(0, len(held), 2)}

        for trial in range(1000):
            redis.command("DEL", day, life, old_day, old_life)
            caps = [rng.randint(1, 8), rng.randint(1, 8)][: rng.randint(1, 2)]
            hashes = [{}, {}]
            for k, pair in enumerate(((day, old_day), (life, old_life))[: len(caps)]):
                for name in rng.sample(names + ["~"], rng.randint(0, 9)):
                    value = rng.randint(-2, 5)
                    for key in pair:
                        redis.command("HSET", key, name, value)
                    hashes[k][name] = value
            counts = [(rng.randint(1, len(caps)), rng.choice(names), rng.randint(-3, 3)) for _ in range(rng.randint(1, 9))]
            flat = [str(part) for c in counts for part in c]
            got = run(redis, caps, *counts)
            was = redis.command("EVAL", VERSION_1, len(caps), *[old_day, old_life][: len(caps)], *caps, *flat)
            assert got == was == reference(hashes, caps, counts), (trial, caps, counts, got, was)
            for new_key, old_key, k in ((day, old_day, 0), (life, old_life, 1))[: len(caps)]:
                assert hgetall(new_key) == hgetall(old_key) == hashes[k], (trial, new_key)
        print("PASS: 1000 random counts, near and past their most, with counts of 0 and below: version 2 answers and keeps exactly what version 1 did")

        before = redis.command("HGETALL", day)
        try:
            redis.command("EVAL", count, 2, day, day, 3, 1, 1, "p", 1, 2, "q", 1)
            raise AssertionError("the same hash named twice was taken")
        except RuntimeError:
            pass
        assert redis.command("HGETALL", day) == before
        print("PASS: the same hash named twice is refused and nothing is written")

        # What a store's view sends (lib/stats.ts): nine counts over the day's and the all-time record.
        view = [(1, "v", 1), (1, "r:a", 1), (2, "r:a", 1), (1, "m:x", 1), (2, "m:x", 1), (1, "g:y", 1), (2, "g:y", 1), (1, "k:US", 1), (1, "d:mobile", 1)]
        for label, fill, life_fill, expected in (("below their most", 0, 0, 11), ("with the day's at its most", 100, 0, 12), ("with both at their most", 100, 2100, 13)):
            redis.command("DEL", day, life)
            for i in range(fill):
                redis.command("HSET", day, "f:%d" % i, 1)
            for i in range(life_fill):
                redis.command("HSET", life, "f:%d" % i, 1)
            before = inside_calls(redis)
            run(redis, [100, 2100], *view)
            after = inside_calls(redis)
            ran = {name: after.get(name, 0) - before.get(name, 0) for name in ("hexists", "hlen", "hmget", "hincrby", "hget", "hset")}
            # One HINCRBY a count, one HLEN a hash, and one HMGET for each hash a new name may not fit in.
            assert sum(ran.values()) == expected and ran["hexists"] == 0, (label, ran)
            print("PASS: a view's nine counts %s run %d commands inside the script, billed %d with the EVAL: %r" % (label, expected, expected + 1, ran))

        redis.command("DEL", day)

        def one(index):
            client = Redis()
            try:
                return run(client, [10], (1, "f:%d" % index, 1))[0]
            finally:
                client.close()

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(one, range(64)))
        # Ten names, and "~" beside them for the other 54.
        assert sum(1 for r in results if r == 1) == 10 and redis.command("HLEN", day) == 11
        assert int(redis.command("HGET", day, "~")) == 54
        print("PASS: concurrent new names never take a hash past its most")
    finally:
        redis.command("DEL", day, life)
        redis.close()


if __name__ == "__main__":
    main()
