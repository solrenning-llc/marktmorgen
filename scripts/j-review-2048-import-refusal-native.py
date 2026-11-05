"""Confirm the exact unchanged import-Lua refusal used by the separate JS room-race proof."""
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time


def receive(stream):
    kind = stream.read(1)
    line = stream.readline().removesuffix(b"\r\n")
    if kind == b"+":
        return line.decode()
    if kind == b"-":
        raise RuntimeError(line.decode())
    if kind == b":":
        return int(line)
    if kind == b"$":
        size = int(line)
        if size == -1:
            return None
        value = stream.read(size)
        assert stream.read(2) == b"\r\n"
        return value.decode()
    if kind == b"*":
        return [receive(stream) for _ in range(int(line))]
    raise RuntimeError("Unexpected native Redis reply")


def main():
    binary = Path(sys.argv[1])
    source = Path("lib/crm.ts").read_text()
    script = re.search(r"export const IMPORT_CRM_DEALS = `([^`]+)`;", source).group(1)
    with socket.socket() as allocation:
        allocation.bind(("127.0.0.1", 0))
        port = allocation.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="j-crm-import-native-") as directory:
        with open(Path(directory) / "redis.log", "w") as output:
            process = subprocess.Popen([str(binary), "--bind", "127.0.0.1", "--port", str(port),
                                        "--save", "", "--appendonly", "no", "--dir", directory], stdout=output, stderr=output)
            try:
                connection = None
                for _ in range(40):
                    try:
                        connection = socket.create_connection(("127.0.0.1", port), timeout=1)
                        break
                    except ConnectionRefusedError:
                        if process.poll() is not None:
                            raise RuntimeError("Native Redis exited before the assertions")
                        time.sleep(0.05)
                if connection is None:
                    raise RuntimeError("Native Redis was unavailable before the assertions")
                with connection, connection.makefile("rb") as stream:
                    def command(*args):
                        encoded = [str(arg).encode() for arg in args]
                        wire = b"*" + str(len(encoded)).encode() + b"\r\n"
                        wire += b"".join(b"$" + str(len(arg)).encode() + b"\r\n" + arg + b"\r\n" for arg in encoded)
                        connection.sendall(wire)
                        return receive(stream)
                    keys = ["j:deals", "j:pipes", "j:stages", "j:lock"]
                    record = json.dumps({"id": "jimport001", "title": "Synthetic", "email": "", "stage": "lead00"})
                    command("SET", keys[1], "[]")
                    command("SET", keys[3], "expired", "PX", 1)
                    deadline = time.monotonic() + 2
                    while command("GET", keys[3]) is not None and time.monotonic() < deadline:
                        time.sleep(0.005)
                    assert command("GET", keys[3]) is None
                    refused = command("EVAL", script, 4, *keys, "[]", "", "", 2000, "expired", "jimport001", record)
                    assert refused == [-4, "[]"], refused
                    assert command("HEXISTS", keys[0], "jimport001") == 0
                    assert command("GET", keys[1]) == "[]"
                    command("SET", keys[3], "fresh")
                    accepted = command("EVAL", script, 4, *keys, "[]", "", "", 2000, "fresh", "jimport001", record)
                    assert accepted == [1], accepted
                    assert command("HGET", keys[0], "jimport001") == record
                    print(json.dumps({"native_checks": 6, "refused": refused, "accepted": accepted,
                                      "scope": "exact import Lua only; JS room race is a separate proof"}))
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


if __name__ == "__main__":
    main()
