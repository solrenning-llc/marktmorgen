"""CX-121 evidence using the application Lua and a disposable loopback Redis.
No production address/configuration, provider, account or recipient is used.
Pass MARKTMORGEN_SHIPMENT_TEST_REDIS_BINARY to an existing local redis-server.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import time
from test_form_opportunity_redis import Redis


class DisposableRedis(Redis):
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=5)
        self.stream = self.sock.makefile("rb")


def evidence(redis):
    source = (Path(__file__).resolve().parents[1] / "lib/shipment-mail-outbox.ts").read_text(encoding="utf-8")
    match = re.search(r"export const SHIPMENT_MAIL_SCRIPT = `([^`]+)`;", source)
    assert match and "${" not in match[1], "exact static application Lua required"
    lua = match[1]
    now = 1800000000000
    policy = dict(reviewId="SYNTHETIC_RELEASE", evidence="Synthetic evidence only", ongoingStorageFunded=True,
                  emptyInitializationVerified=True, globalItems=100, globalBytes=10000000, storeItems=100,
                  storeBytes=10000000, maxPayloadBytes=60000, maximumChecks=100, retryMilliseconds=60000,
                  admissionsUntil=now + 86400000)
    failures = []
    checks = 0
    profiles = {}
    made = set()

    def check(name, got, want):
        nonlocal checks
        checks += 1
        if got != want:
            failures.append(name)
            print("FAIL:", name, "expected", repr(want), "got", repr(got))
        else:
            print("PASS:", name)

    def setup(seed, store="synthetic_release"):
        ident = hashlib.sha256(seed.encode()).hexdigest()
        person = "b" * 64
        row = dict(id=ident, statsId=store, session="cs_test_" + seed + "0000000000", person=person,
                   sourceValue='{"at":1800000000,"tracking":""}', sealed="s1.synthetic.payload.only",
                   fingerprint="a" * 64, bytes=12000, created=now, authorizedAt=now, next=now,
                   state="queued", owner="", leaseUntil=0, checks=0, reviewId=policy["reviewId"])
        prefix = "nl:ship:mail:"
        keys = [prefix + "row:" + ident, "nl:ship:done:" + row["session"], prefix + "due",
                prefix + "store:" + store, prefix + "person:" + store + ":" + person,
                prefix + "pool", prefix + "pool:" + store, prefix + "all",
                prefix + "closed:" + store, prefix + "erased:" + store + ":" + person]
        made.update(keys)
        answer = apply("enqueue", row, keys, "", now)
        assert answer[0] == "queued", answer
        return row, keys

    def apply(op, row, keys, raw, at, owner="c" * 48):
        def stats(text):
            return {m[1]: int(m[2]) for m in re.finditer(r"^cmdstat_([^:]+):calls=(\d+),", text, re.M)}
        redis.command("MULTI")
        redis.command("INFO", "COMMANDSTATS")
        redis.command("EVAL", lua, 10, *keys, op, raw, json.dumps(row), at, 131072, json.dumps(policy), owner)
        redis.command("INFO", "COMMANDSTATS")
        before, result, after = redis.command("EXEC")
        a, b = stats(before), stats(after)
        count = sum(b.get(k, 0) - a.get(k, 0) for k in a.keys() | b.keys()) - 1
        profiles.setdefault(op, []).append(count)
        return result

    if redis.command("EXISTS", "nl:ship:mail:pool", "nl:ship:mail:all", "nl:ship:mail:due") != 0:
        raise RuntimeError("The synthetic shipment-evidence namespace is not empty")
    try:
        row, keys = setup("refusal")
        raw = redis.command("GET", keys[0])
        prepared = apply("claim", row, keys, raw, now)
        assert prepared[0] == "preparing"
        dispatched = apply("dispatch", row, keys, prepared[1], now)
        assert dispatched[0] == "dispatching"
        refused = apply("refused", row, keys, dispatched[1], now)
        check("a provider refusal is explicitly acknowledged", refused[0], "refused")
        check("refusal releases the global pending slot", redis.command("HGET", keys[5], "items"), "0")
        check("refusal releases the pending store slot", redis.command("HGET", keys[6], "items") in (None, "0"), True)
        retained = redis.command("GET", keys[0])
        check("refusal removes the sealed message", not retained or not json.loads(retained).get("sealed"), True)
        check("refusal starts the matching shipment retention", redis.command("TTL", keys[1]), 400 * 86400)
        check("refusal cannot remain due for automatic sending", redis.command("ZSCORE", keys[2], row["id"]), None)
        minimal = dict(state="refused", at=now, session=row["session"])
        global_field = "refused:" + row["id"]
        person_field = "refused:" + row["person"] + ":" + row["id"]
        global_summary = redis.command("HGET", keys[5], global_field)
        person_summary = redis.command("HGET", keys[6], person_field)
        check("global status contains only the agreed minimal data", json.loads(global_summary) if global_summary else None, minimal)
        check("personal status contains only the agreed minimal data", json.loads(person_summary) if person_summary else None, minimal)
        check("global terminal field expires independently after400days", redis.command("HTTL", keys[5], "FIELDS", 1, global_field), [400 * 86400])
        check("personal terminal field expires independently after400days", redis.command("HTTL", keys[6], "FIELDS", 1, person_field), [400 * 86400])
        read_match = re.search(r"export const SHIPMENT_MAIL_REFUSED_SCRIPT = `([^`]+)`;", source)
        assert read_match and "${" not in read_match[1]
        reader = read_match[1]
        def terminal(op, selected, field, expected=""):
            return redis.command("EVAL", reader, len(selected), *selected, op, field, expected)
        check("real status Lua reads the exact terminal summary", terminal("one", [keys[5]], global_field), [1, global_summary])
        check("real copy Lua snapshots the person's linked summary", terminal("list", [keys[6]], "refused:" + row["person"] + ":"), [1, [person_field, person_summary]])
        check("a wrong erase witness cannot delete terminal evidence", terminal("erase", [keys[5], keys[6]], person_field, "wrong"), [0])
        check("the wrong witness left the actual summary untouched", redis.command("HGET", keys[5], global_field), global_summary)
        redis.command("HSET", keys[5], global_field, "x" * 1025)
        check("oversized status is refused before returning its body", terminal("one", [keys[5]], global_field), [0])
        redis.command("HSET", keys[5], global_field, global_summary)
        redis.command("HEXPIRE", keys[5], 400 * 86400, "FIELDS", 1, global_field)
        check("real erasure Lua confirms removal of both terminal links", terminal("erase", [keys[5], keys[6]], person_field, global_summary), [1])
        check("terminal erasure removes both copies", [redis.command("HGET", keys[5], global_field), redis.command("HGET", keys[6], person_field)], [None, None])
        check("terminal erasure cannot refund the pending hold twice", redis.command("HGET", keys[5], "items"), "0")


        row, keys = setup("unknown_dispatch")
        prepared = apply("claim", row, keys, redis.command("GET", keys[0]), now)
        dispatched = apply("dispatch", row, keys, prepared[1], now)
        record = json.loads(dispatched[1])
        check("dispatch owns a finite future reservation", record.get("leaseUntil", 0) > now, True)
        replay = apply("claim", row, keys, dispatched[1], now + 600000)
        check("an expired dispatch reservation never authorizes another POST", replay[0] == "preparing", False)

        row, keys = setup("known_no_post", store="synthetic_no_post")
        prepared = apply("claim", row, keys, redis.command("GET", keys[0]), now)
        dispatched = apply("dispatch", row, keys, prepared[1], now)
        held_before = redis.command("HMGET", keys[5], "items", "bytes")
        check("a foreign owner cannot settle a no-POST outcome", apply("not-posted", row, keys, dispatched[1], now, owner="d" * 48)[0], "held")
        check("a malformed old snapshot cannot repair even the same owner", apply("not-posted", row, keys, "not JSON", now)[0], "changed")
        restored = apply("not-posted", row, keys, prepared[1], now)
        check("the same preparation witness repairs a lost dispatch ACK", restored[0], "queued")
        kept = json.loads(redis.command("GET", keys[0]))
        check("no-POST resets only its state and owner", [kept["state"], kept["owner"], kept["leaseUntil"]], ["queued", "", 0])
        check("no-POST uses the already reviewed retry delay", kept["next"], now + policy["retryMilliseconds"])
        check("no-POST retains its original charged check and sealed content", [kept["checks"], kept["sealed"]], [1, row["sealed"]])
        check("no-POST never releases its pending hold", redis.command("HMGET", keys[5], "items", "bytes"), held_before)
        check("no-POST cannot turn its source into terminal retention", redis.command("TTL", keys[1]), -1)

        retried = apply("claim", row, keys, redis.command("GET", keys[0]), now + policy["retryMilliseconds"])
        dispatched = apply("dispatch", row, keys, retried[1], now + policy["retryMilliseconds"])
        not_accepted = apply("not-accepted", row, keys, dispatched[1], now + policy["retryMilliseconds"])
        waiting = json.loads(not_accepted[1])
        check("known non-acceptance clears the completed dispatch lease", waiting["leaseUntil"], 0)
        check("known non-acceptance preserves its consumed checks", waiting["checks"], 2)
        check("known non-acceptance keeps the existing retry interval", waiting["next"], now + 2 * policy["retryMilliseconds"])

        # Fenced and unsupported rows currently stay at the front of the same
        # bounded 25-member read. Their evidence must survive but must not keep
        # excluding later eligible work from every worker visit.
        for kind in ("fenced", "unsupported"):
            row, keys = setup(kind, store="synthetic_" + kind)
            raw = redis.command("GET", keys[0])
            if kind == "fenced":
                redis.command("SET", keys[8], "synthetic erasure fence")
            else:
                changed = json.loads(raw)
                changed["reviewId"] = "SYNTHETIC_OTHER_REVIEW"
                raw = json.dumps(changed)
                redis.command("SET", keys[0], raw)
            answer = apply("claim", row, keys, raw, now)
            check(kind + " never grants dispatch permission", answer[0] == "preparing", False)
            score = redis.command("ZSCORE", keys[2], row["id"])
            check(kind + " does not stay eligible at this same instant", score is None or float(score) > now, True)
            check(kind + " preserves immutable protected evidence", redis.command("GET", keys[0]), raw)
        # Reserved terminal metadata must be bounded before another paid enqueue.
        for index in range(10000):
            redis.command("HSET", "nl:ship:mail:pool", "refused:" + hashlib.sha256(("capacity" + str(index)).encode()).hexdigest(), "synthetic")
        ident = hashlib.sha256(b"capacity-candidate").hexdigest()
        candidate = dict(row, id=ident, session="cs_test_capacitycandidate0001", person="e" * 64, reviewId=policy["reviewId"], bytes=12000)
        capacity_keys = ["nl:ship:mail:row:" + ident, "nl:ship:done:" + candidate["session"], "nl:ship:mail:due", "nl:ship:mail:store:capacity", "nl:ship:mail:person:capacity:" + candidate["person"], "nl:ship:mail:pool", "nl:ship:mail:pool:capacity", "nl:ship:mail:all", "nl:ship:mail:closed:capacity", "nl:ship:mail:erased:capacity:" + candidate["person"]]
        made.update(capacity_keys)
        candidate["statsId"] = "capacity"
        capacity = apply("enqueue", candidate, capacity_keys, "", now)
        check("terminal evidence capacity is reserved before enqueue", capacity, ["full"])
        check("a capacity refusal writes neither private payload nor origin", redis.command("EXISTS", capacity_keys[0], capacity_keys[1]), 0)
        print(json.dumps({"eval_and_internal_max": {op: max(values) for op, values in profiles.items()}, "supplier_invoice": False, "actual_funding": None}))
        print(f"{checks} checks, {len(failures)} failing")
        return bool(failures)
    finally:
        if made:
            redis.command("DEL", *sorted(made))


def main():
    binary = os.environ.get("MARKTMORGEN_SHIPMENT_TEST_REDIS_BINARY") or shutil.which("redis-server")
    if not binary or not Path(binary).is_file():
        raise RuntimeError("An existing local redis-server binary is required; no download or remote Redis fallback")
    with tempfile.TemporaryDirectory(prefix="shipment-release-evidence-") as temp:
        with socket.socket(socket.AF_INET) as free:
            free.bind(("127.0.0.1", 0))
            port = free.getsockname()[1]
        process = subprocess.Popen([binary, "--bind", "127.0.0.1", "--port", str(port), "--protected-mode", "yes",
                                    "--save", "", "--appendonly", "no", "--dir", temp], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        redis = None
        try:
            until = time.monotonic() + 5
            while time.monotonic() < until:
                if process.poll() is not None:
                    raise RuntimeError("Disposable Redis exited before startup")
                try:
                    redis = DisposableRedis(port)
                    break
                except (FileNotFoundError, ConnectionRefusedError):
                    time.sleep(0.01)
            if redis is None:
                raise RuntimeError("Disposable Redis did not start")
            assert redis.command("PING") == "PONG"
            return evidence(redis)
        finally:
            if redis:
                redis.close()
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            process.stderr.close()


if __name__ == "__main__":
    raise SystemExit(main())
