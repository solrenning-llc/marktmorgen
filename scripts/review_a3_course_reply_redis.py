"""Confirm the exact application Lua reply on explicitly disposable Redis."""
import json
import os
from pathlib import Path
import re
import uuid
from test_order_confirmation_outbox_redis import LocalRedis

if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
    raise RuntimeError("Disposable loopback Redis opt-in required")
source = (Path(__file__).resolve().parents[1] / "lib/course.ts").read_text()
found = re.search(r"export const READ_COURSE_WITHIN = `([^`]+)`;", source)
assert found and "${" not in found[1]
client = LocalRedis()
key = "review-a3-course:" + uuid.uuid4().hex
try:
    missing = client.command("EVAL", found[1], 1, key, 1000000)
    assert missing == [1, None], missing
    client.command("SET", key, "synthetic")
    present = client.command("EVAL", found[1], 1, key, 1000000)
    assert present == [1, "synthetic"], present
    oversized = client.command("EVAL", found[1], 1, key, 1)
    assert oversized == [0], oversized
    print(json.dumps({"missing": missing, "present": present, "oversized": oversized, "supplier": False}))
finally:
    client.command("DEL", key)
    client.sock.close()
