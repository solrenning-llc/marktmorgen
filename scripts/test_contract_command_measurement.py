"""Exercise command accounting on dedicated loopback CI Redis, never a provider.

The probe injects another client's PING at the former between-INFO boundary.
An atomic measurement must exclude that noise, retain Lua PING, and keep EVAL.
"""
import os
from test_form_opportunity_redis import Redis
from test_contract_funding_redis import measured_command


def main():
    if os.environ.get('MARKTMORGEN_REDIS_INTEGRATION') != '1':
        raise RuntimeError('Use dedicated CI Redis on loopback port 16379 only')
    client, noise = Redis(), Redis()
    try:
        def outside_ping():
            assert noise.command('PING') == 'PONG'
            return client.command('EVAL', 'return 1', 0)
        result, counts = measured_command(client, outside_ping)
        assert result == 1 and counts == {'eval': 1}, counts
        def lua_ping():
            assert noise.command('PING') == 'PONG'
            return client.command('EVAL', "return redis.call('PING')", 0)
        result, counts = measured_command(client, lua_ping)
        assert result == 'PONG' and counts == {'eval': 1, 'ping': 1}, counts
        # Unknown commands cannot silently disappear from the measured budget.
        result, counts = measured_command(client, lambda: client.command('EVAL', "return redis.call('DBSIZE')", 0))
        assert isinstance(result, int) and counts == {'eval': 1, 'dbsize': 1}, counts
        result, counts = measured_command(client, lambda: client.command('EVAL', "return redis.call('INFO','commandstats')", 0))
        assert isinstance(result, str) and counts == {'eval': 1, 'info': 1}, counts
        # A malformed probe is refused and never leaves this connection queued.
        refused = False
        try:
            measured_command(client, lambda: None)
        except (AssertionError, RuntimeError):
            refused = True
        assert refused, 'Missing application command must fail'
        assert client.command('PING') == 'PONG'
        print('PASS: atomic INFO/EVAL/INFO excludes external PING, retains EVAL, internal PING/DBSIZE/INFO; invalid probe leaves no transaction')
    finally:
        client.close()
        noise.close()


def check_contract_profiles(operation):
    """Run the actual contract suite with another client's PING at every
    observation boundary. This exercises each real caller, not a replica of
    its accounting formula; an unprotected INFO window must fail its budget.
    """
    original = operation.__globals__['Redis']
    noise = Redis()
    observed = []
    class BoundaryNoiseRedis(original):
        def command(self, *parts):
            reply = super().command(*parts)
            if parts == ('INFO', 'commandstats'):
                assert noise.command('PING') == 'PONG'
                observed.append(1)
            return reply
    try:
        operation.__globals__['Redis'] = BoundaryNoiseRedis
        operation()
        assert observed, 'The actual contract suite must exercise command accounting'
        print('PASS: every actual contract profile survives deterministic external PING at ' + str(len(observed)) + ' INFO boundaries')
    finally:
        operation.__globals__['Redis'] = original
        noise.close()


if __name__ == '__main__':
    main()
