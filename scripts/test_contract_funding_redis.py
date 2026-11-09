"""Execute contract cash admission against disposable loopback CI Redis only."""
import concurrent.futures
import os
import json
from pathlib import Path
import re
import uuid
from test_form_opportunity_redis import Redis


def measured_command(client, operation):
    """Observe exactly one application command and its Lua calls atomically.

    INFO commandstats is server-wide. The CI service's independent health PING
    must not enter the application budget. MULTI/EXEC is test instrumentation:
    no other client runs between INFO, the actual command, and the final INFO.
    No application command name is filtered; even Lua PING remains counted.
    """
    def counts(raw):
        if not isinstance(raw, str):
            raise AssertionError('Expected INFO commandstats text')
        return {name: int(calls) for name, calls in
                re.findall(r'cmdstat_([^:]+):calls=(\d+)', raw)}
    started = False
    try:
        assert client.command('MULTI') == 'OK'
        started = True
        assert client.command('INFO', 'commandstats') == 'QUEUED'
        assert operation() == 'QUEUED', 'Expected one queued application command'
        assert client.command('INFO', 'commandstats') == 'QUEUED'
        replies = client.command('EXEC')
        started = False
        assert isinstance(replies, list) and len(replies) == 3, 'Expected exactly one application command'
        before, after = counts(replies[0]), counts(replies[2])
        delta = {name: after.get(name, 0) - before.get(name, 0)
                 for name in before.keys() | after.keys()}
        # The first INFO completes after its snapshot, so exactly one
        # observer INFO enters the delta; the final one completes afterward.
        # Preserve any additional INFO executed by the application Lua.
        assert delta.get('info', 0) >= 1, delta
        delta['info'] -= 1
        assert all(value >= 0 for value in delta.values()), delta
        return replies[1], {name: value for name, value in delta.items() if value}
    finally:
        if started:
            client.command('DISCARD')


def main():
    if os.environ.get('MARKTMORGEN_REDIS_INTEGRATION') != '1':
        raise RuntimeError('Use dedicated CI Redis on loopback port 16379 only')
    source = (Path(__file__).resolve().parents[1] / 'lib/contract-funding.ts').read_text(encoding='utf-8')
    match = re.search(r'export const RESERVE_CONTRACT = `([^`]+)`;', source)
    if not match or '$' + '{' in match.group(1):
        raise RuntimeError('Expected static application contract reservation Lua')
    script = match.group(1)
    activated = re.search(r'export const ACTIVATE_CONTRACT = `([^`]+)`;', source)
    if not activated or '$' + '{' in activated.group(1):
        raise RuntimeError('Expected static checkout activation Lua')
    activation_script = activated.group(1)
    switch_match = re.search(r'export const ACTIVATE_SWITCH_CONTRACT = `([^`]+)`;', source)
    if not switch_match or '$' + '{' in switch_match.group(1):
        raise RuntimeError('Expected static switch activation Lua')
    switch_script = switch_match.group(1)
    # The studio's read-only proofs are cut from these two scripts at runtime
    # (lib/contract-funding.ts observeOnly); the same cut is executed here.
    committed_branch = '\n return {2,finish}\nend\n'
    if 'export const OBSERVE_CONTRACT=observeOnly(ACTIVATE_CONTRACT);' not in source or 'export const OBSERVE_SWITCH_CONTRACT=observeOnly(ACTIVATE_SWITCH_CONTRACT);' not in source or "const committed='\\n return {2,finish}\\nend\\n'" not in source:
        raise RuntimeError('Expected the read-only proofs cut from the activation Lua')
    def observe_only(text):
        if text.count(committed_branch) != 1:
            raise RuntimeError('Expected one committed branch in the activation Lua')
        observed = text[:text.index(committed_branch) + len(committed_branch)] + 'return 0\n'
        if set(re.findall(r"redis\.call\('([A-Z]+)'", observed)) != {'HGET', 'TTL', 'TYPE'}:
            raise RuntimeError('Read-only activation proof would write')
        return observed
    observe_script, observe_switch_script = observe_only(activation_script), observe_only(switch_script)
    intent_match = re.search(r'export const CLAIM_RESTART_INTENT = `([^`]+)`;', source)
    if not intent_match or '$' + '{' in intent_match.group(1):
        raise RuntimeError('Expected static integrated restart intent Lua')
    intent_script = intent_match.group(1)
    arm_match = re.search(r'export const ARM_RESTART_SUBMISSION = `([^`]+)`;', source)
    if not arm_match or '$' + '{' in arm_match.group(1):
        raise RuntimeError('Expected static submission barrier Lua')
    arm_script = arm_match.group(1)
    result_match = re.search(r'export const RECORD_RESTART_RESULT = `([^`]+)`;', source)
    if not result_match or '$' + '{' in result_match.group(1):
        raise RuntimeError('Expected static durable restart result Lua')
    result_script = result_match.group(1)
    recovery_match = re.search(r'export const TAKE_RESTART_RECOVERY = `([^`]+)`;', source)
    if not recovery_match or '$' + '{' in recovery_match.group(1):
        raise RuntimeError('Expected static bounded restart recovery Lua')
    recovery_script = recovery_match.group(1)
    restart_activation_source = (Path(__file__).resolve().parents[1] / 'lib/contract-restart-activation.ts').read_text(encoding='utf-8')
    restart_activation_match = re.search(r'export const ACTIVATE_RESTART_CONTRACT = `([^`]+)`;', restart_activation_source)
    if not restart_activation_match or '$' + '{' in restart_activation_match.group(1):
        raise RuntimeError('Expected static funded restart activation Lua')
    restart_activation_script = restart_activation_match.group(1)
    publication_source = (Path(__file__).resolve().parents[1] / 'lib/contract-restart-publication.ts').read_text(encoding='utf-8')
    publication_match = re.search(r'export const PUBLISH_RESTART_STORE = `([^`]+)`;', publication_source)
    readback_match = re.search(r'export const READ_RESTART_PUBLICATION = `([^`]+)`;', publication_source)
    if not publication_match or not readback_match or chr(36)+'{' in publication_match.group(1) or chr(36)+'{' in readback_match.group(1):
        raise RuntimeError('Expected static actual joint publication/readback Lua')
    publication_script,readback_script = publication_match.group(1),readback_match.group(1)
    assert publication_script.count(restart_activation_script) == 1, 'Joint publisher must replay the exact current financial activation script'

    resource_source = (Path(__file__).resolve().parents[1] / 'lib/contract-resource-window.ts').read_text(encoding='utf-8')
    resource_match = re.search(r'export const RESERVE_PAID_RESOURCE_WINDOW = `([^`]+)`;', resource_source)
    if not resource_match or '$' + '{' in resource_match.group(1):
        raise RuntimeError('Expected static paid resource cohort Lua')
    resource_script = resource_match.group(1)
    prefix = 'marktmorgen:integration:contract:' + uuid.uuid4().hex + ':'
    keys = [prefix + str(i) for i in range(47)]
    intent_refs = ['synthetic-restart-intent-' + uuid.uuid4().hex + '-' + str(i) for i in range(3)]
    from test_contract_command_measurement import main as check_measurement
    check_measurement()
    redis = Redis()
    joint_owned_keys = []
    def snapshot(key):
        fields = redis.command('HGETALL', key)
        assert len(fields) % 2 == 0
        # Hash iteration order is unspecified; compare every field/value pair.
        return sorted(zip(fields[::2], fields[1::2]))
    def seed(key, carried=0):
        redis.command('HSET', key, 'review', 'review', 'policy', 'binding', 'reserved', carried, 'carried', carried, 'slots:creator_month', 2, 'slots:creator_year', 2)
    def take(client, key, store='one', nonce='ctr_one', choice='creator_month', charge=50, limit=100, carry=0, binding='binding', action='checkout', source_subscription='', now=1800000001, submission=300):
        receipt = '|'.join(map(str, ['review', store, choice, action, charge, 1800000300, 1800003600, 1800086400, 2000000000000]))
        return client.command('EVAL', script, 1, key, binding, 'review', store, choice, charge, limit, carry, 2, nonce, receipt, action, source_subscription, now, *([submission] if action == 'restart' else []))
    def parallel(key, store, nonce):
        client = Redis()
        try:
            return take(client, key, store, nonce)
        finally:
            client.close()
    try:
        assert redis.command('PING') == 'PONG'
        seed(keys[0])
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda i: parallel(keys[0], 'store' + str(i), 'ctr_' + str(i)), range(64)))
        assert sum(results) == 2
        assert redis.command('HGET', keys[0], 'reserved') == '100'
        assert redis.command('HGET', keys[0], 'slots:creator_month') == '0'
        print('PASS: 64 concurrent contracts cannot reuse two funded grant slots')
        seed(keys[1])
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda i: parallel(keys[1], 'same', 'ctr_' + str(i)), range(64)))
        assert sum(results) == 1
        assert redis.command('HGET', keys[1], 'reserved') == '50'
        assert redis.command('HGET', keys[1], 'slots:creator_month') == '1'
        print('PASS: a store can hold only one pending contract across concurrent attempts')
        seed(keys[2])
        take(redis, keys[2])  # Deliberately ignore a committed reply.
        assert take(redis, keys[2]) == 0
        assert take(redis, keys[2], nonce='ctr_retry') == 0
        assert take(redis, keys[2], store='other') == 0
        assert redis.command('HGET', keys[2], 'reserved') == '50'
        assert redis.command('HGET', keys[2], 'grant:ctr_one') is not None
        print('PASS: lost replies retain cash, nonce, capacity and the pending store lock')
        seed(keys[3], carried=100)
        assert take(redis, keys[3], limit=200, carry=100) == 1
        assert redis.command('HGET', keys[3], 'reserved') == '150'
        redis.command('HSET', keys[3], 'reserved', 99)
        before = snapshot(keys[3])
        assert take(redis, keys[3], 'other', 'ctr_other', limit=200, carry=100) == 0
        assert snapshot(keys[3]) == before
        print('PASS: carried obligations cannot be reset to finance another contract')
        seed(keys[4])
        assert take(redis, keys[4], limit=75) == 1
        before = snapshot(keys[4])
        assert take(redis, keys[4], 'other', 'ctr_other', limit=75) == 0
        assert snapshot(keys[4]) == before
        print('PASS: the company cash ceiling blocks a grant without changing any field')
        for key, field, value in [(keys[5], 'reserved', '-1'), (keys[6], 'slots:creator_month', '3'), (keys[7], 'policy', 'changed')]:
            seed(key)
            redis.command('HSET', key, field, value)
            before = snapshot(key)
            assert take(redis, key) == 0
            assert snapshot(key) == before
        print('PASS: corrupt amounts, slots and funding bindings refuse before writes')
        seed(keys[8])
        redis.command('EXPIRE', keys[8], 60)
        assert take(redis, keys[8]) == 0
        redis.command('SET', keys[9], 'preserve')
        assert take(redis, keys[9]) == 0
        assert redis.command('GET', keys[9]) == 'preserve'
        assert take(redis, keys[10]) == 0
        assert redis.command('EXISTS', keys[10]) == 0
        print('PASS: expiring, wrong-type and missing company ledgers never initialize funding')
        seed(keys[11])
        for charge in [0, -1, '50.5', '01', 1000000000001]:
            before = snapshot(keys[11])
            assert take(redis, keys[11], charge=charge) == 0
            assert snapshot(keys[11]) == before
        print('PASS: zero, fractional, noncanonical and unsafe charges cannot create a grant')
        # Activation runs the actual application Lua, not the TypeScript double.
        instant = 1800000000
        def funded_activation(key, action='checkout'):
            seed(key)
            assert take(redis, key) == 1
            receipt = '|'.join(map(str, ['review', 'one', 'creator_month', action, 50, instant+300, instant+3600, instant+86400, 2000000000000]))
            redis.command('HSET', key, 'grant:ctr_one', receipt)
        def activate(client, key, subscription='sub_Activation001', store='one', nonce='ctr_one', created=instant, now=instant+1, phase='paid', period_start=instant, period_end=instant+30*86400):
            return client.command('EVAL', activation_script, 1, key, 'binding', 'review', store, 'creator_month', nonce, subscription, created, now, 50, 100, 0, 300, 2, phase, period_start, period_end)
        def measured_activation(key, label, **args):
            result, changes = measured_command(redis, lambda: activate(redis, key, **args))
            assert all(value >= 0 for value in changes.values()), changes
            changes = {name: value for name, value in changes.items() if value}
            assert changes.get('eval') == 1, changes
            total = sum(changes.values())
            assert 1 <= total <= 14, (label, total, changes)
            print('MEASURED activation commands:', label, total, sorted(changes.items()))
            return result, total
        funded_activation(keys[12])
        money = redis.command('HGET', keys[12], 'reserved')
        slots = redis.command('HGET', keys[12], 'slots:creator_month')
        result, total = measured_activation(keys[12], 'first activation')
        assert result == [1, instant+86400]
        assert total == 14, 'Every internal command must be measured, including writes'
        assert redis.command('HGET', keys[12], 'reserved') == money
        assert redis.command('HGET', keys[12], 'slots:creator_month') == slots
        assert redis.command('HGET', keys[12], 'pending:one') is None
        assert redis.command('HGET', keys[12], 'grant:ctr_one') is not None
        before = snapshot(keys[12])
        result, _ = measured_activation(keys[12], 'identical retry')
        assert result == [2, instant+30*86400]
        assert snapshot(keys[12]) == before
        result, _ = measured_activation(keys[12], 'foreign subscription', subscription='sub_Other001')
        assert result == 0
        assert activate(redis, keys[12], period_start=instant+3600, period_end=instant+30*86400+3600) == 0
        assert activate(redis, keys[12], phase='trial', period_end=instant+7*86400) == 0
        assert snapshot(keys[12]) == before
        print('PASS: checkout activation binds once, retains all cash/slots and recovers identical lost replies')
        before = snapshot(keys[12])
        assert take(redis, keys[12], nonce='ctr_second_checkout') == 0
        assert snapshot(keys[12]) == before
        active = redis.command('HGET', keys[12], 'active:one')
        measured_ack, switch_changes = measured_command(redis, lambda: take(redis, keys[12], nonce='ctr_switch_after_active', action='switch', source_subscription='sub_Activation001'))
        assert measured_ack == 1
        assert all(value >= 0 for value in switch_changes.values()), switch_changes
        switch_changes = {name: value for name, value in switch_changes.items() if value}
        assert switch_changes.get('eval') == 1 and sum(switch_changes.values()) == 17, switch_changes
        print('MEASURED source-bound switch reservation commands:', 17, sorted(switch_changes.items()))
        assert redis.command('HGET', keys[12], 'grant:ctr_switch_after_active').split('|')[-1] == 'ctr_one'
        assert redis.command('HGET', keys[12], 'active:one') == active
        assert redis.command('HGET', keys[12], 'reserved') == '100'
        assert redis.command('HGET', keys[12], 'slots:creator_month') == '0'
        print('PASS: an active contract blocks another checkout, while a separate switch retains both obligations')
        funded_activation(keys[13])
        def parallel_activation(_):
            client = Redis()
            try:
                return activate(client, keys[13])
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(parallel_activation, range(64)))
        assert sum(result == [1, instant+86400] for result in results) == 1
        assert all(result in ([1, instant+86400], [2, instant+30*86400]) for result in results)
        assert redis.command('HGET', keys[13], 'reserved') == '50'
        assert redis.command('HGET', keys[13], 'slots:creator_month') == '1'
        print('PASS: 64 duplicate activation observations share exactly one immutable subscription binding')
        funded_activation(keys[14])
        before = snapshot(keys[14])
        for args in [dict(store='other'), dict(nonce='ctr_missing'), dict(created=instant-1), dict(now=instant+86401)]:
            assert activate(redis, keys[14], **args) == 0
            assert snapshot(keys[14]) == before
        funded_activation(keys[15], action='switch')
        assert activate(redis, keys[15]) == 0
        print('PASS: foreign, absent, expired, predating and switch receipts cannot activate checkout rights')
        for key, field, value in [(keys[16], 'reserved', 0), (keys[17], 'slots:creator_month', 2), (keys[18], 'active:one', 'other')]:
            funded_activation(key)
            redis.command('HSET', key, field, value)
            before = snapshot(key)
            assert activate(redis, key) == 0
            assert snapshot(key) == before
        funded_activation(keys[19])
        redis.command('EXPIRE', keys[19], 60)
        before = snapshot(keys[19])
        assert activate(redis, keys[19]) == 0
        assert snapshot(keys[19]) == before
        print('PASS: corrupt, already-active and expiring activation ledgers fail before writes')
        seed(keys[20])
        before = snapshot(keys[20])
        forged_receipt = 'review|one|creator_month|checkout|50|1800000300|1800003600|1800086400|2000000000000'
        assert redis.command('EVAL', script, 1, keys[20], 'binding', 'review', 'one', 'creator_month', 50, 100, 0, 2, 'ctr_wrong_action', forged_receipt, 'switch') == 0
        assert snapshot(keys[20]) == before
        measured_ack, changes = measured_command(redis, lambda: take(redis, keys[20]))
        assert measured_ack == 1
        assert all(value >= 0 for value in changes.values()), changes
        changes = {name: value for name, value in changes.items() if value}
        assert changes.get('eval') == 1 and sum(changes.values()) == 15, changes
        print('MEASURED checkout reservation commands:', 15, sorted(changes.items()))


        seed(keys[21])
        before = snapshot(keys[21])
        assert take(redis, keys[21], action='switch', source_subscription='sub_Activation001') == 0
        assert snapshot(keys[21]) == before
        for key, corrupt in [
            (keys[22], 'foreign'),
            (keys[23], 'expired'),
            (keys[24], 'activation'),
            (keys[25], 'receipt-store'),
            (keys[26], 'receipt-tail'),
        ]:
            funded_activation(key)
            assert activate(redis, key) == [1, instant+86400]
            sub = 'sub_Activation001'
            if corrupt == 'foreign':
                sub = 'sub_Other0001'
            elif corrupt == 'expired':
                expired = '|'.join(map(str, ['ctr_one', sub, 'creator_month', instant, 'paid', instant, instant+1]))
                redis.command('HSET', key, 'active:one', expired, 'activated:ctr_one', expired)
            elif corrupt == 'activation':
                redis.command('HSET', key, 'activated:ctr_one', 'different')
            else:
                receipt = redis.command('HGET', key, 'grant:ctr_one').split('|')
                receipt[1 if corrupt == 'receipt-store' else 8] = 'other' if corrupt == 'receipt-store' else str(instant*1000)
                redis.command('HSET', key, 'grant:ctr_one', '|'.join(receipt))
            before = snapshot(key)
            assert take(redis, key, nonce='ctr_denied_switch', action='switch', source_subscription=sub, now=instant+2) == 0
            assert snapshot(key) == before
        print('PASS: missing, foreign, expired and corrupt source bindings cannot spend another cent or slot')
        funded_activation(keys[27])
        assert activate(redis, keys[27]) == [1, instant+86400]
        old_active = redis.command('HGET', keys[27], 'active:one')
        old_receipt = redis.command('HGET', keys[27], 'grant:ctr_one')
        def parallel_switch(i):
            client = Redis()
            try:
                return take(client, keys[27], nonce='ctr_switch_'+str(i), action='switch', source_subscription='sub_Activation001')
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(parallel_switch, range(64)))
        assert sum(results) == 1
        assert redis.command('HGET', keys[27], 'active:one') == old_active
        assert redis.command('HGET', keys[27], 'grant:ctr_one') == old_receipt
        assert redis.command('HGET', keys[27], 'reserved') == '100'
        pending = redis.command('HGET', keys[27], 'pending:one')
        receipt = redis.command('HGET', keys[27], 'grant:'+pending).split('|')
        assert len(receipt) == 10 and receipt[-1] == 'ctr_one'
        before = snapshot(keys[27])
        assert take(redis, keys[27], nonce='ctr_lost_reply_retry', action='switch', source_subscription='sub_Activation001') == 0
        assert snapshot(keys[27]) == before
        print('PASS: 64 source-bound switches fund one additional obligation and preserve the old active grant')


        def switch_ready(key, trial=False):
            funded_activation(key)
            if trial:
                assert activate(redis, key, phase='trial', period_end=instant+7*86400) == [1, instant+86400]
            else:
                assert activate(redis, key) == [1, instant+86400]
            assert take(redis, key, nonce='ctr_switch', action='switch', source_subscription='sub_Activation001') == 1
        def switch_activate(client, key, subscription='sub_Activation001', created=instant, now=instant+2, phase='paid', start=instant, finish=instant+30*86400, span=31*86400):
            return client.command('EVAL', switch_script, 1, key, 'binding', 'review', 'one', 'creator_month', 'ctr_switch', subscription, created, now, 50, 100, 0, 300, 2, phase, start, finish, span)
        switch_ready(keys[28])
        source_proof = redis.command('HGET', keys[28], 'active:one')
        source_receipt = redis.command('HGET', keys[28], 'grant:ctr_one')
        measured_ack, switch_activation_changes = measured_command(redis, lambda: switch_activate(redis, keys[28]))
        assert measured_ack == [1, instant + 86400]
        assert all(value >= 0 for value in switch_activation_changes.values())
        switch_activation_changes = {name: count for name, count in switch_activation_changes.items() if count}
        assert switch_activation_changes.get('eval') == 1 and sum(switch_activation_changes.values()) == 16, switch_activation_changes
        print('MEASURED switch activation commands:', 16, sorted(switch_activation_changes.items()))
        assert redis.command('HGET', keys[28], 'active:one') != source_proof
        assert redis.command('HGET', keys[28], 'activated:ctr_one') == source_proof
        assert redis.command('HGET', keys[28], 'grant:ctr_one') == source_receipt
        assert redis.command('HGET', keys[28], 'pending:one') is None
        assert redis.command('HGET', keys[28], 'reserved') == '100'
        assert redis.command('HGET', keys[28], 'slots:creator_month') == '0'
        before = snapshot(keys[28])
        measured_ack, retry_changes = measured_command(redis, lambda: switch_activate(redis, keys[28]))
        assert measured_ack == [2, instant + 30 * 86400]
        assert all(value >= 0 for value in retry_changes.values()) and sum(retry_changes.values()) == 13, retry_changes
        print('MEASURED switch activation retry commands:', 13, sorted((name, count) for name, count in retry_changes.items() if count))
        assert snapshot(keys[28]) == before
        switch_ready(keys[29])
        def parallel_switch_activation(_):
            client = Redis()
            try:
                return switch_activate(client, keys[29])
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(parallel_switch_activation, range(64)))
        assert sum(value == [1, instant+86400] for value in results) == 1
        assert all(value in ([1, instant+86400], [2, instant+30*86400]) for value in results)
        assert redis.command('HGET', keys[29], 'reserved') == '100'
        assert redis.command('HGET', keys[29], 'slots:creator_month') == '0'
        assert redis.command('HGET', keys[29], 'activated:ctr_one') is not None
        print('PASS: 64 switch activation observations share one new binding and retain both principals')
        def read_only(label, operation, expected, key):
            before = snapshot(key)
            result, changes = measured_command(redis, operation)
            changes = {name: count for name, count in changes.items() if count}
            assert result == expected, (label, result)
            assert changes.get('eval') == 1 and set(changes) <= {'eval', 'hget', 'type', 'ttl'}, (label, changes)
            assert snapshot(key) == before, label
        def observe(key, **args):
            subscription, now, period_end = args.get('subscription', 'sub_Activation001'), args.get('now', instant+1), args.get('period_end', instant+30*86400)
            return lambda: redis.command('EVAL', observe_script, 1, key, 'binding', 'review', 'one', 'creator_month', 'ctr_one', subscription, instant, now, 50, 100, 0, 300, 2, 'paid', instant, period_end)
        funded_activation(keys[45])
        read_only('checkout before activation', observe(keys[45]), 0, keys[45])
        assert redis.command('HGET', keys[45], 'pending:one') == 'ctr_one'
        assert activate(redis, keys[45]) == [1, instant+86400]
        read_only('checkout committed', observe(keys[45]), [2, instant+30*86400], keys[45])
        read_only('checkout foreign subscription', observe(keys[45], subscription='sub_Other001'), 0, keys[45])
        read_only('checkout other period', observe(keys[45], period_end=instant+29*86400), 0, keys[45])
        def observe_switch(key):
            return lambda: redis.command('EVAL', observe_switch_script, 1, key, 'binding', 'review', 'one', 'creator_month', 'ctr_switch', 'sub_Activation001', instant, instant+2, 50, 100, 0, 300, 2, 'paid', instant, instant+30*86400, 31*86400)
        switch_ready(keys[46])
        read_only('switch before activation', observe_switch(keys[46]), 0, keys[46])
        assert redis.command('HGET', keys[46], 'pending:one') == 'ctr_switch'
        assert switch_activate(redis, keys[46]) == [1, instant+86400]
        read_only('switch committed', observe_switch(keys[46]), [2, instant+30*86400], keys[46])
        print('PASS: the read-only proofs confirm only committed activations, never activate and write nothing')
        switch_ready(keys[30])
        before = snapshot(keys[30])
        for args in [dict(subscription='sub_Other0001'), dict(created=instant+1), dict(phase='trial', finish=instant+7*86400), dict(finish=instant+32*86400), dict(now=instant+86401)]:
            assert switch_activate(redis, keys[30], **args) == 0
            assert snapshot(keys[30]) == before
        switch_ready(keys[31], trial=True)
        before = snapshot(keys[31])
        assert switch_activate(redis, keys[31], phase='trial', finish=instant+8*86400, span=14*86400) == 0
        assert snapshot(keys[31]) == before
        assert switch_activate(redis, keys[31], phase='trial', finish=instant+7*86400, span=14*86400) == [1, instant+86400]
        for key, field, value in [(keys[32], 'active:one', 'different'), (keys[33], 'activated:ctr_one', 'different'), (keys[34], 'grant:ctr_one', 'missing'), (keys[35], 'reserved', 50)]:
            switch_ready(key)
            redis.command('HSET', key, field, value)
            before = snapshot(key)
            assert switch_activate(redis, key) == 0
            assert snapshot(key) == before
        print('PASS: foreign periods, new or extended trials, corrupt sources and insufficient cash cannot activate a switch')
        funded_activation(keys[36])
        old_created = instant-30*86400
        old_receipt = '|'.join(map(str, ['review', 'one', 'creator_month', 'checkout', 50, old_created+300, old_created+3600, old_created+86400, 2000000000000]))
        redis.command('HSET', keys[36], 'grant:ctr_one', old_receipt)
        assert activate(redis, keys[36], created=old_created, now=old_created+1, period_start=old_created, period_end=old_created+31*86400) == [1, old_created+86400]
        assert take(redis, keys[36], nonce='ctr_switch', action='switch', source_subscription='sub_Activation001') == 1
        assert switch_activate(redis, keys[36], created=old_created) == [1, instant+86400]
        print('PASS: a switch keeps the original subscription creation identity while its new grant has a fresh deadline')

        # Late observations may read only a previously committed exact term.
        # Reuse existing generated keys; no extra service or cleanup namespace.
        before = snapshot(keys[13])
        measured_ack, changes = measured_command(redis, lambda: activate(redis, keys[13], now=instant + 2 * 86400))
        assert measured_ack == [2, instant + 30 * 86400]
        assert all(value >= 0 for value in changes.values()) and sum(changes.values()) == 11, changes
        print('MEASURED committed checkout term observation commands:', 11, sorted((name, count) for name, count in changes.items() if count))
        assert snapshot(keys[13]) == before
        assert activate(redis, keys[13], now=instant+30*86400) == 0
        assert activate(redis, keys[13], now=instant+2*86400, period_end=instant+30*86400+1) == 0
        assert snapshot(keys[13]) == before
        before = snapshot(keys[29])
        measured_ack, changes = measured_command(redis, lambda: switch_activate(redis, keys[29], now=instant + 2 * 86400))
        assert measured_ack == [2, instant + 30 * 86400]
        assert all(value >= 0 for value in changes.values()) and sum(changes.values()) == 13, changes
        print('MEASURED committed switch term observation commands:', 13, sorted((name, count) for name, count in changes.items() if count))
        assert snapshot(keys[29]) == before
        assert switch_activate(redis, keys[29], now=instant+30*86400) == 0
        assert switch_activate(redis, keys[29], now=instant+2*86400, start=instant+1) == 0
        assert snapshot(keys[29]) == before
        print('PASS: committed checkout and switch proofs survive activation deadlines without any write, renewal or expired unconsumed activation')

        def resource_slots(key, annual=False):
            redis.command('HSET', key, 'slots:creator_month', 0 if annual else 1,
                          'slots:creator_year', 1 if annual else 0,
                          'slots:pro_month', 0, 'slots:pro_year', 0, 'slots:scale_month', 0, 'slots:scale_year', 0)
        def resource_claim(client, key, annual=False, index=0, subscription='sub_Activation001', shift=0, now_ms=None):
            start, finish = instant, instant+(360 if annual else 30)*86400
            from_ms = (instant+index*30*86400)*1000+shift
            until_ms = (instant+(index+1)*30*86400)*1000
            now_ms = now_ms if now_ms is not None else from_ms+1000
            quotes = [0 if annual else 2, 50, 2 if annual else 0, 50, 0, 1, 0, 1, 0, 1, 0, 1]
            return client.command('EVAL', resource_script, 1, key, 'binding', 'review', 'one',
                                  subscription, 'creator_year' if annual else 'creator_month',
                                  start, finish, from_ms, until_ms, now_ms, index, 12 if annual else 1,
                                  50, 100, 0, 2, *quotes)
        funded_activation(keys[37])
        assert activate(redis, keys[37]) == [1, instant+86400]
        resource_slots(keys[37])
        original = snapshot(keys[37])
        for expected_count, label in [(18, 'first cohort'), (17, 'repeated cohort')]:
            measured_ack, delta = measured_command(redis, lambda: resource_claim(redis, keys[37]))
            assert measured_ack == [1, (instant + 30 * 86400) * 1000]
            assert all(value >= 0 for value in delta.values()) and sum(delta.values()) == expected_count, delta
            print('MEASURED paid resource commands:', label, expected_count, sorted((name, value) for name, value in delta.items() if value))
        for name, value in original:
            assert redis.command('HGET', keys[37], name) == value
        committed = snapshot(keys[37])
        for args in [dict(subscription='sub_Foreign001'), dict(shift=1), dict(index=1), dict(now_ms=(instant+30*86400)*1000)]:
            assert resource_claim(redis, keys[37], **args) == 0
            assert snapshot(keys[37]) == committed
        redis.command('HSET', keys[37], 'slots:pro_year', 1)
        corrupt = snapshot(keys[37])
        assert resource_claim(redis, keys[37]) == 0
        assert snapshot(keys[37]) == corrupt
        seed(keys[38])
        redis.command('HSET', keys[38], 'slots:creator_month', 0)
        assert take(redis, keys[38], choice='creator_year') == 1
        assert redis.command('EVAL', activation_script, 1, keys[38], 'binding', 'review', 'one',
                             'creator_year', 'ctr_one', 'sub_Activation001', instant, instant+1,
                             50, 100, 0, 300, 2, 'paid', instant, instant+360*86400) == [1, instant+86400]
        resource_slots(keys[38], annual=True)
        def concurrent_resource(_):
            client = Redis()
            try:
                return resource_claim(client, keys[38], annual=True)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(concurrent_resource, range(64)))
        assert all(value == [1, (instant+30*86400)*1000] for value in results)
        assert len([name for name, value in snapshot(keys[38]) if name.startswith('resource:')]) == 1
        for index in range(12):
            assert resource_claim(redis, keys[38], annual=True, index=index) == [1, (instant+(index+1)*30*86400)*1000]
        before = snapshot(keys[38])
        assert len([name for name, value in before if name.startswith('resource:')]) == 12
        assert resource_claim(redis, keys[38], annual=True, index=12) == 0
        assert redis.command('HGET', keys[38], 'reserved') == '50'
        assert redis.command('HGET', keys[38], 'slots:creator_year') == '1'
        assert snapshot(keys[38]) == before
        redis.command('EXPIRE', keys[38], 60)
        assert resource_claim(redis, keys[38], annual=True) == 0
        assert snapshot(keys[38]) == before
        print('PASS: paid resource cohorts retain cash, reconcile six slot counters, share64 replies and bound annual fields to12')


        # Reservation-only restart primitive. The production TypeScript gate is
        # false; these receipts/cash are synthetic, not reviewed supplier funds.
        def seed_restart(key):
            redis.command('DEL', key)
            seed(key)
            binding = 'ctr_restart_source|sub_RestartSource01|creator_month|1799999000|paid|1799999000|1800000000'
            receipt = 'review|restart-store|creator_month|checkout|40|1799999300|1800000000|1800000200|2000000000000'
            redis.command('HSET', key, 'reserved', 40, 'active:restart-store', binding,
                          'activated:ctr_restart_source', binding, 'grant:ctr_restart_source', receipt)
            return binding, receipt
        def take_restart(client, key, nonce='ctr_restart_new', **over):
            args = dict(store='restart-store', nonce=nonce, action='restart',
                        source_subscription='sub_RestartSource01', limit=140)
            args.update(over)
            return take(client, key, **args)
        old_binding, old_receipt = seed_restart(keys[39])
        def concurrent_restart(index):
            client = Redis()
            try:
                return take_restart(client, keys[39], 'ctr_restart_' + str(index))
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(concurrent_restart, range(64)))
        assert sum(results) == 1
        assert redis.command('HGET', keys[39], 'reserved') == '90'
        assert redis.command('HGET', keys[39], 'slots:creator_month') == '1'
        assert redis.command('HGET', keys[39], 'active:restart-store') == old_binding
        assert redis.command('HGET', keys[39], 'activated:ctr_restart_source') == old_binding
        assert redis.command('HGET', keys[39], 'grant:ctr_restart_source') == old_receipt
        winner = redis.command('HGET', keys[39], 'pending:restart-store')
        assert winner.startswith('ctr_restart_')
        assert redis.command('HGET', keys[39], 'grant:' + winner).endswith('|ctr_restart_source')
        assert redis.command('TTL', keys[39]) == -1
        print('PASS: 64 restart reserves share one new full obligation and retain every old cash/source receipt')

        invalid = [
            ('active:restart-store', old_binding.replace('|paid|', '|trial|'), {}),
            ('active:restart-store', old_binding.replace('|1800000000', '|1800000100'), {}),
            ('active:restart-store', old_binding.replace('creator_month', 'creator_year'), {}),
            ('active:restart-store', old_binding + '|extra', {}),
            ('activated:ctr_restart_source', 'mismatched', {}),
            ('grant:ctr_restart_source', old_receipt.replace('|restart-store|', '|other-store|'), {}),
            ('grant:ctr_restart_source', old_receipt.replace('|40|', '|41|'), {'limit': 40}),
            ('grant:ctr_restart_source', old_receipt + '|extra', {}),
            ('reserved', 39, {}),
            ('policy', 'unknown', {}),
            (None, None, {'source_subscription': 'sub_OtherSource01'}),
            (None, None, {'choice': 'creator_year'}),
            (None, None, {'choice': 'pro_month'}),
            (None, None, {'now': 1800000301}),
            (None, None, {'submission': 0}),
            (None, None, {'submission': '01'}),
        ]
        for field, value, options in invalid:
            seed_restart(keys[40])
            if field is not None:
                redis.command('HSET', keys[40], field, value)
            before = snapshot(keys[40])
            assert take_restart(redis, keys[40], **options) == 0
            assert snapshot(keys[40]) == before
        seed_restart(keys[40])
        redis.command('HDEL', keys[40], 'activated:ctr_restart_source')
        before = snapshot(keys[40])
        assert take_restart(redis, keys[40]) == 0
        assert snapshot(keys[40]) == before
        print('PASS: unknown, live, trial, foreign, annual or unbacked restart sources refuse without writes')

        # Count the actual application Lua's commands, including EVAL and
        # internal calls. Exclude only INFO used to observe the test.
        rule_source = (Path(__file__).resolve().parents[1] / 'lib/contract-funding-rules.ts').read_text(encoding='utf-8')
        ceiling_match = re.search(r'restartReservation:\{[^}]*commandCeiling:(\d+)', rule_source)
        assert ceiling_match
        command_ceiling = int(ceiling_match.group(1))
        old_binding, old_receipt = seed_restart(keys[41])
        measured_ack, first_counts = measured_command(redis, lambda: take_restart(redis, keys[41]))
        assert measured_ack == 1
        assert sum(first_counts.values()) <= command_ceiling
        # Ignore that committed acknowledgement; neither same nor new nonce
        # may reserve again, expire ownership, release old cash or overwrite it.
        before = snapshot(keys[41])
        measured_ack, duplicate_counts = measured_command(redis, lambda: take_restart(redis, keys[41]))
        assert measured_ack == 0
        assert sum(duplicate_counts.values()) <= command_ceiling
        assert take_restart(redis, keys[41], 'ctr_retry_restart') == 0
        assert take(redis, keys[41], store='restart-store', nonce='ctr_restart_checkout') == 0
        assert snapshot(keys[41]) == before
        assert redis.command('HGET', keys[41], 'reserved') == '90'
        assert redis.command('HGET', keys[41], 'active:restart-store') == old_binding
        assert redis.command('HGET', keys[41], 'grant:ctr_restart_source') == old_receipt
        print('PASS: restart lost-ack reservation retains cash and pending ownership without replay')
        print('MEASURED restart reservation commands: first=' + str(first_counts) +
              ', duplicate=' + str(duplicate_counts) + ', canonical ceiling=' + str(command_ceiling))

        # Actual application intent ownership, separate from reservation. No
        # provider permission, activation or production coverage is inferred.
        def intent_ready(key, ref, source_action='checkout'):
            assert source_action in ('checkout', 'switch', 'restart')
            _, receipt = seed_restart(key)
            if source_action != 'checkout':
                receipt = receipt.replace('|checkout|', '|' + source_action + '|') + '|ctr_upstream_source'
                # Historical upstream principal is retained explicitly, not
                # silently treated as zero by a synthetic ten-field fixture.
                if source_action == 'switch':
                    upstream = 'ctr_upstream_source|sub_RestartSource01|creator_month|1799999000|paid|1799999000|1800000000'
                    upstream_receipt = 'review|restart-store|creator_month|checkout|10|1799999300|1800000000|1800000200|2000000000000'
                else:
                    upstream = 'ctr_upstream_source|sub_PreviousSource01|creator_month|1799998000|paid|1799998000|1799999000'
                    upstream_receipt = 'review|restart-store|creator_month|checkout|10|1799998300|1799999000|1799999300|2000000000000'
                redis.command('HSET', key, 'grant:ctr_restart_source', receipt, 'reserved', 50,
                              'grant:ctr_upstream_source', upstream_receipt,
                              'activated:ctr_upstream_source', upstream)
            assert take_restart(redis, key) == 1
            pause = json.dumps(dict(subscription='sub_RestartSource01',
                                    customer='cus_IntentCustomer01', paymentMethod='pm_IntentCard001',
                                    tier='creator', **{'from': 1800000000}, until=1800000001,
                                    told=0, funding=dict(version=1, grantId='ctr_restart_source')),
                               separators=(',', ':'))
            redis.command('SET', 'nl:pause:' + ref, pause)
            redis.command('SET', 'nl:pause:last:' + ref, 1799999000)
            redis.command('ZADD', 'nl:pause:due', 1800000001, ref)
            return pause
        def intent_claim(client, key, ref, pause, claim='claim_first', **over):
            options = dict(binding='binding', review='review', now=1800000001,
                           source='sub_RestartSource01', raw=pause, amount=50, limit=140,
                           source_grant='ctr_restart_source', payload=None, extra=False, prove_input_bound=False)
            options.update(over)
            intent = json.dumps(dict(version=1, grant='ctr_restart_new', review=options['review'],
                                     statsId='restart-store', sourceSubscription=options['source'],
                                     sourceGrant=options['source_grant'], ref=ref, handle='synthetic-store',
                                     paused=options['raw'], claim=claim, created=options['now'],
                                     deadline=1800000300), separators=(',', ':'))
            if options['extra']:
                intent = json.dumps({**json.loads(intent), 'unexpected': 'not an owned field'}, separators=(',', ':'))
            if options['prove_input_bound']:
                assert len(intent.encode()) <= 4096
            return client.command('EVAL', intent_script, 4, key, 'nl:pause:' + ref,
                                  'nl:pause:due', 'nl:pause:last:' + ref,
                                  options['binding'], options['review'], 'restart-store',
                                  'creator_month', 'ctr_restart_new', options['source'],
                                  options['now'], options['amount'], options['limit'], 0, 300,
                                  ref, options['raw'], claim, 'synthetic-store',
                                  options['payload'] if options['payload'] is not None else intent)
        pause = intent_ready(keys[42], intent_refs[0])
        before = snapshot(keys[42])
        def concurrent_intent(index):
            client = Redis()
            try:
                return intent_claim(client, keys[42], intent_refs[0], pause, 'claim_' + str(index))
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(concurrent_intent, range(64)))
        assert sum(isinstance(result, list) and len(result) == 2 and result[0] == 1 for result in results) == 1
        assert all(result == 0 or isinstance(result, list) and len(result) == 2 and result[0] == 1 and isinstance(result[1], str) for result in results)
        for field, value in before:
            assert redis.command('HGET', keys[42], field) == value
        claimed = json.loads(redis.command('HGET', keys[42], 'restart-intent:ctr_restart_new'))
        assert claimed['paused'] == pause and claimed['sourceGrant'] == 'ctr_restart_source'
        original = dict(before)
        assert claimed['sourceBinding'] == original['active:restart-store']
        assert claimed['sourceReceipt'] == original['grant:ctr_restart_source']
        assert claimed['restartReceipt'] == original['grant:ctr_restart_new']
        assert claimed['reservedCents'] == 90 and claimed['carriedCents'] == 0 and claimed['annual'] == 1799999000
        winner = next(result for result in results if isinstance(result, list))
        assert winner[1] == redis.command('HGET', keys[42], 'restart-intent:ctr_restart_new')
        assert redis.command('TTL', keys[42]) == -1
        print('PASS:64 actual restart intent contenders produce one immutable owned source/cash snapshot')

        # Unknown acknowledgement is deliberately ignored; all subsequent
        # attempts, including a new nonce and time beyond the window, refuse.
        pause = intent_ready(keys[44], intent_refs[2])
        match = re.search(r'restartIntent:\{[^}]*commandCeiling:(\d+)', rule_source)
        assert match
        intent_ceiling = int(match.group(1))
        first_ack, first = measured_command(redis, lambda: intent_claim(redis, keys[44], intent_refs[2], pause))
        assert first.get('eval') == 1 and sum(first.values()) <= intent_ceiling, first
        assert isinstance(first_ack, list) and len(first_ack) == 2 and first_ack[0] == 1
        assert first_ack[1] == redis.command('HGET', keys[44], 'restart-intent:ctr_restart_new')
        committed = snapshot(keys[44])
        duplicate_ack, duplicate = measured_command(redis, lambda: intent_claim(redis, keys[44], intent_refs[2], pause))
        assert duplicate_ack == 0
        assert duplicate.get('eval') == 1 and sum(duplicate.values()) <= intent_ceiling, duplicate
        assert intent_claim(redis, keys[44], intent_refs[2], pause, claim='claim_after_lost_ack') == 0
        assert intent_claim(redis, keys[44], intent_refs[2], pause, now=1800000301) == 0
        assert snapshot(keys[44]) == committed
        print('MEASURED restart intent commands:first=' + str(first) + ',duplicate=' + str(duplicate) + ',canonical ceiling=' + str(intent_ceiling))
        print('PASS:lost intent ACK never releases money, expires ownership or yields a second permission')

        for scenario in ['policy', 'review', 'pending', 'source', 'activated', 'old-grant',
                         'cash', 'carried', 'ttl', 'pause-missing', 'pause-marker',
                         'due-missing', 'due-score', 'annual-missing', 'raw-mismatch',
                         'expired', 'rollback', 'foreign-source', 'foreign-grant', 'oversize',
                         'extra-request-field', 'enriched-overflow']:
            ref = intent_refs[1]
            pause = intent_ready(keys[43], ref)
            args = {}
            if scenario in ('policy', 'review'):
                redis.command('HSET', keys[43], scenario, 'unknown')
            elif scenario == 'pending':
                redis.command('HSET', keys[43], 'pending:restart-store', 'ctr_foreign')
            elif scenario == 'source':
                redis.command('HSET', keys[43], 'active:restart-store', 'unknown')
            elif scenario == 'activated':
                redis.command('HDEL', keys[43], 'activated:ctr_restart_source')
            elif scenario == 'old-grant':
                redis.command('HDEL', keys[43], 'grant:ctr_restart_source')
            elif scenario == 'cash':
                redis.command('HSET', keys[43], 'reserved', 89)
            elif scenario == 'carried':
                redis.command('HSET', keys[43], 'carried', 1)
            elif scenario == 'ttl':
                redis.command('EXPIRE', keys[43], 60)
            elif scenario == 'pause-missing':
                redis.command('DEL', 'nl:pause:' + ref)
            elif scenario == 'pause-marker':
                pause = pause.replace('"version":1', '"version":2')
                redis.command('SET', 'nl:pause:' + ref, pause)
            elif scenario == 'due-missing':
                redis.command('ZREM', 'nl:pause:due', ref)
            elif scenario == 'due-score':
                redis.command('ZADD', 'nl:pause:due', 1800000002, ref)
            elif scenario == 'annual-missing':
                redis.command('DEL', 'nl:pause:last:' + ref)
            elif scenario == 'raw-mismatch':
                args['raw'] = pause + ' '
            elif scenario == 'expired':
                args['now'] = 1800000301
            elif scenario == 'rollback':
                args['now'] = 1799999999
            elif scenario == 'foreign-source':
                args['source'] = 'sub_ForeignIntent01'
            elif scenario == 'foreign-grant':
                args['source_grant'] = 'ctr_foreign'
            elif scenario == 'oversize':
                args['payload'] = 'x' * 4097
            elif scenario == 'extra-request-field':
                args['extra'] = True
            elif scenario == 'enriched-overflow':
                review = 'R' * 850
                old = redis.command('HGET', keys[43], 'grant:ctr_restart_source').replace('review|', review + '|', 1)
                new = redis.command('HGET', keys[43], 'grant:ctr_restart_new').replace('review|', review + '|', 1)
                assert len(old.encode()) <= 1024 and len(new.encode()) <= 1024
                redis.command('HSET', keys[43], 'review', review, 'grant:ctr_restart_source', old, 'grant:ctr_restart_new', new)
                pause = json.dumps({**json.loads(pause), 'padding': 'x' * 900}, separators=(',', ':'))
                assert len(pause.encode()) <= 1536
                redis.command('SET', 'nl:pause:' + ref, pause)
                args.update(review=review, prove_input_bound=True)
            before = snapshot(keys[43])
            pause_before = redis.command('GET', 'nl:pause:' + ref)
            last_before = redis.command('GET', 'nl:pause:last:' + ref)
            due_before = redis.command('ZSCORE', 'nl:pause:due', ref)
            assert intent_claim(redis, keys[43], ref, pause, **args) == 0, scenario
            assert snapshot(keys[43]) == before, scenario
            assert redis.command('GET', 'nl:pause:' + ref) == pause_before
            assert redis.command('GET', 'nl:pause:last:' + ref) == last_before
            assert redis.command('ZSCORE', 'nl:pause:due', ref) == due_before
        print('PASS:22 unknown, mismatched or over-limit restart intent observations retain exact pause/source/annual/cash evidence')

        for source_action in ('switch', 'restart'):
            ref = intent_refs[1]
            pause = intent_ready(keys[43], ref, source_action)
            before = snapshot(keys[43])
            ack = intent_claim(redis, keys[43], ref, pause)
            assert isinstance(ack, list) and len(ack) == 2 and ack[0] == 1
            owned = json.loads(ack[1])
            prior = dict(before)
            assert owned['sourceReceipt'] == prior['grant:ctr_restart_source']
            assert owned['sourceReceipt'].split('|')[3] == source_action
            assert len(owned['sourceReceipt'].split('|')) == 10
            assert owned['sourceBinding'] == prior['active:restart-store']
            assert owned['reservedCents'] == 100 and owned['carriedCents'] == 0
            assert prior['grant:ctr_upstream_source'].split('|')[4] == '10'
            assert redis.command('HGET', keys[43], 'grant:ctr_upstream_source') == prior['grant:ctr_upstream_source']
            assert redis.command('HGET', keys[43], 'activated:ctr_upstream_source') == prior['activated:ctr_upstream_source']
            assert ack[1] == redis.command('HGET', keys[43], 'restart-intent:ctr_restart_new')
            for field, value in before:
                assert redis.command('HGET', keys[43], field) == value
        print('PASS:owned intent retains exact checkout, switch and prior-restart source receipts without replacing any principal')

        def arm(client, key, ref, pause, **over):
            args = dict(binding='binding', review='review', stats='restart-store', grant='ctr_restart_new',
                        claim='claim_first', now=1800000002, claimed=1800000001, deadline=1800000300,
                        raw=pause, source=json.loads(client.command('HGET', key, 'restart-intent:ctr_restart_new'))['sourceBinding'],
                        price='price_SyntheticRestart01', digest='a' * 64)
            args.update(over)
            return client.command(
                'EVAL', arm_script, 4, key, 'nl:pause:' + ref, 'nl:pause:due', 'nl:pause:last:' + ref,
                args['binding'], args['review'], args['stats'], args['grant'], args['claim'], args['now'],
                args['claimed'], args['deadline'], ref, args['raw'], args['source'], args['price'], args['digest'])
        ref = intent_refs[0]
        pause = intent_ready(keys[42], ref)
        assert intent_claim(redis, keys[42], ref, pause)[0] == 1
        before = snapshot(keys[42])
        original_intent = json.loads(redis.command('HGET', keys[42], 'restart-intent:ctr_restart_new'))
        # Capture the source before measuring actual Redis commands.
        binding = original_intent['sourceBinding']
        def arm_direct(client):
            return client.command('EVAL', arm_script, 4, keys[42], 'nl:pause:' + ref,
                                  'nl:pause:due', 'nl:pause:last:' + ref,
                                  'binding','review','restart-store','ctr_restart_new','claim_first',
                                  1800000002,1800000001,1800000300,ref,pause,binding,
                                  'price_SyntheticRestart01','a' * 64)
        armed_ack, first_arm_counts = measured_command(redis, lambda: arm_direct(redis))
        assert sum(first_arm_counts.values()) <= intent_ceiling
        assert armed_ack[0] == 1
        # Deliberately ignore first ACK: all contenders must refuse permanently.
        def duplicate_arm(_index):
            client = Redis()
            try:
                return arm_direct(client)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            assert list(pool.map(duplicate_arm, range(64))) == [0] * 64
        stored = json.loads(redis.command('HGET', keys[42], 'restart-intent:ctr_restart_new'))
        assert stored.pop('submission') == dict(version=1,phase='uncertain',priceId='price_SyntheticRestart01',
                                               bodyHash='a' * 64,armedAt=1800000002,
                                               idempotencyKey='restart:ctr_restart_new:claim_first')
        assert stored == original_intent
        assert armed_ack[1] == redis.command('HGET', keys[42], 'restart-intent:ctr_restart_new')
        for field, value in before:
            if field != 'restart-intent:ctr_restart_new':
                assert redis.command('HGET', keys[42], field) == value
        assert redis.command('TTL', keys[42]) == -1
        print('PASS:actual permanent submission barrier retains all source/cash fields and refuses64duplicates after ignoredACK')
        print('RESTART_SUBMISSION_BARRIER_COMMANDS:' + json.dumps(first_arm_counts, sort_keys=True))

        race_ref = intent_refs[2]
        race_pause = intent_ready(keys[44], race_ref)
        assert intent_claim(redis, keys[44], race_ref, race_pause)[0] == 1
        race_original = json.loads(redis.command('HGET', keys[44], 'restart-intent:ctr_restart_new'))
        def first_arm_race(_index):
            client = Redis()
            try:
                return arm(client, keys[44], race_ref, race_pause)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            raced = list(pool.map(first_arm_race, range(64)))
        assert sum(isinstance(value,list) and value[0] == 1 for value in raced) == 1
        race_stored = json.loads(redis.command('HGET', keys[44], 'restart-intent:ctr_restart_new'))
        assert race_stored.pop('submission')['phase'] == 'uncertain'
        assert race_stored == race_original
        assert arm(redis, keys[44], race_ref, race_pause, claim='claim_new') == 0
        print('PASS:64 actual first submission contenders produce exactly one durable barrier ACK;new claim cannot rearm')

        for scenario in ('claim','binding','review','deadline','rollback','price','digest','pause','due','annual','annual-changed','source','pending','cash','overflow','owner-index'):
            ref = intent_refs[1]
            pause = intent_ready(keys[43], ref)
            assert intent_claim(redis, keys[43], ref, pause)[0] == 1
            over = {}
            if scenario == 'claim': over['claim'] = 'claim_foreign'
            elif scenario == 'binding': over['binding'] = 'changed'
            elif scenario == 'review': over['review'] = 'changed'
            elif scenario == 'deadline': over['now'] = 1800000301
            elif scenario == 'rollback': over['now'] = 1800000000
            elif scenario == 'price': over['price'] = 'not-a-price'
            elif scenario == 'digest': over['digest'] = 'z' * 64
            elif scenario == 'pause': redis.command('SET', 'nl:pause:' + ref, pause + ' ')
            elif scenario == 'due': redis.command('ZADD', 'nl:pause:due', 1800000003, ref)
            elif scenario == 'annual': redis.command('DEL', 'nl:pause:last:' + ref)
            elif scenario == 'annual-changed': redis.command('SET', 'nl:pause:last:' + ref, '1799999999')
            elif scenario == 'source': redis.command('HSET', keys[43], 'active:restart-store', 'changed')
            elif scenario == 'pending': redis.command('HSET', keys[43], 'pending:restart-store', 'ctr_other')
            elif scenario == 'cash': redis.command('HSET', keys[43], 'reserved', 89)
            elif scenario == 'owner-index': redis.command('HSET',keys[43],'restart-owner:ctr_restart_source','ctr_foreign')
            elif scenario == 'overflow':
                raw = redis.command('HGET', keys[43], 'restart-intent:ctr_restart_new')
                redis.command('HSET', keys[43], 'restart-intent:ctr_restart_new', raw + ' ' * 4097)
            snapshot_before = snapshot(keys[43])
            assert arm(redis, keys[43], ref, pause, **over) == 0, scenario
            assert snapshot(keys[43]) == snapshot_before, scenario
        print('PASS:16 foreign, stale, changed, incomplete, annual generation, index and oversize barrier cases preserve exact ledger evidence')

        # A result ID is evidence, not a new submission or rights activation.
        # Policy/month/deadline changes must not discard an already observed ID.
        ref = intent_refs[0]
        pause = intent_ready(keys[42], ref)
        assert intent_claim(redis, keys[42], ref, pause)[0] == 1
        assert arm(redis, keys[42], ref, pause)[0] == 1
        redis.command('HSET', keys[42], 'policy', 'next-month-policy', 'review', 'next-month-review')
        before_result = snapshot(keys[42])
        original = json.loads(redis.command('HGET', keys[42], 'restart-intent:ctr_restart_new'))
        def record_result(client, subscription='sub_ObservedRestart01', **over):
            options = dict(grant='ctr_restart_new', review='review', stats='restart-store',
                           claim='claim_first', price='price_SyntheticRestart01', digest='a' * 64,
                           now=1803000000, armed=1800000002)
            options.update(over)
            return client.command('EVAL', result_script, 1, keys[42],
                                  options['grant'],options['review'],options['stats'],options['claim'],
                                  options['price'],options['digest'],subscription,options['now'],options['armed'])
        measured_ack, record_counts = measured_command(redis, lambda: record_result(redis))
        assert measured_ack == 1
        assert sum(record_counts.values()) <= 17
        known = json.loads(redis.command('HGET', keys[42], 'restart-intent:ctr_restart_new'))
        assert known['submission']['phase'] == 'observed'
        assert known['submission']['subscriptionId'] == 'sub_ObservedRestart01'
        assert known['submission']['observedAt'] == 1803000000
        expected_submission = {**original['submission'], 'phase':'observed',
                               'subscriptionId':'sub_ObservedRestart01','observedAt':1803000000}
        assert known.pop('submission') == expected_submission
        assert known == {name:value for name,value in original.items() if name != 'submission'}
        stored_before_duplicates = snapshot(keys[42])
        def result_duplicate(_index):
            client = Redis()
            try:
                return record_result(client)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            assert list(pool.map(result_duplicate, range(64))) == [2] * 64
        assert snapshot(keys[42]) == stored_before_duplicates
        assert record_result(redis, 'sub_ForeignResult01') == 0
        for field,value in [('grant','ctr_foreign'),('review','foreign'),('stats','foreign'),
                            ('claim','claim_foreign'),('price','price_Foreign01'),('digest','b'*64),
                            ('now',1800000001),('armed',1800000001)]:
            assert record_result(redis, **{field:value}) == 0, field
            assert snapshot(keys[42]) == stored_before_duplicates
        for field,value in before_result:
            if field != 'restart-intent:ctr_restart_new':
                assert redis.command('HGET', keys[42], field) == value
        assert redis.command('TTL', keys[42]) == -1
        print('PASS:durable result ID retained after deadline/policy-month change;64sameIDduplicates are evidence ACK2 only;foreign IDs/owners refuse')
        print('RESTART_RESULT_COMMANDS:' + json.dumps(record_counts, sort_keys=True))

        def recovery(client, key, record_ref, pause, **over):
            options = dict(stats='restart-store',source='sub_RestartSource01',source_grant='ctr_restart_source',
                           ref=record_ref,handle='synthetic-store',raw=pause,now=1800000003,binding='binding',review='review')
            options.update(over)
            return client.command('EVAL',recovery_script,4,key,'nl:pause:'+record_ref,'nl:pause:due','nl:pause:last:'+record_ref,
                                  *[options[name] for name in ('stats','source','source_grant','ref','handle','raw','now','binding','review')])
        ref = intent_refs[0]
        pause = intent_ready(keys[42],ref)
        # Fresh synthetic source with no reservation or intent, not a release
        # operation: seed only this generated fixture ledger from its origin.
        seed_restart(keys[42])
        before = snapshot(keys[42])
        assert recovery(redis,keys[42],ref,pause) == ['absent']
        assert snapshot(keys[42]) == before
        assert recovery(redis,keys[42],ref,pause,binding='old-policy') == 0
        assert take_restart(redis,keys[42]) == 1
        assert recovery(redis,keys[42],ref,pause) == 0  # pre-index pending is unknown
        assert intent_claim(redis,keys[42],ref,pause)[0] == 1
        assert redis.command('HGET',keys[42],'restart-owner:ctr_restart_source') == 'ctr_restart_new'
        assert recovery(redis,keys[42],ref,pause) == ['held']  # claim ACK lost before arm
        index_before = snapshot(keys[42])
        redis.command('HDEL',keys[42],'pending:restart-store')
        without_pending = snapshot(keys[42])
        assert take_restart(redis,keys[42],nonce='ctr_new_owner') == 0
        assert snapshot(keys[42]) == without_pending
        assert recovery(redis,keys[42],ref,pause) == 0
        redis.command('HSET',keys[42],'pending:restart-store','ctr_restart_new')
        assert snapshot(keys[42]) == index_before
        assert arm(redis,keys[42],ref,pause)[0] == 1
        before_recovery = snapshot(keys[42])
        initial = json.loads(redis.command('HGET',keys[42],'restart-intent:ctr_restart_new'))
        first_recovery, recovery_counts = measured_command(redis, lambda: recovery(redis, keys[42], ref, pause))   # Deliberately ignore this provider-read allowance.
        assert first_recovery[0] == 'read'
        assert sum(recovery_counts.values()) <= 17
        def recovery_race(_index):
            client = Redis()
            try:
                return recovery(client,keys[42],ref,pause)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            attempts = list(pool.map(recovery_race,range(64)))
        assert sum(value[0] == 'read' for value in attempts) == 2
        assert sum(value == ['held'] for value in attempts) == 62
        after = json.loads(redis.command('HGET',keys[42],'restart-intent:ctr_restart_new'))
        assert after['submission']['recoveryReads'] == 3
        assert after['submission']['lastRecoveryAt'] == 1800000003
        assert after['submission']['phase'] == 'uncertain'
        after['submission'].pop('recoveryReads')
        after['submission'].pop('lastRecoveryAt')
        assert after == initial
        for field,value in before_recovery:
            if field != 'restart-intent:ctr_restart_new':
                assert redis.command('HGET',keys[42],field) == value
        assert recovery(redis,keys[42],ref,pause,now=1803000000) == ['held']
        assert arm(redis,keys[42],ref,pause) == 0
        print('PASS:permanent source index blocks a new owner even without pending;ignored recoveryACK+64contenders consume at most3lifetime provider reads')
        print('RESTART_RECOVERY_COMMANDS:'+json.dumps(recovery_counts,sort_keys=True))

        for scenario in ('raw','ref','handle','source','grant','due','annual','annual-changed','cash','index','rollback'):
            ref = intent_refs[1]
            pause = intent_ready(keys[43],ref)
            assert intent_claim(redis,keys[43],ref,pause)[0] == 1
            assert arm(redis,keys[43],ref,pause)[0] == 1
            over = {}
            if scenario == 'raw': over['raw'] = pause+' '
            elif scenario == 'ref': over['ref'] = 'foreign'
            elif scenario == 'handle': over['handle'] = 'foreign-store'
            elif scenario == 'source': over['source'] = 'sub_ForeignRecover01'
            elif scenario == 'grant': over['source_grant'] = 'ctr_foreign'
            elif scenario == 'due': redis.command('ZADD','nl:pause:due',1800000004,ref)
            elif scenario == 'annual': redis.command('DEL','nl:pause:last:'+ref)
            elif scenario == 'annual-changed': redis.command('SET','nl:pause:last:'+ref,'1799999999')
            elif scenario == 'cash': redis.command('HSET',keys[43],'reserved',89)
            elif scenario == 'index': redis.command('HSET',keys[43],'restart-owner:ctr_restart_source','ctr_missing')
            elif scenario == 'rollback': over['now'] = 1800000001
            before = snapshot(keys[43])
            assert recovery(redis,keys[43],ref,pause,**over) == 0,scenario
            assert snapshot(keys[43]) == before,scenario
        print('PASS:11unknown/foreign/missing/annual-generation/cash/clock recovery cases retain every ledger field')

        ref = intent_refs[0]
        pause = intent_ready(keys[42],ref)
        assert intent_claim(redis,keys[42],ref,pause)[0] == 1
        assert arm(redis,keys[42],ref,pause)[0] == 1
        assert record_result(redis) == 1
        redis.command('HSET',keys[42],'policy','changed-after-submission','review','changed-after-submission')
        known_before = snapshot(keys[42])
        acknowledged = recovery(redis,keys[42],ref,pause,now=1803000001,binding='',review='')
        assert acknowledged[0] == 'read'
        known = json.loads(acknowledged[1])
        assert known['submission']['phase'] == 'observed'
        assert known['submission']['subscriptionId'] == 'sub_ObservedRestart01'
        assert known['submission']['recoveryReads'] == 1
        for field,value in known_before:
            if field != 'restart-intent:ctr_restart_new':
                assert redis.command('HGET',keys[42],field) == value
        print('PASS:known durable result ID remains readable after policy/month/deadline without creating submission permission')


        # New closed activation stage: actual application Lua, not a mocked
        # financial approval. Reuse existing owned synthetic keys and pause.
        def activation_ready():
            owner_ref = intent_refs[0]
            owner_pause = intent_ready(keys[42],owner_ref)
            assert intent_claim(redis,keys[42],owner_ref,owner_pause)[0] == 1
            assert arm(redis,keys[42],owner_ref,owner_pause)[0] == 1
            assert record_result(redis,now=1800000003) == 1
            owner = json.loads(redis.command('HGET',keys[42],'restart-intent:ctr_restart_new'))
            submission = owner.pop('submission')
            sent = {field:submission[field] for field in ('priceId','bodyHash','idempotencyKey','armedAt')}
            observed = dict(id='sub_ObservedRestart01',created=1800000003,start=1800000003,finish=1801000000,renews=True,shared=False)
            return owner_ref,owner_pause,owner,sent,observed
        def activate_restart(client,fixture,**over):
            owner_ref,owner_pause,owner,sent,observed = fixture
            args = dict(binding='binding',review='review',expected=owner,sent=sent,observed=observed,
                        now=1800000004,minimum=50,limit=140,carry=0,funded=2,span=31*86400)
            args.update(over)
            return client.command('EVAL',restart_activation_script,4,keys[42],
                                  'nl:pause:'+owner_ref,'nl:pause:due','nl:pause:last:'+owner_ref,
                                  args['binding'],args['review'],json.dumps(args['expected'],separators=(',',':')),
                                  json.dumps(args['sent'],separators=(',',':')),json.dumps(args['observed'],separators=(',',':')),
                                  args['now'],args['minimum'],args['limit'],args['carry'],args['funded'],args['span'])
        fixture = activation_ready()
        before = snapshot(keys[42])
        ignored, activation_counts = measured_command(redis, lambda: activate_restart(redis, fixture))  # Deliberately lose first ACK.
        assert ignored == [1,1800086400]
        assert sum(activation_counts.values()) <= 17
        new_binding = 'ctr_restart_new|sub_ObservedRestart01|creator_month|1800000003|paid|1800000003|1801000000'
        assert redis.command('HGET',keys[42],'activated:ctr_restart_new') == new_binding
        assert redis.command('HGET',keys[42],'active:restart-store') == new_binding
        publication_raw = redis.command('HGET',keys[42],'restart-publication:ctr_restart_new')
        assert len(publication_raw.encode('utf-8')) <= 384
        assert json.loads(publication_raw) == dict(version=1,binding=new_binding,renews=True,shared=False)
        for field,value in before:
            if field not in ('active:restart-store','restart-intent:ctr_restart_new'):
                assert redis.command('HGET',keys[42],field) == value
            elif field=='restart-intent:ctr_restart_new':
                retained=json.loads(redis.command('HGET',keys[42],field))
                assert retained['submission'].pop('publication') == dict(renews=True,shared=False)
                assert retained == json.loads(value)
        assert redis.command('HGET',keys[42],'pending:restart-store') == 'ctr_restart_new'
        assert redis.command('GET','nl:pause:'+fixture[0]) == fixture[1]
        def activation_retry(_index):
            client = Redis()
            try:
                return activate_restart(client,fixture,now=1800086401)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            assert list(pool.map(activation_retry,range(64))) == [[2,1801000000]]*64
        print('PASS:restart activation lostACK plus64late observations retain exact binding,pending,pause,source and all cash')
        print('RESTART_ACTIVATION_COMMANDS:'+json.dumps(activation_counts,sort_keys=True))
        fixture = activation_ready()
        def first_activation_race(_index):
            client = Redis()
            try:
                return activate_restart(client,fixture)
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(first_activation_race,range(64)))
        assert results.count([1,1800086400]) == 1
        assert results.count([2,1801000000]) == 63
        assert redis.command('HGET',keys[42],'reserved') == '90'
        assert redis.command('HGET',keys[42],'slots:creator_month') == '1'
        print('PASS:64first restart activation contenders produce exactly1committed binding without releasing or reusing principal')

        for scenario in ('raw','ref','claim','price','digest','id','source-id','created','period','span',
                         'deadline','pending','index','source','receipt','cash','slots','policy','due','annual','annual-changed','ttl','phase'):
            fixture = activation_ready()
            owner_ref,owner_pause,owner,sent,observed = fixture
            over = {}
            if scenario in ('raw','ref','claim'):
                changed = dict(owner)
                changed[dict(raw='paused',ref='ref',claim='claim')[scenario]] = owner['paused']+' ' if scenario=='raw' else 'foreign'
                over['expected'] = changed
            elif scenario in ('price','digest'):
                over['sent'] = {**sent,dict(price='priceId',digest='bodyHash')[scenario]:'price_ForeignActivation01' if scenario=='price' else 'b'*64}
            elif scenario in ('id','source-id','created','period','span'):
                changes = {'id':dict(id='sub_ForeignActivation01'),'source-id':dict(id=owner['sourceSubscription']),
                           'created':dict(created=1800000001),'period':dict(start=1800000002),'span':dict(finish=1804000000)}
                over['observed'] = {**observed,**changes[scenario]}
            elif scenario=='deadline': over['now'] = 1800086401
            elif scenario=='pending': redis.command('HDEL',keys[42],'pending:restart-store')
            elif scenario=='index': redis.command('HSET',keys[42],'restart-owner:ctr_restart_source','ctr_foreign')
            elif scenario=='source': redis.command('HSET',keys[42],'activated:ctr_restart_source','foreign')
            elif scenario=='receipt': redis.command('HSET',keys[42],'grant:ctr_restart_source','foreign')
            elif scenario=='cash': redis.command('HSET',keys[42],'reserved',89)
            elif scenario=='slots': redis.command('HSET',keys[42],'slots:creator_month',0)
            elif scenario=='policy': redis.command('HSET',keys[42],'policy','foreign')
            elif scenario=='due': redis.command('ZADD','nl:pause:due',1800000002,owner_ref)
            elif scenario=='annual': redis.command('DEL','nl:pause:last:'+owner_ref)
            elif scenario=='annual-changed': redis.command('SET','nl:pause:last:'+owner_ref,'1799999999')
            elif scenario=='ttl': redis.command('EXPIRE',keys[42],300)
            elif scenario=='phase':
                retained = json.loads(redis.command('HGET',keys[42],'restart-intent:ctr_restart_new'))
                retained['submission']['phase'] = 'uncertain'
                redis.command('HSET',keys[42],'restart-intent:ctr_restart_new',json.dumps(retained,separators=(',',':')))
            before = snapshot(keys[42])
            evidence = [redis.command('GET','nl:pause:'+owner_ref),redis.command('GET','nl:pause:last:'+owner_ref),
                        redis.command('ZSCORE','nl:pause:due',owner_ref)]
            assert activate_restart(redis,fixture,**over) == 0,scenario
            assert snapshot(keys[42]) == before,scenario
            assert [redis.command('GET','nl:pause:'+owner_ref),redis.command('GET','nl:pause:last:'+owner_ref),
                    redis.command('ZSCORE','nl:pause:due',owner_ref)] == evidence,scenario
        print('PASS:23foreign/unknown/late/annual-generation restart activation cases preserve every field and pause/year/due')


        for scenario in ('unbacked-checkpoint','unbacked-intent-flags'):
            fixture = activation_ready()
            if scenario=='unbacked-checkpoint':
                redis.command('HSET',keys[42],'restart-publication:ctr_restart_new',json.dumps(dict(version=1,binding=new_binding,renews=True,shared=False),separators=(',',':')))
            else:
                retained=json.loads(redis.command('HGET',keys[42],'restart-intent:ctr_restart_new'))
                retained['submission']['publication']=dict(renews=True,shared=False)
                redis.command('HSET',keys[42],'restart-intent:ctr_restart_new',json.dumps(retained,separators=(',',':')))
            state=snapshot(keys[42])
            assert activate_restart(redis,fixture)==0,scenario
            assert snapshot(keys[42])==state,scenario
        print('PASS:unbacked publication checkpoint or intent flags cannot authorize first activation or backfill')
        
        # The exact Store handoff is committed with activation, never inferred later.
        for renews in (False,True):
            for shared in (False,True):
                fixture = activation_ready()
                observed = {**fixture[4],'renews':renews,'shared':shared}
                fixture = (*fixture[:4],observed)
                assert activate_restart(redis,fixture) == [1,1800086400]
                expected_checkpoint = dict(version=1,binding=new_binding,renews=renews,shared=shared)
                checkpoint_raw = redis.command('HGET',keys[42],'restart-publication:ctr_restart_new')
                assert len(checkpoint_raw.encode('utf-8')) <= 384
                assert json.loads(checkpoint_raw) == expected_checkpoint
                state = snapshot(keys[42])
                assert activate_restart(redis,fixture,now=1800086401) == [2,1801000000]
                assert snapshot(keys[42]) == state
                for field in ('renews','shared'):
                    assert activate_restart(redis,fixture,observed={**observed,field:not observed[field]}) == 0
                    assert snapshot(keys[42]) == state
        for field in ('renews','shared'):
            for value in (None,'false',0):
                fixture = activation_ready()
                before = snapshot(keys[42])
                assert activate_restart(redis,fixture,observed={**fixture[4],field:value}) == 0
                assert snapshot(keys[42]) == before
        for scenario in ('missing','foreign-binding','extra-field','wrong-version','unknown-renews','unknown-shared','opposite-renews','opposite-shared'):
            fixture = activation_ready()
            assert activate_restart(redis,fixture) == [1,1800086400]
            checkpoint = json.loads(redis.command('HGET',keys[42],'restart-publication:ctr_restart_new'))
            if scenario=='missing':
                redis.command('HDEL',keys[42],'restart-publication:ctr_restart_new')
            else:
                changes={'foreign-binding':{'binding':'foreign'},'extra-field':{'extra':True},'wrong-version':{'version':2},
                         'unknown-renews':{'renews':'true'},'unknown-shared':{'shared':None},
                         'opposite-renews':{'renews':False},'opposite-shared':{'shared':True}}
                checkpoint.update(changes[scenario])
                redis.command('HSET',keys[42],'restart-publication:ctr_restart_new',json.dumps(checkpoint,separators=(',',':')))
            state = snapshot(keys[42])
            assert activate_restart(redis,fixture,now=1800086401) == 0,scenario
            assert snapshot(keys[42]) == state,scenario
            result = recovery(redis,keys[42],fixture[0],fixture[1],now=1800086402)
            assert result==0,scenario
            assert snapshot(keys[42]) == state,scenario
        print('PASS:publication checkpoint stores4explicit renewal/share combinations,exact lostACK replay,6unknown flag refusals and8missing/foreign/changed checkpoint cases without backfill')
        
        # Committed paid evidence is a local observation, not another provider read.
        for consumed in (0,1,3):
            fixture = activation_ready()
            assert activate_restart(redis,fixture) == [1,1800086400]
            raw_owner = json.loads(redis.command('HGET',keys[42],'restart-intent:ctr_restart_new'))
            if consumed:
                raw_owner['submission']['recoveryReads'] = consumed
                raw_owner['submission']['lastRecoveryAt'] = 1800000004
                redis.command('HSET',keys[42],'restart-intent:ctr_restart_new',json.dumps(raw_owner,separators=(',',':')))
            state = snapshot(keys[42])
            evidence = [redis.command('GET','nl:pause:'+fixture[0]),redis.command('GET','nl:pause:last:'+fixture[0]),redis.command('ZSCORE','nl:pause:due',fixture[0])]
            ignored, activated_recovery_counts = measured_command(redis, lambda: recovery(redis, keys[42], fixture[0], fixture[1], now=1800086402))  # Lose ACK.
            assert ignored[0] == 'activated' and ignored[2] == new_binding
            assert sum(activated_recovery_counts.values()) <= 17
            assert activated_recovery_counts.get('hset',0) == 0
            assert json.loads(ignored[1]) == raw_owner
            assert json.loads(ignored[3]) == dict(version=1,binding=new_binding,renews=True,shared=False)
            def after_activation_recovery(_index):
                client = Redis()
                try:
                    return recovery(client,keys[42],fixture[0],fixture[1],now=1800086402)
                finally:
                    client.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                attempts = list(pool.map(after_activation_recovery,range(64)))
            assert all(value == ignored for value in attempts)
            assert snapshot(keys[42]) == state
            assert [redis.command('GET','nl:pause:'+fixture[0]),redis.command('GET','nl:pause:last:'+fixture[0]),redis.command('ZSCORE','nl:pause:due',fixture[0])] == evidence
            assert arm(redis,keys[42],fixture[0],fixture[1],now=1800086402) == 0
        print('PASS:activated owner lostACK plus64contenders at0/1/3consumed reads retain every field and return exact paid evidence without HSET,provider-read entitlement,POST,rearm or cleanup')
        print('ACTIVATED_RESTART_RECOVERY_COMMANDS:'+json.dumps(activated_recovery_counts,sort_keys=True))

        for scenario in ('missing-activated','active-foreign','active-unbacked','source-proof','future-created','wrong-period','wrong-key','reverted-active','expired-paid-period','corrupt-read-count','boolean-read-count'):
            fixture = activation_ready()
            assert activate_restart(redis,fixture) == [1,1800086400]
            current = redis.command('HGET',keys[42],'active:restart-store')
            if scenario=='expired-paid-period':
                fields=current.split('|');fields[6]='1800086402'
                changed='|'.join(fields)
                redis.command('HSET',keys[42],'active:restart-store',changed,'activated:ctr_restart_new',changed)
            elif scenario in ('corrupt-read-count','boolean-read-count'):
                malformed=json.loads(redis.command('HGET',keys[42],'restart-intent:ctr_restart_new'))
                malformed['submission']['recoveryReads']=False if scenario=='boolean-read-count' else 4
                redis.command('HSET',keys[42],'restart-intent:ctr_restart_new',json.dumps(malformed,separators=(',',':')))
            elif scenario=='missing-activated': redis.command('HDEL',keys[42],'activated:ctr_restart_new')
            elif scenario=='active-foreign': redis.command('HSET',keys[42],'active:restart-store',current.replace('sub_ObservedRestart01','sub_ForeignActive01'))
            elif scenario=='active-unbacked': redis.command('HSET',keys[42],'active:restart-store',current+'|extra')
            elif scenario=='source-proof': redis.command('HDEL',keys[42],'activated:ctr_restart_source')
            elif scenario=='reverted-active': redis.command('HSET',keys[42],'active:restart-store',owner['sourceBinding'])
            else:
                fields = current.split('|')
                if scenario=='future-created': fields[3]='1801000001'
                elif scenario=='wrong-period': fields[5]='1800000002'
                elif scenario=='wrong-key': fields[2]='pro_month'
                changed = '|'.join(fields)
                redis.command('HSET',keys[42],'active:restart-store',changed,'activated:ctr_restart_new',changed)
            before = snapshot(keys[42])
            assert recovery(redis,keys[42],fixture[0],fixture[1],now=1800086402) == 0,scenario
            assert snapshot(keys[42]) == before,scenario
        print('PASS:11unknown/expired activated-binding recovery cases cannot spend a read allowance or change the ledger')

        # A legitimate full31day paid month starts when the provider creates
        # the replacement, not a few seconds before at intent claim time.
        fixture = activation_ready()
        ref,pause,owner,sent,observed = fixture
        observed = {**observed,'finish':observed['start']+31*86400}
        monthly = (ref,pause,owner,sent,observed)
        assert activate_restart(redis,monthly) == [1,1800086400]
        assert redis.command('HGET',keys[42],'reserved') == '90'
        assert redis.command('HGET',keys[42],'slots:creator_month') == '1'
        print('PASS:full31day provider period fits explicit prefunded receipt horizon without truncating paid rights')


        # The actual strict Store CAS primitive never retries an EVAL as GET/SET.
        lock_source = (Path(__file__).resolve().parents[1] / 'lib/redis-lock.ts').read_text(encoding='utf-8')
        strict_match = re.search(r'export const STRICT_FENCED_CAS = `([^`]+)`;', lock_source)
        if not strict_match or '$' + '{' in strict_match.group(1):
            raise RuntimeError('Expected static application strict fenced CAS Lua')
        strict_script = strict_match.group(1)
        lock_key, value_key = keys[0], keys[1]
        def seed_strict(before='before'):
            redis.command('DEL', lock_key, value_key)
            redis.command('SET', lock_key, 'owned-token', 'PX', 60000)
            redis.command('SET', value_key, before)
        def strict_cas(client, before='before', after='after', limit=1000000, token='owned-token'):
            return client.command('EVAL', strict_script, 2, lock_key, value_key, token, before, after, limit)
        def strict_record(key):
            kind = redis.command('TYPE', key)
            if kind == 'string': return kind, redis.command('GET', key)
            if kind == 'hash': return kind, snapshot(key)
            return kind, None
        def strict_contender(after):
            client = Redis()
            try:
                return strict_cas(client, after=after)
            finally:
                client.close()
        seed_strict()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            answers = list(pool.map(strict_contender, ['after-' + str(i) for i in range(64)]))
        assert answers.count(1) == 1 and answers.count(0) == 63, answers
        assert redis.command('GET', value_key).startswith('after-')
        seed_strict()
        assert strict_cas(redis) == 1  # Ignore this ACK, as if the client lost it.
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            recovered = list(pool.map(strict_contender, ['after'] * 64))
        assert recovered == [2] * 64, recovered
        assert redis.command('GET', value_key) == 'after'
        print('PASS:strict CAS64different contenders permit one write; ignored ACK64identical recoveries never write again')

        for refusal in ('foreign-token','expired-lock','permanent-lock','expiring-record','wrong-lock-type','wrong-record-type','stale-record','oversize-before','oversize-after','fractional-limit','too-large-limit'):
            seed_strict()
            before, after, limit, token = 'before', 'after', 1000000, 'owned-token'
            if refusal=='foreign-token': token='foreign-token'
            elif refusal=='expired-lock': redis.command('PEXPIREAT', lock_key, 1)
            elif refusal=='permanent-lock': redis.command('PERSIST', lock_key)
            elif refusal=='expiring-record': redis.command('PEXPIRE', value_key, 60000)
            elif refusal=='wrong-lock-type':
                redis.command('DEL', lock_key); redis.command('HSET', lock_key, 'field', 'kept')
            elif refusal=='wrong-record-type':
                redis.command('DEL', value_key); redis.command('HSET', value_key, 'field', 'kept')
            elif refusal=='stale-record': redis.command('SET', value_key, 'newer')
            elif refusal=='oversize-before': before='x' * 9; limit=8
            elif refusal=='oversize-after': after='x' * 9; limit=8
            elif refusal=='fractional-limit': limit='8.5'
            elif refusal=='too-large-limit': limit=1000001
            kept_lock, kept_value = strict_record(lock_key), strict_record(value_key)
            assert strict_cas(redis, before, after, limit, token) == 0, refusal
            assert strict_record(lock_key) == kept_lock, refusal
            assert strict_record(value_key) == kept_value, refusal
        seed_strict('éé')
        assert strict_cas(redis, 'éé', 'after', 3) == 0
        assert redis.command('GET', value_key) == 'éé'
        seed_strict()
        assert strict_cas(redis) == 1
        redis.command('SET', value_key, 'newer-write-after-ack-loss')
        assert strict_cas(redis) == 0
        assert redis.command('GET', value_key) == 'newer-write-after-ack-loss'
        print('PASS:strict CAS11invalid/expired/type/budget cases,UTF8bytes and newer-write recovery preserve exact values')

        seed_strict()
        measured_ack, strict_counts = measured_command(redis, lambda: strict_cas(redis))
        assert measured_ack == 1
        assert sum(strict_counts.values()) <= 8, strict_counts
        print('PASS:actual strict CAS INFO commands=' + json.dumps(strict_counts,sort_keys=True))


        strict_release_match = re.search(r'export const STRICT_RELEASE_LOCK = `([^`]+)`;', lock_source)
        if not strict_release_match or '$' + '{' in strict_release_match.group(1):
            raise RuntimeError('Expected static application strict release Lua')
        strict_release_script = strict_release_match.group(1)
        def release_strict(client, token='owned-token'):
            return client.command('EVAL', strict_release_script, 1, lock_key, token)
        def release_contender(token):
            client = Redis()
            try:
                return release_strict(client, token)
            finally:
                client.close()
        seed_strict()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            released = list(pool.map(release_contender, ['owned-token'] * 64))
        assert released.count(1) == 1 and released.count(0) == 63, released
        assert redis.command('GET', lock_key) is None
        seed_strict()
        assert release_strict(redis) == 1  # Client loses this acknowledgement.
        redis.command('SET', lock_key, 'new-owner-token', 'PX', 60000)
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            old_owner_retries = list(pool.map(release_contender, ['owned-token'] * 64))
        assert old_owner_retries == [0] * 64, old_owner_retries
        assert redis.command('GET', lock_key) == 'new-owner-token'
        assert redis.command('GET', value_key) == 'before'
        print('PASS:strict release64contenders delete once;64old-owner retries after lost ACK preserve new owner and Store')

        for scenario in ('wrong-token','oversize-token','permanent','expired','hash'):
            seed_strict()
            token='owned-token'
            if scenario=='wrong-token': token='foreign-token'
            elif scenario=='oversize-token': token='x' * 129
            elif scenario=='permanent': redis.command('PERSIST', lock_key)
            elif scenario=='expired': redis.command('PEXPIREAT', lock_key, 1)
            elif scenario=='hash':
                redis.command('DEL', lock_key); redis.command('HSET', lock_key, 'kept', 'record')
            before_lock, before_store = strict_record(lock_key), strict_record(value_key)
            assert release_strict(redis, token) == 0, scenario
            assert strict_record(lock_key) == before_lock, scenario
            assert strict_record(value_key) == before_store, scenario
        seed_strict()
        measured_ack, release_counts = measured_command(redis, lambda: release_strict(redis))
        assert measured_ack == 1
        assert sum(release_counts.values()) <= 5, release_counts
        print('PASS:strict release5negative cases and actual INFO commands=' + json.dumps(release_counts,sort_keys=True))


        pause_source = (Path(__file__).resolve().parents[1] / 'lib/plan-pause.ts').read_text(encoding='utf-8')
        observation_match = re.search(r'export const PAUSE_OBSERVATION = `([^`]+)`;', pause_source)
        assert observation_match and chr(36) + '{' not in observation_match.group(1)
        observation_script = observation_match.group(1)
        observation_key = prefix + ':bounded-pause'
        keys.append(observation_key)
        def observe_pause():
            return redis.command('EVAL', observation_script, 1, observation_key)
        assert observe_pause() == [0]
        for value in ('', 'x' * 4097, 'é' * 2049):
            redis.command('SET', observation_key, value, 'EX', 600)
            measured_ack, observed_counts = measured_command(redis, lambda: observe_pause())
            assert measured_ack == [-1]
            assert sum(observed_counts.values()) <= 3, observed_counts
            assert redis.command('GET', observation_key) == value
            assert 0 < redis.command('TTL', observation_key) <= 600
        for value in ('x' * 4096, 'é' * 2048, '{"unknownCreatorField":[],"funding":{"version":1}}'):
            redis.command('SET', observation_key, value)
            measured_ack, observed_counts = measured_command(redis, lambda: observe_pause())
            assert measured_ack == [1, value]
            assert sum(observed_counts.values()) <= 3, observed_counts
            assert redis.command('GET', observation_key) == value
        redis.command('DEL', observation_key)
        redis.command('HSET', observation_key, 'foreign', 'value')
        assert observe_pause() == [-1]
        assert redis.command('HGET', observation_key, 'foreign') == 'value'
        redis.command('DEL', observation_key)
        assert observe_pause() == [0]
        print('PASS:bounded pause observation distinguishes absent,empty,wrongtype,oversize;4096byte ASCII/UTF8 exact;no writes or TTL change;actual commands=' + json.dumps(observed_counts, sort_keys=True))


        due_observation_match = re.search(r'export const PAUSE_DUE_OBSERVATION = `([^`]+)`;', pause_source)
        assert due_observation_match and chr(36) + '{' not in due_observation_match.group(1)
        due_observation_script = due_observation_match.group(1)
        bounded_due_key = prefix + ':bounded-due'
        keys.append(bounded_due_key)
        def observe_due(deadline='1800000000'):
            return redis.command('EVAL',due_observation_script,1,bounded_due_key,deadline)
        assert observe_due() == []
        for value in ('x' * 1280, 'é' * 640):
            redis.command('ZADD',bounded_due_key,1800000000,value)
            redis.command('EXPIRE',bounded_due_key,600)
            measured_ack, due_counts = measured_command(redis, lambda: observe_due())
            assert measured_ack == [value]
            assert sum(due_counts.values()) <= 3, due_counts
            assert 0 < redis.command('TTL',bounded_due_key) <= 600
            redis.command('DEL',bounded_due_key)
        for value in ('', 'x' * 1281, 'é' * 641):
            redis.command('ZADD',bounded_due_key,1800000000,value)
            redis.command('EXPIRE',bounded_due_key,600)
            assert observe_due() == [-1]
            assert redis.command('ZRANGE',bounded_due_key,0,-1) == [value]
            assert 0 < redis.command('TTL',bounded_due_key) <= 600
            redis.command('DEL',bounded_due_key)
        redis.command('SET',bounded_due_key,'foreign')
        assert observe_due() == [-1]
        assert redis.command('GET',bounded_due_key) == 'foreign'
        redis.command('DEL',bounded_due_key)
        for index in range(201):
            redis.command('ZADD',bounded_due_key,1800000000,'synthetic-' + str(index).zfill(3))
        assert observe_due() == ['synthetic-' + str(index).zfill(3) for index in range(200)]
        for deadline in ('-1','1.5','NaN','01','1000000000001'):
            assert observe_due(deadline) == [-1]
        assert redis.command('ZCARD',bounded_due_key) == 201
        redis.command('DEL',bounded_due_key)
        print('PASS:due observation returns at most200members/1280UTF8bytes each;ASCII/UTF8 boundary,oversize,empty,wrongtype,clock refusals preserve evidence/TTL;commands='+json.dumps(due_counts,sort_keys=True))

        forget_match = re.search(r'export const PAUSE_WORKER_FORGET = `([^`]+)`;', pause_source)
        assert forget_match and chr(36) + '{' not in forget_match.group(1)
        forget_script = forget_match.group(1)
        pause_key, due_key = prefix + ':worker-pause', prefix + ':worker-due'
        keys.extend([pause_key, due_key])
        worker_raw = json.dumps({'until': 1800000000, 'subscription': 'sub_SyntheticWorker'})
        replacement = json.dumps({'until': 1800086400, 'subscription': 'sub_SyntheticWorker'})
        def worker_forget(mode, raw):
            return redis.command('EVAL', forget_script, 2, pause_key, due_key, 'synthetic-member', mode, raw)
        def seed_worker(raw=worker_raw, score=1800000000):
            redis.command('DEL', pause_key, due_key)
            if raw is not None: redis.command('SET', pause_key, raw)
            redis.command('ZADD', due_key, score, 'synthetic-member')
        for mode in ('missing', 'known'):
            seed_worker(replacement, 1800086400)
            assert worker_forget(mode, '' if mode == 'missing' else worker_raw) == 0
            assert redis.command('GET', pause_key) == replacement
            assert redis.command('ZSCORE', due_key, 'synthetic-member') == '1800086400'
        seed_worker(worker_raw, 1800086400)
        assert worker_forget('known', worker_raw) == 0
        assert redis.command('GET', pause_key) == worker_raw
        funded_raw = json.dumps({'until': 1800000000, 'funding': {'version': 1}})
        seed_worker(funded_raw)
        assert worker_forget('known', funded_raw) == 0
        assert redis.command('GET', pause_key) == funded_raw
        for length in (4096, 4097, 100000):
            bounded_worker_raw = worker_raw + ' ' * (length - len(worker_raw))
            seed_worker(bounded_worker_raw)
            result, bounded_worker_counts = measured_command(redis, lambda: worker_forget('known', bounded_worker_raw))
            assert sum(bounded_worker_counts.values()) <= 5, bounded_worker_counts
            assert result == (1 if length == 4096 else 0)
            assert redis.command('GET', pause_key) == (None if length == 4096 else bounded_worker_raw)
            assert redis.command('ZSCORE', due_key, 'synthetic-member') == (None if length == 4096 else '1800000000')
        print('PASS:known pause cleanup reads at most4097bytes;4096boundary accepts exact generation;oversized replacement retained without cleanup')
        seed_worker()
        measured_ack, worker_counts = measured_command(redis, lambda: worker_forget('known', worker_raw))
        assert measured_ack == 1
        assert sum(worker_counts.values()) <= 5, worker_counts
        assert redis.command('GET', pause_key) is None
        assert redis.command('ZSCORE', due_key, 'synthetic-member') is None
        seed_worker(replacement, 1800086400)
        assert worker_forget('known', worker_raw) == 0  # Lost ACK never removes a replacement.
        seed_worker(None)
        measured_ack, missing_counts = measured_command(redis, lambda: worker_forget('missing', ''))
        assert measured_ack == 1
        assert sum(missing_counts.values()) <= 3, missing_counts
        assert redis.command('ZSCORE', due_key, 'synthetic-member') is None
        print('PASS:pause worker exact raw/due cleanup preserves replacements, changed score, funded ownership and lostACK;known=' + json.dumps(worker_counts, sort_keys=True) + ';missing=' + json.dumps(missing_counts, sort_keys=True))


        notice_match = re.search(r'export const PAUSE_WORKER_NOTICE = `([^`]+)`;', pause_source)
        assert notice_match and chr(36) + '{' not in notice_match.group(1)
        notice_script = notice_match.group(1)
        notice_record = {'subscription': 'sub_NoticeFixture', 'customer': 'cus_NoticeFixture', 'paymentMethod': 'pm_NoticeFixture', 'tier': 'creator', 'from': 1790000000, 'until': 1800000000, 'told': 0}
        notice_raw = json.dumps(notice_record)
        notice_next = json.dumps(dict(notice_record, told=1799999000))
        def notice(raw=notice_raw, next_raw=notice_next, now=1799999000):
            return redis.command('EVAL', notice_script, 2, pause_key, due_key, 'synthetic-member', raw, next_raw, now)
        for scenario in ('replacement', 'removed', 'due', 'funded', 'future', 'changed-plan', 'already-told', 'expired'):
            raw = notice_raw
            score = 1800000000
            if scenario == 'replacement': raw = json.dumps(dict(notice_record, until=1800086400)); score=1800086400
            elif scenario == 'removed': raw=None
            elif scenario == 'due': score=1800086400
            elif scenario == 'funded': raw=json.dumps(dict(notice_record, funding={'version': 1}))
            elif scenario == 'future': raw=json.dumps(dict(notice_record, futureEvidence='retain'))
            elif scenario == 'already-told': raw=notice_next
            seed_worker(raw, score)
            before_raw=redis.command('GET', pause_key)
            before_due=redis.command('ZSCORE', due_key, 'synthetic-member')
            expected = raw if scenario in ('funded','future','already-told') else notice_raw
            changed = json.dumps(dict(notice_record, told=1799999000, tier='pro')) if scenario == 'changed-plan' else notice_next
            assert notice(expected, changed, 1800000000 if scenario == 'expired' else 1799999000) == 0, scenario
            assert redis.command('GET', pause_key) == before_raw, scenario
            assert redis.command('ZSCORE', due_key, 'synthetic-member') == before_due, scenario
        seed_worker(notice_raw)
        redis.command('PEXPIRE', pause_key, 60000)
        ttl_before = redis.command('PTTL', pause_key)
        measured_ack, notice_counts = measured_command(redis, lambda: notice())
        assert measured_ack == 1
        assert sum(notice_counts.values()) <= 4, notice_counts
        ttl_after = redis.command('PTTL', pause_key)
        assert 0 < ttl_after <= ttl_before
        assert redis.command('GET', pause_key) == notice_next
        assert notice() == 0  # Lost ACK cannot replay a marker write.
        seed_worker(replacement, 1800086400)
        assert notice() == 0
        assert redis.command('GET', pause_key) == replacement
        print('PASS:pause notice8negative cases, exact generation/due, lostACK, replacement and KEEPTTL;commands=' + json.dumps(notice_counts, sort_keys=True))



        # Actual joint publisher uses canonical app key names only on this disposable CI Redis.
        import hashlib
        from datetime import datetime, timezone
        joint_ledger='nl:contract-reserve:v1'
        joint_indexes=['nl:plan:ended','nl:plan:paying','nl:share:stores']
        for fixed in [joint_ledger,*joint_indexes]:
            assert redis.command('EXISTS',fixed)==0, 'Refuse an unrelated existing canonical CI fixture'
        joint_ref=intent_refs[0]
        joint_owner='nl:store:owner:'+hashlib.sha256(('nimbus-store:'+joint_ref.lower()).encode()).hexdigest()[:40]
        joint_lock=joint_owner.replace('nl:store:owner:','nl:store:lock:')
        for owned in [joint_owner,joint_lock]:
            assert redis.command('EXISTS',owned)==0
        joint_owned_keys.extend([joint_ledger,*joint_indexes,joint_owner,joint_lock])
        def joint_ready(shared=False):
            redis.command('DEL',*joint_owned_keys)
            fixture=activation_ready()
            fixture=(*fixture[:4],{**fixture[4],'shared':shared})
            assert activate_restart(redis,fixture)==[1,1800086400]
            valid_stats='c'*32
            fields=[]
            for field,value in snapshot(keys[42]):
                fields.extend([field.replace('restart-store',valid_stats),value.replace('restart-store',valid_stats)])
            redis.command('HSET',joint_ledger,*fields)
            retained=json.loads(redis.command('HGET',joint_ledger,'restart-intent:ctr_restart_new'))
            sent={field:retained['submission'][field] for field in ('priceId','bodyHash','idempotencyKey','armedAt')}
            expected={key:value for key,value in retained.items() if key!='submission'}
            observed=fixture[4]
            paused=json.loads(fixture[1])
            before=dict(handle=expected['handle'],name='Synthetic creator',email=joint_ref,sid='b'*32,extra=False,
                        statsId=valid_stats,subscriptionId=expected['sourceSubscription'],stripeCustomerId=paused['customer'],
                        subscriptionActive=False,tier='creator',cycle='month',trialEnds=0,shared=False,period=None,
                        planEndedAt='2026-01-01T00:00:00.000Z',
                        catalog=dict(id='a'*32,items=[['d'*32,0,'e'*32]],head=[]),
                        creatorContent=dict(emptyArray=[],emptyObject={},languages=['pt','en'],price=1.25),futureField=dict(enabled=True))
            after={**json.loads(json.dumps(before)),'subscriptionId':observed['id'],'subscriptionActive':True,
                   'subscriptionCheckedAt':datetime.fromtimestamp(observed['start'],timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z'),
                   'trialEnds':0,'shared':observed['shared'],'planEndedAt':'',
                   'period':dict(start=observed['start'],end=observed['finish'],renews=observed['renews'],funded=True)}
            binding='|'.join([expected['grant'],observed['id'],'creator_month',str(observed['created']),'paid',str(observed['start']),str(observed['finish'])])
            receipt=dict(version=1,policy='binding',review='review',grant=expected['grant'],sourceGrant=expected['sourceGrant'],
                         claim=expected['claim'],ref=joint_ref,statsId=valid_stats,handle=expected['handle'],sid=before['sid'],
                         customerId=paused['customer'],sourceSubscriptionId=expected['sourceSubscription'],subscriptionId=observed['id'],
                         binding=binding,start=observed['start'],finish=observed['finish'],tier='creator',
                         renews=observed['renews'],shared=observed['shared'],annual=expected['annual'])
            encode=lambda value:json.dumps(value,separators=(',',':'),ensure_ascii=False)
            before_raw,after_raw,receipt_raw=encode(before),encode(after),encode(receipt)
            assert len(receipt_raw.encode())<=1536
            redis.command('SET',joint_owner,before_raw)
            redis.command('SET',joint_lock,'joint-synthetic-token','PX',15000)
            redis.command('ZADD',joint_indexes[0],1799999999,joint_ref)
            ks=[joint_ledger,joint_lock,joint_owner,'nl:pause:'+joint_ref,'nl:pause:due','nl:pause:last:'+joint_ref,*joint_indexes]
            args=['binding','review',encode(expected),encode(sent),encode(observed),1800000004,50,140,0,2,31*86400,
                  'joint-synthetic-token',before_raw,after_raw,receipt_raw]
            return ks,args,before,after,receipt
        def joint_call(client,ks,args,read=False):
            return client.command('EVAL',readback_script if read else publication_script,9,*ks,*args)
        def joint_state(ks):
            result=[]
            for key in ks:
                kind=redis.command('TYPE',key)
                if kind=='hash': value=snapshot(key)
                elif kind=='string': value=redis.command('GET',key)
                elif kind=='set': value=sorted(redis.command('SMEMBERS',key))
                elif kind=='zset': value=redis.command('ZRANGE',key,0,-1,'WITHSCORES')
                else: value=None
                result.append((key,kind,value))
            return result
        for shared in (False,True):
            ks,args,before,after,receipt=joint_ready(shared)
            cash=snapshot(joint_ledger)
            annual=redis.command('GET',ks[5])
            ignored, write_counts = measured_command(redis, lambda: joint_call(redis, ks, args))  # Deliberately lose the write ACK.
            assert ignored==[1,1801000000]
            assert sum(write_counts.values())<=64,write_counts
            assert json.loads(redis.command('GET',joint_owner))==after
            assert after['catalog']==before['catalog'] and after['creatorContent']==before['creatorContent']
            for field,value in cash:
                if field=='pending:'+'c'*32:
                    assert redis.command('HGET',joint_ledger,field) is None
                else:
                    assert redis.command('HGET',joint_ledger,field)==value,field
            assert json.loads(redis.command('HGET',joint_ledger,'restart-published:ctr_restart_new'))==receipt
            assert redis.command('GET',ks[3]) is None and redis.command('ZSCORE',ks[4],joint_ref) is None
            assert redis.command('GET',ks[5])==annual
            assert redis.command('ZSCORE',joint_indexes[0],joint_ref) is None
            assert redis.command('SISMEMBER',joint_indexes[1],joint_ref)==1
            assert redis.command('SISMEMBER',joint_indexes[2],joint_ref)==int(shared)
            state=joint_state(ks)
            measured_ack, read_counts = measured_command(redis, lambda: joint_call(redis, ks, args, True))
            assert measured_ack == [2, 1801000000]
            assert sum(read_counts.values())<=64,read_counts
            assert all(name not in read_counts for name in ('set','hset','hdel','del','zadd','zrem','sadd','srem'))
            def joint_readback(_index):
                client=Redis()
                try:return joint_call(client,ks,args,True)
                finally:client.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                assert list(pool.map(joint_readback,range(64)))==[[2,1801000000]]*64
            assert joint_state(ks)==state
            expired=[*args];expired[5]=1801000000
            assert joint_call(redis,ks,expired,True)==0
            assert joint_state(ks)==state
        print('PASS:joint Store/index/pause-due publication lostACK plus64readbacks preserves catalog,creator fields,cash,source,annual and permanent owner for both share states')
        print('RESTART_JOINT_WRITE_COMMANDS:'+json.dumps(write_counts,sort_keys=True))
        print('RESTART_JOINT_READ_COMMANDS:'+json.dumps(read_counts,sort_keys=True))
        ks,args,_,_,_=joint_ready()
        def joint_first_writer(_index):
            client=Redis()
            try:return joint_call(client,ks,args)
            finally:client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            contenders=list(pool.map(joint_first_writer,range(64)))
        assert contenders.count([1,1801000000])==1 and contenders.count(0)==63
        print('PASS:64joint publication contenders produce exactly1commit without another provider operation or grant release')
        # Resource cohorts use a complete synthetic two-grant50cent allocation.
        def restart_resource_ready(shared=False):
            ks,args,_,after,published=joint_ready(shared)
            assert joint_call(redis,ks,args)==[1,1801000000]
            source_raw=redis.command('HGET',joint_ledger,'grant:ctr_restart_source')
            source_parts=source_raw.split('|');source_parts[4]='50'
            source_raw='|'.join(source_parts)
            intent=json.loads(redis.command('HGET',joint_ledger,'restart-intent:ctr_restart_new'))
            intent['sourceReceipt']=source_raw;intent['reservedCents']=100
            redis.command('HSET',joint_ledger,'grant:ctr_restart_source',source_raw,'reserved',100,
                          'restart-intent:ctr_restart_new',json.dumps(intent,separators=(',',':')),
                          'slots:creator_month',0,'slots:creator_year',0,'slots:pro_month',0,
                          'slots:pro_year',0,'slots:scale_month',0,'slots:scale_year',0)
            return after,published
        def restart_resource(client,**over):
            args=['binding','review','c'*32,'sub_ObservedRestart01','creator_month',
                  1800000003,1801000000,1800000003000,1801000000000,1800000004000,0,1,
                  50,140,0,2,2,50,0,1,0,1,0,1,0,1,0,1]
            for index,value in over.items():args[int(index)]=value
            return client.command('EVAL',resource_script,1,joint_ledger,*args)
        for shared in (False,True):
            restart_resource_ready(shared)
            before=snapshot(joint_ledger)
            ignored, cohort_counts = measured_command(redis, lambda: restart_resource(redis))  # Lost ACK retains one existing cohort.
            assert ignored==[1,1801000000000]
            assert sum(cohort_counts.values())<=40,cohort_counts
            field='resource:ctr_restart_new:0'
            assert redis.command('HGET',joint_ledger,field)=='1800000003000|1801000000000'
            assert [(k,v) for k,v in snapshot(joint_ledger) if k!=field]==before
            committed=snapshot(joint_ledger)
            def repeat_resource(_):
                client=Redis()
                try:return restart_resource(client)
                finally:client.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                assert list(pool.map(repeat_resource,range(64)))==[[1,1801000000000]]*64
            assert snapshot(joint_ledger)==committed
        for scenario in ('owner','published-missing','published-binding','published-source','published-type',
                         'checkpoint','intent-source','intent-publication','old-activation','old-receipt',
                         'cash','slots','period','expired'):
            restart_resource_ready()
            if scenario=='owner':redis.command('HSET',joint_ledger,'restart-owner:ctr_restart_source','ctr_foreign')
            elif scenario=='published-missing':redis.command('HDEL',joint_ledger,'restart-published:ctr_restart_new')
            elif scenario.startswith('published-'):
                pub=json.loads(redis.command('HGET',joint_ledger,'restart-published:ctr_restart_new'))
                if scenario=='published-binding':pub['binding']='foreign'
                elif scenario=='published-source':pub['sourceGrant']='ctr_foreign'
                else:pub['tier']=None
                redis.command('HSET',joint_ledger,'restart-published:ctr_restart_new',json.dumps(pub))
            elif scenario=='checkpoint':redis.command('HDEL',joint_ledger,'restart-publication:ctr_restart_new')
            elif scenario.startswith('intent-'):
                intent=json.loads(redis.command('HGET',joint_ledger,'restart-intent:ctr_restart_new'))
                if scenario=='intent-source':intent['sourceReceipt']='foreign'
                else:intent['submission']['publication']['shared']=True
                redis.command('HSET',joint_ledger,'restart-intent:ctr_restart_new',json.dumps(intent,separators=(',',':')))
            elif scenario=='old-activation':redis.command('HDEL',joint_ledger,'activated:ctr_restart_source')
            elif scenario=='old-receipt':redis.command('HDEL',joint_ledger,'grant:ctr_restart_source')
            elif scenario=='cash':redis.command('HSET',joint_ledger,'reserved',99)
            elif scenario=='slots':redis.command('HSET',joint_ledger,'slots:pro_year',1)
            before=snapshot(joint_ledger)
            overrides={'6':1801000001} if scenario=='period' else {'9':1801000000000} if scenario=='expired' else {}
            assert restart_resource(redis,**overrides)==0,scenario
            assert snapshot(joint_ledger)==before,scenario
        print('PASS:published restart resource cohort both share states,lostACK64replays,14lineage/financial/window refusals retain cash and fullledger;commands='+json.dumps(cohort_counts,sort_keys=True))

        scenarios=('lock-foreign','lock-expired','lock-too-long','owner-changed','owner-ttl','source-active','next-content',
                   'next-subscription','next-unfunded','next-renews','checkpoint','pause','due','annual','policy','cash',
                   'ended-type','paying-type','sharing-type','published-foreign','oversized','receipt-foreign')
        for scenario in scenarios:
            ks,args,before,after,receipt=joint_ready()
            if scenario=='lock-foreign':redis.command('SET',joint_lock,'foreign-token','PX',15000)
            elif scenario=='lock-expired':redis.command('DEL',joint_lock)
            elif scenario=='lock-too-long':redis.command('PEXPIRE',joint_lock,30000)
            elif scenario=='owner-changed':redis.command('SET',joint_owner,args[12]+' ')
            elif scenario=='owner-ttl':redis.command('EXPIRE',joint_owner,300)
            elif scenario=='source-active':
                before['subscriptionActive']=True;args[12]=json.dumps(before,separators=(',',':'));redis.command('SET',joint_owner,args[12])
            elif scenario.startswith('next-'):
                if scenario=='next-content':after['creatorContent']['languages']=['foreign']
                elif scenario=='next-subscription':after['subscriptionId']='sub_ForeignJoint01'
                elif scenario=='next-unfunded':after['period']['funded']=False
                elif scenario=='next-renews':after['period']['renews']=False if after['period']['renews'] else True
                args[13]=json.dumps(after,separators=(',',':'))
            elif scenario=='checkpoint':redis.command('HDEL',joint_ledger,'restart-publication:ctr_restart_new')
            elif scenario=='pause':redis.command('SET',ks[3],args[2])
            elif scenario=='due':redis.command('ZADD',ks[4],json.loads(json.loads(args[2])['paused'])['until']+1,joint_ref)
            elif scenario=='annual':redis.command('SET',ks[5],1799999999)
            elif scenario=='policy':redis.command('HSET',joint_ledger,'policy','foreign')
            elif scenario=='cash':redis.command('HSET',joint_ledger,'reserved',1)
            elif scenario.endswith('-type'):
                index={'ended-type':0,'paying-type':1,'sharing-type':2}[scenario]
                redis.command('DEL',joint_indexes[index]);redis.command('SET',joint_indexes[index],'wrong-type')
            elif scenario=='published-foreign':redis.command('HSET',joint_ledger,'restart-published:ctr_restart_new','foreign')
            elif scenario=='oversized':args[13]='x'*1000001
            elif scenario=='receipt-foreign':
                receipt['customerId']='cus_ForeignJoint01';args[14]=json.dumps(receipt,separators=(',',':'))
            state=joint_state(ks)
            assert joint_call(redis,ks,args)==0,scenario
            assert joint_state(ks)==state,scenario
        print('PASS:22unknown/foreign/expired-lock/raw-CAS/type/financial/generation joint refusals preserve every key')
        for scenario in ('receipt','pending','active','cash','pause-returned','due-returned','ended-returned','paying-missing','sharing-wrong','annual','owner-plan','owner-content'):
            ks,args,_,after,_=joint_ready()
            assert joint_call(redis,ks,args)==[1,1801000000]
            if scenario=='receipt':redis.command('HDEL',joint_ledger,'restart-published:ctr_restart_new')
            elif scenario=='pending':redis.command('HSET',joint_ledger,'pending:'+'c'*32,'ctr_restart_new')
            elif scenario=='active':redis.command('HSET',joint_ledger,'active:'+'c'*32,'foreign')
            elif scenario=='cash':redis.command('HSET',joint_ledger,'reserved',1)
            elif scenario=='pause-returned':redis.command('SET',ks[3],'foreign')
            elif scenario=='due-returned':redis.command('ZADD',ks[4],1800000001,joint_ref)
            elif scenario=='ended-returned':redis.command('ZADD',ks[6],1800000001,joint_ref)
            elif scenario=='paying-missing':redis.command('SREM',ks[7],joint_ref)
            elif scenario=='sharing-wrong':redis.command('SADD',ks[8],joint_ref)
            elif scenario=='annual':redis.command('SET',ks[5],1799999999)
            elif scenario=='owner-plan':
                after['tier']='pro';redis.command('SET',joint_owner,json.dumps(after,separators=(',',':')))
            elif scenario=='owner-content':
                after['creatorContent']['newContent']='preserve future creator edit'
                redis.command('SET',joint_owner,json.dumps(after,separators=(',',':')))
            state=joint_state(ks)
            assert joint_call(redis,ks,args,True)==([2,1801000000] if scenario=='owner-content' else 0),scenario
            assert joint_state(ks)==state,scenario
        print('PASS:joint readback refuses11partial/foreign financial/index/generation states and preserves a later creator-only edit without writes')

        bounded_key = prefix + ':bounded-restart-source'
        keys.append(bounded_key)
        redis.command('SET', bounded_key, 'x' * 1000002)
        bounded_result, bounded_counts = measured_command(redis, lambda: redis.command('GETRANGE', bounded_key, 0, 1000000))
        assert len(bounded_result.encode('utf-8')) == 1000001
        assert sum(bounded_counts.values()) == 1, bounded_counts
        redis.command('SET', bounded_key, 'é' * 450000)
        assert len(redis.command('GETRANGE', bounded_key, 0, 1000000).encode('utf-8')) == 900000
        assert redis.command('GETRANGE', prefix + ':missing-bounded-source', 0, 1000000) == ''
        print('PASS:bounded restart source GETRANGE returns at most1000001raw bytes in1command;UTF8 and missing observations stay explicit;commands=' + json.dumps(bounded_counts, sort_keys=True))


    finally:
        allowed_joint={'nl:contract-reserve:v1','nl:plan:ended','nl:plan:paying','nl:share:stores'}
        for key in joint_owned_keys:
            if key not in allowed_joint and not re.fullmatch(r'nl:store:(owner|lock):[a-f0-9]{40}',key):
                raise RuntimeError('Refuse cleanup outside explicitly owned disposable joint fixture')
            redis.command('DEL',key)
        for ref in intent_refs:
            if not ref.startswith('synthetic-restart-intent-'):
                raise RuntimeError('Refuse unrelated synthetic pause cleanup')
            redis.command('DEL', 'nl:pause:' + ref, 'nl:pause:last:' + ref)
            redis.command('ZREM', 'nl:pause:due', ref)
        for key in keys:
            if not key.startswith(prefix):
                raise RuntimeError('Refuse cleanup outside this generated CI namespace')
            redis.command('DEL', key)
        redis.close()


if __name__ == '__main__':
    from test_contract_command_measurement import check_contract_profiles
    check_contract_profiles(main)
