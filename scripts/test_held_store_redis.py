"""Check actual held-store Lua on disposable CI loopback Redis; no provider IO."""
import concurrent.futures
import os
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis


def main():
    if os.environ.get('MARKTMORGEN_REDIS_INTEGRATION') != '1':
        raise RuntimeError('Use dedicated CI Redis on loopback port 16379 only')
    source = (Path(__file__).resolve().parents[1] / 'lib/held-stores.ts').read_text(encoding='utf-8')
    scripts = {}
    for name in ('CLAIM_HELD_RECHECK', 'NOTE_HELD_CLOSING', 'RECORD_HELD_MONTH'):
        match = re.search(r'export const ' + name + r' = `([^`]+)`;', source)
        if not match or '${' in match.group(1):
            raise RuntimeError('Expected static held-store Lua: ' + name)
        scripts[name] = match.group(1)
    prefix = 'marktmorgen:integration:held:' + uuid.uuid4().hex + ':'
    keys = [prefix + suffix for suffix in ('day', 'next-day', 'index', 'month', 'bad')]
    redis = Redis()
    def claim(key, identity):
        client = Redis()
        try:
            return client.command('EVAL', scripts['CLAIM_HELD_RECHECK'], 1, key, identity, 50, 172800)
        finally:
            client.close()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda i: claim(keys[0], str(i)), range(80)))
        assert sum(results) == 50
        assert redis.command('HGET', keys[0], 'count') == '50'
        assert 0 < redis.command('TTL', keys[0]) <= 172800
        assert claim(keys[0], '0') == 0
        assert claim(keys[1], '0') == 1
        assert claim(keys[1], '0') == 0  # Also a lost committed reply.
        redis.command('HSET', keys[4], 'count', '01')
        before = redis.command('HGETALL', keys[4])
        assert claim(keys[4], 'x') == -1
        assert redis.command('HGETALL', keys[4]) == before
        print('PASS: actual Lua holds50 global claims, one/store/day, TTL and malformed/lost replies')
        state, month = scripts['NOTE_HELD_CLOSING'], scripts['RECORD_HELD_MONTH']
        assert redis.command('EVAL', state, 2, keys[2], keys[3], 1, 'private@example.test', 20) == 1
        assert redis.command('EVAL', month, 2, keys[2], keys[3], '2026-11-30', 1, 34560000) == 1
        assert redis.command('HMGET', keys[3], 'count', 'peak', 'complete') == ['1', '1', '1']
        assert 'private' not in str(redis.command('HGETALL', keys[3]))
        assert redis.command('EVAL', state, 2, keys[2], keys[3], 0, 'private@example.test', 20) == 1
        assert redis.command('HGET', keys[3], 'complete') is None
        assert redis.command('EVAL', month, 2, keys[2], keys[3], '2026-11-30', 1, 34560000) == 1
        assert redis.command('HMGET', keys[3], 'count', 'peak', 'complete') == ['0', '1', '1']
        redis.command('DEL', keys[4]); redis.command('SET', keys[4], 'wrong-type')
        assert redis.command('EVAL', state, 2, keys[2], keys[4], 1, 'unfunded', 20) == -1
        assert redis.command('ZCARD', keys[2]) == 0
        print('PASS: actual Lua atomically invalidates monthly observations, preserves peak and refuses wrong types without membership writes')
    finally:
        for key in keys:
            if not key.startswith(prefix):
                raise RuntimeError('Refuse cleanup outside generated CI namespace')
            redis.command('DEL', key)
        redis.close()


if __name__ == '__main__':
    main()
