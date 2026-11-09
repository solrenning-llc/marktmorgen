"""Run the erasure's form script (lib/form-store.ts FORGET_FORM_PERSON) in a real Redis.

Takes the script exactly as the application sends it and every case of
tests/form-forget-cases.ts, with what the rule of lib/form-respondent.ts
makes of each (scripts/form-forget-redis.mjs prints them), runs the script
on each case in a database of its own that is empty when the check starts
and flushed when it ends, and holds Redis to the rule: the same responses
kept, the same written back without the person's address, the same deleted,
and a reply in the shape forgetFormsPerson reads. tests/form-forget-parity.test.ts
holds the stand-in (lib/redis-memory.ts) to the same cases, so the Lua, the
stand-in and the rule agree, lengths counted as lib/forms.ts counts them.
No application credentials or production host configuration are read.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys

from test_contact_erasure_redis import Redis as DatabaseRedis


class Redis(DatabaseRedis):
    """The person-deletion check's client on a port of our choosing (16379 in CI)."""

    def __init__(self, port, db):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.stream = self.sock.makefile("rb")
        if db:
            assert self.command("SELECT", db) == "OK"


def canonical(raw):
    try:
        return json.dumps(json.loads(raw), sort_keys=True, ensure_ascii=False)
    except ValueError:
        return raw


def pick_database(port):
    probe = Redis(port, 0)
    try:
        for db in range(15, 0, -1):
            probe.command("SELECT", db)
            if probe.command("DBSIZE") == 0:
                return db
    finally:
        probe.close()
    raise RuntimeError("No empty Redis database to use")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=16379)
    port = parser.parse_args().port
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against a dedicated throwaway Redis on loopback")
    root = Path(__file__).resolve().parents[1]
    run = subprocess.run(["node", str(root / "scripts" / "form-forget-redis.mjs")], cwd=root, capture_output=True, timeout=300)
    if run.returncode != 0:
        sys.stderr.write(run.stderr.decode("utf-8", "replace"))
        sys.exit(run.returncode)
    given = json.loads(run.stdout.decode("utf-8"))
    script = given["script"]
    assert script.startswith("-- marktmorgen:form-forget:"), "Expected the application's form erasure script"
    db = pick_database(port)
    redis = Redis(port, db)
    failures = 0
    try:
        for case in given["cases"]:
            redis.command("FLUSHDB")
            keys = ["marktmorgen:integration:form-forget:%d" % k for k in range(len(case["forms"]))]
            for key, form in zip(keys, case["forms"]):
                redis.command("RPUSH", key, *form["items"])
            reply = redis.command("EVAL", script, len(keys), *keys, case["address"], *[json.dumps(form["ids"]) for form in case["forms"]])
            assert isinstance(reply, list) and len(reply) % 4 == 0, (case["name"], reply)
            entries = [reply[i:i + 4] for i in range(0, len(reply), 4)]
            for k, (key, form) in enumerate(zip(keys, case["forms"])):
                want = form["expected"]
                after = redis.command("LRANGE", key, 0, -1) or []
                mine = [entry for entry in entries if entry[0] == k + 1]
                shaped = all(isinstance(e[1], str) and isinstance(e[2], int) and e[2] >= 1 and isinstance(e[3], str) for e in mine)
                rewritten = [e for e in mine if e[3] != ""]
                deleted = [e for e in mine if e[3] == ""]
                got = {
                    "after": [canonical(raw) for raw in after],
                    "deleted": len(deleted),
                    "rewritten": len(rewritten),
                    "shaped": shaped and all(e[2] == 1 for e in rewritten),
                }
                expected = {
                    "after": [canonical(raw) for raw in want["after"]],
                    "deleted": want["deleted"],
                    "rewritten": want["rewritten"],
                    "shaped": True,
                }
                label = case["name"] + (", form %d" % (k + 1) if len(case["forms"]) > 1 else "")
                if got == expected:
                    print("PASS: %s (%s)" % (label, ", ".join(want["roles"])))
                else:
                    failures += 1
                    print("FAIL: %s (%s)" % (label, ", ".join(want["roles"])))
                    print("  Redis: %s" % json.dumps(got, ensure_ascii=False))
                    print("  rule : %s" % json.dumps(expected, ensure_ascii=False))
    finally:
        try:
            redis.command("FLUSHDB")
        finally:
            redis.close()
    if failures:
        print("%d case(s) where the real Lua and lib/form-respondent.ts disagree" % failures)
        sys.exit(1)
    print("PASS: the form erasure's Lua agrees with lib/form-respondent.ts in a real Redis")


if __name__ == "__main__":
    main()
