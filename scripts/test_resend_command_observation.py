"""Run the real disposable-Redis fallback suite with causal observer noise.

All original suite arguments, including the reviewed local Redis binary and
unoccupied loopback port, pass through. No provider credentials or calls.
"""
import sys
from test_contract_funding_redis import measured_command


def check_observer(client, port):
    """Linked native controls: external work excluded, Lua work retained."""
    noise = type(client)(port)
    try:
        def external_ping():
            assert noise.command("PING") == "PONG"
            return client.command("EVAL", "return 1", 0)
        result, counts = measured_command(client, external_ping)
        assert result == 1 and counts == {"eval": 1}, counts
        for script, expected in [
            ("return redis.call('PING')", {"eval": 1, "ping": 1}),
            ("return redis.call('DBSIZE')", {"eval": 1, "dbsize": 1}),
            ("return redis.call('INFO','commandstats')", {"eval": 1, "info": 1}),
        ]:
            _, counts = measured_command(client, lambda: client.command("EVAL", script, 0))
            assert counts == expected, counts
        print("PASS: external PING excluded; EVAL and internal PING/DBSIZE/INFO retained")
    finally:
        noise.close()


def main():
    import test_resend_fallback_budget_redis as suite
    mode = "--without-observer-noise"
    noisy = mode not in sys.argv
    if not noisy:
        sys.argv.remove(mode)
    original = suite.Redis
    boundaries = []

    class BoundaryNoiseRedis(original):
        def __init__(self, port):
            super().__init__(port)
            self.proof_port = port

        def command(self, *parts):
            reply = super().command(*parts)
            if noisy and parts == ("INFO", "commandstats"):
                # A distinct connection acts only at the observation boundary.
                # Under MULTI, these PINGs precede EXEC and both snapshots;
                # under the old open window, the first PING enters the delta.
                noise = original(self.proof_port)
                try:
                    assert noise.command("PING") == "PONG"
                    boundaries.append(1)
                finally:
                    noise.close()
            return reply

    try:
        suite.Redis = BoundaryNoiseRedis
        suite.main()
        if noisy:
            assert boundaries, "The real suite must exercise the observer"
        print("PASS: real fallback suite, external PING boundaries=" + str(len(boundaries)))
    finally:
        suite.Redis = original


if __name__ == "__main__":
    main()
