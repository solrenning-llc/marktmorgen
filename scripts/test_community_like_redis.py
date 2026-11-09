"""Exercise the application's composed community like script (TOGGLE_LIKE) against disposable CI Redis only.

Synthetic keys under marktmorgen:integration:; no application credentials or production host are read.
"""
import argparse
import concurrent.futures
import os
from pathlib import Path
import re
import socket
import uuid
from test_form_opportunity_redis import Redis


class PortRedis(Redis):
    """The shared minimal client, on a chosen loopback port (16379 is the CI service)."""

    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.stream = self.sock.makefile("rb")


def constants(root):
    """TOGGLE_LIKE with ${TAKE_DATA} expanded, and the byte figures the application sends with it."""
    community = (root / "lib/community.ts").read_text(encoding="utf-8")
    store_data = (root / "lib/store-data.ts").read_text(encoding="utf-8")
    trace = (root / "lib/community-trace.ts").read_text(encoding="utf-8")
    toggle = re.search(r"export const TOGGLE_LIKE = `([\s\S]*?)`;", community)
    take = re.search(r"export const TAKE_DATA = `([\s\S]*?)`;", store_data)
    entry = re.search(r"export const SET_ENTRY_BYTES = (\d+);", community)
    traced = re.search(r'export const TRACE_ENTRY = \{ slot: "([^"]+)", bytes: (\d+) \} as const;', trace)
    if not (toggle and take and entry and traced) or "${" in take.group(1):
        raise RuntimeError("Expected the application's like and data-room scripts")
    names = set(re.findall(r"\$\{([A-Za-z_]+)\}", toggle.group(1)))
    if names != {"TAKE_DATA"}:
        raise RuntimeError("Unexpected interpolation in TOGGLE_LIKE: " + ",".join(sorted(names)))
    script = toggle.group(1).replace("${TAKE_DATA}", take.group(1))
    if "${" in script:
        raise RuntimeError("Unresolved application script")
    return script, int(entry.group(1)), traced.group(1), int(traced.group(2))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=16379)
    args = parser.parse_args()
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Use dedicated disposable loopback CI Redis only")
    script, like_bytes, trace_slot, trace_bytes = constants(Path(__file__).resolve().parents[1])
    redis = PortRedis(args.port)
    suffix = uuid.uuid4().hex
    room = "marktmorgen:integration:like-room:" + suffix
    likes = "marktmorgen:integration:like-set:" + suffix
    trace = "marktmorgen:integration:like-trace:" + suffix
    post_slot = "cm:p:" + suffix[:12]
    ref = "l:" + suffix[:12]
    member = "ada-" + suffix
    month = "2026-11"
    field = 64  # The room's own field for a slot, counted while it is there (TAKE_DATA).
    new_like = like_bytes + field + trace_bytes + field

    def press(limit=100000, client=None, keys=None, argv=None):
        keys = keys or [room, likes, trace]
        argv = argv or [limit, month, member, ref, post_slot, trace_slot, like_bytes, trace_bytes]
        return (client or redis).command("EVAL", script, len(keys), *keys, *argv)

    def reset():
        redis.command("DEL", room, likes, trace)

    def state():
        """Every key's type and whole content, read in a way that works for any type."""
        out = []
        for key in [room, likes, trace]:
            kind = redis.command("TYPE", key)
            if kind == "hash":
                pairs = redis.command("HGETALL", key)
                content = sorted(zip(pairs[::2], pairs[1::2]))
            elif kind == "set":
                content = sorted(redis.command("SMEMBERS", key))
            elif kind == "string":
                content = redis.command("GET", key)
            else:
                content = None
            out.append((kind, content))
        return out

    def room_of(name):
        value = redis.command("HGET", room, name)
        return None if value is None else int(value)

    def stored():
        """What the room should count for what is stored now."""
        total = 0
        if redis.command("SISMEMBER", likes, member):
            total += like_bytes + field
        if redis.command("SISMEMBER", trace, ref):
            total += trace_bytes + field
        return total

    try:
        assert redis.command("PING") == "PONG"

        # held = 0, traced = 0: the like and its trace entry are written, both counted.
        reset()
        assert press() == [1, new_like, 1]
        assert redis.command("SISMEMBER", likes, member) == 1 and redis.command("SISMEMBER", trace, ref) == 1
        assert room_of(post_slot) == like_bytes and room_of(trace_slot) == trace_bytes and room_of("#") == new_like
        # held = 1, traced = 1: both taken out, both given back.
        assert press() == [1, 0, -1]
        assert redis.command("EXISTS", likes, trace) == 0
        assert room_of(post_slot) is None and room_of(trace_slot) is None and room_of("#") == 0
        # held = 0, traced = 1: the trace entry already there is not counted twice.
        reset()
        redis.command("SADD", trace, ref)
        redis.command("HSET", room, trace_slot, trace_bytes, "#", trace_bytes + field)
        assert press() == [1, trace_bytes + field + like_bytes + field, 1]
        assert redis.command("SISMEMBER", likes, member) == 1 and redis.command("SISMEMBER", trace, ref) == 1
        assert room_of(post_slot) == like_bytes and room_of(trace_slot) == trace_bytes
        # held = 1, traced = 0: only the like is given back; the missing trace entry is not.
        reset()
        redis.command("SADD", likes, member)
        redis.command("HSET", room, post_slot, like_bytes, trace_slot, 500, "#", like_bytes + field + 500 + field)
        assert press() == [1, 500 + field, -1]
        assert redis.command("EXISTS", likes, trace) == 0
        assert room_of(post_slot) is None and room_of(trace_slot) == 500 and room_of("#") == 500 + field
        print("PASS: held/traced, all four cases: each written or taken-out entry counted once, the point answered is +1 or -1")

        # Many presses of the same member at once: one at a time, the room always equals what is stored.
        reset()
        def race(_):
            client = PortRedis(args.port)
            try:
                return press(client=client)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            answers = list(pool.map(race, range(33)))
        assert all(answer[0] == 1 and answer[2] in (1, -1) for answer in answers)
        assert sum(answer[2] for answer in answers) == 1 == redis.command("SISMEMBER", likes, member)
        assert room_of("#") == stored() == new_like
        print("PASS: 33 simultaneous presses: the answered points sum to what the likes moved, the room equals what is stored")

        # Almost full: a new like that does not fit is refused with nothing written; one that fits exactly is taken.
        reset()
        redis.command("HSET", room, "#", 1000 - new_like + 1)
        before = state()
        assert press(limit=1000) == [0, 1000 - new_like + 1, 0]
        assert state() == before
        redis.command("HSET", room, "#", 1000 - new_like)
        assert press(limit=1000) == [1, 1000, 1]
        # Over the limit, taking one back always works and gives its room back.
        redis.command("HSET", room, "#", 5000)
        assert press(limit=1000) == [1, 5000 - new_like, -1]
        assert redis.command("EXISTS", likes, trace) == 0
        print("PASS: almost full: a like past the room is refused with nothing written, one taken back always goes")

        # A past month's slot is dropped first (its bytes and its field), then the like is counted.
        reset()
        redis.command("HSET", room, "~", "2026-09", "~2026-09", 1000, "#", 1000 + field)
        assert press(limit=400) == [1, new_like, 1]
        assert room_of("~2026-09") is None and redis.command("HGET", room, "~") is None
        # Still refused when it does not fit after the drop, and the drop is kept.
        reset()
        redis.command("HSET", room, "~", "2026-09,2026-11", "~2026-09", 1000, "~2026-11", 10, "#", 1000 + field + 10 + field + 700)
        assert press(limit=1000) == [0, 10 + field + 700, 0]
        assert room_of("~2026-09") is None and redis.command("HGET", room, "~") == "2026-11"
        assert room_of("#") == 10 + field + 700 and redis.command("EXISTS", likes, trace) == 0
        print("PASS: a past month is dropped before the like is measured, also when the like is then refused")

        # Invalid arguments and an unreadable room: {-1, ...} with nothing written.
        reset()
        redis.command("HSET", room, post_slot, 7, "#", 7 + field)
        redis.command("SADD", trace, "other")
        before = state()
        good = [100000, month, member, ref, post_slot, trace_slot, like_bytes, trace_bytes]
        def with_arg(index, value):
            argv = list(good)
            argv[index] = value
            return argv
        bad = [
            ("two keys", [room, likes], good),
            ("seven arguments", None, good[:7]),
            ("nine arguments", None, good + ["x"]),
            ("a like of 0 bytes", None, with_arg(6, "0")),
            ("a like of 096 bytes", None, with_arg(6, "096")),
            ("a like of 1e3 bytes", None, with_arg(6, "1e3")),
            ("a like of 1,000,000,000 bytes", None, with_arg(6, "1000000000")),
            ("a trace entry of -96 bytes", None, with_arg(7, "-96")),
            ("a trace entry of 9.6 bytes", None, with_arg(7, "9.6")),
            ("an unreadable limit", None, with_arg(0, "abc")),
            ("an empty limit", None, with_arg(0, "")),
            ("a negative limit", None, with_arg(0, "-1")),
            ("a malformed month", None, with_arg(1, "2026-1")),
            ("the room's total as a slot", None, with_arg(4, "#")),
            ("an empty slot", None, with_arg(5, "")),
        ]
        for name, keys, argv in bad:
            answer = press(keys=keys, argv=argv)
            assert answer[0] == -1 and answer[2] == 0, (name, answer)
            assert state() == before, name
        redis.command("HSET", room, "#", "unknown")
        before = state()
        assert press() == [-1, 0, 0]
        assert state() == before
        print("PASS: " + str(len(bad)) + " kinds of invalid arguments and an unreadable room answer -1 with nothing written")

        # A key of another type fails before anything is written.
        for wrong in [likes, trace, room]:
            reset()
            redis.command("SET", wrong, "wrong-type")
            before = state()
            try:
                press()
            except RuntimeError as error:
                assert "WRONGTYPE" in str(error), str(error)
            else:
                raise AssertionError("A key of another type was accepted")
            assert state() == before
        print("PASS: WRONGTYPE on the likes, the trace or the room fails with nothing written")
    finally:
        reset()
        redis.close()


if __name__ == "__main__":
    main()
