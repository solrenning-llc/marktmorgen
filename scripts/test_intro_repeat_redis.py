"""Run the actual intro repeat count script (lib/intro-repeat.ts, INTRO_REPEAT_COUNT_IF) against disposable local CI Redis.
No application credentials or production host configuration are read.

A sale's mark and its count are written in one step, counted only when the mark was not there, so a count that fails
leaves no mark and the next pass counts the sale, and one that ran is never counted twice (pre-review of
claude5/intro-repeat-count, 9 November 2026). lib/redis-memory.ts models the same script for the unit tests.
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
    count_if = script(root / "lib/intro-repeat.ts", "INTRO_REPEAT_COUNT_IF")
    base = "marktmorgen:integration:intro-repeat:" + uuid.uuid4().hex
    mark, month = base + ":mark", base + ":month"
    redis = Redis()

    def run(field):
        return redis.command("EVAL", count_if, 2, mark, month, field, 172800, 5356800)

    try:
        assert redis.command("PING") == "PONG"
        assert run("repeat") == 1
        assert redis.command("HGET", month, "repeat") == "1"
        assert 0 < redis.command("TTL", mark) <= 172800 and 0 < redis.command("TTL", month) <= 5356800
        print("PASS: an unmarked sale is marked and counted in one step, both bounded in time")

        assert run("repeat") == 0 and run("first") == 0
        assert redis.command("HGET", month, "repeat") == "1" and redis.command("HEXISTS", month, "first") == 0
        print("PASS: a sale already marked is never counted again")
    finally:
        redis.command("DEL", mark, month)
        redis.close()


if __name__ == "__main__":
    main()
