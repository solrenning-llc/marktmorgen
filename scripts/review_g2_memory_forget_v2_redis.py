"""Exact memory-forget v2 fence on disposable Redis; quota expiry is exercised separately through TypeScript."""
import re
import socket
import subprocess
import time
from pathlib import Path
from test_crm_pipelines_redis import Redis
root = Path(__file__).resolve().parents[1]
def script(name):
    found = re.search(r"export const " + name + r" = `([^`]+)`;", (root / "lib/assistant-memory-store.ts").read_text())
    assert found and "${" not in found.group(1)
    return found.group(1)
with socket.socket() as probe:
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
server = subprocess.Popen(["/tmp/marktmorgen-redis-7.4.12/src/redis-server", "--bind", "127.0.0.1", "--port", str(port), "--save", "", "--appendonly", "no"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
client = None
try:
    for attempt in range(100):
        try:
            sock = socket.create_connection(("127.0.0.1", port), timeout=1)
            break
        except OSError:
            time.sleep(0.01)
    else:
        raise RuntimeError("Owned Redis did not start")
    client = Redis.__new__(Redis)
    client.sock = sock
    client.stream = sock.makefile("rb")
    call = client.command
    write, forget = script("MEMORY_WRITE"), script("MEMORY_FORGET")
    call("SET", "lock", "old", "EX", 10)
    assert call("EVAL", write, 2, "lock", "notes", "old", "old record") == 1
    call("PEXPIRE", "lock", 0)
    call("SET", "lock", "new", "EX", 10)
    assert call("EVAL", write, 2, "lock", "notes", "new", "L" * 500) == 1
    assert call("EVAL", write, 2, "lock", "notes", "old", "stale record") == 0
    assert call("GET", "notes") == "L" * 500
    assert call("EVAL", forget, 2, "lock", "notes", "forget", 10) == 1
    assert call("GET", "notes") is None and call("GET", "lock") == "forget"
    assert call("SET", "lock", "fresh", "NX", "EX", 10) is None
    call("PEXPIRE", "lock", 0)
    assert call("EVAL", write, 2, "lock", "notes", "new", "resurrection") == 0
    call("SET", "lock", "fresh", "EX", 10)
    assert call("EVAL", write, 2, "lock", "notes", "fresh", "fresh record") == 1
    assert call("GET", "notes") == "fresh record"
    print("PASS: exact MEMORY_WRITE rejects expired/foreign tokens, MEMORY_FORGET v2 deletes notes and keeps its own lock; fresh lock acquisition refuses until expiry, old writer cannot restore, fresh writer can save after expiry. Post-receipt quota changes are outside these scripts and reproduced through the TypeScript helpers.")
finally:
    if client is not None:
        client.close()
    server.terminate()
    server.wait(timeout=5)
