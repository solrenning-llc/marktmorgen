"""Execute company exposure reservation against disposable CI loopback Redis only."""
import concurrent.futures
import os
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis


def main():
    if os.environ.get('MARKTMORGEN_REDIS_INTEGRATION') != '1':
        raise RuntimeError('Use dedicated CI Redis on loopback port 16379 only')
    source = (Path(__file__).resolve().parents[1] / 'lib/exposure-budget.ts').read_text(encoding='utf-8')
    match = re.search(r'export const RESERVE_EXPOSURE = `([^`]+)`;', source)
    if not match or '$' + '{' in match.group(1):
        raise RuntimeError('Expected static application exposure reservation script')
    script = match.group(1)
    prefix = 'marktmorgen:integration:exposure:' + uuid.uuid4().hex + ':'
    keys = [prefix + str(i) for i in range(14)]
    redis = Redis()
    def seed(key, slots=2):
        redis.command('HSET', key, 'review', 'review', 'policy', 'binding', 'reserved', 0, 'slots:trial', slots, 'slots:setup', slots)
    def take(client, key, customer='one', scope='trial', charge=100, limit=200, funded=2, binding='binding'):
        return client.command('EVAL', script, 1, key, 'review', binding, scope, customer, charge, limit, funded)
    def concurrent_take(key, customer):
        client = Redis()
        try:
            return take(client, key, customer)
        finally:
            client.close()
    try:
        assert redis.command('PING') == 'PONG'
        seed(keys[0])
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda i: concurrent_take(keys[0], str(i)), range(64)))
        assert sum(results) == 2
        assert redis.command('HGET', keys[0], 'reserved') == '200'
        assert redis.command('HGET', keys[0], 'slots:trial') == '0'
        print('PASS: 64 concurrent stores share exactly two complete exposure allocations')
        seed(keys[1])
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda _: concurrent_take(keys[1], 'same'), range(64)))
        assert sum(results) == 64
        assert redis.command('HGET', keys[1], 'reserved') == '100'
        assert redis.command('HGET', keys[1], 'slots:trial') == '1'
        print('PASS: repeated requests reuse one full allocation without renewing money or slots')
        seed(keys[2])
        take(redis, keys[2])  # Simulate ignoring a committed reply.
        assert take(redis, keys[2]) == 1
        assert redis.command('HGET', keys[2], 'reserved') == '100'
        print('PASS: a lost committed reply retains its allocation on retry')
        seed(keys[3])
        assert take(redis, keys[3], limit=150) == 1
        before = redis.command('HGETALL', keys[3])
        assert take(redis, keys[3], 'other', scope='setup', limit=150) == 0
        assert redis.command('HGETALL', keys[3]) == before
        assert take(redis, keys[3], 'other', scope='setup', charge=50, limit=150) == 1
        print('PASS: scopes share the company ceiling and refusal changes no counters')
        for key, field, value in [(keys[4], 'reserved', '-1'), (keys[5], 'slots:trial', '3'), (keys[6], 'policy', 'changed')]:
            seed(key)
            redis.command('HSET', key, field, value)
            before = redis.command('HGETALL', key)
            assert take(redis, key) == 0
            assert redis.command('HGETALL', key) == before
        print('PASS: corrupt counters and mismatched funding bindings refuse before writes')
        seed(keys[7])
        assert take(redis, keys[7]) == 1
        redis.command('HSET', keys[7], 'reserved', 0)
        before = redis.command('HGETALL', keys[7])
        assert take(redis, keys[7]) == 0
        assert redis.command('HGETALL', keys[7]) == before
        print('PASS: a retained receipt cannot bypass missing reserved money')
        seed(keys[8])
        redis.command('EXPIRE', keys[8], 60)
        assert take(redis, keys[8]) == 0
        redis.command('SET', keys[9], 'preserve')
        assert take(redis, keys[9]) == 0
        assert redis.command('GET', keys[9]) == 'preserve'
        assert take(redis, keys[10]) == 0
        assert redis.command('EXISTS', keys[10]) == 0
        print('PASS: expiring, wrong-type and missing ledgers cannot initialize funding')
        seed(keys[11], slots=1)
        assert take(redis, keys[11], charge=0, limit=0, funded=1) == 1
        assert take(redis, keys[11], charge=0, limit=0, funded=1) == 1
        assert take(redis, keys[11], 'other', charge=0, limit=0, funded=1) == 0
        print('PASS: an explicitly zero-cost case still consumes a finite occurrence slot')
        seed(keys[12])
        redis.command('HSET', keys[12], 'slots:platform_waitlist', 2)
        assert take(redis, keys[12], 'same', charge=100, limit=140) == 1
        def platform_take(index):
            client = Redis()
            try:
                return take(client, keys[12], str(index),
                            scope='platform_waitlist', charge=20, limit=140)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(platform_take, range(64)))
        assert sum(results) == 2
        assert redis.command('HGET', keys[12], 'reserved') == '140'
        assert redis.command('HGET', keys[12], 'slots:platform_waitlist') == '0'
        assert redis.command('HGET', keys[12], 'case:trial:same') == '100'
        assert redis.command('PTTL', keys[12]) == -1
        print('PASS: 64 platform waitlist contenders share company cash without consuming trial receipts')
        seed(keys[13])
        before = redis.command('HGETALL', keys[13])
        assert take(redis, keys[13], scope='platform_waitlist', charge=20) == 0
        assert redis.command('HGETALL', keys[13]) == before
        assert redis.command('HEXISTS', keys[13], 'slots:platform_waitlist') == 0
        print('PASS: an existing ledger without reviewed platform waitlist slots refuses without initialization')
    finally:
        for key in keys:
            if not key.startswith(prefix):
                raise RuntimeError('Refuse cleanup outside this generated CI namespace')
            redis.command('DEL', key)
        redis.close()


if __name__ == '__main__':
    main()
    from test_held_store_redis import main as held_store_checks
    held_store_checks()
