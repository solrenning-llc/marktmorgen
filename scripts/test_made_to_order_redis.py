"""Check lib/made-to-order.ts LIST_IF_ROOM on disposable CI loopback Redis; no provider IO."""
import concurrent.futures
import os
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis

CAP = 500
KEEP = 150 * 86400


def main():
    if os.environ.get('MARKTMORGEN_REDIS_INTEGRATION') != '1':
        raise RuntimeError('Use dedicated CI Redis on loopback port 16379 only')
    source = (Path(__file__).resolve().parents[1] / 'lib/made-to-order.ts').read_text(encoding='utf-8')
    match = re.search(r'export const LIST_IF_ROOM = `([^`]+)`;', source)
    if not match or '${' in match.group(1):
        raise RuntimeError('Expected static made-to-order Lua: LIST_IF_ROOM')
    script = match.group(1)
    prefix = 'marktmorgen:integration:mto:' + uuid.uuid4().hex + ':'
    lst, other = prefix + 'list', prefix + 'other'
    now, ends = 1_800_000_000, 1_800_000_000 + KEEP
    redis = Redis()

    def listing(key, member, at=now):
        client = Redis()
        try:
            return client.command('EVAL', script, 1, key, at, CAP, ends, member, KEEP)
        finally:
            client.close()

    try:
        for i in range(CAP - 1):
            redis.command('ZADD', lst, ends, '%032x' % i)
        redis.command('ZADD', lst, now - 1, 'f' * 32)
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda i: listing(lst, '%032x' % (10_000 + i)), range(40)))
        assert results.count(1) == 1 and results.count(0) == 39, results
        assert redis.command('ZCARD', lst) == CAP
        assert redis.command('ZSCORE', lst, 'f' * 32) is None  # The ended record was taken out first.
        assert 0 < redis.command('TTL', lst) <= KEEP
        listed = [m for m in ('%032x' % (10_000 + i) for i in range(40)) if redis.command('ZSCORE', lst, m) is not None]
        assert len(listed) == 1
        assert listing(lst, listed[0]) == 2  # Already listed, even at the cap; also a lost committed reply.
        assert listing(lst, '%032x' % 99_999) == 0
        redis.command('SET', other, 'not a list')
        assert listing(other, 'a' * 32) == -1
        assert redis.command('GET', other) == 'not a list'
        print('made-to-order listing: cap held under 40 concurrent calls, ended taken out, other kinds refused')
    finally:
        redis.command('DEL', lst, other)
        redis.close()


if __name__ == '__main__':
    main()
