"""Independent observer controls; starts and stops its own loopback Redis."""
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import uuid
from test_order_confirmation_checkpoint_redis import LocalRedis, measure_commands


def main():
    binary = Path(os.environ["CODEX_G_REDIS_SERVER"])
    if not binary.is_file():
        raise RuntimeError("An explicit local test Redis binary is required")
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="g2338-observer-") as directory:
        with open(Path(directory) / "redis.log", "w") as log:
            server = subprocess.Popen([str(binary), "--bind", "127.0.0.1", "--port", str(port),
                                       "--save", "", "--appendonly", "no", "--dir", directory],
                                      stdout=log, stderr=subprocess.STDOUT)
            client = None
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError("Own test Redis stopped before ready")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=.1):
                            break
                    except OSError:
                        time.sleep(.01)
                else:
                    raise RuntimeError("Own Redis did not become ready")
                os.environ["MARKTMORGEN_CONFIRMATION_REDIS_PORT"] = str(port)
                client = LocalRedis()
                key = "g:observer:" + uuid.uuid4().hex
                cases = [
                    ("Lua PING remains billed", "return redis.call('PING')", 0, [], "PONG", 2),
                    ("Lua INFO remains billed", "return #redis.call('INFO','server')>0 and 1 or 0", 0, [], 1, 2),
                    ("Lua INFO and PING both remain billed", "redis.call('INFO','server');return redis.call('PING')", 0, [], "PONG", 3),
                    ("all three data operations remain billed", "redis.call('HSET',KEYS[1],'n',1);redis.call('HINCRBY',KEYS[1],'n',1);return redis.call('HGET',KEYS[1],'n')", 1, [key], "2", 4),
                ]
                for name, lua, n, keys, expected, count in cases:
                    got = measure_commands(client, lambda: client.command("EVAL", lua, n, *keys))
                    assert got == (expected, count), (name, got)
                    print("PASS", name, got)

                def broken():
                    raise RuntimeError("own callback failed before queued command")

                try:
                    measure_commands(client, broken)
                    raise AssertionError("A failed callback was accepted")
                except RuntimeError as error:
                    assert "own callback" in str(error)
                assert client.command("PING") == "PONG"
                print("PASS failed callback discards transaction and leaves connection usable")

                def wrong_ack():
                    assert client.command("EVAL", "return 1", 0) == "QUEUED"
                    return "not queued"

                try:
                    measure_commands(client, wrong_ack)
                    raise RuntimeError("Wrong queue ACK was accepted")
                except AssertionError:
                    pass
                assert client.command("PING") == "PONG"
                print("PASS wrong queue ACK refuses and discards transaction")

                def two_commands():
                    assert client.command("EVAL", "return 1", 0) == "QUEUED"
                    return client.command("EVAL", "return 2", 0)

                try:
                    measure_commands(client, two_commands)
                    raise RuntimeError("Two application commands were accepted as one")
                except AssertionError:
                    pass
                assert client.command("PING") == "PONG"
                client.command("DEL", key)
                print("PASS two application commands refuse cardinality instead of certifying budget")
                print("7 independent native observer controls passed")
            finally:
                if client is not None:
                    client.close()
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
                print("OWN_REDIS_STOPPED", server.returncode)


if __name__ == "__main__":
    main()
