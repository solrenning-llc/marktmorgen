import {prepareRestartActivation,type RestartContractActivation} from "@/lib/contract-restart-activation";
import {CURRENT_CONTRACT_FUNDING_POLICY,type ContractFundingPolicy,type ContractFundingContext} from "@/lib/contract-funding-rules";
import {CURRENT_COMMERCIAL_MARGIN_REVIEW,CURRENT_PRICE_AND_RIGHTS_SNAPSHOT} from "@/lib/commercial-margin";
import {redisPipeline} from "@/lib/redis";
import {withRestartPublicationRecord,type RestartPublicationGoal} from "@/lib/store";
import {ENDED_INDEX} from "@/lib/plan-standing";
import {PAYING_INDEX} from "@/lib/free-pool-rules";
import {SHARING_INDEX} from "@/lib/platform-share";
import type {Tier} from "@/lib/plan";
import type {StartedSubscription} from "@/lib/billing";

export const PUBLISH_RESTART_STORE = `local function integer(n) return type(n)=='number' and n==math.floor(n) and n>=0 and n<=1000000000000 end
local function decode(raw,cap)
 if type(raw)~='string' or #raw>cap then return nil end
 local ok,v=pcall(cjson.decode,raw)
 if not ok or type(v)~='table' then return nil end
 return v
end
local function kind(key,expected,absent)
 local t=redis.call('TYPE',key).ok
 return t==expected or (absent and t=='none')
end
local function same(a,b,depth)
 if type(a)~=type(b) or depth>30 then return false end
 if type(a)~='table' then return a==b end
 local count=0
 for k,v in pairs(a) do count=count+1 if not same(v,b[k],depth+1) then return false end end
 local n=0 for _ in pairs(b) do n=n+1 end
 return n==count
end
if #KEYS~=9 or #ARGV~=15 then return 0 end
local e,s,o=decode(ARGV[3],4096),decode(ARGV[4],512),decode(ARGV[5],256)
local r=decode(ARGV[15],1536)
local now=tonumber(ARGV[6])
if not e or not s or not o or not r or not integer(now) or not integer(o.start) or not integer(o.finish) or o.start>now or o.finish<=now then return 0 end
for _,f in ipairs({'grant','sourceGrant','claim','ref','statsId','handle','sourceSubscription','restartReceipt','paused'}) do if type(e[f])~='string' then return 0 end end
if type(o.id)~='string' or not integer(o.created) or type(ARGV[12])~='string' or #ARGV[12]>128 then return 0 end
if KEYS[1]~='nl:contract-reserve:v1' or KEYS[2]~=string.gsub(KEYS[3],'nl:store:owner:','nl:store:lock:',1) or
 KEYS[4]~='nl:pause:'..e.ref or KEYS[5]~='nl:pause:due' or KEYS[6]~='nl:pause:last:'..e.ref or
 KEYS[7]~='nl:plan:ended' or KEYS[8]~='nl:plan:paying' or KEYS[9]~='nl:share:stores' then return 0 end
if type(KEYS[3])~='string' or #KEYS[3]~=55 or not string.match(KEYS[3],'^nl:store:owner:[a-f0-9]+$') then return 0 end
if not kind(KEYS[1],'hash',false) or redis.call('TTL',KEYS[1])~=-1 or not kind(KEYS[3],'string',false) or redis.call('TTL',KEYS[3])~=-1 then return 0 end
if not kind(KEYS[5],'zset',true) or not kind(KEYS[6],'string',false) or not kind(KEYS[7],'zset',true) or not kind(KEYS[8],'set',true) or not kind(KEYS[9],'set',true) then return 0 end
local planKey=string.match(e.restartReceipt,'^[^|]+|[^|]+|([^|]+)|')
if planKey~='creator_month' and planKey~='pro_month' and planKey~='scale_month' then return 0 end
local binding=e.grant..'|'..o.id..'|'..planKey..'|'..o.created..'|paid|'..o.start..'|'..o.finish
if #binding>256 or type(o.renews)~='boolean' or type(o.shared)~='boolean' then return 0 end
local count=0 for _ in pairs(r) do count=count+1 end
if count~=20 or r.version~=1 or r.policy~=ARGV[1] or r.review~=ARGV[2] or r.grant~=e.grant or r.sourceGrant~=e.sourceGrant or r.claim~=e.claim or r.ref~=e.ref or
 r.statsId~=e.statsId or r.handle~=e.handle or r.sourceSubscriptionId~=e.sourceSubscription or r.subscriptionId~=o.id or r.binding~=binding or r.start~=o.start or r.finish~=o.finish or
 r.renews~=o.renews or r.shared~=o.shared or r.annual~=e.annual then return 0 end
if type(r.tier)~='string' or r.tier..'_month'~=planKey then return 0 end
local paused=decode(e.paused,1536)
if not paused or r.customerId~=paused.customer or r.tier~=paused.tier or type(r.sid)~='string' or #r.sid>32 then return 0 end
local function storeMatches(v,active)
 if not v or type(v.extra)~='boolean' or type(v.email)~='string' or type(v.sid)~='string' or v.handle~=r.handle or v.statsId~=r.statsId or v.sid~=r.sid or v.stripeCustomerId~=r.customerId or v.tier~=r.tier or v.cycle~='month' or v.subscriptionActive~=active then return false end
 local ref=v.extra==true and ('#'..v.sid) or v.email
 if ref~=r.ref then return false end
 if not active then return v.subscriptionId==r.sourceSubscriptionId end
 local p=v.period
 return v.subscriptionId==r.subscriptionId and v.trialEnds==0 and v.shared==r.shared and v.planEndedAt=='' and
 type(p)=='table' and p.start==r.start and p['end']==r.finish and p.renews==r.renews and p.funded==true
end

if type(ARGV[13])~='string' or #ARGV[13]>1000000 or type(ARGV[14])~='string' or #ARGV[14]>1000000 then return 0 end
if not kind(KEYS[2],'string',false) or not kind(KEYS[4],'string',false) then return 0 end
local lease=redis.call('PTTL',KEYS[2])
if lease<=0 or lease>15000 or redis.call('GET',KEYS[2])~=ARGV[12] or redis.call('GET',KEYS[3])~=ARGV[13] then return 0 end
local before,after=decode(ARGV[13],1000000),decode(ARGV[14],1000000)
if not storeMatches(before,false) or not storeMatches(after,true) then return 0 end
local allowed={stripeCustomerId=true,subscriptionId=true,subscriptionActive=true,subscriptionCheckedAt=true,tier=true,cycle=true,trialEnds=true,shared=true,period=true,planEndedAt=true}
for k,v in pairs(before) do if not allowed[k] and not same(v,after[k],0) then return 0 end end
for k,v in pairs(after) do if not allowed[k] and before[k]==nil then return 0 end end
if type(after.subscriptionCheckedAt)~='string' or #after.subscriptionCheckedAt~=24 then return 0 end
local periodFields=0 for _ in pairs(after.period) do periodFields=periodFields+1 end
if periodFields~=4 then return 0 end
if redis.call('HGET',KEYS[1],'activated:'..e.grant)~=binding or redis.call('HGET',KEYS[1],'restart-published:'..e.grant) then return 0 end
local function validateActivation()
 local KEYS={KEYS[1],KEYS[4],KEYS[5],KEYS[6]}
 local ARGV={ARGV[1],ARGV[2],ARGV[3],ARGV[4],ARGV[5],ARGV[6],ARGV[7],ARGV[8],ARGV[9],ARGV[10],ARGV[11]}

local function integer(n)
 return type(n)=='number' and n==math.floor(n) and n>=0 and n<=1000000000000
end
local function amount(raw)
 if type(raw)~='string' or not string.match(raw,'^%d+$') or (#raw>1 and string.sub(raw,1,1)=='0') then return nil end
 local n=tonumber(raw)
 if not integer(n) then return nil end
 return n
end
local function parts(raw,limit)
 if type(raw)~='string' or #raw>limit then return nil end
 local out={}
 for p in string.gmatch(raw,'[^|]+') do out[#out+1]=p end
 if table.concat(out,'|')~=raw then return nil end
 return out
end
local function decode(raw,limit)
 if type(raw)~='string' or #raw>limit then return nil end
 local ok,value=pcall(cjson.decode,raw)
 if not ok or type(value)~='table' then return nil end
 return value
end
if #KEYS~=4 or #ARGV~=11 then return 0 end
local e,s,o=decode(ARGV[3],4096),decode(ARGV[4],512),decode(ARGV[5],256)
if not e or not s or not o or type(o.renews)~='boolean' or type(o.shared)~='boolean' then return 0 end
local fields={'version','grant','review','statsId','sourceSubscription','sourceGrant','ref','handle','paused','claim','created','deadline','sourceBinding','sourceReceipt','restartReceipt','reservedCents','carriedCents','annual'}
local count=0
for _ in pairs(e) do count=count+1 end
if count~=#fields then return 0 end
for _,f in ipairs(fields) do if e[f]==nil then return 0 end end
if e.version~=1 or type(e.grant)~='string' or #e.grant>84 or not string.match(e.grant,'^ctr_[%w_-]+$') or type(e.sourceGrant)~='string' or #e.sourceGrant>84 or not string.match(e.sourceGrant,'^ctr_[%w_-]+$') or e.grant==e.sourceGrant then return 0 end
if type(e.statsId)~='string' or #e.statsId<1 or #e.statsId>128 or not string.match(e.statsId,'^[%w_-]+$') or type(e.sourceSubscription)~='string' or #e.sourceSubscription>68 or not string.match(e.sourceSubscription,'^sub_[A-Za-z0-9]+$') then return 0 end
if type(e.ref)~='string' or #e.ref<1 or #e.ref>320 or type(e.handle)~='string' or #e.handle<3 or #e.handle>24 or type(e.paused)~='string' or #e.paused>1536 or type(e.claim)~='string' or #e.claim>86 or not string.match(e.claim,'^claim_[%w_-]+$') then return 0 end
if e.review~=ARGV[2] or not integer(e.created) or not integer(e.deadline) or e.created>e.deadline or not integer(e.reservedCents) or not integer(e.carriedCents) or e.carriedCents>e.reservedCents then return 0 end
if KEYS[2]~='nl:pause:'..e.ref or KEYS[3]~='nl:pause:due' or KEYS[4]~='nl:pause:last:'..e.ref then return 0 end
local now,minimum,limit,carry,funded,span=amount(ARGV[6]),amount(ARGV[7]),amount(ARGV[8]),amount(ARGV[9]),amount(ARGV[10]),amount(ARGV[11])
if not now or not minimum or minimum<=0 or not limit or not carry or not funded or funded<1 or not span or span<=0 then return 0 end
if type(o.id)~='string' or #o.id>68 or not string.match(o.id,'^sub_[A-Za-z0-9]+$') or o.id==e.sourceSubscription or not integer(o.created) or not integer(o.start) or not integer(o.finish) or o.created<=0 or o.start<o.created or o.start>now or o.finish<=now or o.finish-o.start>span then return 0 end
if type(s.priceId)~='string' or #s.priceId>106 or not string.match(s.priceId,'^price_[A-Za-z0-9]+$') or type(s.bodyHash)~='string' or #s.bodyHash~=64 or not string.match(s.bodyHash,'^[a-f0-9]+$') or not integer(s.armedAt) or s.armedAt<e.created or s.armedAt>e.deadline or s.armedAt>now or o.created<s.armedAt or s.idempotencyKey~='restart:'..e.grant..':'..e.claim then return 0 end
local source,receipt,oldReceipt=parts(e.sourceBinding,256),parts(e.restartReceipt,1024),parts(e.sourceReceipt,1024)
if not source or #source~=7 or source[1]~=e.sourceGrant or source[2]~=e.sourceSubscription or source[5]~='paid' or not receipt or #receipt~=10 or receipt[1]~=e.review or receipt[2]~=e.statsId or receipt[3]~=source[3] or receipt[4]~='restart' or receipt[10]~=e.sourceGrant then return 0 end
if receipt[3]~='creator_month' and receipt[3]~='pro_month' and receipt[3]~='scale_month' then return 0 end
local oldCreated,oldStart,oldFinish=amount(source[4]),amount(source[6]),amount(source[7])
local charge,submitted,expires,deadline=amount(receipt[5]),amount(receipt[6]),amount(receipt[7]),amount(receipt[8])
local through=tonumber(receipt[9])
if not oldCreated or not oldStart or not oldFinish or oldCreated<=0 or oldStart<oldCreated or oldFinish<=oldStart or oldFinish>e.created or charge~=minimum or submitted~=e.deadline or not expires or not deadline or expires<submitted or deadline<expires or o.created>deadline then return 0 end
if not through or through~=math.floor(through) or through>9007199254740991 or not string.match(receipt[9],'^%d+$') or (#receipt[9]>1 and string.sub(receipt[9],1,1)=='0') or o.finish*1000>through then return 0 end
if not oldReceipt or oldReceipt[1]~=e.review or oldReceipt[2]~=e.statsId or oldReceipt[3]~=source[3] or not ((#oldReceipt==9 and oldReceipt[4]=='checkout') or (#oldReceipt==10 and (oldReceipt[4]=='switch' or oldReceipt[4]=='restart'))) then return 0 end
local oldCharge=amount(oldReceipt[5])
if not oldCharge or oldCharge<=0 or oldCharge+charge>e.reservedCents-e.carriedCents then return 0 end
local pause=decode(e.paused,1536)
if not pause or pause.subscription~=e.sourceSubscription or pause.from~=oldFinish or not integer(pause['until']) or pause['until']<=oldFinish or pause['until']>e.created or type(pause.funding)~='table' or pause.funding.version~=1 or pause.funding.grantId~=e.sourceGrant then return 0 end
if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('TTL',KEYS[1])~=-1 then return 0 end
local v=redis.call('HMGET',KEYS[1],'policy','review','pending:'..e.statsId,'active:'..e.statsId,'restart-owner:'..e.sourceGrant,'restart-intent:'..e.grant,'grant:'..e.sourceGrant,'activated:'..e.sourceGrant,'grant:'..e.grant,'reserved','carried','slots:'..receipt[3],'activated:'..e.grant,'restart-publication:'..e.grant)
if v[1]~=ARGV[1] or v[2]~=e.review or v[3]~=e.grant or v[5]~=e.grant or v[7]~=e.sourceReceipt or v[8]~=e.sourceBinding or v[9]~=e.restartReceipt then return 0 end
local actual=decode(v[6],4096)
if not actual then return 0 end
local actualFields=0
for _ in pairs(actual) do actualFields=actualFields+1 end
if actualFields~=#fields+1 then return 0 end
for _,f in ipairs(fields) do if actual[f]~=e[f] then return 0 end end
local a=actual.submission
if type(a)~='table' or a.version~=1 or a.phase~='observed' or a.subscriptionId~=o.id or a.priceId~=s.priceId or a.bodyHash~=s.bodyHash or a.armedAt~=s.armedAt or a.idempotencyKey~=s.idempotencyKey then return 0 end
local reserved,carried,slots=amount(v[10]),amount(v[11]),amount(v[12])
if not reserved or not carried or not slots or carried~=carry or carried~=e.carriedCents or reserved<e.reservedCents or reserved>limit or reserved-carried<oldCharge+charge or slots<1 or slots>funded then return 0 end
if redis.call('GET',KEYS[2])~=e.paused or redis.call('ZSCORE',KEYS[3],e.ref)~=tostring(pause['until']) then return 0 end
local annual=amount(redis.call('GET',KEYS[4]))
if not annual or annual<=0 or annual>now or annual~=e.annual then return 0 end
local binding=e.grant..'|'..o.id..'|'..receipt[3]..'|'..o.created..'|paid|'..o.start..'|'..o.finish
if #binding>256 then return 0 end
local checkpoint={version=1,binding=binding,renews=o.renews,shared=o.shared}
local encodedCheckpoint=cjson.encode(checkpoint)
if #encodedCheckpoint>384 then return 0 end
if v[13] then
 if v[13]~=binding or v[4]~=binding then return 0 end
 local existing=decode(v[14],384)
 if not existing then return 0 end
 local n=0 for _ in pairs(existing) do n=n+1 end
 if n~=4 or existing.version~=1 or existing.binding~=binding or existing.renews~=o.renews or existing.shared~=o.shared then return 0 end
 local retained=a.publication
 if type(retained)~='table' then return 0 end
 local retainedFields=0 for _ in pairs(retained) do retainedFields=retainedFields+1 end
 if retainedFields~=2 or retained.renews~=o.renews or retained.shared~=o.shared then return 0 end
 return {2,o.finish}
end
if v[14] or a.publication~=nil then return 0 end
if now>deadline or v[4]~=e.sourceBinding then return 0 end
a.publication={renews=o.renews,shared=o.shared}
local retainedIntent=cjson.encode(actual)
if #retainedIntent>4096 then return 0 end
redis.call('HSET',KEYS[1],'activated:'..e.grant,binding,'active:'..e.statsId,binding,'restart-publication:'..e.grant,encodedCheckpoint,'restart-intent:'..e.grant,retainedIntent)
return {1,deadline}

end
local acknowledged=validateActivation()
if type(acknowledged)~='table' or acknowledged[1]~=2 or acknowledged[2]~=o.finish then return 0 end
redis.call('SET',KEYS[3],ARGV[14],'KEEPTTL')
redis.call('ZREM',KEYS[7],e.ref)
redis.call('SADD',KEYS[8],e.ref)
if r.shared then redis.call('SADD',KEYS[9],e.ref) else redis.call('SREM',KEYS[9],e.ref) end
redis.call('DEL',KEYS[4])
redis.call('ZREM',KEYS[5],e.ref)
redis.call('HSET',KEYS[1],'restart-published:'..e.grant,ARGV[15])
redis.call('HDEL',KEYS[1],'pending:'..e.statsId)
return {1,o.finish}
`;
export const READ_RESTART_PUBLICATION = `local function integer(n) return type(n)=='number' and n==math.floor(n) and n>=0 and n<=1000000000000 end
local function decode(raw,cap)
 if type(raw)~='string' or #raw>cap then return nil end
 local ok,v=pcall(cjson.decode,raw)
 if not ok or type(v)~='table' then return nil end
 return v
end
local function kind(key,expected,absent)
 local t=redis.call('TYPE',key).ok
 return t==expected or (absent and t=='none')
end
local function same(a,b,depth)
 if type(a)~=type(b) or depth>30 then return false end
 if type(a)~='table' then return a==b end
 local count=0
 for k,v in pairs(a) do count=count+1 if not same(v,b[k],depth+1) then return false end end
 local n=0 for _ in pairs(b) do n=n+1 end
 return n==count
end
if #KEYS~=9 or #ARGV~=15 then return 0 end
local e,s,o=decode(ARGV[3],4096),decode(ARGV[4],512),decode(ARGV[5],256)
local r=decode(ARGV[15],1536)
local now=tonumber(ARGV[6])
if not e or not s or not o or not r or not integer(now) or not integer(o.start) or not integer(o.finish) or o.start>now or o.finish<=now then return 0 end
for _,f in ipairs({'grant','sourceGrant','claim','ref','statsId','handle','sourceSubscription','restartReceipt','paused'}) do if type(e[f])~='string' then return 0 end end
if type(o.id)~='string' or not integer(o.created) or type(ARGV[12])~='string' or #ARGV[12]>128 then return 0 end
if KEYS[1]~='nl:contract-reserve:v1' or KEYS[2]~=string.gsub(KEYS[3],'nl:store:owner:','nl:store:lock:',1) or
 KEYS[4]~='nl:pause:'..e.ref or KEYS[5]~='nl:pause:due' or KEYS[6]~='nl:pause:last:'..e.ref or
 KEYS[7]~='nl:plan:ended' or KEYS[8]~='nl:plan:paying' or KEYS[9]~='nl:share:stores' then return 0 end
if type(KEYS[3])~='string' or #KEYS[3]~=55 or not string.match(KEYS[3],'^nl:store:owner:[a-f0-9]+$') then return 0 end
if not kind(KEYS[1],'hash',false) or redis.call('TTL',KEYS[1])~=-1 or not kind(KEYS[3],'string',false) or redis.call('TTL',KEYS[3])~=-1 then return 0 end
if not kind(KEYS[5],'zset',true) or not kind(KEYS[6],'string',false) or not kind(KEYS[7],'zset',true) or not kind(KEYS[8],'set',true) or not kind(KEYS[9],'set',true) then return 0 end
local planKey=string.match(e.restartReceipt,'^[^|]+|[^|]+|([^|]+)|')
if planKey~='creator_month' and planKey~='pro_month' and planKey~='scale_month' then return 0 end
local binding=e.grant..'|'..o.id..'|'..planKey..'|'..o.created..'|paid|'..o.start..'|'..o.finish
if #binding>256 or type(o.renews)~='boolean' or type(o.shared)~='boolean' then return 0 end
local count=0 for _ in pairs(r) do count=count+1 end
if count~=20 or r.version~=1 or r.policy~=ARGV[1] or r.review~=ARGV[2] or r.grant~=e.grant or r.sourceGrant~=e.sourceGrant or r.claim~=e.claim or r.ref~=e.ref or
 r.statsId~=e.statsId or r.handle~=e.handle or r.sourceSubscriptionId~=e.sourceSubscription or r.subscriptionId~=o.id or r.binding~=binding or r.start~=o.start or r.finish~=o.finish or
 r.renews~=o.renews or r.shared~=o.shared or r.annual~=e.annual then return 0 end
if type(r.tier)~='string' or r.tier..'_month'~=planKey then return 0 end
local paused=decode(e.paused,1536)
if not paused or r.customerId~=paused.customer or r.tier~=paused.tier or type(r.sid)~='string' or #r.sid>32 then return 0 end
local function storeMatches(v,active)
 if not v or type(v.extra)~='boolean' or type(v.email)~='string' or type(v.sid)~='string' or v.handle~=r.handle or v.statsId~=r.statsId or v.sid~=r.sid or v.stripeCustomerId~=r.customerId or v.tier~=r.tier or v.cycle~='month' or v.subscriptionActive~=active then return false end
 local ref=v.extra==true and ('#'..v.sid) or v.email
 if ref~=r.ref then return false end
 if not active then return v.subscriptionId==r.sourceSubscriptionId end
 local p=v.period
 return v.subscriptionId==r.subscriptionId and v.trialEnds==0 and v.shared==r.shared and v.planEndedAt=='' and
 type(p)=='table' and p.start==r.start and p['end']==r.finish and p.renews==r.renews and p.funded==true
end

local function amount(raw)
 if type(raw)~='string' or not string.match(raw,'^%d+$') or (#raw>1 and string.sub(raw,1,1)=='0') then return nil end
 local n=tonumber(raw) if not integer(n) then return nil end return n
end
local v=redis.call('HMGET',KEYS[1],'policy','review','pending:'..e.statsId,'active:'..e.statsId,'activated:'..e.grant,
 'restart-owner:'..e.sourceGrant,'restart-intent:'..e.grant,'grant:'..e.sourceGrant,'activated:'..e.sourceGrant,'grant:'..e.grant,
 'reserved','carried','slots:'..planKey,'restart-publication:'..e.grant,'restart-published:'..e.grant)
if v[1]~=ARGV[1] or v[2]~=ARGV[2] or v[3] or v[4]~=binding or v[5]~=binding or v[6]~=e.grant or v[8]~=e.sourceReceipt or v[9]~=e.sourceBinding or v[10]~=e.restartReceipt or v[15]~=ARGV[15] then return 0 end
local reserved,carried,slots=amount(v[11]),amount(v[12]),amount(v[13])
local limit,carry,funded=amount(ARGV[8]),amount(ARGV[9]),amount(ARGV[10])
if not reserved or not carried or not slots or not limit or not carry or not funded or reserved<e.reservedCents or reserved>limit or carried~=carry or carried~=e.carriedCents or slots<1 or slots>funded then return 0 end
local retained=decode(v[7],4096)
if not retained then return 0 end
local n=0 for _ in pairs(retained) do n=n+1 end
local expectedFields=0 for k,x in pairs(e) do expectedFields=expectedFields+1 if retained[k]~=x then return 0 end end
if n~=expectedFields+1 then return 0 end
local sub=retained.submission
if type(sub)~='table' or sub.version~=1 or sub.phase~='observed' or sub.subscriptionId~=o.id or sub.priceId~=s.priceId or sub.bodyHash~=s.bodyHash or sub.armedAt~=s.armedAt or sub.idempotencyKey~=s.idempotencyKey then return 0 end
local cp=decode(v[14],384)
if not cp or cp.version~=1 or cp.binding~=binding or cp.renews~=r.renews or cp.shared~=r.shared then return 0 end
local cpFields=0 for _ in pairs(cp) do cpFields=cpFields+1 end
local flags=sub.publication
if cpFields~=4 or type(flags)~='table' or flags.renews~=r.renews or flags.shared~=r.shared then return 0 end
local flagFields=0 for _ in pairs(flags) do flagFields=flagFields+1 end
if flagFields~=2 then return 0 end
local raw=redis.call('GETRANGE',KEYS[3],0,1000000)
if #raw>1000000 or not storeMatches(decode(raw,1000000),true) then return 0 end
if redis.call('GET',KEYS[4]) or redis.call('ZSCORE',KEYS[5],e.ref) or redis.call('ZSCORE',KEYS[7],e.ref) then return 0 end
if redis.call('SISMEMBER',KEYS[8],e.ref)~=1 or redis.call('SISMEMBER',KEYS[9],e.ref)~=(r.shared and 1 or 0) then return 0 end
if amount(redis.call('GET',KEYS[6]))~=e.annual then return 0 end
return {2,o.finish}
`;

type PublishedRestart=StartedSubscription&{fundedPublication:true};
function publicationAck(reply:unknown,finish:number):boolean|null{
 try{
  if(!Array.isArray(reply))return null;
  const outerLength=Object.getOwnPropertyDescriptor(reply,"length");
  if(!outerLength||!Object.hasOwn(outerLength,"value")||outerLength.value!==1)return null;
  if(Object.getOwnPropertySymbols(reply).length!==0)return null;
  const entry=Object.getOwnPropertyDescriptor(reply,"0");
  if(!entry||!Object.hasOwn(entry,"value"))return null;
  const ack=entry.value;
  if(ack===0)return false;
  if(!Array.isArray(ack))return null;
  const innerLength=Object.getOwnPropertyDescriptor(ack,"length");
  if(!innerLength||!Object.hasOwn(innerLength,"value")||innerLength.value!==2)return null;
  if(Object.getOwnPropertySymbols(ack).length!==0)return null;
  const flag=Object.getOwnPropertyDescriptor(ack,"0"),end=Object.getOwnPropertyDescriptor(ack,"1");
  if(!flag||!end||!Object.hasOwn(flag,"value")||!Object.hasOwn(end,"value"))return null;
  return (flag.value===1||flag.value===2)&&end.value===finish?true:null;
 }catch{return null;}
}
/** Acknowledged Store/index/generation publication only. Never another provider operation.
 * Notice funding and remaining lifecycle gates are separate; current coverage stays false.
 */
export async function publishRestartStore(
 input:RestartContractActivation,
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
):Promise<PublishedRestart|null>{
 const prepared=prepareRestartActivation(input,policy,context);if(!prepared)return null;
 const {armed,subscriptionId,createdSeconds,periodStartSeconds,periodEndSeconds,renews,shared}=prepared.input;
 const {intent}=armed;
 let paused:{customer?:unknown};try{paused=JSON.parse(intent.paused);}catch{return null;}
 if(typeof paused.customer!=="string")return null;
 const tier=intent.grant.key.split("_")[0] as Tier;
 const goal:RestartPublicationGoal={handle:intent.handle,statsId:intent.grant.statsId,sourceSubscriptionId:intent.grant.sourceSubscriptionId,
  customerId:paused.customer,tier,subscriptionId,periodStartSeconds,periodEndSeconds,renews,shared};
 return withRestartPublicationRecord<PublishedRestart|null>(intent.ref,goal,async record=>{
  const fresh=prepareRestartActivation(prepared.input,prepared.policy,prepared.context);
  if(!fresh||fresh.binding!==prepared.binding)return null;
  const expected=JSON.parse(String(fresh.args[2])) as {sourceGrant:string};
  const binding=[intent.grant.id,subscriptionId,intent.grant.key,createdSeconds,"paid",periodStartSeconds,periodEndSeconds].join("|");
  const receipt=JSON.stringify({version:1,policy:fresh.args[0],review:fresh.args[1],grant:intent.grant.id,sourceGrant:expected.sourceGrant,
   claim:intent.claim,ref:intent.ref,statsId:intent.grant.statsId,handle:intent.handle,sid:record.store.sid,customerId:goal.customerId,
   sourceSubscriptionId:goal.sourceSubscriptionId,subscriptionId,binding,start:periodStartSeconds,finish:periodEndSeconds,
   tier,renews,shared,annual:intent.source.annual});
  if(new TextEncoder().encode(receipt).length>1536)return null;
  const keys=["nl:contract-reserve:v1",record.held.key,record.owner,...fresh.keys.slice(1),ENDED_INDEX,PAYING_INDEX,SHARING_INDEX];
  const args=[...fresh.args,record.held.token,record.expected,record.next,receipt];
  let ack:boolean|null=null;
  try{ack=publicationAck(await redisPipeline([["EVAL",PUBLISH_RESTART_STORE,9,...keys,...args]]),periodEndSeconds);}catch{ack=null;}
  if(ack===false)return null;
  if(ack===null){
   // One bounded readback of this exact publication; no retrying writes or provider reads.
   const checked=prepareRestartActivation(prepared.input,prepared.policy,prepared.context);
   if(!checked||checked.binding!==fresh.binding)return null;
   try{ack=publicationAck(await redisPipeline([["EVAL",READ_RESTART_PUBLICATION,9,...keys,...checked.args,record.held.token,record.expected,record.next,receipt]]),periodEndSeconds);}
   catch{return null;}
  }
  const current=prepareRestartActivation(prepared.input,prepared.policy,prepared.context);
  if(ack!==true||!current||current.binding!==fresh.binding||Date.now()<fresh.startedAt)return null;
  return {customerId:goal.customerId,subscriptionId,active:true,tier,cycle:"month",trialEnds:0,shared,
   period:{start:periodStartSeconds,end:periodEndSeconds,renews,funded:true},fundedPublication:true};
 });
}
