"""Exercise the low-stock number's save and off (lib/low-stock.ts, LOW_STOCK_SAVE and LOW_STOCK_OFF, each built on the
data room's TAKE_DATA from lib/store-data.ts) against disposable local CI Redis: the number and its room stand or fall
together, whatever runs at the same time (Codex G and Codex X6 on #3650).
No application credentials or production host configuration are read.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis


def take_data(root):
    match = re.search(r"export const TAKE_DATA = `([^`]+)`;", (root / "lib/store-data.ts").read_text(encoding="utf-8"))
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected static application script TAKE_DATA")
    return match.group(1)


def low_stock_script(root, name, take):
    """LOW_STOCK_SAVE or LOW_STOCK_OFF as lib/low-stock.ts builds them: LOW_STOCK_ROOM with TAKE_DATA put in, nothing else."""
    source = (root / "lib/low-stock.ts").read_text(encoding="utf-8")
    room = re.search(r"const LOW_STOCK_ROOM = `([^`]+)`;", source)
    body = re.search(r"export const " + name + r" = `([^`]+)`;", source)
    if not room or not body or "\\" in room.group(1) or "\\" in body.group(1):
        raise RuntimeError("Expected application scripts LOW_STOCK_ROOM and " + name)
    text = body.group(1).replace("${LOW_STOCK_ROOM}", room.group(1).replace("${TAKE_DATA}", take))
    if "${" in text:
        raise RuntimeError(name + " puts in something this test does not")
    return text


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    take = take_data(root)
    save_script = low_stock_script(root, "LOW_STOCK_SAVE", take)
    off_script = low_stock_script(root, "LOW_STOCK_OFF", take)
    room = "marktmorgen:integration:data:" + uuid.uuid4().hex
    record = "marktmorgen:integration:ls:" + uuid.uuid4().hex
    product = "p" + uuid.uuid4().hex[:12]
    slot = "ls:" + product
    size = 120
    month = "2026-11"
    redis = Redis()

    def save(client, limit, low, seen):
        value = json.dumps({"low": low, "seen": seen}, separators=(",", ":"))
        return client.command("EVAL", save_script, 2, room, record, limit, month, slot, size, product, value)

    def off(client):
        return client.command("EVAL", off_script, 2, room, record, month, slot, product)

    def total():
        return int(redis.command("HGET", room, "#") or 0)

    def together():
        has = redis.command("HEXISTS", record, product) == 1
        held = int(redis.command("HGET", room, slot) or 0)
        return has == (held == size) and total() == (held + 64 if held else 0)

    try:
        assert save(redis, 10_000, 5, 10) == [1, size + 64]
        assert redis.command("HGET", record, product) == '{"low":5,"seen":10}'
        assert int(redis.command("HGET", room, slot)) == size and total() == size + 64
        print("PASS: a save takes its room and writes its number in one step")

        assert save(redis, 0, 4, 10) == [1, size + 64]
        assert redis.command("HGET", record, product) == '{"low":4,"seen":10}'
        print("PASS: a number changed within the room it holds takes nothing more, even in a full room")

        assert off(redis) == [1, 1]
        assert redis.command("HEXISTS", record, product) == 0 and redis.command("HEXISTS", room, slot) == 0 and total() == 0
        print("PASS: off deletes the number and gives its room back in one step")

        assert save(redis, size, 5, 10) == [0, 0]
        assert redis.command("HEXISTS", record, product) == 0 and redis.command("HEXISTS", room, slot) == 0
        print("PASS: a full room writes nothing and takes nothing")

        # A slot left with no number (a save whose answer was lost before this fix, or a product deleted).
        take_args = [str(part) for part in ("s", slot, size)]
        assert redis.command("EVAL", take, 1, room, 10_000, "1", month, *take_args) == [1, size + 64]
        assert off(redis) == [0, 1]
        assert redis.command("HEXISTS", room, slot) == 0 and total() == 0
        print("PASS: off with no number still gives a stranded slot back")

        redis.command("DEL", room)
        assert off(redis) == [0, 1]
        assert redis.command("EXISTS", room) == 0
        print("PASS: off on a room the store's erasure took away writes no room back")

        assert redis.command("EVAL", save_script, 2, room, record, 10_000, "not-a-month", slot, size, product, "{}") == [-1, 0]
        assert redis.command("EXISTS", record) == 0
        print("PASS: a save it cannot read writes nothing")

        def race(i):
            client = Redis()
            try:
                return save(client, 10_000, 5, i) if i % 2 == 0 else off(client)
            finally:
                client.close()

        for _ in range(20):
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(race, range(16)))
            assert together(), "a number and its room parted"
        print("PASS: saves and offs at once leave the number and its room together")
    finally:
        redis.command("DEL", room, record)
        redis.close()


if __name__ == "__main__":
    main()
