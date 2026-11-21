"""Exercise the actual order-write Lua (lib/order-data.ts, ORDER_WRITE) against disposable local CI Redis.

Every charge is held at or above what Redis itself says the write made it keep
(MEMORY USAGE, every sample), key by key and over many writes at once.
No application credentials or production host configuration are read.
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
    write = script(root / "lib/order-data.ts", "ORDER_WRITE")
    # ORDER_WRITE_IF_NEW is put together in lib/order-data.ts exactly this way: the guard, then ORDER_WRITE below its first line.
    if_new = script(root / "lib/order-data.ts", "ORDER_IF_NEW_GUARD") + "\n" + write.split("\n", 1)[1]
    base = "marktmorgen:integration:order:" + uuid.uuid4().hex
    room = base + ":room"
    redis = Redis()
    made = set()

    def run(*commands):
        keys = [room]
        argv = [len(commands)]
        for command in commands:
            name, key, *args = command
            if key not in keys:
                keys.append(key)
            made.add(key)
            argv += [name, keys.index(key) + 1, len(args), *args]
        return redis.command("EVAL", write, len(keys), *keys, *argv)

    def usage(*keys):
        total = 0
        for key in keys:
            n = redis.command("MEMORY", "USAGE", key, "SAMPLES", "0")
            total += n or 0
        return total

    def held():
        return int(redis.command("HGET", room, "o") or 0), int(redis.command("HGET", room, "#") or 0)

    try:
        assert redis.command("PING") == "PONG"
        k1 = base + ":contact"
        reply = run(("HSET", k1, "buyer@example.com", '{"agreed":false,"titles":["A guide"],"ids":["p1"]}'))
        charged = reply[0]
        assert charged % 16 == 0 and charged >= usage(k1), (charged, usage(k1))
        assert reply[1] == 1
        assert held() == (charged, charged + 64)
        print("PASS: a new key and field is charged at least what Redis keeps for it")

        reply = run(("HSET", k1, "buyer@example.com", '{"agreed":false,"titles":["A guide","A course"],"ids":["p1","p2"]}'))
        charged += reply[0]
        assert reply[0] > 0 and charged >= usage(k1), (charged, usage(k1))
        for i in range(40):
            charged += run(("HSET", k1, "buyer@example.com", '{"agreed":false,"titles":[' + ",".join('"A product %d"' % j for j in range(i + 3)) + ']}'))[0]
            assert charged >= usage(k1), (i, charged, usage(k1))
        same = run(("HSET", k1, "buyer@example.com", '{"agreed":false,"titles":["A guide","A course"],"ids":["p1","p2"]}'))
        assert same[0] == 0
        shorter = run(("HSET", k1, "buyer@example.com", "{}"))
        assert shorter[0] == 0
        print("PASS: a value made longer is charged what it grew by, at every step at least what Redis keeps; one kept or shortened nothing")

        k2 = base + ":ledger"
        reply = run(("HSETNX", k2, "p1", "1760000000"), ("HSETNX", k2, "p1", "1760000001"), ("DEL", base + ":cache"))
        assert reply[1] == 1 and reply[2] == 0 and reply[3] == 0
        assert reply[0] >= usage(k2)
        again = run(("HSETNX", k2, "p1", "1"))
        assert again[0] == 0 and again[1] == 0
        print("PASS: what is already there is charged nothing, a repeat buyer's order costs no room")

        k3 = base + ":library"
        reply = run(("SADD", k3, "a" * 32), ("EXPIRE", k3, 94608000))
        assert reply[1] == 1 and reply[2] == 1 and reply[0] >= usage(k3)
        assert run(("SADD", k3, "a" * 32))[0] == 0
        k4 = base + ":mark"
        reply = run(("SET", k4, "1", "NX"), ("SET", k4, "2", "NX"))
        assert reply[1] == "OK" and reply[2] is None and reply[0] >= usage(k4)
        k5 = base + ":board"
        reply = run(("ZADD", k5, "NX", 1, "member-one"), ("ZINCRBY", k5, 1, "member-two"))
        assert reply[0] >= usage(k5)
        assert run(("ZINCRBY", k5, 1, "member-two"))[0] == 0
        print("PASS: sets, marks and boards are charged what they add")

        # Many fields in one hash: the charges together never fall below what
        # the hash keeps, through the change of encoding Redis makes on the way.
        k6 = base + ":bond"
        total = 0
        for i in range(600):
            total += run(("HSETNX", k6, uuid.uuid4().hex, "0123456789ab"))[0]
            assert total >= usage(k6), (i, total, usage(k6))
        print("PASS: six hundred fields charged at least what the hash keeps, at every step")

        # The shapes an order's records take, each grown past the size Redis
        # changes its encoding at: long values in a hash, a set and a board of
        # hundreds, and many small keys with an expiry, each a buyer's.
        shapes = {
            "hash-long": lambda i: ("HSETNX", base + ":contacts", "buyer%d@example.com" % i, '{"agreed":true,"titles":["%s"],"ids":["p%d"]}' % ("A long product title " * 4, i)),
            "set": lambda i: ("SADD", base + ":members", uuid.uuid4().hex),
            "zset": lambda i: ("ZINCRBY", base + ":points", 1, uuid.uuid4().hex[:12]),
        }
        for name, make in shapes.items():
            total = 0
            key = None
            for i in range(400):
                command = make(i)
                key = command[1]
                total += run(command)[0]
                assert total >= usage(key), (name, i, total, usage(key))
        small = []
        total = 0
        for i in range(300):
            key = base + ":mark:" + uuid.uuid4().hex
            small.append(key)
            total += run(("SET", key, "1", "NX", "EX", 3600))[0]
            total += run(("EXPIRE", key, 7200))[0]
            assert total >= usage(*small), (i, total, usage(*small))
        print("PASS: hashes of long values, sets and boards of hundreds, and hundreds of expiring keys: charged at least what Redis keeps, at every step")

        for size in (65, 300, 1025, 1500, 2049, 5000, 20_001):
            k7 = base + ":large:" + str(size)
            reply = run(("HSET", k7, "f", "x" * size), ("SET", k7 + ":s", "y" * size))
            assert reply[0] >= usage(k7, k7 + ":s"), (size, reply[0], usage(k7, k7 + ":s"))
        print("PASS: values of every size class are charged at least what Redis allocates for them")

        assert run(("GET", k1)) == [-1]
        assert run(("HSET", k4, "f", "v"))[1].startswith("\x00order-write-error:")
        print("PASS: a command outside the list is refused, and one Redis refuses is answered as such")

        def run_if_new(*commands):
            keys = [room]
            argv = [len(commands)]
            for command in commands:
                name, key, *args = command
                if key not in keys:
                    keys.append(key)
                made.add(key)
                argv += [name, keys.index(key) + 1, len(args), *args]
            return redis.command("EVAL", if_new, len(keys), *keys, *argv)

        sale, info, waiting, wrong = (base + ":keys:" + part for part in ("sale", "info", "waiting", "wrong"))
        made.update((waiting, wrong))
        redis.command("HSET", waiting, "cs_1", "{}")
        first = run_if_new(("HSETNX", sale, "cs_1", "KEY-A"), ("HSET", info, "KEY-A", '{"r":"cs_1"}'), ("HDEL", waiting, "cs_1"))
        assert first[1:] == [1, 1, 1] and first[0] >= usage(sale, info), (first, usage(sale, info))
        before = held()
        assert run_if_new(("HSETNX", sale, "cs_1", "KEY-B"), ("HSET", info, "KEY-B", "x"), ("HDEL", waiting, "cs_1")) == [-2]
        assert redis.command("HGET", sale, "cs_1") == "KEY-A" and redis.command("HEXISTS", info, "KEY-B") == 0 and held() == before
        redis.command("SET", wrong, "x")
        assert run_if_new(("HSETNX", sale, "cs_2", "KEY-C"), ("HSET", wrong, "KEY-C", "x")) == [-1]
        assert run_if_new(("HSET", sale, "cs_2", "KEY-C")) == [-1]
        assert run_if_new(("HSETNX", sale, "cs_2", "KEY-C"), ("SADD", info, "m")) == [-1]
        assert run_if_new(("HSETNX", sale, "cs_2", "KEY-C"), ("HSET", info, "a", "b", "c")) == [-1]
        assert redis.command("HEXISTS", sale, "cs_2") == 0 and redis.command("HEXISTS", info, "KEY-C") == 0 and held() == before
        print("PASS: written if new: every command with the first HSETNX, or, when its field is there or the call is not one it takes, nothing")

        o, whole = held()
        assert o > 0 and whole == o + 64
        print("PASS: the room's slot and its total moved together")
    finally:
        for key in made | {room}:
            redis.command("DEL", key)
        redis.close()


if __name__ == "__main__":
    main()
