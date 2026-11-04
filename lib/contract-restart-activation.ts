import {isRedisConfigured,redisPipeline} from "@/lib/redis";
import {commercialMarginReady,CURRENT_COMMERCIAL_MARGIN_REVIEW,CURRENT_PRICE_AND_RIGHTS_SNAPSHOT} from "@/lib/commercial-margin";
import {CONTRACT_ADMISSION_COVERAGE,CONTRACT_FUNDING_RULES,CURRENT_CONTRACT_FUNDING_POLICY,canonicalFinancialSnapshot,contractFundingConfiguration,type ContractFundingPolicy,type ContractFundingContext} from "@/lib/contract-funding-rules";
import {contractFundingBinding,ownedRestartIntentFromAcknowledgement,type ArmedRestartSubmission} from "./contract-funding";

/** Ledger activation only. Keeps the source, cash, pending owner and exact pause.
 * Store publication and generation-aware cleanup are separate acknowledgements.
 * Current coverage refuses before IO, including with an injected policy.
 */
export const ACTIVATE_RESTART_CONTRACT = `
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
`;

export type RestartContractActivation={armed:ArmedRestartSubmission;subscriptionId:string;createdSeconds:number;periodStartSeconds:number;periodEndSeconds:number;renews:boolean;shared:boolean};
/** One immutable, bounded activation request shared by activation and the future joint publisher.
 * Current coverage refuses before input getters or any IO. Preparation is not authorization.
 */
export function prepareRestartActivation(
 input:RestartContractActivation,
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
){
 if(!Boolean(CONTRACT_ADMISSION_COVERAGE.pauseRestart))return null;
 try{
  const encoded=canonicalFinancialSnapshot({input,policy,context});if(!encoded)return null;
  ({input,policy,context}=JSON.parse(encoded));
  const {armed,subscriptionId,createdSeconds,periodStartSeconds,periodEndSeconds,renews,shared}=input;
  if(typeof renews!=='boolean'||typeof shared!=='boolean')return null;
  const {intent}=armed,{grant}=intent;
  const before=new Date(),seconds=Math.floor(before.getTime()/1000),config=contractFundingConfiguration(policy,context,before);
  if(!config||!commercialMarginReady(context.review)||config.reviewId!==grant.reviewId||config.grantCents[grant.key]!==grant.reservedCents||!isRedisConfigured())return null;
  const sourceGrantId=intent.source.binding.split("|")[0];
  const expected={version:1,grant:grant.id,review:grant.reviewId,statsId:grant.statsId,sourceSubscription:grant.sourceSubscriptionId,sourceGrant:sourceGrantId,ref:intent.ref,handle:intent.handle,paused:intent.paused,claim:intent.claim,created:intent.claimedAtSeconds,deadline:grant.submitUntilSeconds,sourceBinding:intent.source.binding,sourceReceipt:intent.source.receipt,restartReceipt:intent.source.restartReceipt,reservedCents:intent.source.reservedCents,carriedCents:intent.source.carriedCents,annual:intent.source.annual};
  if(!ownedRestartIntentFromAcknowledgement({grant,ref:intent.ref,handle:intent.handle,paused:intent.paused,claim:intent.claim,sourceGrantId},intent.claimedAtSeconds,{cashLimitCents:config.cashLimitCents,carryForwardCents:config.carryForwardCents},[1,JSON.stringify(expected)]))return null;
  if(typeof subscriptionId!=="string"||!/^sub_[A-Za-z0-9]{6,64}$/.test(subscriptionId)||subscriptionId===grant.sourceSubscriptionId||![createdSeconds,periodStartSeconds,periodEndSeconds].every(n=>Number.isSafeInteger(n)&&n>0)||periodStartSeconds<createdSeconds||periodStartSeconds>seconds||periodEndSeconds<=seconds)return null;
  const submission={priceId:armed.priceId,bodyHash:armed.bodyHash,idempotencyKey:armed.idempotencyKey,armedAt:armed.armedAtSeconds};
  const observation={id:subscriptionId,created:createdSeconds,start:periodStartSeconds,finish:periodEndSeconds,renews,shared};
  const span=CONTRACT_FUNDING_RULES.longestMonthDays*86400;
  return {input,policy,context,binding:config.binding,startedAt:before.getTime(),
   keys:["nl:contract-reserve:v1","nl:pause:"+intent.ref,"nl:pause:due","nl:pause:last:"+intent.ref],args:[contractFundingBinding(config),config.reviewId,JSON.stringify(expected),JSON.stringify(submission),JSON.stringify(observation),seconds,config.grantCents[grant.key],config.cashLimitCents,config.carryForwardCents,config.fundedGrants[grant.key],span] as (string|number)[]};
 }catch{return null;}
}

/** Bounded own data only: a possibly committed activation is never permission
 * merely because a response has inherited fields or executable getters. */
function restartActivationAcknowledged(reply:unknown):[number,number]|null{
 try{
  if(!Array.isArray(reply))return null;
  const length=Object.getOwnPropertyDescriptor(reply,'length');
  if(!length||!Object.hasOwn(length,'value')||length.value!==1)return null;
  const entry=Object.getOwnPropertyDescriptor(reply,'0');
  if(!entry||!Object.hasOwn(entry,'value')||!Array.isArray(entry.value))return null;
  const ack=entry.value,innerLength=Object.getOwnPropertyDescriptor(ack,'length');
  if(!innerLength||!Object.hasOwn(innerLength,'value')||innerLength.value!==2)return null;
  const flag=Object.getOwnPropertyDescriptor(ack,'0'),end=Object.getOwnPropertyDescriptor(ack,'1');
  if(!flag||!Object.hasOwn(flag,'value')||(flag.value!==1&&flag.value!==2)||!end||!Object.hasOwn(end,'value')||!Number.isSafeInteger(end.value))return null;
  return [flag.value,end.value];
 }catch{return null;}
}
export async function activateRestartContract(
 input:RestartContractActivation,
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
):Promise<boolean>{
 const prepared=prepareRestartActivation(input,policy,context);
 if(!prepared)return false;
 try{
  const reply:unknown=await redisPipeline([["EVAL",ACTIVATE_RESTART_CONTRACT,4,...prepared.keys,...prepared.args]]);
  const ack=restartActivationAcknowledged(reply);
  const current=contractFundingConfiguration(prepared.policy,prepared.context,new Date()),checkedAt=Date.now();
  const {periodStartSeconds,periodEndSeconds,armed}=prepared.input;
  if(!current||current.binding!==prepared.binding||!commercialMarginReady(prepared.context.review)||checkedAt<prepared.startedAt||checkedAt<periodStartSeconds*1000||checkedAt>=periodEndSeconds*1000||!ack)return false;
  return ack[0]===2?ack[1]===periodEndSeconds:ack[0]===1&&ack[1]===armed.intent.grant.activationUntilSeconds&&checkedAt<=ack[1]*1000;
 }catch{return false;}
}
