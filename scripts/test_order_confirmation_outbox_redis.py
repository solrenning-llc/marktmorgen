"""Exact protected-origin Lua on disposable loopback Redis, no provider.
Run with MARKTMORGEN_REDIS_INTEGRATION=1 and CONFIRMATION_ORIGIN_REDIS_PORT.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import uuid
from test_form_opportunity_redis import Redis


class LocalRedis(Redis):
    def __init__(self):
        port = int(os.environ.get("CONFIRMATION_ORIGIN_REDIS_PORT", "16379"))
        if not 1024 <= port <= 65535:
            raise RuntimeError("Dedicated loopback Redis required")
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.stream = self.sock.makefile("rb")


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Disposable loopback Redis only")
    root = Path(__file__).resolve().parents[1]
    def script(file, name):
        match = re.search(r"export const " + name + r" = `([^`]+)`;", (root / file).read_text())
        assert match and "${" not in match[1]
        return match[1]
    shared = script("lib/shipment-mail-outbox.ts", "SHIPMENT_MAIL_SCRIPT")
    origin = script("lib/order-confirmation-outbox.ts", "CONFIRMATION_ORIGIN_SCRIPT")
    paid_script = script("lib/order-confirmation-outbox.ts", "CONFIRMATION_PAID_SCRIPT")
    erasure_script = script("lib/order-confirmation-outbox.ts", "CONFIRMATION_ERASURE_SCRIPT")
    prefix = "marktmorgen:integration:confirmation-origin:" + uuid.uuid4().hex + ":"
    db = LocalRedis()
    made = set()
    clock = db.command("TIME")
    now = int(clock[0]) * 1000 + int(clock[1]) // 1000
    policy = dict(reviewId="SYNTHETIC", emptyInitializationVerified=True, globalItems=4,
                  globalBytes=2_000_000, storeItems=4, storeBytes=2_000_000,
                  maximumChecks=10, admissionsUntil=now + 86_400_000, retryMilliseconds=60_000)
    def fixture(name):
        ident = hashlib.sha256(name.encode()).hexdigest()
        keys = [prefix + "row:" + ident, prefix + "source:" + ident, prefix + "due",
                prefix + "store", prefix + "person:" + ident, prefix + "pool", prefix + "storepool",
                prefix + "all", prefix + "closed", prefix + "erased:" + ident]
        made.update(keys)
        row = dict(kind="confirmation", id=ident, statsId="SYNTHETIC", nonce=ident, accountId="acct_TestOrigin01",
                   bodyDigest="b" * 64, intentFingerprint="c" * 64, bindingFingerprint="", session="", person=ident,
                   sourceValue="source-" + ident, sealed="s1.synthetic.protected", fingerprint="d" * 64,
                   bytes=160_000, created=now, authorizedAt=now, next=now, expiresAt=now + 450 * 86_400_000,
                   state="queued", phase="awaiting_creation", owner="", leaseUntil=0, checks=0,
                   createAttempts=0, reviewId="SYNTHETIC", recoveryCursor="", recoveryUpper=0, erasedPeople="", erasureSaturated=False)
        return row, keys
    def enqueue(row, keys):
        return db.command("EVAL", shared, 10, *keys, "enqueue", "", json.dumps(row), now, 131072, json.dumps(policy), "")
    def change(op, row, keys, supplied="", client=None, at=now, expected=None, owner="a" * 48):
        return (client or db).command("EVAL", origin, 10, *keys, op,
            expected if expected is not None else db.command("GET", keys[0]), supplied, at, owner, json.dumps(policy))
    def candidate(row, session, token):
        return dict(row, session=session, bindingFingerprint=hashlib.sha256(token.encode()).hexdigest(),
                    phase="awaiting_payment", sourceValue="bound:" + session, sealed="s1." + token)
    def stats():
        out = {}
        for line in db.command("INFO", "COMMANDSTATS").splitlines():
            match = re.match(r"cmdstat_([^:]+):calls=(\d+),", line)
            if match and match[1] != "info": out[match[1]] = int(match[2])
        return out
    def measured(run):
        before = stats(); result = run(); after = stats()
        return result, sum(after.get(k, 0) - before.get(k, 0) for k in set(before) | set(after))
    profiles = {}
    # Another client keeps talking to the same server (as the CI service's health check does):
    # a measured profile must count only the measured script's own commands.
    neighbor_stop = threading.Event()
    def neighbor():
        other = LocalRedis()
        try:
            while not neighbor_stop.is_set(): other.command("PING")
        finally: other.sock.close()
    neighbor_thread = threading.Thread(target=neighbor, daemon=True)
    neighbor_thread.start()
    try:
        row, keys = fixture("atomic")
        first, profiles["enqueue"] = measured(lambda: enqueue(row, keys))
        assert first[0] == "queued"
        assert db.command("TTL", keys[0]) == -1 and db.command("TTL", keys[1]) == -1
        assert db.command("HGET", keys[5], "items") == "1"
        assert enqueue(row, keys)[0] == "existing"
        assert db.command("HGET", keys[5], "items") == "1"
        raw_before_create = db.command("GET", keys[0])
        permission, profiles["create"] = measured(lambda: change("create", row, keys, expected=raw_before_create))
        assert permission[0] == "creating" and len(permission) == 4
        assert int(permission[2]) < int(permission[3])
        assert change("create", row, keys)[0] == "held"
        print("PASS: protected source and bounded slots precede acknowledged creation; duplicate/lost enqueue ACK never grants another slot")
        raw = db.command("GET", keys[0]); current = json.loads(raw)
        candidates = [json.dumps(candidate(current, "cs_test_syntheticwinner" + str(i), "token" + str(i))) for i in range(32)]
        def bind(payload):
            conn = LocalRedis()
            try: return change("bind", current, keys, payload, client=conn, expected=raw)
            finally: conn.sock.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            replies = list(pool.map(bind, candidates))
        assert sum(r[0] == "bound" for r in replies) == 1
        saved = db.command("GET", keys[0]); winning = json.loads(saved)
        assert saved in candidates and winning["bindingFingerprint"] and db.command("GET", keys[1]) == winning["sourceValue"]
        another = candidate(winning, "cs_test_differentAfterLostACK", "other-token")
        assert change("bind", winning, keys, json.dumps(another), expected=saved) == ["bound", saved]
        assert db.command("GET", keys[0]) == saved
        print("PASS:32 competing verified-session candidates choose one immutable session/token/fingerprint; replay returns persisted winner")
        _, profiles["bound_replay"] = measured(lambda: change("bind", winning, keys, json.dumps(another), expected=saved))
        for field, value in [("intentFingerprint", "x" * 64), ("bodyDigest", "x" * 64), ("accountId", "acct_Foreign"), ("nonce", "f" * 64)]:
            n = dict(another); n[field] = value
            assert change("bind", winning, keys, json.dumps(n), expected=saved)[0] == "unknown"
        print("PASS: a candidate cannot replace original account/body/nonce/admission fingerprint")
        # The same exact winning row is required immediately before URL exposure.
        # This is read-only: original expiry, source, pools and pending TTL stay fixed.
        before_url = db.command("GET", keys[0])
        source_before_url = db.command("GET", keys[1])
        pool_before_url = db.command("HGETALL", keys[5])
        request_url = json.dumps(dict(session=winning["session"], bindingFingerprint=winning["bindingFingerprint"]))
        allowed = change("url", winning, keys, request_url, expected=before_url)
        assert allowed[:4] == ["url", winning["id"], winning["session"], winning["bindingFingerprint"]]
        assert int(allowed[4]) < int(allowed[5]) == min(winning["expiresAt"], int(allowed[4]) + 1000)
        assert db.command("GET", keys[0]) == before_url and db.command("GET", keys[1]) == source_before_url
        assert db.command("HGETALL", keys[5]) == pool_before_url
        assert db.command("TTL", keys[0]) == -1 and db.command("TTL", keys[1]) == -1
        for fence in (keys[8], keys[9]):
            db.command("SET", fence, "closed-before-final-url-gate")
            assert change("url", winning, keys, request_url, expected=before_url) == ["held"]
            db.command("DEL", fence)
        db.command("SET", keys[1], "replaced-source")
        assert change("url", winning, keys, request_url, expected=before_url) == ["unknown"]
        db.command("SET", keys[1], source_before_url)
        replaced = dict(winning, session="cs_test_otherWinner000001")
        db.command("SET", keys[0], json.dumps(replaced))
        assert change("url", winning, keys, request_url, expected=before_url) == ["changed"]
        db.command("SET", keys[0], before_url)
        assert change("url", winning, keys, json.dumps(dict(session="cs_test_wrong000001", bindingFingerprint=winning["bindingFingerprint"]))) == ["held"]
        refused = dict(winning, phase="refused")
        db.command("SET", keys[0], json.dumps(refused))
        assert change("url", refused, keys, request_url) == ["held"]
        preparing_url = dict(winning, state="preparing", owner="f"*48, leaseUntil=now+60_000)
        preparing_raw = json.dumps(preparing_url)
        db.command("SET", keys[0], preparing_raw)
        assert change("url", preparing_url, keys, request_url)[:4] == ["url", winning["id"], winning["session"], winning["bindingFingerprint"]]
        assert db.command("GET", keys[0]) == preparing_raw
        db.command("SET", keys[8], "closure while worker prepares")
        assert change("url", preparing_url, keys, request_url) == ["held"]
        db.command("DEL", keys[8])
        db.command("SET", keys[0], before_url)
        assert change("url", winning, keys, request_url, at=now-73*3_600_000) == ["unknown"]
        print("PASS: final URL gate checks exact winner/source/store/person fences with read-only timely permission; no renewed source/TTL/pool")
        old, oldkeys = fixture("past-retention")
        old["created"] = now - 25 * 3_600_000
        assert enqueue(old, oldkeys)[0] == "queued"
        assert change("create", old, oldkeys)[0] == "creation_unknown"
        assert json.loads(db.command("GET", oldkeys[0]))["createAttempts"] == 0
        raw_before_cursor = db.command("GET", oldkeys[0])
        progress, profiles["cursor"] = measured(lambda: change("cursor", old, oldkeys, json.dumps(dict(recoveryCursor="cs_test_page000000001", recoveryUpper=now // 1000)), expected=raw_before_cursor))
        assert progress[0] == "cursor"
        assert json.loads(db.command("GET", oldkeys[0]))["recoveryCursor"] == "cs_test_page000000001"
        recovered = candidate(json.loads(db.command("GET", oldkeys[0])), "cs_test_recoveredAfter25h", "original-proof-token")
        raw_before_bind = db.command("GET", oldkeys[0])
        bound, profiles["bind"] = measured(lambda: change("bind", old, oldkeys, json.dumps(recovered), expected=raw_before_bind))
        assert bound[0] == "bound"
        print("PASS: after25h no creation POST permission; durable read pagination and original-proof binding remain possible")
        skew, skewkeys = fixture("skew")
        assert enqueue(skew, skewkeys)[0] == "queued"
        previous = db.command("GET", skewkeys[0])
        assert change("create", skew, skewkeys, at=now - 73 * 3_600_000)[0] == "unknown"
        assert db.command("GET", skewkeys[0]) == previous
        expired = dict(skew, expiresAt=now - 1)
        db.command("SET", skewkeys[0], json.dumps(expired))
        assert change("bind", expired, skewkeys, json.dumps(candidate(expired, "cs_test_pastHorizon00001", "expired")))[0] == "unknown"
        print("PASS: Redis clock denies worker skew and expired original horizon before mutation")
        fenced, fencedkeys = fixture("fenced")
        assert enqueue(fenced, fencedkeys)[0] == "queued"
        db.command("SET", fencedkeys[8], "cleanup-won")
        assert change("create", fenced, fencedkeys)[0] == "held"
        assert change("bind", fenced, fencedkeys, json.dumps(candidate(fenced, "cs_test_fenced000000001", "fenced")))[0] == "held"
        full, fullkeys = fixture("full")
        assert enqueue(full, fullkeys)[0] == "unknown"  # shared store fence also denies producer
        db.command("DEL", fencedkeys[8])
        assert enqueue(full, fullkeys)[0] == "full"
        assert db.command("EXISTS", fullkeys[0], fullkeys[1]) == 0
        print("PASS: closed-store fence wins before creation/binding, and full storage budget creates neither origin nor source")
        assert profiles == {"enqueue": 27, "create": 17, "bound_replay": 15, "cursor": 17, "bind": 18}, profiles
        def shared_change(op, k, expected=None, owner="f" * 48):
            return db.command("EVAL", shared, 10, *k, op,
                db.command("GET", k[0]) if expected is None else expected, "", now, 131072, json.dumps(policy), owner)
        newperson = prefix + "person:verified-buyer"
        newfence = prefix + "erased:verified-buyer"
        made.update([newperson, newfence])
        def paid_change(op, k, supplied="", expected=None, at=now, owner="f" * 48):
            return db.command("EVAL", paid_script, 12, *k, newperson, newfence, op,
                db.command("GET", k[0]) if expected is None else expected, supplied, at, owner, json.dumps(policy))
        ready = json.loads(db.command("GET", keys[0])); ready["next"] = now
        db.command("SET", keys[0], json.dumps(ready))
        assert shared_change("claim", keys)[0] == "preparing"
        pre_paid = db.command("GET", keys[0]); preparing = json.loads(pre_paid)
        next_paid = dict(preparing, person="e" * 64, phase="queued", sealed="s1.synthetic-paid-message", fingerprint="a" * 64)
        payload = json.dumps(next_paid)
        for field, value in [("accountId", "acct_Foreign"), ("bytes", 1), ("session", "cs_test_other"), ("bindingFingerprint", "x" * 64), ("intentFingerprint", "y" * 64)]:
            n = dict(next_paid); n[field] = value
            assert paid_change("paid", keys, json.dumps(n))[0] == "unknown"
            assert db.command("GET", keys[0]) == pre_paid
        assert paid_change("paid", keys, payload, owner="b" * 48)[0] == "held"
        assert paid_change("paid", keys, payload, at=now - 73 * 3_600_000)[0] == "unknown"
        db.command("SET", newfence, "person-deleted-before-recipient-known")
        assert paid_change("paid", keys, payload)[0] == "held"
        assert db.command("GET", keys[0]) == pre_paid and db.command("SCARD", newperson) == 0
        db.command("DEL", newfence)
        db.command("RPUSH", newperson, "wrong-type")
        assert paid_change("paid", keys, payload)[0] == "unknown"
        assert db.command("GET", keys[0]) == pre_paid
        db.command("DEL", newperson)
        paid_result, profiles["paid"] = measured(lambda: paid_change("paid", keys, payload, expected=pre_paid))
        assert paid_result == ["paid", payload]
        assert db.command("SISMEMBER", keys[4], preparing["id"]) == 0
        assert db.command("SISMEMBER", newperson, preparing["id"]) == 1
        assert db.command("TTL", keys[0]) == -1 and db.command("TTL", keys[1]) == -1
        assert paid_change("paid", keys, payload, expected=pre_paid)[0] == "changed"
        print("PASS:paid CAS preserves original account/session/token envelope, moves recipient index atomically, and refuses wrong owner, clock, type or erasure fence before any write")
        paidkeys = list(keys); paidkeys[4] = newperson; paidkeys[9] = newfence
        dispatch_raw = db.command("GET", keys[0])
        dispatched, profiles["dispatch"] = measured(lambda: shared_change("dispatch", paidkeys, expected=dispatch_raw))
        assert dispatched[0] == "dispatching"
        assert shared_change("claim", paidkeys)[0] == "held"
        assert db.command("EVAL", shared, 10, *paidkeys, "claim", db.command("GET", keys[0]), "", now + 73 * 3_600_000, 131072, json.dumps(policy), "d" * 48)[0] == "held"
        print("PASS:permanent dispatch barrier cannot be reclaimed after73h or a lost ACK")
        accepted_raw = db.command("GET", keys[0])
        accepted, profiles["accepted_unsettled"] = measured(lambda: paid_change("accepted", paidkeys, expected=accepted_raw))
        assert accepted[0] == "accepted"
        held = json.loads(db.command("GET", keys[0])); assert held["phase"] == "accepted" and held["state"] == "refused"
        assert db.command("TTL", keys[0]) == -1 and db.command("TTL", keys[1]) == -1
        assert shared_change("claim", paidkeys)[0] == "held"
        assert paid_change("settlement", paidkeys)[0] == "held"  # not due yet
        held["next"] = 0
        db.command("SET", keys[0], json.dumps(held))
        settlement_raw = db.command("GET", keys[0])
        retried, profiles["settlement_retry"] = measured(lambda: paid_change("settlement", paidkeys, expected=settlement_raw))
        assert retried[0] == "settlement" and json.loads(retried[1])["checks"] == held["checks"] + 1
        assert paid_change("settlement", paidkeys)[0] == "held"
        held = json.loads(retried[1]); held["next"] = 0; held["checks"] = policy["maximumChecks"] - 1
        db.command("SET", keys[0], json.dumps(held))
        assert paid_change("settlement", paidkeys)[0] == "settlement"
        assert db.command("ZSCORE", keys[2], held["id"]) is None
        assert paid_change("settlement", paidkeys)[0] == "held"
        assert db.command("EXISTS", keys[0], keys[1]) == 2
        print("PASS:email acceptance with unknown accounting retains protected evidence and no TTL; financial retries are scheduled and capped without another POST")
        final_check = json.loads(db.command("GET", keys[0])); final_check.update(state="dispatching", phase="queued", owner="f" * 48, next=0)
        db.command("SET", keys[0], json.dumps(final_check)); db.command("ZADD", keys[2], now, final_check["id"])
        assert paid_change("accepted", paidkeys)[0] == "accepted"
        assert db.command("ZSCORE", keys[2], final_check["id"]) is None
        assert db.command("TTL", keys[0]) == -1
        print("PASS:acceptance on the last funded check parks evidence without leaving a hot polling member")
        before_items = int(db.command("HGET", keys[5], "items"))
        cancel_raw = db.command("GET", keys[0])
        canceled, profiles["cancel_paid"] = measured(lambda: shared_change("cancel", paidkeys, expected=cancel_raw))
        assert canceled == ["canceled"]
        assert db.command("EXISTS", keys[0]) == 0 and db.command("TTL", keys[1]) > 399 * 86_400
        assert db.command("SISMEMBER", newperson, held["id"]) == 0
        assert int(db.command("HGET", keys[5], "items")) == before_items - 1
        assert db.command("SISMEMBER", keys[7], held["id"]) == 0
        print("PASS:origin cancellation erases its actual paid-person index and protected row, releases one shared reservation and retains only the400day matching source")
        assert {k: profiles[k] for k in ["paid", "dispatch", "accepted_unsettled", "settlement_retry", "cancel_paid"]} == {"paid": 20, "dispatch": 16, "accepted_unsettled": 19, "settlement_retry": 19, "cancel_paid": 25}
        print(json.dumps({"paid_worker_commands_including_eval_and_redis_call": {k: profiles[k] for k in ["paid", "dispatch", "accepted_unsettled", "settlement_retry", "cancel_paid"]}, "supplier_invoice": False}))

        # The actual production erasure Lua snapshots older origins and stores
        # bounded markers in the already-funded envelope, never a new key/slot.
        erased, erasedkeys = fixture("unresolved-erasure")
        assert enqueue(erased, erasedkeys)[0] == "queued"
        recipient = hashlib.sha256(b"buyer@example.test").hexdigest()
        erasure_fence = prefix + "erasure:recipient"
        made.add(erasure_fence)
        request = "9" * 48
        begun, profiles["erasure_begin"] = measured(lambda: db.command("EVAL", erasure_script, 2, erasedkeys[3], erasure_fence, "begin", request, recipient, "SYNTHETIC"))
        assert begun[0] == "begun" and erased["id"] in begun[1]
        for wrong_type in [False, True]:
            bad_index, bad_fence = prefix+"bad-index:"+str(wrong_type), prefix+"bad-fence:"+str(wrong_type)
            made.update([bad_index, bad_fence])
            db.command("RPUSH" if wrong_type else "SADD", bad_index, "invalid-member")
            assert db.command("EVAL", erasure_script, 2, bad_index, bad_fence, "begin", request, recipient, "SYNTHETIC") == ["unknown"]
            assert db.command("TTL", bad_fence) == -1
        excessive_index, excessive_fence = prefix+"excessive-index", prefix+"excessive-fence"
        made.update([excessive_index, excessive_fence])
        db.command("SADD", excessive_index, *[hashlib.sha256(str(i).encode()).hexdigest() for i in range(10001)])
        assert db.command("EVAL", erasure_script, 2, excessive_index, excessive_fence, "begin", request, recipient, "SYNTHETIC") == ["unknown"]
        assert db.command("TTL", excessive_fence) == -1
        before_hold = db.command("HGETALL", erasedkeys[5])
        before_marker = db.command("GET", erasedkeys[0])
        def mark(who=recipient, token=request, client=None):
            return (client or db).command("EVAL", erasure_script, 3, erasedkeys[0], erasedkeys[1], erasure_fence, "mark", token, who, "SYNTHETIC")
        marked, profiles["erasure_mark"] = measured(mark)
        assert marked == ["marked"]
        stored = json.loads(db.command("GET", erasedkeys[0]))
        assert stored["erasedPeople"] == recipient and stored["bytes"] == erased["bytes"]
        assert db.command("TTL", erasedkeys[0]) == -1 and db.command("TTL", erasedkeys[1]) == -1
        assert db.command("HGETALL", erasedkeys[5]) == before_hold
        assert mark() == ["marked"] and json.loads(db.command("GET", erasedkeys[0]))["erasedPeople"] == recipient
        # Simulated ACK loss: rerunning the exact marking operation cannot
        # append another entry or expire the source or release its reservation.
        assert db.command("EVAL", erasure_script, 1, erasure_fence, "finish", "8" * 48, recipient, "SYNTHETIC") == ["changed"]
        assert db.command("TTL", erasure_fence) == -1
        finished, profiles["erasure_finish"] = measured(lambda: db.command("EVAL", erasure_script, 1, erasure_fence, "finish", request, recipient, "SYNTHETIC"))
        assert finished == ["finished"] and 0 < db.command("TTL", erasure_fence) <= 600
        db.command("PEXPIREAT", erasure_fence, 1)
        assert db.command("EXISTS", erasure_fence) == 0
        # Preparing an old source after the short fence is actually gone still
        # refuses the erased recipient before payload/index mutation.
        stored.update(session="cs_test_erasurepaid00001", bindingFingerprint="a" * 64, phase="awaiting_payment", state="preparing", owner="f" * 48, leaseUntil=now+60_000)
        db.command("SET", erasedkeys[0], json.dumps(stored))
        erased_candidate = dict(stored, person=recipient, phase="queued", sealed="s1.no-erased-buyer-payload")
        assert paid_change("paid", erasedkeys, json.dumps(erased_candidate))[0] == "erased"
        assert db.command("GET", erasedkeys[0]) == json.dumps(stored)
        # A different buyer is still eligible, and a candidate cannot strip
        # previously acknowledged erasures even if all its other fields match.
        other = dict(erased_candidate, person="7" * 64)
        assert paid_change("paid", erasedkeys, json.dumps(dict(other, erasedPeople="")))[0] == "unknown"
        assert paid_change("paid", erasedkeys, json.dumps(other))[0] == "paid"
        # Race all additions on one unresolved row with real Redis. Exactly64
        # hashes fit; later requests park only this row, not another/new order.
        stored.update(phase="awaiting_payment", state="queued", owner="", leaseUntil=0, erasedPeople="", erasureSaturated=False)
        db.command("SET", erasedkeys[0], json.dumps(stored)); db.command("SET", erasure_fence, request)
        def concurrent_mark(i):
            connection = LocalRedis()
            try: return mark(hashlib.sha256(str(i).encode()).hexdigest(), client=connection)
            finally: connection.sock.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            assert all(reply == ["marked"] for reply in pool.map(concurrent_mark, range(80)))
        saturated = json.loads(db.command("GET", erasedkeys[0]))
        assert len(saturated["erasedPeople"]) == 4096 and saturated["erasureSaturated"] is True
        assert len(set(saturated["erasedPeople"][i:i+64] for i in range(0,4096,64))) == 64
        assert saturated["bytes"] == erased["bytes"] and len(db.command("GET", erasedkeys[0]).encode()) < erased["bytes"]
        assert db.command("HGETALL", erasedkeys[5]) == before_hold
        saturated.update(state="preparing", owner="f" * 48, leaseUntil=now+60_000)
        db.command("SET", erasedkeys[0], json.dumps(saturated))
        assert paid_change("paid", erasedkeys, json.dumps(dict(saturated, person="6"*64, phase="queued")))[0] == "held"
        print("PASS:atomic bounded origin snapshots, durable idempotent erasure, expired-fence suppression, other-buyer rights, stale-request CAS and80concurrent markers on official Redis")

        # A reserve-only course shares the existing pool and privacy family;
        # it has no creation, URL, paid, claim or delivery permission.
        course_row, course_keys = fixture("course-reserve")
        course_keys = [k.replace(prefix, prefix + "course:") for k in course_keys]
        made.update(course_keys)
        course_row.update(originKind="course", courseBindingFingerprint="f" * 64, phase="course_reserved", next=0)
        course_row["sourceValue"] = json.dumps(dict(kind="confirmation", originKind="course", nonce=course_row["nonce"],
            accountId=course_row["accountId"], bodyDigest=course_row["bodyDigest"], session="", courseBindingFingerprint="f" * 64))
        def course_enqueue(row=course_row, p=policy, client=None):
            return (client or db).command("EVAL", shared, 10, *course_keys, "enqueue", "", json.dumps(row), now, 131072, json.dumps(p), "")
        assert course_enqueue() == ["unknown"]
        assert db.command("EXISTS", *course_keys) == 0
        course_policy = dict(policy, coveredOrigins=["course-confirmation"])
        for bad in [dict(course_row, originKind="future"), dict(course_row, phase="awaiting_creation"),
                    dict(course_row, courseBindingFingerprint="not-a-hash")]:
            assert course_enqueue(bad, course_policy) == ["unknown"]
        assert db.command("EXISTS", *course_keys) == 0
        # Count the unchanged shared Lua footprint on an isolated course
        # family; instrument only this proof, not a provider invoice.
        measured_keys = [k.replace(prefix + "course:", prefix + "course-measure:") for k in course_keys]
        made.update(measured_keys)
        def measured_enqueue():
            return db.command("EVAL", shared, 10, *measured_keys, "enqueue", "", json.dumps(course_row), now,
                131072, json.dumps(course_policy), "")
        first_course, profiles["course_enqueue"] = measured(measured_enqueue)
        repeat_course, profiles["course_existing"] = measured(measured_enqueue)
        assert first_course[0] == "queued" and repeat_course[0] == "existing"
        assert db.command("ZSCORE", measured_keys[2], course_row["id"]) is None, "reserve-only course cannot become hot polling work"
        assert profiles["course_enqueue"] == 26 and profiles["course_existing"] == 13
        assert db.command("EVAL", shared, 10, *measured_keys, "cancel", db.command("GET", measured_keys[0]), "", now,
            131072, "null", "") == ["canceled"]
        def course_race(_):
            conn = LocalRedis()
            try: return course_enqueue(p=course_policy, client=conn)
            finally: conn.sock.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as workers:
            replies = list(workers.map(course_race, range(32)))
        assert sum(r[0] == "queued" for r in replies) == 1
        assert sum(r[0] == "existing" for r in replies) == 31
        assert db.command("HGET", course_keys[5], "items") == "1"
        original_course_raw = db.command("GET", course_keys[0])
        original_course_source = db.command("GET", course_keys[1])
        assert db.command("TTL", course_keys[0]) == -1 and db.command("TTL", course_keys[1]) == -1
        replacement = dict(course_row, courseBindingFingerprint="e" * 64)
        existing = course_enqueue(replacement, course_policy)
        assert existing == ["existing", original_course_raw, original_course_source]
        for op in ["create", "cursor", "bind", "url"]:
            assert change(op, course_row, course_keys, json.dumps(replacement), expected=original_course_raw) == ["unknown"]
        for op in ["claim", "dispatch", "defer", "not-accepted", "refused", "accepted"]:
            assert db.command("EVAL", shared, 10, *course_keys, op, original_course_raw, json.dumps(replacement), now,
                131072, json.dumps(course_policy), "a" * 48) == ["unknown"]
        course_paidkeys = course_keys + [prefix + "course:new-person", prefix + "course:new-fence"]
        made.update(course_paidkeys)
        assert db.command("EVAL", paid_script, 12, *course_paidkeys, "paid", original_course_raw, json.dumps(replacement), now,
            "a" * 48, json.dumps(course_policy)) == ["unknown"]
        assert db.command("GET", course_keys[0]) == original_course_raw
        assert db.command("GET", course_keys[1]) == original_course_source
        # Same pool: another physical intention cannot evade its item cap.
        physical, physicalkeys = fixture("course-shared-physical")
        physicalkeys = [k.replace(prefix, prefix + "course:") for k in physicalkeys]
        made.update(physicalkeys)
        narrow_policy = dict(course_policy, globalItems=1, storeItems=1)
        assert db.command("EVAL", shared, 10, *physicalkeys, "enqueue", "", json.dumps(physical), now,
            131072, json.dumps(narrow_policy), "") == ["full"]
        # The existing erasure protocol must mark an unresolved course and
        # cancel it without requiring an unsupported delivery-stage policy.
        request, recipient = "d" * 48, "3" * 64
        course_fence = prefix + "course:erased-request"
        made.add(course_fence)
        begun = db.command("EVAL", erasure_script, 2, course_keys[3], course_fence, "begin", request, recipient, "SYNTHETIC")
        assert begun == ["begun", [course_row["id"]]]
        assert db.command("EVAL", erasure_script, 3, course_keys[0], course_keys[1], course_fence,
            "mark", request, recipient, "SYNTHETIC") == ["marked"]
        marked_course = json.loads(db.command("GET", course_keys[0]))
        assert marked_course["courseBindingFingerprint"] == course_row["courseBindingFingerprint"]
        assert marked_course["erasedPeople"] == recipient
        assert db.command("TTL", course_keys[0]) == -1
        assert db.command("EVAL", shared, 10, *course_keys, "cancel", db.command("GET", course_keys[0]), "", now,
            131072, "null", "") == ["canceled"]
        assert db.command("GET", course_keys[0]) is None and db.command("GET", course_keys[1]) == original_course_source
        assert db.command("TTL", course_keys[1]) > 399 * 86400
        assert db.command("HGET", course_keys[5], "items") == "0"
        print("PASS: course explicit coverage,32CAS rivals,immutable winner,unsupported stages closed,shared cap and original erasure/retention")

        print(json.dumps({"observed_commands_including_eval_and_redis_call": profiles, "supplier_invoice": False}))
        # Exercise production TypeScript plus the exact shared/paid/accounting
        # Lua together, under the same explicitly disposable loopback opt-in.
        runner = """
import {build} from 'esbuild';
import {spawnSync} from 'node:child_process';
import {testAliases,testEnvironment} from './tests/test-config.mjs';
for(const file of ['order-confirmation-paid.test.ts','order-confirmation-paid-erasure.test.ts','course-origin-persistence.test.ts','pending-mail-recovery.test.ts']) {
await build({entryPoints:['tests/'+file],bundle:true,platform:'node',format:'cjs',outfile:process.argv[1],logLevel:'error',alias:testAliases(file,process.cwd(),process.cwd()+'/tests')});
const result=spawnSync(process.execPath,[process.argv[1]],{env:testEnvironment(process.env),stdio:'inherit'});
if(result.status!==0){process.exitCode=result.status ?? 1;break;}
}
"""
        with tempfile.TemporaryDirectory(prefix="confirmation-paid-ts-") as directory:
            subprocess.run(["node", "--input-type=module", "-e", runner, str(Path(directory) / "paid.cjs")], cwd=root, check=True,
                           env=dict(os.environ, CONFIRMATION_ORIGIN_REDIS_PORT=os.environ.get("CONFIRMATION_ORIGIN_REDIS_PORT", "16379")))

    finally:
        neighbor_stop.set(); neighbor_thread.join(10)
        for key in made: db.command("DEL", key)
        db.sock.close()
        print("CLEANUP: only this proof's synthetic keys removed")


if __name__ == "__main__":
    main()
