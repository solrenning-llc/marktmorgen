"""Execute the actual CRM deals import Lua script (lib/crm.ts, IMPORT_CRM_DEALS) against an isolated local CI Redis.
No application credentials or production host configuration are read.
"""
import concurrent.futures
import os
from pathlib import Path
import re
import uuid

from test_crm_pipelines_redis import Redis


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against the dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    source = (root / "lib/crm.ts").read_text(encoding="utf-8")
    match = re.search(r"export const IMPORT_CRM_DEALS = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected one static CRM deals import script")
    script = match.group(1)
    prefix = "marktmorgen:integration:crm-import:" + uuid.uuid4().hex + ":"
    deals, pipes, stages, race = (prefix + s for s in ("deals", "pipes", "stages", "race"))
    keys = [deals, pipes, stages, race]
    redis = Redis()
    try:
        assert redis.command("PING") == "PONG"
        # Never saved pipelines: the snapshot is "". Deals only, the pipelines left as they are.
        assert redis.command("EVAL", script, 3, deals, pipes, stages, "", "", "", 3, "a", "deal-a", "b", "deal-b") == [2]
        assert redis.command("HGET", deals, "a") == "deal-a" and redis.command("EXISTS", pipes) == 0
        print("PASS: deals written over an unsaved pipelines record, which stays unsaved")
        # A deal already there refuses the whole import, is never overwritten, and is answered as it is kept.
        assert redis.command("EVAL", script, 3, deals, pipes, stages, "", "", "", 9, "c", "deal-c", "a", "other") == [-2, "", "a", "deal-a"]
        assert redis.command("HGET", deals, "a") == "deal-a" and redis.command("HEXISTS", deals, "c") == 0
        print("PASS: an id already there refuses everything, overwrites nothing and is answered with its deal")
        # Past the ceiling: nothing.
        assert redis.command("EVAL", script, 3, deals, pipes, stages, "", "", "", 3, "c", "deal-c", "d", "deal-d") == [-3, ""]
        assert redis.command("HLEN", deals) == 2
        print("PASS: past the ceiling nothing is written")
        # New pipelines with the deals, in one step.
        assert redis.command("EVAL", script, 3, deals, pipes, stages, "", "pipes-v1", "stages-v1", 9, "c", "deal-c") == [1]
        assert redis.command("GET", pipes) == "pipes-v1" and redis.command("GET", stages) == "stages-v1" and redis.command("HGET", deals, "c") == "deal-c"
        print("PASS: pipelines, their copy and the deals are written together")
        # The board changed the pipelines since the snapshot: nothing, even with no pipeline change of the import's own.
        redis.command("SET", pipes, "pipes-from-the-board")
        assert redis.command("EVAL", script, 3, deals, pipes, stages, "pipes-v1", "", "", 9, "e", "deal-e") == [-1, "pipes-from-the-board"]
        assert redis.command("EVAL", script, 3, deals, pipes, stages, "pipes-v1", "pipes-v2", "stages-v2", 9, "e", "deal-e", "c", "again") == [-1, "pipes-from-the-board", "c", "deal-c"]
        assert redis.command("GET", pipes) == "pipes-from-the-board" and redis.command("HEXISTS", deals, "e") == 0 and redis.command("GET", stages) == "stages-v1"
        print("PASS: a stale pipelines snapshot writes nothing and answers the record as it is, with any id already there")
        # Many imports over one snapshot: exactly one lands.
        redis.command("SET", race, "snapshot")
        def run(index):
            client = Redis()
            try:
                return client.command("EVAL", script, 3, deals, race, stages, "snapshot", "writer-" + str(index), "copy", 1000, "r" + str(index), "deal")
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            replies = list(pool.map(run, range(32)))
        assert replies.count([1]) == 1 and sum(1 for r in replies if r[0] == -1 and r[1].startswith("writer-")) == 31, replies
        print("PASS: 32 concurrent imports over one snapshot: exactly one is written")
    finally:
        assert all(key.startswith(prefix) for key in keys)
        redis.command("DEL", *keys)
        redis.close()


if __name__ == "__main__":
    main()
