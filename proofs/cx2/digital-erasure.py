"""Execute the actual erasure Lua 5.1 with bounded synthetic Redis/cjson.

Usage: python proofs/cx2/digital-erasure.py PATH_TO_LOCAL_LUPA
This is a Lua proof, not a native Redis or provider integration certificate.
The same digital-phase assertion also lives in the existing native Redis suite.
"""
import hashlib
import json
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, sys.argv.pop(1))
from lupa.lua51 import LuaRuntime  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SOURCE = (ROOT / "lib/order-confirmation-outbox.ts").read_text(encoding="utf-8")
MATCH = re.search(r"export const CONFIRMATION_ERASURE_SCRIPT = `([^`]+)`;", SOURCE)
assert MATCH and "${" not in MATCH[1]
SCRIPT = MATCH[1]
TOTAL = 0


class DigitalErasure(unittest.TestCase):
    def invoke(self, phase, *, bad_fence=False, bad_json=False):
        lua = LuaRuntime(unpack_returned_tuples=True, max_memory=8 * 1024 * 1024)
        person = hashlib.sha256(b"erased@example.invalid").hexdigest()
        token = "a" * 48
        row = dict(kind="confirmation", statsId="synthetic-store", sourceValue="source",
                   phase=phase, person="", erasedPeople="", erasureSaturated=False, bytes=8192)
        original = json.dumps(row)
        data = {"row": "not-json" if bad_json else original, "source": "source",
                "fence": "b" * 48 if bad_fence else token}
        writes = []

        def table(value):
            if isinstance(value, dict):
                return lua.table_from({k: table(v) for k, v in value.items()})
            return value

        def plain(value):
            if hasattr(value, "items"):
                return {k: plain(v) for k, v in value.items()}
            return value

        def call(op, key, *args):
            global TOTAL
            if TOTAL >= 1000:
                raise RuntimeError("Synthetic command admission exhausted")
            TOTAL += 1
            if op == "TYPE":
                return lua.table_from({"ok": "string" if key in data else "none"})
            if op == "GET":
                return data.get(key)
            if op == "GETRANGE":
                return data.get(key, "")[int(args[0]):int(args[1]) + 1]
            if op == "SET":
                writes.append((key, args[0]))
                data[key] = args[0]
                return "OK"
            raise AssertionError("Unexpected Redis command: " + op)

        lua.globals().redis = lua.table_from({"call": call})
        lua.globals().cjson = lua.table_from({
            "decode": lambda value: table(json.loads(value)),
            "encode": lambda value: json.dumps(plain(value), separators=(",", ":")),
        })
        lua.globals().KEYS = lua.table_from(["row", "source", "fence"])
        lua.globals().ARGV = lua.table_from(["mark", token, person, "synthetic-store"])
        result = lua.execute(SCRIPT)
        return result[1], json.loads(data["row"]) if not bad_json else None, writes, original, person

    def test_unbound_digital_option_keeps_no_buyer_hash(self):
        reply, row, writes, original, _ = self.invoke("digital_option_reserved")
        self.assertEqual(reply, "other")
        self.assertEqual(row["erasedPeople"], "")
        self.assertEqual(writes, [])
        self.assertEqual(row, json.loads(original))

    def test_pending_binding_still_gets_its_recipient_fence(self):
        for phase in ["course_reserved", "awaiting_creation", "creating", "creation_unknown", "awaiting_payment"]:
            with self.subTest(phase=phase):
                reply, row, writes, _, person = self.invoke(phase)
                self.assertEqual(reply, "marked")
                self.assertEqual(row["erasedPeople"], person)
                self.assertEqual(len(writes), 1)

    def test_resolved_unrelated_buyer_stays_unchanged(self):
        reply, row, writes, _, _ = self.invoke("accepted")
        self.assertEqual(reply, "other")
        self.assertEqual(row["erasedPeople"], "")
        self.assertEqual(writes, [])

    def test_lost_fence_does_not_mutate(self):
        reply, _, writes, _, _ = self.invoke("digital_option_reserved", bad_fence=True)
        self.assertEqual(reply, "changed")
        self.assertEqual(writes, [])

    def test_unreadable_row_does_not_mutate(self):
        reply, _, writes, _, _ = self.invoke("digital_option_reserved", bad_json=True)
        self.assertEqual(reply, "unknown")
        self.assertEqual(writes, [])


if __name__ == "__main__":
    print("actual Lua sha256", hashlib.sha256(SCRIPT.encode()).hexdigest(), flush=True)
    result = unittest.main(exit=False)
    print("synthetic Redis admissions", TOTAL)
    sys.exit(0 if result.result.wasSuccessful() else 1)
