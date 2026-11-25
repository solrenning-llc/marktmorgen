"""CX-113: measure the live legacy receipt and billed Lua on disposable Redis.
No deployment, account, payment or email service is used.
"""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid
from test_order_confirmation_checkpoint_redis import LocalRedis, measure_commands


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Dedicated disposable loopback Redis required")
    root = Path(__file__).resolve().parents[1]
    # Read the actual cost model with the repository's normal test wiring.
    # No copied monetary coefficient or supplier price is used here.
    with tempfile.TemporaryDirectory(prefix="a3-legacy-cost-") as temp:
        out = str(Path(temp) / "budget.cjs")
        source = """
import { FAMILIES } from './tests/store-data-registry';
import { COMMAND, ORDER_COST, ORDER_COMPUTE, ORDER_LIBRARY, ORDER_RENEWAL_STOP, PER_EMAIL } from './tests/plan-cost-registry';
const part=FAMILIES['nl:orders:seen:@lib/orders.ts'].parts.find(p=>'per' in p && p.per==='order');
console.log(JSON.stringify({bytes:part.bytes,days:part.days,accountingCost:ORDER_COST-(2*PER_EMAIL+ORDER_COMPUTE+ORDER_LIBRARY+ORDER_RENEWAL_STOP),commandCost:COMMAND}));
"""
        build = """
import {build} from 'esbuild';
import {testAliases} from './tests/test-config.mjs';
await build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:process.argv[2],alias:testAliases('legacy-order-accounting-cost.test.ts',process.cwd(),process.cwd()+'/tests')});
"""
        subprocess.run(["node", "--input-type=module", "-e", build, source, out], cwd=root, check=True)
        budget = json.loads(subprocess.check_output(["node", out], cwd=root, text=True))
    source = (root / "lib/orders.ts").read_text(encoding="utf-8")
    match = re.search(r"export const COMMIT_ORDER_CONFIRMATION = `([^`]+)`;", source)
    assert match and "${" not in match[1]
    script = match[1]
    client = LocalRedis()
    nonce = uuid.uuid4().hex
    folder = hashlib.sha256(nonce.encode()).hexdigest()[:32]
    reference = "checkout:cs_test_" + nonce
    seen = "nl:orders:seen:" + hashlib.sha256(reference.encode()).hexdigest()[:32]
    now = int(time.time() * 1000)
    month = time.strftime("%Y-%m", time.gmtime(now / 1000))
    keys = [seen, f"nl:orders:n:{folder}:{month}", f"nl:orders:open:{folder}",
            f"nl:orders:bytes:{folder}", f"nl:orders:folders:{nonce}", f"nl:store:folder-owner:{folder}"]
    receipt, until, hour = "oc1:" + hashlib.sha256(nonce.encode()).hexdigest(), now + 45 * 86_400_000, str(now // 3_600_000)
    def commit():
        return client.command("EVAL", script, 6, *keys, receipt, hour, 8960, 1,
                              folder, "synthetic@example.test", until, now, 34_560_000)
    try:
        client.command("HSET", keys[2], hour, 2)
        client.command("HSET", keys[3], hour, 17920)
        result, commands = measure_commands(client, commit)
        assert result == 1
        memory = client.command("MEMORY", "USAGE", seen, "SAMPLES", 0)
        assert len(seen.encode()) == 47 and len(receipt.encode()) == 68
        print(json.dumps({"keyBytes": 47, "valueBytes": 68, "memoryBytes": memory,
                          "billedCommands": commands, "allocatedBytes": budget["bytes"], "days": budget["days"]}), flush=True)
        assert memory <= budget["bytes"], (memory, budget)
        assert commands == 23, commands
        assert commands * budget["commandCost"] <= budget["accountingCost"] + 1e-15, budget
        assert budget["days"] == 45
        assert client.command("PEXPIRETIME", seen) == until
        assert client.command("GET", keys[1]) == "1"
        assert client.command("HGET", keys[2], hour) == "1"
        assert commit() == 2
        assert client.command("PEXPIRETIME", seen) == until
        assert client.command("GET", keys[1]) == "1"
        assert client.command("HGET", keys[2], hour) == "1"
        print("PASS: live receipt fits its allocation; all 23 billed commands priced; replay keeps the absolute 45-day horizon and the other checkout")
        stuck_main(client, budget, script, source)
    finally:
        client.command("DEL", *keys)
        client.close()


def stuck_main(client, budget, ordinary, source):
    """Codex's MEDIUM on #3667 (coordinator's decision 4c5c, option (a)): the stuck paid checkout's one worst-case
    count, on real Redis: its billed commands with the ordinary refusal before it, once only, never after a complete
    ordinary receipt, and never less on a fault before its mark."""
    match = re.search(r"export const COUNT_STUCK_LEGACY_CHECKOUT = `([^`]+)`;", source)
    assert match and "${" not in match[1]
    stuck = match[1]
    nonce = uuid.uuid4().hex
    folder = hashlib.sha256(nonce.encode()).hexdigest()[:32]
    seen = "nl:orders:seen:" + hashlib.sha256(("stuck" + nonce).encode()).hexdigest()[:32]
    now = int(time.time() * 1000)
    month = time.strftime("%Y-%m", time.gmtime(now / 1000))
    hour = str(now // 3_600_000)
    keys = [seen, f"nl:orders:n:{folder}:{month}", f"nl:orders:open:{folder}",
            f"nl:orders:bytes:{folder}", f"nl:orders:folders:{nonce}", f"nl:store:folder-owner:{folder}"]
    until, owner = now + 45 * 86_400_000, "synthetic@example.test"
    mark = "ocf:" + hashlib.sha256(("mark" + nonce).encode()).hexdigest()

    def refuse():
        return client.command("EVAL", ordinary, 6, *keys, "oc1:" + "a" * 64, hour, 8960, 1,
                              folder, owner, until, now, 34_560_000)

    def count(c=client, code=stuck, expiry=until):
        return c.command("EVAL", code, 4, keys[0], keys[1], keys[4], keys[5], mark, folder, owner, expiry, now, 34_560_000)

    def reset():
        client.command("DEL", *keys)

    try:
        # The ordinary refusal and the stuck count that follows it, measured together, in both shapes: with no seen
        # key the refusal reads every check (the hold short of the bytes) and the count writes the owner; with a seen
        # key (a partial intent) the refusal stops at it and the count reads it. The worse is the priced 27.
        paths = []
        for partial in (True, False):
            reset()
            client.command("SET", keys[1], "5")
            client.command("HSET", keys[2], hour, 1)
            client.command("HSET", keys[3], hour, 1)
            if partial:
                client.command("SET", keys[0], "oci:" + "a" * 64)
            refused, refusal = measure_commands(client, refuse)
            assert refused == -1
            result, counted = measure_commands(client, count)
            assert result == 1
            paths.append((refusal, counted))
        print(json.dumps({"partialIntent": paths[0], "noSeenKey": paths[1]}), flush=True)
        assert paths == [(9, 14), (14, 13)], paths
        total = max(a + b for a, b in paths)
        assert total == 27
        assert total * budget["commandCost"] <= budget["accountingCost"] + 1e-15, budget
        assert client.command("GET", keys[1]) == "6"
        assert client.command("GET", keys[0]) == mark and client.command("PEXPIRETIME", keys[0]) == until
        assert client.command("GET", keys[5]) == owner and client.command("SISMEMBER", keys[4], folder) == 1
        assert client.command("HGET", keys[2], hour) == "1", "the hold is never released by the way out"
        assert count() == 2 and client.command("GET", keys[1]) == "6"
        assert refuse() == -1 and client.command("GET", keys[1]) == "6"
        print("PASS: stuck path within its 27 priced commands; counted once; a replay and a later ordinary commit count nothing more")

        reset()
        client.command("SET", keys[0], "oc1:" + "b" * 64)
        assert count() == 2 and client.command("EXISTS", keys[1]) == 0
        assert client.command("GET", keys[0]) == "oc1:" + "b" * 64
        print("PASS: a complete ordinary receipt is counted already: never a second count")

        reset()
        client.command("RPUSH", keys[0], "wrong type")
        client.command("SET", keys[5], "another@example.test")
        assert count() == 1 and client.command("GET", keys[1]) == "1"
        assert client.command("GET", keys[0]) == mark and client.command("GET", keys[5]) == "another@example.test"
        print("PASS: a seen key of another type and another owner's record no longer strand a paid order; the owner is kept")

        for bad in ("oops", "01", "10000000000000"):
            reset()
            client.command("SET", keys[1], bad)
            assert count() == -1 and client.command("EXISTS", keys[0]) == 0 and client.command("GET", keys[1]) == bad
        reset()
        client.command("RPUSH", keys[1], "wrong type")
        assert count() == -1 and client.command("EXISTS", keys[0]) == 0
        server_time = client.command("TIME")
        server_now = int(server_time[0]) * 1000 + int(server_time[1]) // 1000
        reset()
        assert count(expiry=server_now) == -1 and client.command("EXISTS", keys[0], keys[1]) == 0
        print("PASS: an unreadable window counter and a Redis-past horizon stay unknown before every mutation")

        reset()
        def attempt(_):
            other = LocalRedis()
            try:
                return count(other)
            finally:
                other.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(attempt, range(32)))
        assert outcomes.count(1) == 1 and outcomes.count(2) == 31 and client.command("GET", keys[1]) == "1"
        print("PASS: 32 simultaneous stuck counts are one count")

        reset()
        last = "redis.call('SET',KEYS[1],mark,'PXAT',untilAt)"
        assert stuck.count(last) == 1
        try:
            count(code=stuck.replace(last, "error('synthetic before mark'); " + last))
            raise AssertionError("Injected fault was not reached")
        except RuntimeError as error:
            assert "synthetic before mark" in str(error), error
        assert client.command("GET", keys[1]) == "1" and client.command("EXISTS", keys[0]) == 0
        assert count() == 1 and client.command("GET", keys[1]) == "2"
        print("PASS: a fault before the mark leaves the count and no mark, so a retry counts more, never less")
    finally:
        client.command("DEL", *keys)


if __name__ == "__main__":
    main()
