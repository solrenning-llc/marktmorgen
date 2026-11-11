"""Execute the actual purchase-move retry Lua (lib/purchase-moves.ts) against disposable local CI Redis.
No application credentials or production host configuration are read.

MemoryRedis answers a script's SET with the string "OK"; real Redis hands Lua a status
table {ok="OK"}. This check runs the shipped script on a real server so the two cannot
diverge silently again (Claude 1 on #3659).
"""
import os
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis


def script(path, name):
    source = Path(path).read_text(encoding="utf-8")
    match = re.search(r"export const " + name + r" = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected static application script " + name)
    return match.group(1)


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    create = script(root / "lib/purchase-moves.ts", "MOVE_RETRY_CREATE")
    prefix = "marktmorgen:integration:pm:" + uuid.uuid4().hex + ":"
    keys = [prefix + "retry", prefix + "r", prefix + "from", prefix + "to"]
    redis = Redis()
    try:
        assert redis.command("PING") == "PONG"
        index = '{"id":"a","claim":"b"}'
        first = redis.command("EVAL", create, 4, *keys, index, "request", "from-row", "to-row", 600)
        assert first == [1, index], first
        assert redis.command("GET", keys[0]) == index
        assert redis.command("GET", keys[1]) == "request"
        assert redis.command("GET", keys[2]) == "from-row"
        assert redis.command("GET", keys[3]) == "to-row"
        assert 0 < redis.command("TTL", keys[1]) <= 600
        print("PASS: a fresh tuple writes the index, the request and both links in one step")

        again = redis.command("EVAL", create, 4, *keys, '{"id":"c","claim":"d"}', "other", "x", "y", 600)
        assert again == [0, index], again
        assert redis.command("GET", keys[1]) == "request"
        print("PASS: a second ask the same day reads back the one identity and writes nothing")

        redis.command("DEL", *keys)
        redis.command("SET", keys[2], "taken")
        partial = redis.command("EVAL", create, 4, *keys, index, "request", "from-row", "to-row", 600)
        assert partial == [-1, index], partial
        assert redis.command("GET", keys[0]) == index and redis.command("GET", keys[2]) == "taken"
        print("PASS: a link already taken fails closed after the index, so no second identity is made")
    finally:
        redis.command("DEL", *keys)
        redis.close()


if __name__ == "__main__":
    main()
