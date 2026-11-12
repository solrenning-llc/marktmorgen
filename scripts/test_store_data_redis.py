"""Exercise the actual data room Lua (lib/store-data.ts, TAKE_DATA), and the receipt number script built on it
(lib/receipt-number.ts, RECEIPT_NUMBER), against disposable local CI Redis.
No application credentials or production host configuration are read.
"""
import concurrent.futures
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


def receipt_script(root, take_data):
    """RECEIPT_NUMBER as lib/receipt-number.ts builds it: TAKE_DATA and the slot's name put in, nothing else."""
    source = (root / "lib/receipt-number.ts").read_text(encoding="utf-8")
    match = re.search(r"export const RECEIPT_NUMBER = `([^`]+)`;", source)
    slot = re.search(r'export const RECEIPT_SLOT = "([a-z]+)";', source)
    if not match or not slot or "\\" in match.group(1):
        raise RuntimeError("Expected application script RECEIPT_NUMBER")
    body = match.group(1).replace("${TAKE_DATA}", take_data).replace("${RECEIPT_SLOT}", slot.group(1))
    if "${" in body:
        raise RuntimeError("RECEIPT_NUMBER puts in something this test does not")
    return body


def receipt_ceiling(root):
    """RECEIPT_NUMBER_COMMANDS, read from the code it is written in."""
    own = re.search(r"export const RECEIPT_NUMBER_COMMANDS = (\d+) \+ DATA_EXPIRED_COMMANDS;", (root / "lib/receipt-number.ts").read_text(encoding="utf-8"))
    expired = re.search(r"export const DATA_EXPIRED_COMMANDS = (\d+);", (root / "lib/store-data.ts").read_text(encoding="utf-8"))
    if not own or not expired:
        raise RuntimeError("Expected RECEIPT_NUMBER_COMMANDS = n + DATA_EXPIRED_COMMANDS")
    return int(own.group(1)) + int(expired.group(1))


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    take_data = script(root / "lib/store-data.ts", "TAKE_DATA")
    room = "marktmorgen:integration:data:" + uuid.uuid4().hex
    numbers = "marktmorgen:integration:rcpt:n:" + uuid.uuid4().hex
    counter = "marktmorgen:integration:rcpt:seq:" + uuid.uuid4().hex
    redis = Redis()

    def take(client, limit, *triples, always=False, month="2026-10"):
        flat = [str(part) for triple in triples for part in triple]
        return client.command("EVAL", take_data, 1, room, limit, "1" if always else "0", month, *flat)

    def total():
        return int(redis.command("HGET", room, "#") or 0)

    try:
        assert redis.command("PING") == "PONG"
        # A slot's own field counts 64 bytes while it is there.
        assert take(redis, 1_000, ("s", "p:one", 400)) == [1, 464]
        assert take(redis, 1_000, ("a", "p:one", 100)) == [1, 564]
        assert take(redis, 1_000, ("s", "p:two", 600)) == [0, 564]
        assert redis.command("HEXISTS", room, "p:two") == 0 and total() == 564
        print("PASS: a write is taken while it fits, and one past the room writes nothing")

        assert take(redis, 1_000, ("s", "p:one", 0)) == [1, 0]
        assert redis.command("HEXISTS", room, "p:one") == 0
        assert take(redis, 10, ("a", "p:gone", -500)) == [1, 0]
        assert redis.command("HEXISTS", room, "p:gone") == 0
        print("PASS: shrinking or deleting is always taken, and never below nothing")

        assert take(redis, 100, ("s", "o", 5_000), always=True) == [1, 5_064]
        assert take(redis, 100, ("a", "p:x", 1)) == [0, 5_064]
        assert take(redis, 100, ("a", "o", -64)) == [1, 5_000]
        print("PASS: what is taken always passes the room, and nothing else does after it")

        redis.command("DEL", room)
        # Two changes: all or nothing.
        assert take(redis, 1_000, ("s", "a", 300), ("s", "b", 600)) == [0, 0]
        assert redis.command("HLEN", room) <= 1
        assert take(redis, 1_000, ("s", "a", 300), ("s", "b", 500)) == [1, 928]
        print("PASS: several slots at once are taken whole or not at all")

        redis.command("DEL", room)
        assert take(redis, 10_000, ("a", "~2026-11", 1_000), month="2026-10") == [1, 1_064]
        assert take(redis, 10_000, ("a", "~2026-12", 500), month="2026-10") == [1, 1_628]
        assert redis.command("HGET", room, "~") == "2026-11,2026-12"
        # December comes: November's records have expired by themselves and come off.
        assert take(redis, 10_000, ("a", "p:new", 10), month="2026-12") == [1, 1_628 - 1_064 + 74]
        assert redis.command("HEXISTS", room, "~2026-11") == 0
        assert redis.command("HGET", room, "~") == "2026-12"
        print("PASS: what expires by itself comes off the room once its month is over")

        redis.command("DEL", room)
        # A store idle for years: every month that is over comes off in one call, exactly, read with one HMGET and
        # removed with one HDEL, so one call's commands stay bounded however many there are (review of #3001).
        # Changed (rule 23): b518e114f took at most two a call and left the rest counted, the room fuller than it was.
        idle = ["2020-%02d" % m for m in range(1, 13)] + ["2021-01"]

        def commands():
            stats = redis.command("INFO", "commandstats")
            return sum(int(n) for n in re.findall(r"^cmdstat_[^:]+:calls=(\d+)", stats, re.M))

        def billed(months):
            redis.command("DEL", room)
            redis.command("HSET", room, "#", str(len(months) * 164), "~", ",".join(months), *[part for m in months for part in ("~" + m, "100")])
            before = commands()
            assert take(redis, 100_000, ("a", "p:new", 10), month="2026-11") == [1, 74]
            return commands() - before

        assert billed(idle[:1]) == billed(idle)
        assert redis.command("HEXISTS", room, "~") == 0
        assert [redis.command("HEXISTS", room, "~" + m) for m in idle] == [0] * len(idle)
        assert take(redis, 100_000, ("a", "p:new", 10), month="2026-11") == [1, 84]
        # A month listed twice is taken off once.
        redis.command("DEL", room)
        redis.command("HSET", room, "#", "328", "~", "2020-01,2020-01,2020-02", "~2020-01", "100", "~2020-02", "100")
        assert take(redis, 100_000, ("a", "p:new", 10), month="2026-11") == [1, 74]
        # Past DATA_MONTHS_CLEARED_MOST (512) the oldest 512 come off and the rest on the next call: it converges, exactly.
        many = ["%04d-%02d" % (1900 + i // 12, i % 12 + 1) for i in range(520)]
        redis.command("DEL", room)
        redis.command("HSET", room, "#", str(len(many) * 164), "~", ",".join(many), *[part for m in many for part in ("~" + m, "100")])
        assert take(redis, 10**9, ("a", "p:new", 10), month="2026-11") == [1, 8 * 164 + 74]
        assert redis.command("HGET", room, "~") == ",".join(many[512:])
        assert take(redis, 10**9, ("a", "p:new", 10), month="2026-11") == [1, 84]
        assert redis.command("HEXISTS", room, "~") == 0
        print("PASS: a long-idle room sheds every expired month in one call, in the same commands as one month")

        redis.command("DEL", room)
        assert take(redis, 10_000, ("a", "~2026-09", 100), month="2026-10")[0] == -1
        assert take(redis, 10_000, ("s", "~2026-11", 100), month="2026-10")[0] == -1
        assert take(redis, 10_000, ("s", "#", 100))[0] == -1
        assert take(redis, 10_000, ("x", "p:a", 100))[0] == -1
        assert take(redis, 10_000, ("s", "p:a", "many"))[0] == -1
        assert take(redis, -1, ("s", "p:a", 1))[0] == -1
        assert take(redis, 10_000, ("s", "p:a", 1), month="October")[0] == -1
        assert redis.command("EXISTS", room) == 0
        print("PASS: a malformed change writes nothing at all")

        redis.command("HSET", room, "#", "x")
        assert take(redis, 10_000, ("s", "p:a", 1))[0] == -1
        print("PASS: an unreadable room takes nothing")

        redis.command("DEL", room)

        def one(index):
            client = Redis()
            try:
                return take(client, 64 * 10 + 10 * 100, ("s", "p:%d" % index, 100))[0]
            finally:
                client.close()

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(one, range(64)))
        assert sum(1 for r in results if r == 1) == 10 and all(r in (0, 1) for r in results)
        assert total() == 64 * 10 + 10 * 100
        print("PASS: concurrent writes never take more room than there is")

        # A receipt's number (lib/receipt-number.ts): the commands one numbering bills, counted with INFO commandstats,
        # never past RECEIPT_NUMBER_COMMANDS, the figure tests/kb22-receipt-number.test.ts prices inside the receipt's
        # studio requests (review of #3001, M1, comment 6697804893: 37 measured at 13 expired months against 16).
        receipt_number = receipt_script(root, take_data)
        ceiling = receipt_ceiling(root)

        def calls():
            stats = redis.command("INFO", "commandstats")
            return sum(int(n) for n in re.findall(r"^cmdstat_[^:]+:calls=(\d+)", stats, re.M))

        def number(reference, limit=10**9):
            return redis.command("EVAL", receipt_number, 3, room, numbers, counter, limit, "2026-11", reference, 352, 368)

        def billed(reference, limit=10**9):
            before = calls()
            reply = number(reference, limit)
            # Less the INFO that read the count before it.
            return reply, calls() - before - 1

        most = 0
        for idle in (0, 1, 13, 40, 520):
            redis.command("DEL", room, numbers, counter)
            months = ["%04d-%02d" % (1900 + i // 12, i % 12 + 1) for i in range(idle)]
            if months:
                redis.command("HSET", room, "#", str(idle * 164), "~", ",".join(months), *[part for m in months for part in ("~" + m, "100")])
            for reference, want in (("cs_test_first", [3, 1]), ("cs_test_first", [2, 1]), ("cs_test_next", [3, 2])):
                reply, used = billed(reference)
                assert reply == want and used <= ceiling, (idle, reference, reply, used, ceiling)
                most = max(most, used)
            redis.command("HSET", room, "#", "999999999999", "~", ",".join(months) or "2026-12")
            reply, used = billed("cs_test_full", 10)
            assert reply == [0, 999999999999] and used <= ceiling, (idle, reply, used, ceiling)
        assert most == 13, most
        print("PASS: one receipt number bills at most RECEIPT_NUMBER_COMMANDS (%d; %d measured), however long the store sat idle" % (ceiling, most))

        # A count Redis cannot add to takes no room and gives no number (review of #3001, L1, comment 6704251804).
        for bad in ("abc", "1.5", "007", "-3", "999999999999", "9999999999999"):
            redis.command("DEL", room, numbers, counter)
            redis.command("SET", counter, bad)
            assert number("cs_test_bad") == [-1, 0] and number("cs_test_bad") == [-1, 0]
            assert redis.command("EXISTS", room) == 0 and redis.command("HEXISTS", numbers, "cs_test_bad") == 0
            assert redis.command("GET", counter) == bad
        redis.command("DEL", room, numbers, counter)
        redis.command("HSET", counter, "n", "1")
        try:
            number("cs_test_bad")
            raise AssertionError("a count of another type was read as a number")
        except RuntimeError as error:
            assert "WRONGTYPE" in str(error)
        assert redis.command("EXISTS", room) == 0
        redis.command("DEL", counter)
        redis.command("SET", counter, "7")
        assert number("cs_test_bad") == [3, 8]
        print("PASS: a receipt count that is not a whole number takes no room and gives no number")
    finally:
        redis.command("DEL", room, numbers, counter)
        redis.close()


if __name__ == "__main__":
    main()
