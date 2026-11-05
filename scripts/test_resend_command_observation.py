"""Run the real disposable-Redis fallback suite with causal observer noise.

Only a new proof file: the occupied application suite remains unchanged.
All original suite arguments, including the reviewed local Redis binary and
unoccupied loopback port, pass through. No provider credentials or calls.
"""
import sys
import test_resend_fallback_budget_redis as suite


def main():
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
