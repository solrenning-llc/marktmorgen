"""Exercise the production atomic settlement Lua on disposable loopback Redis.
No deployment credentials, payment API, sender, or recipient is involved.
"""
import concurrent.futures
import os
from pathlib import Path
import re
import socket
import time
import uuid
from test_form_opportunity_redis import Redis


class LocalRedis(Redis):
    def __init__(self):
        port = int(os.environ.get("MARKTMORGEN_CONFIRMATION_REDIS_PORT", "16379"))
        if not 1024 <= port <= 65535:
            raise RuntimeError("Dedicated disposable loopback port required")
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.stream = self.sock.makefile("rb")


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against disposable CI Redis on loopback")
    root = Path(__file__).resolve().parents[1]
    source = (root / "lib/orders.ts").read_text(encoding="utf-8")
    match = re.search(r"export const COMMIT_ORDER_CONFIRMATION = `([^`]+)`;", source)
    assert match and "${" not in match[1]
    script = match[1]
    redis = LocalRedis()
    prefix = "marktmorgen:integration:order-confirmation:" + uuid.uuid4().hex + ":"
    keys = [prefix + name for name in ("seen", "count-original", "open", "bytes", "folders-original", "owner")]
    now = int(time.time() * 1000)
    hour = now // 3_600_000
    receipt = "oc1:" + "a" * 64
    until = now + 400 * 86_400_000

    def commit(client=redis, mark=receipt, at=now, original_hour=str(hour), counted=1, expiry=until, code=script):
        return client.command("EVAL", code, 6, *keys, mark, original_hour, 8960,
                              counted, "a" * 32, "synthetic@example.test", expiry, at, 34_560_000)

    def setup(orders=2):
        redis.command("DEL", *keys)
        redis.command("HSET", keys[2], str(hour), orders)
        redis.command("HSET", keys[3], str(hour), orders * 8960)

    def state():
        return [redis.command("GET", keys[1]), redis.command("HGETALL", keys[2]), redis.command("HGETALL", keys[3])]

    def command_stats():
        return {m[1]: int(m[2]) for m in re.finditer(r"cmdstat_([^:]+):calls=(\d+),", redis.command("INFO", "COMMANDSTATS")) if m[1] != "info"}

    try:
        setup()
        before = command_stats()
        assert commit() == 1
        after = command_stats()
        commands = sum(n - before.get(name, 0) for name, n in after.items())
        assert commands <= 27, commands
        assert state() == ["1", [str(hour), "1"], [str(hour), "8960"]]
        assert redis.command("PTTL", keys[0]) > 399 * 86_400_000
        marker_memory = redis.command("MEMORY", "USAGE", keys[0], "SAMPLES", 0)
        assert marker_memory <= 512, marker_memory
        snapshot = state()
        assert commit(at=now + 73 * 3_600_000) == 2
        assert state() == snapshot
        assert commit(mark="oc1:" + "b" * 64) == -1
        assert state() == snapshot
        print("PASS: lost ACK and replay beyond 72h never count twice or release another order; billed commands", commands)
        print("MEASURED: 68-byte receipt; synthetic-key MEMORY USAGE", marker_memory, "bytes; fixed 400-day receipt horizon in this fixture")

        setup()
        def attempt(_):
            client = LocalRedis()
            try:
                return commit(client)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(attempt, range(32)))
        assert outcomes.count(1) == 1 and outcomes.count(2) == 31
        assert state() == ["1", [str(hour), "1"], [str(hour), "8960"]]
        print("PASS: 32 simultaneous confirmations have one atomic settlement")

        setup()
        redis.command("DEL", keys[2], keys[3])
        redis.command("HSET", keys[2], str(hour + 73), 7)
        redis.command("HSET", keys[3], str(hour + 73), 7 * 8960)
        assert commit(at=now + 73 * 3_600_000) == 1
        assert state() == ["1", [str(hour + 73), "7"], [str(hour + 73), str(7 * 8960)]]
        print("PASS: expired original hour does not release the worker's newer hour")

        setup()
        assert commit(counted=0) == 1
        assert state() == [None, [str(hour), "1"], [str(hour), "8960"]]
        assert redis.command("GET", keys[0]) == receipt
        assert redis.command("EXISTS", keys[4], keys[5]) == 0
        print("PASS: original share-covered order settles its hold without becoming a billable order")

        setup()
        redis.command("SET", keys[0], "1")
        snapshot = state()
        assert commit() == -1 and state() == snapshot
        assert redis.command("GET", keys[0]) == "1"
        print("PASS: a legacy seen marker cannot prove whether the original hour was settled")
        for key in (keys[0], keys[5]):
            setup()
            redis.command("SET", key, "")
            snapshot = state()
            assert commit() == -1 and state() == snapshot
            assert redis.command("GET", key) == ""

        for index in range(6):
            setup()
            redis.command("DEL", keys[index])
            redis.command("RPUSH", keys[index], "wrong type")
            assert commit() == -1
            if index != 0:
                assert redis.command("EXISTS", keys[0]) == 0
            assert redis.command("LRANGE", keys[index], 0, -1) == ["wrong type"]
        for key, field in [(keys[1], None), (keys[2], str(hour)), (keys[3], str(hour))]:
            for bad in ("oops", "1.5", "-1", "01", "10000000000000"):
                setup()
                if field is None:
                    redis.command("SET", key, bad)
                else:
                    redis.command("HSET", key, field, bad)
                snapshot = state()
                assert commit() == -1 and state() == snapshot
                assert redis.command("EXISTS", keys[0]) == 0
        print("PASS: wrong types and malformed counters refuse before every mutation")

        setup()
        redis.command("HSET", keys[3], str(hour), 1)
        snapshot = state()
        assert commit() == -1 and state() == snapshot
        setup()
        snapshot = state()
        assert commit(at=until, expiry=until) == -1 and state() == snapshot
        assert redis.command("EXISTS", keys[0]) == 0
        print("PASS: insufficient held bytes and an expired receipt horizon do not release or count")

        faults = [
            ("after intent", "if n==1 then", "error('synthetic after intent'); if n==1 then"),
            ("after count", "redis.call('INCR',KEYS[2]);", "redis.call('INCR',KEYS[2]); error('synthetic after count');"),
            ("between hold releases", "if kept==bytes then", "error('synthetic between releases'); if kept==bytes then"),
            ("before final receipt", "redis.call('SET',KEYS[1],receipt,'PXAT',untilAt)", "error('synthetic before receipt'); redis.call('SET',KEYS[1],receipt,'PXAT',untilAt)"),
        ]
        for name, find, replacement in faults:
            assert script.count(find) == 1
            setup()
            try:
                commit(code=script.replace(find, replacement))
                raise AssertionError("Injected runtime error was not reached: " + name)
            except RuntimeError as error:
                assert "synthetic" in str(error), error
            assert redis.command("GET", keys[0]) == "oci:" + "a" * 64
            partial = state()
            assert commit(at=now + 73 * 3_600_000) == -1
            assert state() == partial
            assert redis.command("GET", keys[0]) == "oci:" + "a" * 64
        print("PASS: faults after intent/count/between releases/before receipt stay unknown and never replay partial effects")

        # Red control: remove just the intent from this production script.
        # A fault after the effects but before the final receipt then makes a
        # retry consume the other order's hold. The green protocol above must
        # prevent exactly this, not merely handle a lost final response.
        intent = "redis.call('SET',KEYS[1],'oci:'..string.sub(receipt,5),'PXAT',untilAt)"
        assert script.count(intent) == 1
        unsafe = script.replace(intent, "")
        finish = "redis.call('SET',KEYS[1],receipt,'PXAT',untilAt)"
        setup()
        try:
            commit(code=unsafe.replace(finish, "error('synthetic red control'); " + finish))
            raise AssertionError("Red control did not fault")
        except RuntimeError as error:
            assert "synthetic red control" in str(error)
        assert state() == ["1", [str(hour), "1"], [str(hour), "8960"]]
        assert redis.command("EXISTS", keys[0]) == 0
        assert commit(code=unsafe) == 1
        assert state() == ["2", [], []]
        print("PASS: negative control without intent reproduces double counting and release of the other order")

        server_time = redis.command("TIME")
        server_now = int(server_time[0]) * 1000 + int(server_time[1]) // 1000
        expired = server_now - 1000
        worker_now = expired - 1000
        worker_hour = worker_now // 3_600_000

        def setup_clock():
            redis.command("DEL", *keys)
            redis.command("HSET", keys[2], str(worker_hour), 2)
            redis.command("HSET", keys[3], str(worker_hour), 2 * 8960)

        for expiry in (expired, server_now):
            setup_clock()
            before = state()
            assert commit(at=worker_now, expiry=expiry, original_hour=str(worker_hour)) == -1
            assert commit(at=worker_now, expiry=expiry, original_hour=str(worker_hour)) == -1
            assert state() == before and redis.command("EXISTS", keys[0]) == 0
        print("PASS: Redis-past and exact Redis-time expiry refuse despite a lagging worker, before every mutation")

        # A healthy horizon still works when clocks differ; original hour and
        # window keys stay the same instead of being reconstructed from TIME.
        worker_now = server_now - 73 * 3_600_000
        worker_hour = worker_now // 3_600_000
        setup_clock()
        assert commit(at=worker_now, expiry=until, original_hour=str(worker_hour)) == 1
        before = state()
        assert before == ["1", [str(worker_hour), "1"], [str(worker_hour), "8960"]]
        assert commit(at=worker_now, expiry=until, original_hour=str(worker_hour)) == 2
        assert state() == before
        print("PASS: valid expiry with Redis ahead by 73h applies once and preserves the original admission hour")

        # Red control retains the durable-intent protocol but removes only its
        # server-time admission guard. Both PXAT writes disappear immediately.
        clock_guard = "if untilAt<=serverNow then return -1 end"
        assert script.count(clock_guard) == 1
        unsafe_clock = script.replace(clock_guard, "")
        setup_clock()
        assert commit(at=worker_now, expiry=expired, original_hour=str(worker_hour), code=unsafe_clock) == 1
        assert redis.command("GET", keys[0]) is None
        assert commit(at=worker_now, expiry=expired, original_hour=str(worker_hour), code=unsafe_clock) == 1
        assert state() == ["2", [], []]
        print("PASS: negative control without Redis-time guard reproduces expiry-driven duplicate settlement")
    finally:
        redis.command("DEL", *keys)
        redis.close()


if __name__ == "__main__":
    main()
