"""Execute the actual conversion Lua script against an isolated local CI Redis.
No application credentials or production host configuration are read.
"""
import concurrent.futures
import os
from pathlib import Path
import re
import socket
import uuid


class Redis:
    def __init__(self):
        self.sock = socket.create_connection(("127.0.0.1", 16379), timeout=10)
        self.stream = self.sock.makefile("rb")

    def close(self):
        self.stream.close()
        self.sock.close()

    def command(self, *parts):
        encoded = [str(part).encode() for part in parts]
        payload = b"*" + str(len(encoded)).encode() + b"\r\n"
        for part in encoded:
            payload += b"$" + str(len(part)).encode() + b"\r\n" + part + b"\r\n"
        self.sock.sendall(payload)
        return self.read()

    def read(self):
        line = self.stream.readline()
        if not line.endswith(b"\r\n"):
            raise RuntimeError("Incomplete Redis reply")
        kind, value = line[:1], line[1:-2]
        if kind == b"+":
            return value.decode()
        if kind == b"-":
            raise RuntimeError(value.decode())
        if kind == b":":
            return int(value)
        if kind == b"$":
            length = int(value)
            if length == -1:
                return None
            raw = self.stream.read(length + 2)
            if len(raw) != length + 2 or not raw.endswith(b"\r\n"):
                raise RuntimeError("Incomplete Redis bulk reply")
            return raw[:-2].decode()
        if kind == b"*":
            return [self.read() for _ in range(int(value))]
        raise RuntimeError("Unsupported Redis reply")


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against the dedicated CI Redis on loopback port 16379")
    root = Path(__file__).resolve().parents[1]
    source = (root / "lib/form-opportunity.ts").read_text(encoding="utf-8")
    match = re.search(r"export const CREATE_FORM_OPPORTUNITY = `([^`]+)`;", source)
    if not match or "${" in match.group(1):
        raise RuntimeError("Expected one static application Lua script")
    script = match.group(1)
    crm_source = (root / "lib/crm.ts").read_text(encoding="utf-8")
    crm_match = re.search(r"export const SAVE_CRM_DEAL = `([^`]+)`;", crm_source)
    if not crm_match or "${" in crm_match.group(1):
        raise RuntimeError("Expected one static CRM save script")
    save_script = crm_match.group(1)
    move_match = re.search(r"export const MOVE_CRM_DEAL = `([^`]+)`;", crm_source)
    if not move_match or "${" in move_match.group(1):
        raise RuntimeError("Expected one static CRM migration script")
    move_script = move_match.group(1)
    form_source = (root / "lib/form-store.ts").read_text(encoding="utf-8")
    form_match = re.search(r"export const SAVE_FORM = `([^`]+)`;", form_source)
    if not form_match or "${" in form_match.group(1):
        raise RuntimeError("Expected one static form save script")
    form_script = form_match.group(1)
    form_rules = (root / "lib/forms.ts").read_text(encoding="utf-8")
    form_cap = int(re.search(r"export const MAX_FORMS = ([\d_]+);", form_rules).group(1).replace("_", ""))
    rules = (root / "lib/crm-rules.ts").read_text(encoding="utf-8")
    cap = int(re.search(r"export const MAX_DEALS = ([\d_]+);", rules).group(1).replace("_", ""))
    prefix = "marktmorgen:integration:form-opportunity:" + uuid.uuid4().hex + ":"
    keys = [prefix + suffix for suffix in ("race", "capacity", "wrongtype", "mixed", "migration", "forms")]
    redis = Redis()
    try:
        assert redis.command("PING") == "PONG"
        def convert(index):
            client = Redis()
            try:
                return client.command("EVAL", script, 1, keys[0], "response01", "review-" + str(index), cap)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            replies = list(pool.map(convert, range(64)))
        created = [reply for reply in replies if reply[0] == 1]
        assert len(created) == 1, replies
        assert all(reply[0] in (0, 1) and reply[1] == created[0][1] for reply in replies)
        assert redis.command("HLEN", keys[0]) == 1
        print("PASS: 64 concurrent conversions create exactly one record")
        redis.command("HSET", keys[0], "response01", "later-edited-record")
        assert redis.command("EVAL", script, 1, keys[0], "response01", "stale-review", cap) == [0, "later-edited-record"]
        print("PASS: replay preserves later edits")
        # Ignore the first committed result, as when an HTTP reply is lost.
        redis.command("EVAL", script, 1, keys[0], "response02", "committed-record", cap)
        assert redis.command("EVAL", script, 1, keys[0], "response02", "retry", cap) == [0, "committed-record"]
        assert redis.command("HLEN", keys[0]) == 2
        print("PASS: retry after a committed request returns its original record")
        fields = []
        for index in range(cap):
            fields.extend(["entry-" + str(index), "existing"])
        assert redis.command("HSET", keys[1], *fields) == cap
        assert redis.command("EVAL", script, 1, keys[1], "new-record", "not-saved", cap) == [-1, ""]
        assert redis.command("EVAL", script, 1, keys[1], "entry-0", "not-saved", cap) == [0, "existing"]
        assert redis.command("HLEN", keys[1]) == cap
        print("PASS: application capacity blocks new records and allows replay")
        redis.command("SET", keys[2], "wrong-type")
        try:
            redis.command("EVAL", script, 1, keys[2], "new-record", "not-saved", cap)
        except RuntimeError as error:
            assert "WRONGTYPE" in str(error)
        else:
            raise AssertionError("Wrong-type storage must refuse the script")
        assert redis.command("GET", keys[2]) == "wrong-type"
        print("PASS: wrong-type storage is preserved and refuses conversion")
        try:
            redis.command("EVAL", save_script, 1, keys[2], "manual", "not-saved", cap)
        except RuntimeError as error:
            assert "WRONGTYPE" in str(error)
        else:
            raise AssertionError("Wrong-type storage must refuse manual saves")
        assert redis.command("GET", keys[2]) == "wrong-type"
        print("PASS: wrong-type storage refuses manual saves without replacement")
        near_capacity = []
        for index in range(cap - 1):
            near_capacity.extend(["entry-" + str(index), "existing"])
        redis.command("HSET", keys[3], *near_capacity)
        def mixed_save(index):
            client = Redis()
            try:
                if index % 2 == 0:
                    # crm-deal-save:v5 answers {1} for a new deal, 0 when the list is full.
                    saved = client.command("EVAL", save_script, 1, keys[3], "manual-" + str(index), "manual", cap)
                    return 1 if saved == [1] else 0
                reply = client.command("EVAL", script, 1, keys[3], "form-" + str(index), "form", cap)
                return 1 if reply[0] == 1 else 0
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            mixed = list(pool.map(mixed_save, range(64)))
        assert sum(mixed) == 1, mixed
        assert redis.command("HLEN", keys[3]) == cap
        # An update answers {1, the length of the record it replaced} ("existing").
        assert redis.command("EVAL", save_script, 1, keys[3], "entry-0", "updated", cap) == [1, len("existing")]
        assert redis.command("HGET", keys[3], "entry-0") == "updated"
        assert redis.command("HLEN", keys[3]) == cap
        print("PASS: 64 mixed manual/form creations share the last slot and allow updates")
        redis.command("HDEL", keys[3], "entry-0")
        assert redis.command("EVAL", save_script, 1, keys[3], "replacement", "new", cap) == [1]
        assert redis.command("HLEN", keys[3]) == cap
        print("PASS: deletion frees exactly one reusable slot")
        assert redis.command("EVAL", move_script, 1, keys[4], "deleted", "old", "moved") == 0
        assert redis.command("HLEN", keys[4]) == 0
        print("PASS: stage migration cannot resurrect deleted records")
        redis.command("HSET", keys[4], "edited", "concurrent-edit")
        # A refusal answers -1 and the size of the record kept (crm-deal-move:v2).
        assert redis.command("EVAL", move_script, 1, keys[4], "edited", "stale-snapshot", "stale-moved") == [-1, len("concurrent-edit")]
        assert redis.command("HGET", keys[4], "edited") == "concurrent-edit"
        assert redis.command("EVAL", move_script, 1, keys[4], "edited", "concurrent-edit", "latest-moved") == 1
        assert redis.command("HGET", keys[4], "edited") == "latest-moved"
        assert redis.command("HLEN", keys[4]) == 1
        print("PASS: stale stage migration preserves edits and a fresh retry moves them")
        near_form_cap = []
        for index in range(form_cap - 1):
            near_form_cap.extend(["existing-" + str(index), "existing"])
        redis.command("HSET", keys[5], *near_form_cap)
        def save_form(index):
            client = Redis()
            try:
                return client.command("EVAL", form_script, 1, keys[5], "form-" + str(index), "draft", form_cap)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            form_replies = list(pool.map(save_form, range(64)))
        assert sum(form_replies) == 1
        assert redis.command("HLEN", keys[5]) == form_cap
        assert redis.command("EVAL", form_script, 1, keys[5], "existing-0", "edited", form_cap) == 1
        assert redis.command("HLEN", keys[5]) == form_cap
        assert redis.command("HGET", keys[5], "existing-0") == "edited"
        print("PASS: concurrent form saves share the final slot and permit edits at capacity")
    finally:
        assert all(key.startswith(prefix) for key in keys)
        redis.command("DEL", *keys)
        redis.close()


if __name__ == "__main__":
    main()
