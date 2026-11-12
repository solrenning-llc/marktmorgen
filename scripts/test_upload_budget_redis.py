"""Exercise the exact upload admission Lua against dedicated CI Redis only."""
import concurrent.futures
import os
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Dedicated loopback CI Redis required")
    source = (Path(__file__).resolve().parents[1] / "lib/upload-budget.ts").read_text(encoding="utf-8")
    match = re.search(r"export const RESERVE_UPLOAD_BUDGET = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected the static application upload Lua")
    script = match.group(1)
    prefix = "marktmorgen:integration:upload:" + uuid.uuid4().hex + ":"
    keys = []
    redis = Redis()
    def fresh():
        key = prefix + str(len(keys))
        keys.append(key)
        redis.command("HSET", key, "policy", "reviewed-test-policy", "company:opens", 0,
                      "company:bytes", 0, "company:controls", 0, "slots:creator", 1)
        return key
    def reserve(client, key, store="store-a", action="open", size=5, scope="creator", policy="reviewed-test-policy", caps=(2, 10, 6), company=(2, 10, 6), funded=1):
        return client.command("EVAL", script, 1, key, policy, store, scope, action, size, *caps, *company, funded)
    def snapshot(key):
        flat = redis.command("HGETALL", key)
        return dict(zip(flat[::2], flat[1::2]))
    try:
        assert redis.command("PING") == "PONG"
        key = fresh()
        def race(_):
            client = Redis()
            try:
                return reserve(client, key)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            replies = list(pool.map(race, range(64)))
        assert sum(replies) == 2, replies
        assert redis.command("HGET", key, "company:bytes") == "10"
        assert redis.command("HGET", key, "slots:creator") == "0"
        before = snapshot(key)
        assert reserve(redis, key) == 0
        assert snapshot(key) == before
        print("PASS: 64 concurrent starts share exact store and company limits")
        for _ in range(4):
            assert reserve(redis, key, action="control", size=0) == 1
        before = snapshot(key)
        assert reserve(redis, key, action="control", size=0) == 0
        assert snapshot(key) == before
        assert redis.command("HGET", key, "company:controls") == "6"
        print("PASS: signing controls consume the same finite monthly counter")
        key = fresh()
        def claim(index):
            client = Redis()
            try:
                return reserve(client, key, store="claim-" + str(index), size=1)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            replies = list(pool.map(claim, range(64)))
        assert sum(replies) == 1, replies
        assert redis.command("HGET", key, "slots:creator") == "0"
        print("PASS: concurrent stores cannot reuse a funded allocation slot")
        key = fresh()
        reserve(redis, key, size=6)  # Ignore committed reply, like a lost HTTP acknowledgement.
        before = snapshot(key)
        assert reserve(redis, key, size=5) == 0
        assert snapshot(key) == before
        assert reserve(redis, key, size=4) == 1
        assert redis.command("HGET", key, "company:bytes") == "10"
        print("PASS: retries cannot refund an acknowledged or unacknowledged reservation")
        for value in ("", "-1", "01", "1.5", "9000000000000001", "bad"):
            key = fresh()
            redis.command("HSET", key, "company:bytes", value)
            before = snapshot(key)
            assert reserve(redis, key) == 0
            assert snapshot(key) == before
        print("PASS: corrupt and unsafe counters deny before all writes")
        for changes in ({"policy": "different"}, {"scope": "pro"}, {"action": "other"}, {"size": 0}, {"size": 11}, {"action": "control", "size": 1}):
            key = fresh()
            before = snapshot(key)
            assert reserve(redis, key, **changes) == 0
            assert snapshot(key) == before
        print("PASS: policy, scope, action and byte mismatches preserve ledger")
        key = fresh()
        assert reserve(redis, key, size=1) == 1
        before = snapshot(key)
        assert reserve(redis, key, scope="pro", size=1) == 0
        assert snapshot(key) == before
        key = fresh()
        redis.command("EXPIRE", key, 3600)
        before = snapshot(key)
        assert reserve(redis, key) == 0
        assert snapshot(key) == before
        key = prefix + "wrong-type"
        keys.append(key)
        redis.command("SET", key, "preserved")
        assert reserve(redis, key) == 0
        assert redis.command("GET", key) == "preserved"
        missing = prefix + "missing"
        assert reserve(redis, missing) == 0
        assert redis.command("EXISTS", missing) == 0
        print("PASS: tier changes, expiring, wrong-type and missing ledgers cannot reset usage")
        check_matches_take(redis, source, script, prefix, keys)
    finally:
        assert all(key.startswith(prefix) for key in keys)
        if keys:
            redis.command("DEL", *keys)
        redis.close()


def static_lua(source, name):
    match = re.search(r"export const " + name + r" = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected the static application upload Lua " + name)
    return match.group(1)


def check_matches_take(redis, source, reserve_script, prefix, keys):
    """CHECK_UPLOAD_BUDGET writes nothing and answers exactly what OPEN (automatic) then RESERVE answer."""
    open_script = static_lua(source, "OPEN_UPLOAD_BUDGET")
    check_script = static_lua(source, "CHECK_UPLOAD_BUDGET")
    scopes = ["creator", "pro", "scale", "trial", "setup", "ended"]
    review, policy = "automatic_review", "automatic-policy"
    counter = [0]

    def state(key):
        found = {}
        for name in (key, key + ":opened"):
            kind = redis.command("TYPE", name)
            if kind == "hash":
                flat = redis.command("HGETALL", name)
                found[name] = (kind, redis.command("TTL", name), dict(zip(flat[::2], flat[1::2])))
            elif kind == "string":
                found[name] = (kind, redis.command("TTL", name), redis.command("GET", name))
            else:
                found[name] = (kind,)
        return found

    def compare(label, setup, automatic=True, store="s", scope="creator", size=5, caps=(2, 10, 6), company=(4, 20, 12), funded=(1, 1, 1, 0, 0, 0), snapshot=policy, review_id=review):
        counter[0] += 1
        key = prefix + "check-" + str(counter[0])
        keys.extend([key, key + ":opened"])
        setup(key)
        before = state(key)
        reserve_args = [snapshot, store, scope, "open", size, *caps, *company, funded[scopes.index(scope)] if scope in scopes else 1]
        checked = redis.command("EVAL", check_script, 2, key, key + ":opened", *reserve_args, "1" if automatic else "0", review_id, *funded)
        assert state(key) == before, label + ": the check wrote"
        if automatic:
            opened = redis.command("EVAL", open_script, 2, key, key + ":opened", review_id, snapshot, *funded)
            taken = redis.command("EVAL", reserve_script, 1, key, *reserve_args)
            real = 1 if opened == 1 and taken == 1 else 0
        else:
            real = redis.command("EVAL", reserve_script, 1, key, *reserve_args)
        assert checked == real, label + ": check " + str(checked) + " but the take " + str(real)
        return real

    def ledger(fields, review_id=review, snapshot=policy, funded=(1, 1, 1, 0, 0, 0), left=None):
        def setup(key):
            row = {"review": review_id, "policy": snapshot, "company:opens": 0, "company:bytes": 0, "company:controls": 0}
            for i, scope in enumerate(scopes):
                row["funded:" + scope] = funded[i]
                row["slots:" + scope] = funded[i] if left is None else left[i]
            row.update(fields)
            redis.command("HSET", key, *[part for pair in row.items() for part in pair])
        return setup

    nothing = lambda key: None
    answers = []
    answers.append(compare("a new month", nothing))
    answers.append(compare("a new month for an unfunded scope", nothing, scope="trial"))
    answers.append(compare("a lost ledger", lambda key: redis.command("SET", key + ":opened", review)))
    answers.append(compare("another review", ledger({}, review_id="other")))
    answers.append(compare("room", ledger({})))
    answers.append(compare("starts spent", ledger({"store:s:scope": "creator", "store:s:opens": 2, "store:s:bytes": 2, "store:s:controls": 2, "company:opens": 2, "company:bytes": 2, "company:controls": 2})))
    answers.append(compare("bytes spent", ledger({"store:s:scope": "creator", "store:s:opens": 1, "store:s:bytes": 9, "store:s:controls": 1, "company:opens": 1, "company:bytes": 9, "company:controls": 1}), size=2))
    answers.append(compare("exactly the last bytes", ledger({"store:s:scope": "creator", "store:s:opens": 1, "store:s:bytes": 5, "store:s:controls": 1, "company:opens": 1, "company:bytes": 5, "company:controls": 1})))
    answers.append(compare("company spent", ledger({"company:opens": 4})))
    answers.append(compare("no slot left", ledger({}, left=(0, 1, 1, 0, 0, 0))))
    answers.append(compare("another tier", ledger({"store:s:scope": "pro", "store:s:opens": 0, "store:s:bytes": 0, "store:s:controls": 0})))
    answers.append(compare("stray counter", ledger({"store:s:opens": 0})))
    answers.append(compare("corrupt company", ledger({"company:bytes": "01"})))
    answers.append(compare("corrupt store", ledger({"store:s:scope": "creator", "store:s:opens": "x", "store:s:bytes": 0, "store:s:controls": 0})))
    answers.append(compare("changed policy carries slots", ledger({}, snapshot="old", funded=(1, 1, 1, 0, 0, 0), left=(0, 1, 1, 0, 0, 0)), funded=(2, 1, 1, 0, 0, 0)))
    answers.append(compare("changed policy with every slot claimed", ledger({}, snapshot="old", left=(0, 1, 1, 0, 0, 0))))
    answers.append(compare("changed policy with a corrupt slot", ledger({"slots:ended": "bad"}, snapshot="old")))
    answers.append(compare("changed policy with a corrupt company", ledger({"company:controls": ""}, snapshot="old")))
    answers.append(compare("expiring", lambda key: (ledger({})(key), redis.command("EXPIRE", key, 3600))))
    answers.append(compare("wrong type", lambda key: redis.command("SET", key, "x")))
    answers.append(compare("too big", ledger({}), size=11))
    answers.append(compare("unsafe funded list", nothing, funded=(1, 1, 1, 0, 0, "x")))
    answers.append(compare("separately reviewed, missing", nothing, automatic=False))
    answers.append(compare("separately reviewed, room", ledger({}), automatic=False))
    answers.append(compare("separately reviewed, other policy", ledger({}), automatic=False, snapshot="other"))
    answers.append(compare("separately reviewed, spent", ledger({"store:s:scope": "creator", "store:s:opens": 2, "store:s:bytes": 2, "store:s:controls": 2, "company:opens": 2, "company:bytes": 2, "company:controls": 2}), automatic=False))
    assert answers == [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0], answers
    print("PASS: the read-only check writes nothing and answers as the take, in " + str(len(answers)) + " ledger states")


if __name__ == "__main__":
    main()
