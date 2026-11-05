"""Exact history/list CAS scripts on disposable local Redis, with no external configuration."""
import re
import socket
import subprocess
import time
from pathlib import Path
from test_crm_pipelines_redis import Redis
root = Path(__file__).resolve().parents[1]
def script(path, name):
    found = re.search(r"export const " + name + r" = `([^`]+)`;", (root / path).read_text())
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
    write = script("lib/flows.ts", "WRITE_FLOWS_IF")
    assert call("EVAL", write, 1, "flows", "0", "", "first") == 1
    assert call("EVAL", write, 1, "flows", "0", "", "stale") == 0
    assert call("EVAL", write, 1, "flows", "1", "first", "paused") == 1
    assert call("EVAL", write, 1, "flows", "1", "first", "reactivated") == 0
    assert call("GET", "flows") == "paused"
    keep = script("lib/flow-versions.ts", "KEEP_FLOW_VERSION")
    assert call("EVAL", keep, 1, "history", 0, "", "A", 10) == 1
    assert call("EVAL", keep, 1, "history", 0, "", "old", 10) == 0
    assert call("EVAL", keep, 1, "history", 1, "A", "B", 10) == 1
    assert call("EVAL", keep, 1, "history", 2, "A", "wrong-head", 10) == 0
    assert call("LRANGE", "history", 0, -1) == ["B", "A"]
    # A recount can read this list, then another confirmed push occurs before the caller changes its room.
    snapshot = call("LRANGE", "history", 0, -1)
    assert call("EVAL", keep, 1, "history", 2, "B", "C" * 800, 10) == 1
    assert len(snapshot) == 2 and call("LLEN", "history") == 3
    print("PASS: exact WRITE_FLOWS_IF and KEEP_FLOW_VERSION reject stale text/head/length; confirmed pause survives; a separate recount snapshot is stale after a third confirmed push. Storage rollback is exercised separately through the real TypeScript helper.")
finally:
    if client is not None:
        client.close()
    server.terminate()
    server.wait(timeout=5)
