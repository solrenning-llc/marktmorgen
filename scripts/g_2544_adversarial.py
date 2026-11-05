"""Independent G review: exact application Lua on owned loopback Redis only."""
import hashlib, json, os, re
from pathlib import Path
from test_shipment_mail_outbox_redis import LocalRedis

source=(Path(__file__).resolve().parents[1]/'lib/shipment-mail-outbox.ts').read_text()
lua=re.search(r'export const SHIPMENT_MAIL_SCRIPT = `([^`]+)`;',source)[1]
reader=re.search(r'export const SHIPMENT_MAIL_REFUSED_SCRIPT = `([^`]+)`;',source)[1]
assert os.environ.get('MARKTMORGEN_REDIS_INTEGRATION') == '1', 'Owned disposable loopback Redis required'
r=LocalRedis(); now=1800000000000; owner='c'*48; checks=0
assert r.command('EXISTS','nl:ship:mail:pool','nl:ship:mail:all','nl:ship:mail:due') == 0, 'Refuse a previously used namespace'
policy=dict(reviewId='G_REVIEW',evidence='SYNTHETIC only',ongoingStorageFunded=True,emptyInitializationVerified=True,globalItems=100,globalBytes=10000000,storeItems=100,storeBytes=10000000,maxPayloadBytes=60000,maximumChecks=100,retryMilliseconds=60000,admissionsUntil=now+86400000)
def check(name,got,want):
    global checks
    checks+=1
    assert got==want,(name,got,want)
    print('PASS:',name)
def apply(op,row,keys,raw='',at=now):
    return r.command('EVAL',lua,10,*keys,op,raw,json.dumps(row),at,131072,json.dumps(policy),owner)
def fixture(seed):
    stats='g2544'; session='cs_test_'+seed+'0000000000'; person='b'*64
    ident=hashlib.sha256((stats+'\n'+session).encode()).hexdigest()
    row=dict(id=ident,statsId=stats,session=session,person=person,sourceValue='{"at":1800000000,"tracking":""}',sealed='s1.synthetic',fingerprint='a'*64,bytes=12000,created=now,authorizedAt=now,next=now,state='queued',owner='',leaseUntil=0,checks=0,reviewId='G_REVIEW')
    prefix='nl:ship:mail:'
    keys=[prefix+'row:'+ident,'nl:ship:done:'+session,prefix+'due',prefix+'store:'+stats,prefix+'person:'+stats+':'+person,prefix+'pool',prefix+'pool:'+stats,prefix+'all',prefix+'closed:'+stats,prefix+'erased:'+stats+':'+person]
    assert apply('enqueue',row,keys)[0]=='queued'
    prepared=apply('claim',row,keys,r.command('GET',keys[0]))[1]
    dispatched=apply('dispatch',row,keys,prepared)[1]
    return row,keys,prepared,dispatched
try:
    row,keys,prepared,dispatched=fixture('mismatch')
    for field in ['id','statsId','session','person','sourceValue','sealed','fingerprint','bytes','created','authorizedAt','checks','reviewId']:
        changed=json.loads(prepared)
        changed[field]=changed[field]+1 if isinstance(changed[field],int) else changed[field]+'x'
        check('no-POST rejects changed '+field,apply('not-posted',row,keys,json.dumps(changed)),['changed'])
        check('mismatch preserves original dispatch '+field,r.command('GET',keys[0]),dispatched)
    check('unknown dispatch remains closed after lease expiry',apply('claim',row,keys,dispatched,now+1000000)[0],'held')
    before=r.command('HMGET',keys[5],'items','bytes')
    first=apply('refused',row,keys,dispatched) # deliberately discard its ACK
    check('refusal applied before lost ACK',first,['refused'])
    check('lost refusal ACK cannot apply drop twice',apply('refused',row,keys,dispatched),['missing'])
    check('only one pending slot is released',r.command('HMGET',keys[5],'items','bytes'),['0','0'])
    check('original hold existed',before,['1','12000'])
    gf='refused:'+row['id']; sf='refused:'+row['person']+':'+row['id']
    summary=r.command('HGET',keys[5],gf)
    check('lost ACK leaves both same terminal witnesses',r.command('HGET',keys[6],sf),summary)
    r.command('HSET',keys[6],sf,'conflicting witness')
    check('erasure refuses split witnesses',r.command('EVAL',reader,2,keys[5],keys[6],'erase',sf,summary),[0])
    check('split witness does not partially erase global status',r.command('HGET',keys[5],gf),summary)
    r.command('HSET',keys[6],sf,summary)
    check('confirmed erasure deletes both witnesses',r.command('EVAL',reader,2,keys[5],keys[6],'erase',sf,summary),[1])
    row,keys,prepared,dispatched=fixture('fence')
    r.command('SET',keys[9],'erasure in progress')
    check('erasure fence wins before terminal refusal',apply('refused',row,keys,dispatched)[0],'held')
    check('fenced refusal retains custody',r.command('GET',keys[0]),dispatched)
    check('erasure can cancel fenced dispatch',apply('cancel',row,keys,dispatched),['canceled'])
    check('late refusal cannot recreate erased custody',apply('refused',row,keys,dispatched),['missing'])
    check('late refusal creates no terminal summary',r.command('HGET',keys[5],'refused:'+row['id']),None)
    print(f'{checks} checks, all passing; no provider, funding or supplier invoice asserted.')
finally:
    r.close()
