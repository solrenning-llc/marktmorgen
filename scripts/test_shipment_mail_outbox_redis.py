"""Run the actual shipment outbox Lua on disposable loopback Redis only.
No application credential, provider call, real recipient or account is used.
"""
import concurrent.futures
import json
import hashlib
import os
from pathlib import Path
import re
import socket
import uuid
from test_form_opportunity_redis import Redis


class LocalRedis(Redis):
    def __init__(self):
        port = int(os.environ.get("MARKTMORGEN_SHIPMENT_REDIS_PORT", "16379"))
        if not 1024 <= port <= 65535:
            raise RuntimeError("Dedicated loopback Redis port required")
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        self.stream = self.sock.makefile("rb")


def pending_recovery_cases(redis, source, made):
    """Exact new Lua on an exclusively owned disposable Redis, no provider.
    Negative-query unfairness is separately RED; this snapshot cannot truncate.
    """
    match = re.search(r"export const PENDING_MAIL_RECOVERY_SCRIPT = `([^`]+)`;", source)
    assert match and "${" not in match[1]
    lua = match[1]
    pool, all_key = "nl:ship:mail:pool", "nl:ship:mail:all"
    assert redis.command("EXISTS", pool, all_key) == 0, "Recovery test refuses a previously used global namespace"
    made.update([pool, all_key])
    clock = redis.command("TIME")
    now = int(clock[0]) * 1000 + int(clock[1]) // 1000
    grant = dict(recovery=dict(version=1, revision=1, evidence="SYNTHETIC only", startsAt=now-1000, until=now+3600000,
                              maximumAttempts=100, maximumCommandUnits=6400, maximumReadBytes=104857600, checkpointBytes=8192,
                              maximumTriggerInvocations=100, triggerEvidence="SYNTHETIC fixed infra coverage"),
                 reviewId="NEW", maximumChecks=2, globalItems=100, globalBytes=10000000, continuedReviewIds=["OLD"])
    owner = "b" * 48
    fp = "c" * 64
    profiles={'next':[], 'finish':[]}
    def command_counts(text):
        return {m[1]:int(m[2]) for m in re.finditer(r'^cmdstat_([^:]+):calls=(\d+),',text,re.M)}
    def run(op, family="shipment", keys=None, raw="", valid="skip", who=owner, proof=fp, g=grant):
        selected = keys or [pool, all_key]
        t = redis.command("TIME"); at = int(t[0])*1000+int(t[1])//1000
        redis.command('MULTI');redis.command('INFO','COMMANDSTATS')
        redis.command("EVAL", lua, len(selected), *selected, op, json.dumps(g), proof, who, family, at, raw, valid)
        redis.command('INFO','COMMANDSTATS')
        before,result,after=redis.command('EXEC')
        a,b=command_counts(before),command_counts(after)
        count=sum(b.get(k,0)-a.get(k,0) for k in set(a)|set(b))-1 # exactly one observer INFO, no application command filtered
        profiles[op].append(count)
        assert count<=64,(op,count)
        return result
    def checkpoint(): return json.loads(redis.command("HGET", pool, "pendingRecovery"))
    def setup(name, review="OLD", state="queued", phase=None):
        id = hashlib.sha256(name.encode()).hexdigest(); stats="synthetic_recovery"; person="d"*64
        row = dict(id=id, statsId=stats, session="cs_test_"+id, person=person, sourceValue='{"at":1,"tracking":""}',
                   sealed="s1.synthetic", fingerprint="a"*64, bytes=12000, created=now-74*3600000,
                   authorizedAt=now-74*3600000, next=0, state=state, owner="", leaseUntil=0, checks=1, reviewId=review)
        if phase is not None: row.update(kind="confirmation",phase=phase)
        family = "shipment" if phase is None else "confirmation"
        prefix = "nl:ship:mail:" if family=="shipment" else "nl:order-confirmation:"
        rk=prefix+"row:"+id; sk="nl:ship:done:"+row['session'] if family=="shipment" else prefix+"source:"+id
        due=prefix+"due"; closed=prefix+"closed:"+stats; erased=prefix+"erased:"+stats+":"+person
        keys=[pool,all_key,rk,sk,due,closed,erased];made.update(keys)
        raw=json.dumps(row);redis.command("SET",rk,raw);redis.command("SET",sk,row['sourceValue']);redis.command("SADD",all_key,id)
        redis.command("HINCRBY",pool,"items",1);redis.command("HINCRBY",pool,"bytes",12000)
        return id,raw,keys
    id,raw,keys=setup("first")
    assert run("next")==["ticket",id,"1"]
    before=checkpoint();assert before['units']==64 and before['attempts']==1
    assert run("finish",keys=keys,raw=raw,valid="valid")==["rearmed"]
    assert redis.command("GET",keys[2])==raw
    assert redis.command("ZSCORE",keys[4],id) is not None
    assert checkpoint()['family']=='confirmation'
    after=checkpoint()
    assert run("finish",keys=keys,raw=raw,valid="valid")==["held"]
    assert checkpoint()==after
    assert run("next",family="confirmation")==["ticket",id,"1"]
    missing="nl:order-confirmation:row:"+id;made.add(missing)
    assert run("finish",family="confirmation",keys=[pool,all_key,missing])==["skipped"]
    assert checkpoint()['phase']=='done'
    assert run("next")==["done"]
    assert redis.command("GET",keys[2])==raw and redis.command("TTL",keys[2])==-1
    print("PASS: recovery snapshot, pre-read ticket, unchanged source, one rearm and lost-finish ACK replay are durable")
    # Higher revision cannot reuse the same review or shrink the allowed cap.
    bad={**grant,"recovery":{**grant['recovery'],"revision":2}}
    assert run("next",g=bad,proof="e"*64)==["held"]
    assert run("next",g=grant,proof="f"*64)==["held"]
    print("PASS: consumed grant cannot restart, mutate its fingerprint or replay the same review")
    # Discovery capacity is separate from the original finite provider-check
    # cap. Losing a ticket ACK at the technical ceiling must not require an
    # impossible10001 checks just to admit a newly funded discovery revision.
    redis.command('DEL',pool,all_key)
    id,raw,keys=setup('successor-at-technical-check-cap')
    row=json.loads(raw);row['checks']=9999;raw=json.dumps(row);redis.command('SET',keys[2],raw)
    old={**grant,'maximumChecks':10000,'recovery':{**grant['recovery'],'maximumAttempts':1,'maximumCommandUnits':64,'maximumReadBytes':1048576,'maximumTriggerInvocations':1}}
    newer={**grant,'reviewId':'DISCOVERY_SUCCESSOR','maximumChecks':10000,'recovery':{**grant['recovery'],'revision':2}}
    old_fp='1'*64;new_fp='2'*64
    assert run('next',g=old,proof=old_fp)==['ticket',id,'1']
    assert run('next',g=old,proof=old_fp)==['exhausted']
    saved=redis.command('HGET',pool,'pendingRecovery')
    for denied in [{**newer,'reviewId':old['reviewId']},{**newer,'maximumChecks':9999}]:
        assert run('next',g=denied,proof=new_fp)==['held']
        assert redis.command('HGET',pool,'pendingRecovery')==saved
    assert run('next',g=newer,proof=new_fp)==['ticket',id,'1'], 'a newly funded discovery revision may retain the original check cap'
    charged=checkpoint();assert charged['attempts']==1 and charged['units']==64 and charged['readBytes']==1048576
    assert run('finish',keys=keys,raw=raw,valid='valid',g=old,proof=old_fp)==['held']
    assert run('next',g=old,proof=old_fp)==['held']
    assert run('next',g={**newer,'recovery':{**newer['recovery'],'maximumAttempts':99}},proof='3'*64)==['held']
    assert checkpoint()==charged
    assert run('finish',keys=keys,raw=raw,valid='valid',g=newer,proof=new_fp)==['rearmed']
    assert redis.command('GET',keys[2])==raw and redis.command('ZSCORE',keys[4],id)=='0'
    redis.command('DEL',pool,all_key)
    id,raw,keys=setup('successor-cannot-reset-spent-checks')
    row=json.loads(raw);row['checks']=10000;raw=json.dumps(row);redis.command('SET',keys[2],raw)
    assert run('next',g=newer,proof=new_fp)==['ticket',id,'1']
    assert run('finish',keys=keys,raw=raw,valid='valid',g=newer,proof=new_fp)==['skipped']
    assert redis.command('GET',keys[2])==raw and redis.command('ZSCORE',keys[4],id) is None
    print('PASS: an explicitly renewed discovery grant may keep cap10000 without resetting checks or accepting old permissions')
    # Each newly financed small grant must continue the SAME immutable list,
    # not recapture the unsupported first ID on every budget renewal.
    redis.command('DEL',pool,all_key)
    rows=sorted([setup('grant-progress-one'),setup('grant-progress-two')],key=lambda row:row[0])
    first_id,first_raw,first_keys=rows[0]
    first=json.loads(first_raw);first['reviewId']='UNSUPPORTED'
    first_raw=json.dumps(first);redis.command('SET',first_keys[2],first_raw)
    rows[0]=(first_id,first_raw,first_keys)
    target_id,target_raw,target_keys=rows[1]
    visited=[]
    for revision in range(1,7):
        funded={**grant,'reviewId':'CONTINUATION_'+str(revision),'recovery':{**grant['recovery'],'revision':revision,
            'maximumAttempts':1,'maximumCommandUnits':640,'maximumReadBytes':10485760,'maximumTriggerInvocations':10}}
        proof=hashlib.sha256(('continuation'+str(revision)).encode()).hexdigest()
        ticket=run('next',g=funded,proof=proof)
        if ticket[0]=='ticket':
            selected=next(row for row in rows if row[0]==ticket[1]);visited.append(ticket[1])
            assert run('finish',keys=selected[2],raw=selected[1],valid='valid',g=funded,proof=proof) in [['skipped'],['rearmed'],['already']]
    assert redis.command('ZSCORE',target_keys[4],target_id)=='0', 'financed successor grants must reach the later supported origin'
    assert visited[:2]==[first_id,target_id], 'successor must preserve snapshot index and sorted IDs'
    assert redis.command('GET',target_keys[2])==target_raw
    progress=checkpoint();assert progress['family']=='confirmation' and progress['index']==1
    print('PASS: newly financed grants compose snapshot progress through an unsupported prefix without resetting original sources')
    # Membership may change while a ticket is unknown. Only a completed
    # snapshot is recaptured: a successor continues its acknowledged old IDs.
    redis.command('DEL',pool,all_key)
    original=sorted([setup('membership-original-one'),setup('membership-original-two')],key=lambda row:row[0])
    first_id,first_raw,first_keys=original[0];second_id,second_raw,second_keys=original[1]
    assert run('next')==['ticket',first_id,'1']
    old_checkpoint=checkpoint()
    redis.command('DEL',first_keys[2]);redis.command('SREM',all_key,first_id)
    redis.command('HINCRBY',pool,'items',-1);redis.command('HINCRBY',pool,'bytes',-12000)
    added_id,added_raw,added_keys=setup('membership-added-after-snapshot')
    assert added_id not in old_checkpoint['ids']
    renewed={**grant,'reviewId':'MEMBERSHIP_SUCCESSOR','recovery':{**grant['recovery'],'revision':2}}
    renewed_fp='8'*64
    assert run('next',g=renewed,proof=renewed_fp)==['ticket',first_id,'1']
    retained=checkpoint()
    assert retained['ids']==old_checkpoint['ids'] and retained['family']==old_checkpoint['family']
    assert run('finish',g=grant,keys=first_keys,raw=first_raw,valid='valid')==['held']
    assert run('finish',g=renewed,proof=renewed_fp,keys=[pool,all_key,first_keys[2]])==['skipped']
    assert run('next',g=renewed,proof=renewed_fp)==['ticket',second_id,'2']
    assert run('finish',g=renewed,proof=renewed_fp,keys=second_keys,raw=second_raw,valid='valid')==['rearmed']
    assert redis.command('GET',second_keys[2])==second_raw and redis.command('GET',added_keys[2])==added_raw
    assert checkpoint()['ids']==old_checkpoint['ids']
    print('PASS: a funded successor keeps its original snapshot across deletion/new membership and rejects the old in-flight finish')
    # Both ordinary cron workers call next. A known other family is a fixed
    # guard, not a useful ticket, and cannot starve a one-ticket successor.
    redis.command('DEL',pool,all_key)
    id,raw,keys=setup('confirmation-continuation',phase='queued')
    row=json.loads(raw);row.update(erasedPeople='',erasureSaturated=False);raw=json.dumps(row);redis.command('SET',keys[2],raw)
    tiny={**grant,'reviewId':'CONFIRMATION_START','recovery':{**grant['recovery'],'maximumAttempts':1,
        'maximumCommandUnits':640,'maximumReadBytes':10485760,'maximumTriggerInvocations':10}}
    tiny_fp='6'*64
    assert run('next',g=tiny,proof=tiny_fp)==['ticket',id,'1']
    assert run('finish',keys=[pool,all_key,'nl:ship:mail:row:'+id],g=tiny,proof=tiny_fp)==['skipped']
    assert checkpoint()['family']=='confirmation'
    successor={**tiny,'reviewId':'CONFIRMATION_RENEWED','recovery':{**tiny['recovery'],'revision':2}}
    next_fp='7'*64
    assert run('next',g=successor,proof=next_fp)==['held']
    revised=checkpoint()
    assert revised['revision']==2 and revised['fingerprint']==next_fp and revised['reviewId']==successor['reviewId']
    assert revised['attempts']==0 and revised['units']==0 and revised['readBytes']==0, 'known wrong family must not consume a variable-work ticket'
    assert revised['family']=='confirmation' and revised['index']==1
    assert run('finish',g=tiny,proof=tiny_fp,keys=keys,raw=raw,valid='valid',family='confirmation')==['held']
    assert run('next',g=tiny,proof=tiny_fp,family='confirmation')==['held']
    assert run('next',g=successor,proof=next_fp,family='confirmation')==['ticket',id,'1']
    charged=checkpoint();assert charged['attempts']==1 and charged['units']==64 and charged['readBytes']==1048576
    assert run('finish',g=successor,proof=next_fp,keys=keys,raw=raw,valid='valid',family='confirmation')==['rearmed']
    pending=checkpoint();assert pending['phase']=='capturing' and pending['ids']==[] and pending['family']=='shipment'
    assert pending['attempts']==1 and pending['units']==64 and pending['readBytes']==1048576
    before=command_counts(redis.command('INFO','COMMANDSTATS'))
    assert run('next',g=successor,proof=next_fp)==['exhausted']
    after=command_counts(redis.command('INFO','COMMANDSTATS'))
    for name in ['scard','sscan','getrange']:assert after.get(name,0)==before.get(name,0), 'an exhausted grant must not perform fresh variable work'
    assert checkpoint()==pending and redis.command('GET',keys[2])==raw and redis.command('ZSCORE',keys[4],id)=='0'
    refresh={**grant,'reviewId':'REFRESH_FINANCED','recovery':{**grant['recovery'],'revision':3}}
    refresh_fp='9'*64
    assert run('next',g=refresh,proof=refresh_fp)==['ticket',id,'1']
    assert checkpoint()['phase']=='active', 'a funded fresh capture must not request another refresh'
    assert run('finish',g=refresh,proof=refresh_fp,keys=[pool,all_key,'nl:ship:mail:row:'+id])==['skipped']
    assert run('next',g=refresh,proof=refresh_fp,family='confirmation')==['ticket',id,'1']
    assert run('finish',g=refresh,proof=refresh_fp,keys=keys,raw=raw,valid='valid',family='confirmation')==['already']
    complete=checkpoint();assert complete['phase']=='done' and complete['attempts']==2
    before=command_counts(redis.command('INFO','COMMANDSTATS'))
    assert run('next',g=refresh,proof=refresh_fp)==['done']
    after=command_counts(redis.command('INFO','COMMANDSTATS'))
    assert after.get('sscan',0)==before.get('sscan',0) and checkpoint()==complete
    print('PASS: persisted successor high-water rejects old tickets; exhausted retained work cannot recapture and one funded fresh snapshot terminates')
    # The next synthetic grant sees a full bounded snapshot, including first
    # unsupported reviews; each known refusal advances rather than hot-polling.
    redis.command("DEL",pool,all_key)
    rows=[setup("cohort"+str(i),review="UNSUPPORTED" if i<24 else "OLD") for i in range(25)]
    ordered=sorted(rows,key=lambda v:v[0]); target=rows[-1][0]
    for expected,observed,k in ordered:
        assert run("next")==["ticket",expected,str(checkpoint()['index'])]
        result=run("finish",keys=k,raw=observed,valid="valid")
        assert result==(["rearmed"] if expected==target else ["skipped"])
    assert redis.command("ZSCORE",rows[-1][2][4],target) is not None
    assert len(checkpoint()['ids'])==25 and len(redis.command("HGET",pool,"pendingRecovery").encode())<=8192
    print("PASS: all25 snapshot positions progress through unsupported reviews; the supported target is not hidden")
    redis.command("DEL",pool,all_key)
    for i in range(26):redis.command("SADD",all_key,hashlib.sha256(("over"+str(i)).encode()).hexdigest())
    redis.command("HSET",pool,"items",26,"bytes",26*12000)
    before=redis.command("INFO","COMMANDSTATS")
    assert run("next")==["unsupported"]
    after=redis.command("INFO","COMMANDSTATS")
    def calls(text,name):
        m=re.search(r"^cmdstat_"+name+r":calls=(\d+),",text,re.M);return int(m[1]) if m else 0
    assert calls(after,"smembers")==calls(before,"smembers")
    assert calls(after,"sscan")==calls(before,"sscan")
    assert checkpoint()['phase']=='unsupported' and redis.command("SCARD",all_key)==26
    print("PASS: cohort26 refuses before enumeration, never truncates or discards any origin")
    redis.command("DEL",pool,all_key)
    id,raw,keys=setup("budget")
    finite={**grant,'recovery':{**grant['recovery'],'maximumAttempts':1,'maximumCommandUnits':64,'maximumReadBytes':1048576,'maximumTriggerInvocations':1}}
    assert run('next',g=finite)==['ticket',id,'1']
    before=checkpoint()
    assert run('next',g=finite,who='e'*48)==['exhausted']
    assert checkpoint()==before and redis.command('GET',keys[2])==raw
    print('PASS: unknown ticket ACK cannot mint a free retry or advance the cursor after finite capacity is spent')
    for state in ['dispatching','refused']:
        redis.command('DEL',pool,all_key)
        id,raw,keys=setup('terminal-'+state,state=state)
        assert run('next')==['ticket',id,'1']
        assert run('finish',keys=keys,raw=raw,valid='valid')==['skipped']
        assert redis.command('GET',keys[2])==raw and redis.command('ZSCORE',keys[4],id) is None
    redis.command('DEL',pool,all_key)
    id,raw,keys=setup('fenced')
    redis.command('SET',keys[5],'original-close-fence')
    assert run('next')==['ticket',id,'1']
    assert run('finish',keys=keys,raw=raw,valid='valid')==['skipped']
    assert redis.command('GET',keys[2])==raw and redis.command('ZSCORE',keys[4],id) is None
    redis.command('DEL',keys[5]) # only this synthetic case's deliberately installed closure fence
    print('PASS: permanent uncertain dispatch, refusal and closure fences never become new provider permission')
    redis.command('DEL',pool,all_key)
    id,raw,keys=setup('lost-ticket')
    assert run('next')==['ticket',id,'1']
    before=checkpoint()
    assert run('next',who='f'*48)==['held']
    after=checkpoint()
    assert after['index']==before['index'] and after['owner']==before['owner'] and after['attempts']==before['attempts']+1
    assert run('finish',keys=keys,raw=raw+' ',valid='valid')==['changed']
    assert checkpoint()['index']==1 and redis.command('GET',keys[2])==raw
    assert run('finish',keys=keys,raw=raw,valid='valid')==['rearmed']
    print('PASS: concurrent/unknown ticket and changed row retain the exact snapshot position until an acknowledged matching effect')
    # Counter corruption is not free capacity. Preserve the corrupt value,
    # refuse before another source/index effect, and do not reset a revision.
    saved=redis.command('HGET',pool,'pendingRecovery')
    corrupt=json.loads(saved);corrupt['attempts']=0
    redis.command('HSET',pool,'pendingRecovery',json.dumps(corrupt))
    assert run('next')==['unknown']
    assert json.loads(redis.command('HGET',pool,'pendingRecovery'))['attempts']==0
    redis.command('HSET',pool,'pendingRecovery',saved)
    print('PASS: malformed or inconsistent checkpoint counters remain unknown rather than replenished')
    # Reviewed causal regressions: an expired preparation is only returned
    # to its ordinary claim; recovery never clears its row/lease or dispatches.
    redis.command('DEL',pool,all_key)
    id,raw,keys=setup('review-expired-preparation',state='preparing')
    row=json.loads(raw);row.update(owner='e'*48,leaseUntil=now-1000,next=now-1000)
    raw=json.dumps(row);redis.command('SET',keys[2],raw)
    assert run('next')==['ticket',id,'1']
    assert run('finish',keys=keys,raw=raw,valid='valid')==['rearmed'], 'expired preparation must not pin the snapshot forever'
    assert redis.command('GET',keys[2])==raw and redis.command('ZSCORE',keys[4],id)=='0'
    assert checkpoint()['family']=='confirmation'
    for closed in [False,True]:
        redis.command('DEL',pool,all_key)
        id,raw,keys=setup('review-active-preparation-'+str(closed),state='preparing')
        row=json.loads(raw);row.update(owner='e'*48,leaseUntil=now+30000,next=now+30000)
        raw=json.dumps(row);redis.command('SET',keys[2],raw)
        if closed:redis.command('SET',keys[5],'synthetic-close')
        assert run('next')==['ticket',id,'1']
        assert run('finish',keys=keys,raw=raw,valid='valid')==(['skipped'] if closed else ['busy'])
        assert redis.command('GET',keys[2])==raw and redis.command('ZSCORE',keys[4],id) is None
        if closed:redis.command('DEL',keys[5])
    print('PASS: expired preparation can rejoin ordinary claims, active preparation stays busy and closure advances without permission')
    for phase in ['awaiting_creation','creating','creation_unknown']:
        redis.command('DEL',pool,all_key)
        id,raw,keys=setup('review-lost-create-'+phase,phase=phase)
        row=json.loads(raw);row.update(session='',erasedPeople='',erasureSaturated=False)
        raw=json.dumps(row);redis.command('SET',keys[2],raw)
        assert run('next')==['ticket',id,'1']
        assert run('finish',keys=[pool,all_key,'nl:ship:mail:row:'+id])==['skipped']
        assert run('next',family='confirmation')==['ticket',id,'1']
        assert run('finish',family='confirmation',keys=keys,raw=raw,valid='valid')==['rearmed'], 'lost creation ACK must remain discoverable by the read-only worker'
        assert redis.command('GET',keys[2])==raw and redis.command('ZSCORE',keys[4],id)=='0'
    print('PASS: all pre-session creation phases rejoin read-only original-account recovery without source replacement')
    # Literal-prefix refactoring must preserve BOTH existing physical fence
    # key families byte-for-byte, not classify generic unknown key suffixes.
    for family in ['shipment','confirmation']:
        for fence in [5,6]:
            redis.command('DEL',pool,all_key)
            id,raw,keys=setup('concrete-fence-'+family+'-'+str(fence),phase='queued' if family=='confirmation' else None)
            if family=='confirmation':
                row=json.loads(raw);row.update(erasedPeople='',erasureSaturated=False);raw=json.dumps(row);redis.command('SET',keys[2],raw)
                assert run('next')==['ticket',id,'1']
                assert run('finish',keys=[pool,all_key,'nl:ship:mail:row:'+id])==['skipped']
            redis.command('SET',keys[fence],'synthetic-literal-fence')
            assert run('next',family=family)==['ticket',id,'1']
            assert run('finish',family=family,keys=keys,raw=raw,valid='valid')==['skipped']
            assert redis.command('GET',keys[2])==raw and redis.command('ZSCORE',keys[4],id) is None
            redis.command('DEL',keys[fence])
    print('PASS: concrete closed/erased keys remain exact for both existing physical families and deny rearm')
    assert max(profiles['next'])+3+max(profiles['finish'])<=64
    print(json.dumps({'recovery_eval_and_internal_max':{key:max(values) for key,values in profiles.items()},
                      'confirmation_observation_commands':3,'reserved_variable_command_units':64,
                      'checkpoint_stored_bytes':len(saved.encode()),'supplier_invoice':False}))


def main():
    if os.environ.get("MARKTMORGEN_REDIS_INTEGRATION") != "1":
        raise RuntimeError("Run only against disposable loopback CI Redis")
    root = Path(__file__).resolve().parents[1]
    source = (root / "lib/shipment-mail-outbox.ts").read_text(encoding="utf-8")
    match = re.search(r"export const SHIPMENT_MAIL_SCRIPT = `([^`]+)`;", source)
    assert match and "${" not in match.group(1)
    script = match.group(1)
    prefix = "marktmorgen:integration:shipment-mail:" + uuid.uuid4().hex + ":"
    redis = LocalRedis()
    made = set()
    now = 1_790_000_000_000
    policy = dict(reviewId="SYNTHETIC", evidence="SYNTHETIC ONLY", ongoingStorageFunded=True,
                  emptyInitializationVerified=True, globalItems=10, globalBytes=1_000_000,
                  storeItems=10, storeBytes=1_000_000, maxPayloadBytes=60_000,
                  maximumChecks=100, retryMilliseconds=60_000, admissionsUntil=now + 999_000_000)

    def fixture(name, store="one", person="person", **changes):
        row = dict(id=name, statsId=store, session="cs_test_" + name,
                   person=person, sourceValue=json.dumps(dict(at=now // 1000, tracking="")),
                   sealed="s1.synthetic.nonce.protected-payload", fingerprint="a" * 64,
                   bytes=12_000, created=now, authorizedAt=now, next=now, state="queued", owner="", leaseUntil=0,
                   checks=0, reviewId="SYNTHETIC")
        row.update(changes)
        keys = [prefix + "row:" + name, prefix + "source:" + name, prefix + "due",
                prefix + "store:" + store, prefix + "person:" + store + ":" + person,
                prefix + "pool", prefix + "pool:" + store, prefix + "all",
                prefix + "closed:" + store, prefix + "erased:" + store + ":" + person]
        made.update(keys)
        return row, keys

    def run(op, row, keys, expected="", at=now, owner="owner", p=policy, client=redis):
        return client.command("EVAL", script, 10, *keys, op, expected, json.dumps(row), at,
                              131_072, json.dumps(p), owner)

    def stats():
        out = {}
        for line in redis.command("INFO", "COMMANDSTATS").splitlines():
            m = re.match(r"cmdstat_([^:]+):calls=(\d+),", line)
            if m and m[1] != "info":
                out[m[1]] = int(m[2])
        return out

    def measured(fn, ceiling):
        before = stats()
        result = fn()
        after = stats()
        count = sum(n - before.get(cmd, 0) for cmd, n in after.items())
        assert count <= ceiling, (count, ceiling, result)
        return result, count

    try:
        row, keys = fixture("first")
        reply, count = measured(lambda: run("enqueue", row, keys), 27)
        assert reply == ["queued", json.dumps(row)]
        assert redis.command("TTL", keys[0]) == -1
        assert redis.command("TTL", keys[1]) == -1
        assert redis.command("HGET", keys[5], "items") == "1"
        memory = sum(redis.command("MEMORY", "USAGE", key, "SAMPLES", "0") or 0 for key in keys)
        assert memory <= row["bytes"], (memory, row["bytes"])
        print("PASS: source, protected row and bounded indices are one durable write; billed commands", count)

        duplicate = run("enqueue", row, keys)
        assert duplicate[0] == "existing"
        assert redis.command("HGET", keys[5], "items") == "1"
        blocked, blocked_keys = fixture("no-room")
        assert run("enqueue", blocked, blocked_keys, p={**policy, "globalItems": 1}) == ["full"]
        assert redis.command("EXISTS", blocked_keys[0], blocked_keys[1]) == 0
        assert run("enqueue", blocked, blocked_keys, p={**policy, "globalBytes": 12_001}) == ["full"]
        print("PASS: duplicate/lost enqueue ACK cannot spend another slot; full budgets create no shipment mark")

        claim, count = measured(lambda: run("claim", row, keys, duplicate[1], owner="a" * 48), 16)
        assert claim[0] == "preparing"
        claimed = json.loads(claim[1])
        later = now + 2 * 60_000
        second = run("claim", claimed, keys, claim[1], at=later, owner="b" * 48)
        assert second[0] == "preparing"
        assert run("dispatch", claimed, keys, claim[1], at=later, owner="a" * 48)[0] == "changed"
        current = json.loads(second[1])
        barrier, count = measured(lambda: run("dispatch", current, keys, second[1], at=later, owner="b" * 48), 16)
        assert barrier[0] == "dispatching"
        held = json.loads(barrier[1])
        assert run("claim", held, keys, barrier[1], at=later + 73 * 3_600_000)[0] == "held"
        assert redis.command("ZSCORE", keys[2], row["id"]) is None
        assert redis.command("EXISTS", keys[0]) == 1
        print("PASS: lease recovers only pre-dispatch preparation; a lost dispatch ACK stays held beyond 72h")

        accepted, count = measured(lambda: run("accepted", held, keys, barrier[1], at=later, owner="b" * 48), 27)
        assert accepted == ["accepted"]
        assert redis.command("EXISTS", keys[0]) == 0 and redis.command("EXISTS", keys[1]) == 1
        assert 34_559_900 <= redis.command("TTL", keys[1]) <= 34_560_000
        assert redis.command("HGET", keys[5], "bytes") == "0"
        assert redis.command("EXISTS", keys[6]) == 0
        assert run("enqueue", row, keys)[0] == "legacy"
        print("PASS: accepted email removes payload and reservations; its source prevents another automatic send; commands", count)

        r, k = fixture("erase")
        fresh = run("enqueue", r, k)
        c = run("claim", r, k, fresh[1], owner="c" * 48)
        preparing = json.loads(c[1])
        canceled = run("cancel", preparing, k, c[1], p=None)
        assert canceled == ["canceled"]
        assert run("dispatch", preparing, k, c[1], owner="c" * 48)[0] == "missing"
        assert redis.command("SMEMBERS", k[4]) == []
        print("PASS: erasure before dispatch destroys payload, removes indices and blocks a stale worker")

        r, k = fixture("old")
        original = run("enqueue", r, k)
        c = run("claim", r, k, original[1], owner="d" * 48)
        preparing = json.loads(c[1])
        waiting = run("defer", preparing, k, c[1], owner="d" * 48)
        pending = json.loads(waiting[1])
        assert run("claim", pending, k, waiting[1], at=now + 73 * 3_600_000, owner="e" * 48)[0] == "preparing"
        print("PASS: known no-send work resumes after 24/72h without a checkout or expiring provider idempotency key")

        # Closing admissions stops only new obligations, not the separately
        # funded drain. A successor review must name the old one explicitly.
        r, k = fixture("review-continuation", store="continuation")
        enqueued = run("enqueue", r, k)
        successor = {**policy, "reviewId": "NEXT", "admissionsUntil": now - 1}
        assert run("claim", r, k, enqueued[1], p=successor)[0] == "unknown"
        successor["continuedReviewIds"] = ["SYNTHETIC"]
        resumed = run("claim", r, k, enqueued[1], p=successor)
        assert resumed[0] == "preparing" and json.loads(resumed[1])["reviewId"] == "NEXT"
        print("PASS: funded pending work drains after admissions close and only across an explicitly reviewed successor")

        r, k = fixture("last-preparation", store="last")
        enqueued = run("enqueue", r, k, p={**policy, "maximumChecks": 1})
        last = run("claim", r, k, enqueued[1], p={**policy, "maximumChecks": 1})
        assert redis.command("ZSCORE", k[2], r["id"]) is not None
        held = run("claim", json.loads(last[1]), k, last[1], at=now + 61_000, p={**policy, "maximumChecks": 1})
        assert held[0] == "queued" and json.loads(held[1])["next"] == 0
        assert redis.command("ZSCORE", k[2], r["id"]) == "-1"
        print("PASS: the final abandoned preparation becomes an explicit on-hold record, never a phantom queued retry")

        r, k = fixture("old-producer", store="deleted")
        redis.command("SET", k[9], "erasure-generation")
        assert run("enqueue", r, k) == ["unknown"]
        assert redis.command("EXISTS", k[0], k[1]) == 0
        redis.command("DEL", k[9])
        assert run("enqueue", r, k, at=now + 600_001) == ["unknown"]
        print("PASS: erasure fences block an old producer, and its admission expires before a completed fence can disappear")

        r, k = fixture("erase-before-post", store="post-erased")
        enqueued = run("enqueue", r, k)
        prepared = run("claim", r, k, enqueued[1])
        redis.command("SET", k[8], "store-closing-generation")
        assert run("dispatch", json.loads(prepared[1]), k, prepared[1])[0] == "held"
        assert run("cancel", json.loads(prepared[1]), k, prepared[1], p=None) == ["canceled"]
        print("PASS: store/person deletion that wins before the dispatch barrier prevents the provider POST")

        parallel, parallel_keys = fixture("parallel", store="two")
        def attempt(_):
            client = LocalRedis()
            try:
                return run("enqueue", parallel, parallel_keys, client=client)[0]
            finally:
                client.close()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(attempt, range(16)))
        assert outcomes.count("queued") == 1 and outcomes.count("existing") == 15
        print("PASS: sixteen concurrent producers have exactly one durable owner")

        wrong, wrong_keys = fixture("wrong", store="wrong")
        redis.command("RPUSH", wrong_keys[0], "wrong type")
        assert run("enqueue", wrong, wrong_keys) == ["unknown"]
        assert redis.command("EXISTS", wrong_keys[1]) == 0
        print("PASS: wrong types never authorize source writes or provider work")

        large, large_keys = fixture("b" * 64, store="s" * 128, person="c" * 64,
                                    session="cs_test_" + "q" * 200, sealed="s1." + "x" * 80_040,
                                    sourceValue=json.dumps(dict(at=now // 1000, tracking="https://example.test/" + "t" * 470)))
        large["bytes"] = len(json.dumps(large).encode()) + 2 * sum(len(key.encode()) for key in large_keys) + 8_192
        assert run("enqueue", large, large_keys)[0] == "queued"
        memory = sum(redis.command("MEMORY", "USAGE", key, "SAMPLES", "0") or 0 for key in large_keys)
        assert memory <= large["bytes"], (memory, large["bytes"])
        print("PASS: large ciphertext and long ownership keys fit the synthetic pre-write memory reservation; no monetary funding is inferred")

        for malformed in ["24000.0", "024000", "2.4e4", "9007199254740992"]:
            corrupt, corrupt_keys = fixture("shape-" + re.sub(r"\W", "", malformed), store="corrupt")
            current = run("enqueue", corrupt, corrupt_keys)
            before = redis.command("HGET", corrupt_keys[5], "items")
            before_bytes = redis.command("HGET", corrupt_keys[5], "bytes")
            redis.command("HSET", corrupt_keys[5], "bytes", malformed)
            assert run("cancel", corrupt, corrupt_keys, current[1], p=None) == ["canceled"]
            assert redis.command("HGET", corrupt_keys[5], "items") == before
            assert redis.command("HGET", corrupt_keys[5], "bytes") == malformed
            assert run("cancel", corrupt, corrupt_keys, current[1], p=None) == ["missing"]
            assert redis.command("HGET", corrupt_keys[5], "items") == before
            # Restore only this synthetic ledger for the next independent case.
            redis.command("HSET", corrupt_keys[5], "bytes", before_bytes)
        print("PASS: noncanonical integer pools cannot partially refund slots; erasure retains uncertain reserves on repeated calls")

        unknown, unknown_keys = fixture("unknown-pool", store="three")
        enrolled = run("enqueue", unknown, unknown_keys)
        redis.command("HSET", unknown_keys[5], "bytes", "not-a-number")
        assert run("cancel", unknown, unknown_keys, enrolled[1], p=None) == ["canceled"]
        assert redis.command("EXISTS", unknown_keys[0]) == 0
        assert redis.command("HGET", unknown_keys[5], "bytes") == "not-a-number"
        print("PASS: privacy erasure removes payload even if financial evidence is corrupt; unknown reserve is never released")
        pending_recovery_cases(redis, source, made)
    finally:
        if made:
            redis.command("DEL", *sorted(made))
        redis.close()


if __name__ == "__main__":
    main()
