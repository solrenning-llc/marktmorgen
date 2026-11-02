"""Retention-only single-digital origin: exact application Lua, disposable Redis.
No provider, customer payment, access grant or financial review is simulated as live.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import uuid
from test_form_opportunity_redis import Redis


class LocalRedis(Redis):
    def __init__(self):
        port = int(os.environ["CONFIRMATION_ORIGIN_REDIS_PORT"])
        if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1" or not 1024 <= port <= 65535:
            raise RuntimeError("Dedicated disposable loopback Redis required")
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.stream = self.sock.makefile("rb")


def main():
    root = Path(__file__).resolve().parents[1]
    def script(path, name):
        match = re.search(r"export const " + name + r" = `([^`]+)`;", (root / path).read_text())
        assert match and "${" not in match[1]
        return match[1]
    shared = script("lib/shipment-mail-outbox.ts", "SHIPMENT_MAIL_SCRIPT")
    origin = script("lib/order-confirmation-outbox.ts", "CONFIRMATION_ORIGIN_SCRIPT")
    paid = script("lib/order-confirmation-outbox.ts", "CONFIRMATION_PAID_SCRIPT")
    erasure = script("lib/order-confirmation-outbox.ts", "CONFIRMATION_ERASURE_SCRIPT")
    db = LocalRedis()
    clock = db.command("TIME"); now = int(clock[0]) * 1000 + int(clock[1]) // 1000
    prefix = "synthetic:single-digital:" + uuid.uuid4().hex + ":"
    ident = hashlib.sha256(prefix.encode()).hexdigest()
    keys = [prefix + x for x in ("row", "source", "due", "store", "person", "pool", "storepool", "all", "closed", "erased")]
    # A fixed original epoch25h earlier represents the restart boundary. Time
    # is not slept/forged in Lua; its actual TIME check is preserved.
    row = dict(kind="confirmation", originKind="single_digital", id=ident, statsId="SYNTHETIC",
               nonce=ident, accountId="acct_SyntheticDigital01", bodyDigest="b"*64, intentFingerprint="c"*64,
               bindingFingerprint="", session="", person="d"*64, sourceValue="SYNTHETIC_PROTECTED_SOURCE",
               sealed="s1.SYNTHETIC_ONLY", fingerprint="e"*64, bytes=160000, created=now-25*3600000,
               authorizedAt=now, next=now, expiresAt=now+400*86400000, state="queued", phase="awaiting_creation",
               owner="", leaseUntil=0, checks=0, createAttempts=0, reviewId="SYNTHETIC", recoveryCursor="", recoveryUpper=0,
               erasedPeople="", erasureSaturated=False)
    policy = dict(reviewId="SYNTHETIC", evidence="SYNTHETIC_ONLY", ongoingStorageFunded=True,
                  emptyInitializationVerified=True, globalItems=4, storeItems=4, globalBytes=1000000,
                  storeBytes=1000000, maxPayloadBytes=60000, maximumChecks=10, retryMilliseconds=60000,
                  admissionsUntil=now+86400000, coveredOrigins=["single-digital-confirmation"])
    profiles = {}
    def stats():
        return {m[1]: int(m[2]) for m in re.finditer(r"cmdstat_([^:]+):calls=(\d+),", db.command("INFO", "COMMANDSTATS")) if m[1] != "info"}
    def measure(name, call):
        before = stats(); result = call(); after = stats()
        profiles[name] = sum(after.get(k,0)-before.get(k,0) for k in set(before)|set(after))
        assert profiles[name] <= 64, (name, profiles[name])
        return result
    def enqueue(p=policy):
        return db.command("EVAL", shared, 10, *keys, "enqueue", "", json.dumps(row), now, 131072, json.dumps(p), "")
    def mutate(op, code=shared, p=policy, supplied=""):
        raw = db.command("GET", keys[0])
        if code == origin:
            return db.command("EVAL", code, 10, *keys, op, raw, supplied, now, "a"*48, json.dumps(p))
        return db.command("EVAL", code, 10, *keys, op, raw, supplied, now, 131072, json.dumps(p), "a"*48)
    try:
        assert measure("unfunded-purpose", lambda: enqueue(dict(policy, coveredOrigins=["course-confirmation"])))[0] == "unknown"
        assert db.command("EXISTS", *keys) == 0
        assert measure("enqueue", enqueue)[0] == "queued"
        assert db.command("TTL", keys[0]) == db.command("TTL", keys[1]) == -1
        assert db.command("HGET", keys[5], "items") == "1"
        assert measure("duplicate", enqueue)[0] == "existing"
        for op in ("create", "url"):
            assert measure(op, lambda op=op: mutate(op, origin))[0] == "unknown"
        assert measure("claim", lambda: mutate("claim"))[0] == "preparing"
        assert measure("defer", lambda: mutate("defer"))[0] == "queued"
        for op in ("dispatch", "accepted", "not-accepted", "refused"):
            before = db.command("GET", keys[0])
            assert measure(op, lambda op=op: mutate(op))[0] == "unknown"
            assert db.command("GET", keys[0]) == before
        assert measure("missing-coverage-claim", lambda: mutate("claim", p=dict(policy, coveredOrigins=[])))[0] == "unknown"
        assert measure("cursor", lambda: mutate("cursor", origin, supplied=json.dumps(dict(recoveryCursor="cs_test_syntheticCursor001", recoveryUpper=now//1000))))[0] == "cursor"
        current = json.loads(db.command("GET", keys[0]))
        bound = dict(current, session="cs_test_syntheticDigitalBound001", bindingFingerprint="2"*64,
                     phase="awaiting_payment", sourceValue="SYNTHETIC_BOUND_DIGITAL_SOURCE")
        wrong_kind = dict(bound, originKind=None)
        assert mutate("bind", origin, supplied=json.dumps(wrong_kind))[0] == "unknown"
        assert measure("bind", lambda: mutate("bind", origin, supplied=json.dumps(bound)))[0] == "bound"
        assert json.loads(db.command("GET", keys[0]))["originKind"] == "single_digital"
        assert mutate("url", origin)[0] == "unknown"
        # A refused/unknown retained record from any future protocol must never
        # be silently reinterpreted as accepted by this retention construction.
        for state in ("refused", "dispatching"):
            held = dict(json.loads(db.command("GET", keys[0])), state=state)
            db.command("SET", keys[0], json.dumps(held))
            assert mutate("claim")[0] == "held"
            assert mutate("accepted")[0] == "unknown"
            assert db.command("TTL", keys[0]) == -1
        held = json.loads(db.command("GET", keys[0])); held.update(state="queued", checks=10, next=0, expiresAt=now-1)
        db.command("SET", keys[0], json.dumps(held))
        assert measure("financial-horizon-held", lambda: mutate("claim"))[0] == "queued"
        assert db.command("TTL", keys[0]) == -1 and db.command("HGET", keys[5], "items") == "1"
        raw = db.command("GET", keys[0])
        assert db.command("EVAL", paid, 12, *keys, prefix+"newperson", prefix+"newerase", "accepted", raw, "", now, "a"*48, json.dumps(policy))[0] == "unknown"
        # A buyer-erasure request marks an unresolved source durably; store
        # erasure can subsequently remove its personal payload and reservation.
        token, person = "f"*48, "1"*64
        db.command("SET", keys[9], token)
        assert db.command("EVAL", erasure, 3, keys[0], keys[1], keys[9], "mark", token, person, "SYNTHETIC")[0] == "marked"
        assert person in json.loads(db.command("GET", keys[0]))["erasedPeople"]
        memory = sum(db.command("MEMORY", "USAGE", k, "SAMPLES", 0) or 0 for k in keys)
        assert memory <= row["bytes"], memory
        row_bytes = len(db.command("GET", keys[0]).encode())
        assert measure("erase-cancel", lambda: mutate("cancel", p=None))[0] == "canceled"
        assert db.command("EXISTS", keys[0]) == 0 and db.command("HGET", keys[5], "items") == "0"
        assert db.command("TTL", keys[1]) > 399*86400
        print(json.dumps(dict(result="PASS", profiles=profiles, measuredRetainedBytes=memory,
              rowBytes=row_bytes, reservedBytes=row["bytes"], providerRequests=0, financialReview="NULL/UNKNOWN",
              accessRecipe="UNIMPLEMENTED: creation/URL/dispatch/settlement denied", pendingExpiry=False), sort_keys=True))
    finally:
        db.command("DEL", *keys); db.close()


if __name__ == "__main__":
    main()
