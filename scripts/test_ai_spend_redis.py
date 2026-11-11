"""Execute AI spend admission against the disposable loopback CI Redis.
No application credentials or production host configuration are read.
"""
import concurrent.futures
import os
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against dedicated CI Redis on loopback port 16379")
    source = (Path(__file__).resolve().parents[1] / "lib/ai-spend.ts").read_text(encoding="utf-8")
    match = re.search(r"export const RESERVE_AI_SPEND = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected static application AI reservation script")
    script = match.group(1)
    prefix = "marktmorgen:integration:ai-spend:" + uuid.uuid4().hex + ":"
    keys = [prefix + str(index) for index in range(16)]
    redis = Redis()
    def seed(key, slots=1):
        redis.command("HSET", key, "review", "review-v2", "policy", "funded-snapshot-v2", "company", 0, "slots:creator", slots, "slots:pro", 0, "slots:scale", 0, "slots:trial", 0, "slots:setup", 0, "slots:ended", 0)
    def take(client, key, customer="one", snapshot="funded-snapshot-v2", charge=100, store_limit=300, company_limit=400, tier="creator", funded=1):
        return client.command("EVAL", script, 1, key, "review-v2", "store:" + customer, charge, store_limit, company_limit, snapshot, tier, funded)
    try:
        assert redis.command("PING") == "PONG"
        seed(keys[0])
        for _ in range(3):
            assert take(redis, keys[0]) == 1
        assert take(redis, keys[0]) == 0
        assert redis.command("HGET", keys[0], "store:one") == "300"
        assert redis.command("HGET", keys[0], "company") == "300"
        print("PASS: store spending stops at its exact funded ceiling")

        seed(keys[1], slots=4)
        def concurrent_take(index):
            client = Redis()
            try:
                return take(client, keys[1], "customer" + str(index), store_limit=100, funded=4)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(concurrent_take, range(64)))
        assert sum(results) == 4
        assert redis.command("HGET", keys[1], "company") == "400"
        print("PASS: concurrent customers cannot exceed the company ceiling")

        seed(keys[2])
        before = redis.command("HGETALL", keys[2])
        assert take(redis, keys[2], snapshot="changed-ceilings-same-review", store_limit=1000, company_limit=1000) == 0
        assert redis.command("HGETALL", keys[2]) == before
        redis.command("HDEL", keys[2], "policy")
        assert take(redis, keys[2]) == 0
        assert redis.command("HGET", keys[2], "company") == "0"
        print("PASS: changed or missing policy bindings cannot reuse funding")

        seed(keys[3])
        redis.command("HSET", keys[3], "store:one", 100)
        assert take(redis, keys[3]) == 0
        assert redis.command("HGET", keys[3], "company") == "0"
        redis.command("HDEL", keys[3], "store:one")
        for corrupt in ("-1", "01", "NaN", "1.5", "1000000000001"):
            redis.command("HSET", keys[3], "company", corrupt)
            assert take(redis, keys[3]) == 0
            assert redis.command("HGET", keys[3], "company") == corrupt
        print("PASS: corrupt or inconsistent counters refuse without writes")

        seed(keys[4])
        redis.command("EXPIRE", keys[4], 3600)
        assert take(redis, keys[4]) == 0
        redis.command("SET", keys[5], "wrong-type")
        assert take(redis, keys[5]) == 0
        assert take(redis, keys[6]) == 0
        assert redis.command("EXISTS", keys[6]) == 0
        print("PASS: expiring, wrong-type and missing ledgers never authorize spending")

        seed(keys[7])
        def one_slot(index):
            client = Redis()
            try:
                return take(client, keys[7], "slot" + str(index))
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            slot_results = list(pool.map(one_slot, range(64)))
        assert sum(slot_results) == 1
        winner = slot_results.index(1)
        assert redis.command("HGET", keys[7], "slots:creator") == "0"
        assert take(redis, keys[7], "slot" + str(winner)) == 1
        assert take(redis, keys[7], "slot" + str(winner)) == 1
        assert redis.command("HGET", keys[7], "company") == "300"
        print("PASS: a funded store allocation cannot be reused and retains its full budget")

        seed(keys[8])
        redis.command("HSET", keys[8], "slots:pro", 1)
        assert take(redis, keys[8]) == 1
        assert take(redis, keys[8], tier="pro") == 1
        assert redis.command("HGET", keys[8], "tier:store:one") == "pro"
        redis.command("HDEL", keys[8], "store:one")
        assert take(redis, keys[8]) == 0
        assert redis.command("HGET", keys[8], "company") == "200"
        seed(keys[9])
        redis.command("HDEL", keys[9], "slots:creator")
        assert take(redis, keys[9]) == 0
        assert redis.command("HGET", keys[9], "company") == "0"
        print("PASS: tier transitions keep their counters and missing allocation metadata require review")

        # A plan switched inside the window (R32 finding 1): one total, under the current tier's ceiling.
        def seed_switch(key):
            redis.command("HSET", key, "review", "review-v2", "policy", "funded-snapshot-v2", "company", 0, "slots:creator", 0, "slots:pro", 5, "slots:scale", 5, "slots:trial", 0, "slots:setup", 0, "slots:ended", 0)
        def switch(key, tier, charge=100, customer="one"):
            limit = 300 if tier == "pro" else 600
            return take(redis, key, customer=customer, charge=charge, store_limit=limit, company_limit=10000, tier=tier, funded=5)
        seed_switch(keys[10])
        assert switch(keys[10], "pro", charge=200) == 1
        assert switch(keys[10], "scale", charge=400) == 1
        assert switch(keys[10], "scale", charge=1) == 0
        assert redis.command("HGET", keys[10], "store:one") == "600"
        assert redis.command("HGET", keys[10], "tier:store:one") == "scale"
        assert redis.command("HGET", keys[10], "held:pro:store:one") == "1"
        assert redis.command("HGET", keys[10], "slots:pro") == "4"
        assert redis.command("HGET", keys[10], "slots:scale") == "4"
        print("PASS: an upgrade gets the new ceiling minus what the window spent")

        seed_switch(keys[11])
        assert switch(keys[11], "scale", charge=400) == 1
        before = redis.command("HGETALL", keys[11])
        assert switch(keys[11], "pro", charge=1) == 0
        assert redis.command("HGETALL", keys[11]) == before
        seed_switch(keys[12])
        assert switch(keys[12], "scale", charge=100) == 1
        assert switch(keys[12], "pro", charge=200) == 1
        assert switch(keys[12], "pro", charge=1) == 0
        assert redis.command("HGET", keys[12], "store:one") == "300"
        print("PASS: a downgrade never adds the lower ceiling to what was spent")

        seed_switch(keys[13])
        for tier in ("pro", "scale", "pro", "scale", "pro"):
            assert switch(keys[13], tier, charge=10) == 1
        assert redis.command("HGET", keys[13], "slots:pro") == "4"
        assert redis.command("HGET", keys[13], "slots:scale") == "4"
        assert redis.command("HGET", keys[13], "store:one") == "50"
        print("PASS: switching back and forth claims one allocation per tier")

        seed_switch(keys[14])
        assert switch(keys[14], "pro") == 1
        for field, odd in (("tier:store:one", "bogus"), ("tier:store:one", ""), ("tier:store:one", "PRO"), ("held:scale:store:one", "2"), ("held:scale:store:one", ""), ("held:pro:store:one", "0")):
            redis.command("HSET", keys[14], "tier:store:one", "pro")
            redis.command("HDEL", keys[14], "held:scale:store:one", "held:pro:store:one")
            redis.command("HSET", keys[14], field, odd)
            before = redis.command("HGETALL", keys[14])
            assert switch(keys[14], "scale") == 0
            assert redis.command("HGETALL", keys[14]) == before
        redis.command("HSET", keys[14], "held:scale:store:two", "1")
        assert switch(keys[14], "scale", customer="two") == 0
        assert redis.command("HEXISTS", keys[14], "tier:store:two") == 0
        assert take(redis, keys[14], tier="unknown", funded=5) == 0
        seed_switch(keys[15])
        assert switch(keys[15], "pro") == 1
        redis.command("HSET", keys[15], "slots:scale", 0)
        before = redis.command("HGETALL", keys[15])
        assert switch(keys[15], "scale") == 0
        assert redis.command("HGETALL", keys[15]) == before
        print("PASS: unknown scopes, markers or tiers and a spent allocation refuse without writes")

    finally:
        assert all(key.startswith(prefix) for key in keys)
        redis.command("DEL", *keys)
        redis.close()


if __name__ == "__main__":
    main()
