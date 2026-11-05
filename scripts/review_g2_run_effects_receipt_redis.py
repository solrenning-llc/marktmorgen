"""Identified G2 v4 receipt variant of the prior v3 native proof; never changes product scripts."""
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
    score = "1000.125"
    call("ZADD", "lease", score, "member")
    note = script("lib/buyer-profile.ts", "ADD_RUN_NOTE")
    assert call("EVAL", note, 3, "notes", "people", "lease", "note", "synthetic", 60, "member", "1000.25", "person") == 3
    assert call("HGET", "notes", "note") is None
    assert call("EVAL", note, 3, "notes", "people", "lease", "note", "synthetic", 60, "member", score, "person") == 1
    assert call("HGET", "notes", "note") == "synthetic"
    save = script("lib/crm.ts", "SAVE_CRM_DEAL")
    assert call("EVAL", save, 2, "deals", "lease", "deal", "before", 100, "", "member", "1000.25") == [3]
    assert call("HGET", "deals", "deal") is None
    assert call("EVAL", save, 2, "deals", "lease", "deal", "before", 100, "", "member", score) == 1
    move = script("lib/crm.ts", "MOVE_CRM_DEAL")
    assert call("EVAL", move, 2, "deals", "lease", "deal", "before", "after", "member", "1000.25") == [3, len("before")]
    assert call("HGET", "deals", "deal") == "before"
    assert call("EVAL", move, 2, "deals", "lease", "deal", "before", "after", "member", score) == 1
    assert call("EVAL", move, 1, "deals", "deal", "after", "L" * 450) == 1
    # The exact v4 receipt measures the current record within the script; it does not fence a later JS room rollback.
    assert call("EVAL", move, 2, "deals", "lease", "deal", "before", "stale", "member", "1000.25") == [3, 450]
    assert call("HGET", "deals", "deal") == "L" * 450
    print("PASS: exact ADD_RUN_NOTE, SAVE_CRM_DEAL and MOVE_CRM_DEAL reject foreign fractional scores, accept their own; optional board path remains valid; superseded v4 move keeps the larger record and returns its current length. The separate JS room rollback is tested in TypeScript.")
finally:
    if client is not None:
        client.close()
    server.terminate()
    server.wait(timeout=5)
