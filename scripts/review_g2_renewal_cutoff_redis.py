"""Review only: exact renewal Lua on opted-in disposable loopback Redis."""
import hashlib
import json
import os
from pathlib import Path
import re
import uuid
from test_order_confirmation_outbox_redis import LocalRedis

assert os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") == "1"
source = (Path(__file__).resolve().parents[1] / "lib/shipment-mail-outbox.ts").read_text()
script = re.search(r"export const SHIPMENT_MAIL_SCRIPT = `([^`]+)`;", source).group(1)
assert "${" not in script
db = LocalRedis()
made = set()

def attempt(expired):
    clock = db.command("TIME")
    now = int(clock[0]) * 1000 + int(clock[1]) // 1000
    prefix = "marktmorgen:review:g2:" + uuid.uuid4().hex + ":"
    sid = "G2" + uuid.uuid4().hex
    ident = hashlib.sha256(prefix.encode()).hexdigest()
    capsule = "b" * 64
    keys = [prefix + x for x in ["row", "source", "due", "store", "person", "pool", "storepool", "all", "closed", "erased"]]
    keys += ["nl:order-confirmation:renewal:capsule:" + sid + ":" + capsule,
             "nl:order-confirmation:renewal:store:" + sid]
    made.update(keys)
    old = now - 200
    cutoff = now - 100 if expired else now + 3_600_000
    row = dict(kind="confirmation", originKind="single_digital_renewal", purpose="single-digital-access-renewal",
               id=ident, statsId=sid, nonce=ident, person="c" * 64, accountId="acct_SyntheticG2",
               capsuleDigest=capsule, sourceValue="synthetic-source", sealed="s1.synthetic", fingerprint="d" * 64,
               bytes=160000, created=old, authorizedAt=old, next=old, state="queued", phase="renewal_queued",
               owner="", leaseUntil=0, checks=0, reviewId="SYNTHETIC_G2")
    policy = dict(reviewId="SYNTHETIC_G2", evidence="SYNTHETIC ONLY", ongoingStorageFunded=True,
                  emptyInitializationVerified=True, globalItems=4, storeItems=3, globalBytes=2000000,
                  storeBytes=2000000, maxPayloadBytes=60000, maximumChecks=10, retryMilliseconds=60000,
                  admissionsUntil=cutoff, coveredOrigins=["single-digital-confirmation", "single-digital-access-renewal"],
                  singleDigitalAccessEvidence="SYNTHETIC ONLY", singleDigitalRenewalEvidence="SYNTHETIC ONLY")
    answer = db.command("EVAL", script, 12, *keys, "enqueue", "", json.dumps(row), old, 131072, json.dumps(policy), "")
    print(json.dumps(dict(expired=expired, execution_clock=now, admission_cutoff=cutoff, earlier_argv_time=old,
                         result=answer[0], new_row=db.command("EXISTS", keys[0]), pool_items=db.command("HGET", keys[5], "items"))))
    assert answer[0] == ("unknown" if expired else "queued"), "execution-time admission cutoff must precede new storage"

try:
    attempt(False)
    attempt(True)
finally:
    if made:
        db.command("DEL", *made)
    db.sock.close()
