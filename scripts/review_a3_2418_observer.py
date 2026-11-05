"""Deterministic CI-noise reproduction; owned disposable Redis only.

Old O head and current Lua must match exactly. Only the observer changes.
This does not prove which other command occurred in the historical CI job.
"""
import os
from pathlib import Path
import subprocess
import test_order_confirmation_checkpoint_redis as checkpoint

OLD = '7bd3eb3d3ecc17e5ca920681329f8a815d09ae07'
root = Path(__file__).resolve().parents[1]
assert os.environ.get('MARKTMORGEN_REDIS_INTEGRATION') == '1'


def old_file(path):
    return subprocess.check_output(['git', 'show', OLD + ':' + path], cwd=root)


for path in ['lib/order-confirmation-outbox.ts', 'lib/shipment-mail-outbox.ts']:
    assert old_file(path) == (root / path).read_bytes(), path + ' must be identical'

path = 'scripts/test_order_confirmation_outbox_redis.py'
old = old_file(path).decode()
current = (root / path).read_text()


def exercise(source):
    scope = {'__name__': 'a3_observer_proof', '__file__': str(root / path)}
    exec(compile(source, str(root / path), 'exec'), scope)
    base = scope['LocalRedis']
    noise = base()
    observations = []

    class Healthchecked(base):
        def command(self, *parts):
            result = super().command(*parts)
            if str(parts[0]).upper() == 'INFO':
                observations.append(parts)
                # The third observation is just before the create profile.
                # On the old observer, the preceding INFO has already run;
                # on the fixed observer, it is queued inside MULTI/EXEC.
                if len(observations) == 3:
                    assert noise.command('PING') == 'PONG'
            return result

    scope['LocalRedis'] = Healthchecked
    try:
        scope['main']()
    finally:
        noise.close()
    assert len(observations) >= 3


try:
    exercise(old)
except AssertionError as failure:
    assert failure.args == ({'enqueue': 27, 'create': 18, 'bound_replay': 15, 'cursor': 17, 'bind': 18},), failure.args
    print('RED: exact old suite reproduces CI create18/expected17 from one external PING')
else:
    raise AssertionError('The old observer must reproduce the CI profile failure')

exercise(current)
checkpoint.measurement_controls()
print('GREEN: exact current suite keeps create17 under identical noise; application PING/INFO remain counted')
