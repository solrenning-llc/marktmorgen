"""SV4 synthetic Redis server migration and private DNS rollback rehearsal.
Only an explicitly approved standard/public GitHub CI runner's local Docker.
No provider API, real host configuration, production URL, artifact or cache.
"""
import base64
import json
import ipaddress
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import tempfile
import time
import uuid
from test_self_hosted_backup_redis import BinaryRedis, CAPTURE

IMAGE = "redis:7.4-alpine"  # Already cached by the existing CI Redis service.
LABEL = "marktmorgen.synthetic.sv4"
DOMAIN = "marktmorgen.test"


class Peer(BinaryRedis):
    def __init__(self, address, password):
        ip = ipaddress.IPv4Address(address)
        if not ip.is_private or ip.is_loopback or ip.is_unspecified:
            raise RuntimeError("Invalid owned synthetic bridge address")
        self.sock = socket.create_connection((str(ip), 6379), timeout=10)
        self.stream = self.sock.makefile("rb")
        try:
            assert self.command("AUTH", password) == "OK"
        except Exception:
            self.close()
            raise


def main():
    if (os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1"
            or os.environ.get("SV4_STANDARD_PUBLIC_CI") != "true"
            or os.environ.get("GITHUB_ACTIONS") != "true"
            # This repository by its permanent ID (kept across a move to another owner) or its original name.
            or (os.environ.get("GITHUB_REPOSITORY_ID") != "1334793724"
                and os.environ.get("GITHUB_REPOSITORY") != "viniciussucupira/marktmorgen")
            or os.environ.get("RUNNER_OS") != "Linux"):
        raise RuntimeError("Dedicated standard/public Linux CI only; no production mode")
    started = time.monotonic()
    run_id = uuid.uuid4().hex
    stem = "mm-sv4-" + run_id
    names = [stem + "-source", stem + "-target", stem + "-client"]
    networks = [stem + "-control", stem + "-route"]
    prefix = "nl:synthetic:sv4-backup:" + run_id + ":"
    keys = [prefix + item for item in ("binary", "cash", "list", "set", "zset", "expiry")]
    identity = prefix + "identity"
    operator, verifier = secrets.token_hex(32), secrets.token_hex(32)
    peers = []
    times = {}
    def timed_out(_signal, _frame):
        raise RuntimeError("Synthetic rehearsal reached its hard time ceiling")
    previous_alarm = signal.signal(signal.SIGALRM, timed_out)
    signal.alarm(120)

    with tempfile.TemporaryDirectory(prefix="mm-sv4-docker-") as empty_home:
        env = {"PATH": os.environ.get("PATH", ""), "HOME": empty_home}

        def docker(*args, data=None, allow_failure=False, cleanup=False):
            remaining = 120 - (time.monotonic() - started)
            if remaining <= 0 and not cleanup:
                raise RuntimeError("Synthetic rehearsal exceeded its 120-second rehearsal ceiling")
            try:
                result = subprocess.run(
                    ["docker", "--host", "unix:///var/run/docker.sock", *args],
                    input=data, capture_output=True, timeout=5 if cleanup else min(30, max(1, remaining)),
                    env=env)
            except subprocess.TimeoutExpired:
                # Do not print command arguments, stdin, stderr or credentials.
                raise RuntimeError("Synthetic Docker operation timed out") from None
            if result.returncode and not allow_failure:
                raise RuntimeError("Synthetic Docker operation failed; output withheld")
            return result

        def inspect(kind, name, cleanup=False):
            result = docker(*(["network", "inspect"] if kind == "network" else ["inspect"]),
                            name, allow_failure=True, cleanup=cleanup)
            if result.returncode:
                error = result.stderr.lower()
                missing = (b"no such object:" in error or b"no such container:" in error
                           or b"no such network:" in error
                           or b"error response from daemon: network " in error and b" not found" in error)
                if missing:
                    return None
                raise RuntimeError("Synthetic Docker inventory unavailable; absence is not proven")
            rows = json.loads(result.stdout)
            if not isinstance(rows, list) or len(rows) != 1:
                raise RuntimeError("Unexpected synthetic Docker inventory")
            item = rows[0]
            labels = item.get("Labels", {}) if kind == "network" else item.get("Config", {}).get("Labels", {})
            if labels.get(LABEL) != run_id:
                raise RuntimeError("Refusing to alter a resource outside this synthetic run")
            return item

        def phase(name, action):
            before = time.monotonic()
            value = action()
            times[name] = round(time.monotonic() - before, 6)
            return value

        def client(*command, allow_failure=False):
            # The credential travels through stdin into a transient process,
            # not Docker metadata, command arguments, source or CI output.
            result = docker(
                "run", "--rm", "--pull=never", "-i", "--name", names[2],
                "--label", LABEL + "=" + run_id, "--network", networks[1],
                "--read-only", "--tmpfs", "/data:rw,noexec,nosuid,size=1m",
                "--user", "redis", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--memory=64m", "--cpus=0.25", IMAGE,
                "sh", "-c",
                'IFS= read -r REDISCLI_AUTH; export REDISCLI_AUTH; exec redis-cli --raw --user verify -h marktmorgen.test "$@"',
                "verify", *command, data=(verifier + "\n").encode(),
                allow_failure=allow_failure)
            return result.returncode, result.stdout.strip()

        def boot():
            # No pull, account, registry credential or remote Docker context.
            docker("image", "inspect", IMAGE)
            for network in networks:
                docker("network", "create", "--internal", "--label", LABEL + "=" + run_id, network)
                assert inspect("network", network)["Internal"] is True
            for name, role in zip(names[:2], ("source", "target")):
                docker(
                    "run", "-d", "--pull=never", "--name", name,
                    "--label", LABEL + "=" + run_id, "--network", networks[0],
                    "--read-only",
                    "--tmpfs", "/run:rw,noexec,nosuid,size=1m,mode=1777",
                    "--tmpfs", "/data:rw,noexec,nosuid,size=32m,mode=1777",
                    "--user", "redis", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                    "--memory=128m", "--cpus=0.5", IMAGE, "sh", "-c",
                    "while [ ! -f /run/redis.conf ]; do sleep 0.05; done; exec redis-server /run/redis.conf")
                config = ("\n".join([
                    "bind 0.0.0.0", "protected-mode yes", "port 6379",
                    'save ""', "appendonly no", "maxmemory 16mb",
                    "maxmemory-policy noeviction", "requirepass " + operator,
                    "user verify on >" + verifier + " ~" + prefix + "* +get +hget +ping",
                ]) + "\n").encode()
                docker("exec", "-i", name, "sh", "-c",
                       "umask 077; cat > /run/redis.conf.tmp && mv /run/redis.conf.tmp /run/redis.conf",
                       data=config)
                item = inspect("container", name)
                if item["HostConfig"].get("PortBindings"):
                    raise RuntimeError("Synthetic Redis must not publish any host port")
                owned_network = item["NetworkSettings"]["Networks"][networks[0]]
                address = owned_network["IPAddress"]
                network = inspect("network", networks[0])
                subnet = ipaddress.IPv4Network(network["IPAM"]["Config"][0]["Subnet"])
                if ipaddress.IPv4Address(address) not in subnet:
                    raise RuntimeError("Synthetic address does not belong to its owned internal bridge")
                peer = None
                for _ in range(50):
                    try:
                        peer = Peer(address, operator)
                        break
                    except (OSError, RuntimeError):
                        time.sleep(0.1)
                if peer is None:
                    raise RuntimeError("Synthetic Redis did not start")
                peers.append(peer)
                peer.command("SET", identity, role)
            docker("network", "connect", "--alias", DOMAIN, networks[1], names[0])
            assert client("GET", identity) == (0, b"source")

        try:
            phase("boot_two_servers_and_private_dns", boot)
            source, target = peers
            binary = bytes([0, 255, 128, 13, 10]) + "ação 日本語".encode()

            def seed():
                source.command("SET", keys[0], binary)
                source.command("HSET", keys[1], "reserved", 100, "liability", "retained")
                source.command("RPUSH", keys[2], "first", "日本語", "last")
                source.command("SADD", keys[3], "one", "two")
                source.command("ZADD", keys[4], 1, "earlier", 5, "later")
                source.command("SET", keys[5], "expires", "PX", 300000)
                assert client("HGET", keys[1], "reserved") == (0, b"100")
                # The DNS consumer is deliberately read-only, on both servers.
                assert b"NOPERM" in client("INCR", prefix + "forbidden", allow_failure=True)[1]

            phase("seed_synthetic_source", seed)
            captured, raw_rows = phase("capture_real_binary_snapshot",
                                       lambda: source.command("EVAL", CAPTURE, len(keys), *keys))
            snapshot = {"version": 1, "capturedAt": captured, "rows": [
                {"key": key.decode(), "dump": base64.b64encode(dump).decode(),
                 "expiresAt": None if expiry == -1 else expiry}
                for key, dump, expiry in raw_rows]}

            def codec():
                result = subprocess.run(
                    ["node", str(Path(__file__).with_name("test_self_hosted_backup_codec.mjs"))],
                    input=json.dumps(snapshot), text=True, capture_output=True,
                    timeout=30, env={"PATH": env["PATH"], "MARKTMORGEN_REDIS_INTEGRATION": "1"})
                if result.returncode:
                    raise RuntimeError("Actual synthetic backup codec failed; output withheld")
                decoded = json.loads(result.stdout)
                assert decoded["rows"] == snapshot["rows"]
                return decoded["rows"]

            rows = phase("encrypt_authenticate_and_decode_actual_codec", codec)

            def restore(selected):
                for row in selected:
                    args = ["RESTORE", row["key"], row["expiresAt"] or 0,
                            base64.b64decode(row["dump"], validate=True)]
                    if row["expiresAt"] is not None:
                        args.append("ABSTTL")
                    assert target.command(*args) == "OK"

            def retained_source():
                assert client("GET", identity) == (0, b"source")
                _, retained = source.command("EVAL", CAPTURE, len(keys), *keys)
                assert retained == raw_rows
                assert source.command("HGET", keys[1], "reserved") == b"100"

            def refuse_existing_destination():
                # RESTORE must never replace a pre-existing destination value.
                target.command("SET", keys[0], "destination-owned-value")
                try:
                    restore(rows)
                except RuntimeError as error:
                    assert "BUSYKEY" in str(error)
                else:
                    raise AssertionError("Existing destination data must refuse restore")
                assert target.command("GET", keys[0]) == b"destination-owned-value"
                assert target.command("EXISTS", *keys[1:]) == 0
                retained_source()
                target.command("DEL", keys[0])

            phase("existing_destination_refuses_without_overwrite", refuse_existing_destination)

            def refuse_corrupt_binary():
                damaged = bytearray(base64.b64decode(rows[0]["dump"], validate=True))
                # Damage the Redis DUMP checksum, after authenticated decode.
                # This exercises RESTORE's own rejection, not a mocked parser.
                damaged[-1] ^= 1
                try:
                    target.command("RESTORE", keys[0], 0, bytes(damaged))
                except RuntimeError as error:
                    assert "checksum" in str(error).lower()
                else:
                    raise AssertionError("Corrupt Redis binary must refuse restore")
                assert target.command("EXISTS", *keys) == 0
                retained_source()

            phase("corrupt_redis_dump_refuses_before_cutover", refuse_corrupt_binary)

            def refuse_partial():
                restore(rows[:-1])
                try:
                    target.command("EVAL", CAPTURE, len(keys), *keys)
                except RuntimeError as error:
                    assert "missing synthetic key" in str(error)
                else:
                    raise AssertionError("A partial copy must never validate")
                assert client("GET", identity) == (0, b"source")
                # Only the known synthetic destination namespace is discarded.
                target.command("DEL", *keys)

            phase("partial_copy_refuses_before_cutover", refuse_partial)
            phase("restore_complete_second_server", lambda: restore(rows))

            def validate():
                _, target_rows = target.command("EVAL", CAPTURE, len(keys), *keys)
                assert target_rows == raw_rows
                assert target.command("GET", keys[0]) == binary
                assert target.command("HGET", keys[1], "reserved") == b"100"
                assert target.command("PTTL", keys[1]) == -1
                assert target.command("PEXPIRETIME", keys[5]) == snapshot["rows"][5]["expiresAt"]

            def refuse_mismatched_cash():
                target.command("HSET", keys[1], "reserved", 99)
                try:
                    validate()
                except AssertionError:
                    pass
                else:
                    raise AssertionError("A complete copy with changed cash must refuse cutover")
                assert target.command("HGET", keys[1], "reserved") == b"99"
                retained_source()
                # Repair only the owned synthetic target key from the exact
                # authenticated snapshot. Never overwrite it with REPLACE.
                target.command("DEL", keys[1])
                restore([rows[1]])

            phase("changed_destination_cash_refuses_before_cutover", refuse_mismatched_cash)
            phase("validate_types_binary_cash_and_absolute_expiry", validate)

            def cutover():
                docker("network", "disconnect", networks[1], names[0])
                docker("network", "connect", "--alias", DOMAIN, networks[1], names[1])
                assert client("GET", identity) == (0, b"target")
                assert client("HGET", keys[1], "reserved") == (0, b"100")
                assert b"NOPERM" in client("INCR", prefix + "forbidden", allow_failure=True)[1]

            phase("switch_private_test_domain_and_read_destination", cutover)

            def fail_and_back():
                docker("stop", "--time", "1", names[1])
                code, _ = client("GET", identity, allow_failure=True)
                assert code != 0
                docker("network", "disconnect", networks[1], names[1])
                docker("network", "connect", "--alias", DOMAIN, networks[1], names[0])
                assert client("GET", identity) == (0, b"source")
                assert client("HGET", keys[1], "reserved") == (0, b"100")
                _, retained = source.command("EVAL", CAPTURE, len(keys), *keys)
                assert retained == raw_rows

            phase("destination_failure_and_private_dns_rollback", fail_and_back)
            times["total_before_cleanup"] = round(time.monotonic() - started, 6)
        finally:
            signal.alarm(0)
            before = time.monotonic()
            for peer in peers:
                peer.close()
            # Remove only UUID resources whose ownership labels were verified.
            for name in reversed(names):
                if inspect("container", name, cleanup=True) is not None:
                    docker("rm", "--force", "--volumes", name, cleanup=True)
            for network in reversed(networks):
                if inspect("network", network, cleanup=True) is not None:
                    docker("network", "rm", network, cleanup=True)
            times["cleanup_owned_resources"] = round(time.monotonic() - before, 6)
            signal.signal(signal.SIGALRM, previous_alarm)
        times["total"] = round(time.monotonic() - started, 6)
        assert times["total"] <= 180, "Synthetic rehearsal and cleanup exceeded the total ceiling"
        print("SV4_REDIS_MIGRATION_TIMINGS:" + json.dumps({
            "schema": 1, "scope": "two synthetic Redis containers; read-only fresh DNS consumer",
            "seconds": times, "dataKeys": 6, "externalHosts": 0,
            "imagePulls": 0, "artifactUploads": 0, "customerWrites": 0,
            "limits": {"rehearsalSeconds": 120, "cleanupSeconds": 50, "totalSeconds": 180, "redisMemoryMbEach": 16,
                       "serverContainerMbEach": 128, "clientContainerMb": 64},
            "notProven": ["application migration", "live-write draining/replay",
                          "provider DNS/TLS", "cross-host topology", "capacity", "production costs"]
        }, sort_keys=True))
        print("PASS: actual binary copy; existing/corrupt/changed-cash refusals; private DNS cutover, target failure and source rollback")
        print("SV4 prerequisite only; EU hosting flag, providers and commercial gates unchanged")


if __name__ == "__main__":
    main()
