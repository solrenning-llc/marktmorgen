"""CX-113: measure the live legacy receipt and billed Lua on disposable Redis.
No deployment, account, payment or email service is used.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import uuid
from test_order_confirmation_checkpoint_redis import LocalRedis


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
    def stats():
        return {m[1]: int(m[2]) for m in re.finditer(r"cmdstat_([^:]+):calls=(\d+),", client.command("INFO", "COMMANDSTATS")) if m[1] != "info"}
    try:
        client.command("HSET", keys[2], hour, 2)
        client.command("HSET", keys[3], hour, 17920)
        before = stats()
        assert commit() == 1
        after = stats()
        commands = sum(n - before.get(name, 0) for name, n in after.items())
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
    finally:
        client.command("DEL", *keys)
        client.close()


if __name__ == "__main__":
    main()
