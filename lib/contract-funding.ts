import {HANDLE_PATTERN} from '@/lib/store-handle-pattern';
import {customerTaxContractContextSupported} from './customer-tax-review';
import {createHash,randomUUID} from 'node:crypto';
import {isRedisConfigured,redisPipeline} from '@/lib/redis';
import {commercialMarginReady,CURRENT_COMMERCIAL_MARGIN_REVIEW,CURRENT_PRICE_AND_RIGHTS_SNAPSHOT} from '@/lib/commercial-margin';
import {CONTRACT_FUNDING_RULES,CONTRACT_ADMISSION_COVERAGE,CONTRACT_KEYS,CURRENT_CONTRACT_FUNDING_POLICY,canonicalFinancialSnapshot,contractFundingConfiguration,type ContractKey,type ContractFundingPolicy,type ContractFundingContext,type ContractFundingConfiguration} from '@/lib/contract-funding-rules';
import type {Tier,Cycle} from '@/lib/plan';
export const contractFundingBinding=(c:ContractFundingConfiguration)=>createHash('sha256').update(c.binding).digest('hex');
/** Require a single own data entry before interpreting a financial ACK. */
function singleOwnContractAcknowledgement(reply: unknown): {value: unknown} | null {
 try {
  if(!Array.isArray(reply))return null;
  const length=Object.getOwnPropertyDescriptor(reply,'length');
  if(!length||!Object.hasOwn(length,'value')||length.value!==1)return null;
  const entry=Object.getOwnPropertyDescriptor(reply,'0');
  return entry&&Object.hasOwn(entry,'value')?{value:entry.value}:null;
 }catch{return null;}
}
export const RESERVE_CONTRACT = `
local function amount(value)
 if not value or not string.match(value,'^%d+$') or (#value>1 and string.sub(value,1,1)=='0') then return nil end
 local n=tonumber(value)
 if not n or n<0 or n>1000000000000 or n~=math.floor(n) then return nil end
 return n
end
if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('TTL',KEYS[1])~=-1 then return 0 end
if ARGV[11]=='restart' then
 local policyReview=redis.call('HMGET',KEYS[1],'policy','review')
 if policyReview[1]~=ARGV[1] or policyReview[2]~=ARGV[2] then return 0 end
else
 if redis.call('HGET',KEYS[1],'policy')~=ARGV[1] or redis.call('HGET',KEYS[1],'review')~=ARGV[2] then return 0 end
end
if ARGV[11]~='checkout' and ARGV[11]~='switch' and ARGV[11]~='restart' then return 0 end
local receiptPrefix=ARGV[2]..'|'..ARGV[3]..'|'..ARGV[4]..'|'..ARGV[11]..'|'
if string.sub(ARGV[10] or '',1,#receiptPrefix)~=receiptPrefix then return 0 end
-- An activated contract cannot open a second new-enrollment obligation.
-- Switches retain their distinct funded lifecycle and never overwrite active.
if ARGV[11]=='checkout' and redis.call('HEXISTS',KEYS[1],'active:'..ARGV[3])==1 then return 0 end
local sourceGrant=nil
local sourceCharge=nil
if ARGV[11]=='checkout' then
 if ARGV[12]~='' then return 0 end
else
 -- Switch/restart obligations name the same immutable funded subscription.
 -- A restart reserve does not prove that the provider actually stopped it.
 local active=redis.call('HGET',KEYS[1],'active:'..ARGV[3])
 if not active or #active>256 then return 0 end
 local source={}
 for field in string.gmatch(active,'[^|]+') do table.insert(source,field) end
 if #source~=7 or table.concat(source,'|')~=active or source[2]~=ARGV[12] or #source[1]>84 or not string.match(source[1],'^ctr_[%w_-]+$') then return 0 end
 if source[3]~='creator_month' and source[3]~='creator_year' and source[3]~='pro_month' and source[3]~='pro_year' and source[3]~='scale_month' and source[3]~='scale_year' then return 0 end
 local created,start,finish,now=amount(source[4]),amount(source[6]),amount(source[7]),amount(ARGV[13])
 if (source[5]~='trial' and source[5]~='paid') or not created or not start or not finish or not now or start<created or start>now or finish<=start then return 0 end
 if ARGV[11]=='switch' and finish<=now then return 0 end
 if ARGV[11]=='restart' then
  if redis.call('HGET',KEYS[1],'restart-owner:'..source[1]) then return 0 end
  if source[5]~='paid' or created<=0 or start<=0 or now<=0 or finish>now or source[3]~=ARGV[4] or (ARGV[4]~='creator_month' and ARGV[4]~='pro_month' and ARGV[4]~='scale_month') then return 0 end
  local proposed={}
  local proposedRaw=ARGV[10]
  if not proposedRaw or #proposedRaw+#source[1]+1>1024 then return 0 end
  for field in string.gmatch(proposedRaw,'[^|]+') do table.insert(proposed,field) end
  if #proposed~=9 or table.concat(proposed,'|')~=proposedRaw or proposed[1]~=ARGV[2] or proposed[2]~=ARGV[3] or proposed[3]~=ARGV[4] or proposed[4]~='restart' or amount(proposed[5])~=amount(ARGV[5]) then return 0 end
  local submitted,expires,activation,submission=amount(proposed[6]),amount(proposed[7]),amount(proposed[8]),amount(ARGV[14])
  local through=tonumber(proposed[9])
  if not submitted or not expires or not activation or not submission or submission<=0 or submitted<submission or now<submitted-submission or now>submitted or expires<submitted or activation<expires or not through or not string.match(proposed[9],'^%d+$') or (#proposed[9]>1 and string.sub(proposed[9],1,1)=='0') or through>9007199254740991 or through~=math.floor(through) or activation*1000>through then return 0 end
 end
 if redis.call('HGET',KEYS[1],'activated:'..source[1])~=active then return 0 end
 local raw=redis.call('HGET',KEYS[1],'grant:'..source[1])
 if not raw or #raw>1024 then return 0 end
 local receipt={}
 for field in string.gmatch(raw,'[^|]+') do table.insert(receipt,field) end
 if table.concat(receipt,'|')~=raw or receipt[1]~=ARGV[2] or receipt[2]~=ARGV[3] or receipt[3]~=source[3] then return 0 end
 if not ((receipt[4]=='checkout' and #receipt==9) or ((receipt[4]=='switch' or receipt[4]=='restart') and #receipt==10 and string.match(receipt[10],'^ctr_[%w_-]+$'))) then return 0 end
 sourceCharge=amount(receipt[5])
 local submitted,expires,activation=amount(receipt[6]),amount(receipt[7]),amount(receipt[8])
 if not submitted or not expires or not activation or (receipt[4]=='checkout' and (submitted<300 or created<submitted-300 or created>activation)) then return 0 end
 local through=tonumber(receipt[9])
 if not sourceCharge or sourceCharge<=0 or not through or not string.match(receipt[9],'^%d+$') or (#receipt[9]>1 and string.sub(receipt[9],1,1)=='0') or through>9007199254740991 or through~=math.floor(through) or finish*1000>through then return 0 end
 sourceGrant=source[1]
end
local reserved=amount(redis.call('HGET',KEYS[1],'reserved'))
local carried=amount(redis.call('HGET',KEYS[1],'carried'))
local charge,limit,carry,funded=amount(ARGV[5]),amount(ARGV[6]),amount(ARGV[7]),amount(ARGV[8])
local slot='slots:'..ARGV[4]
local slots=amount(redis.call('HGET',KEYS[1],slot))
if not reserved or not carried or not charge or charge<=0 or not limit or not carry or carried~=carry or reserved<carried or reserved>limit or not funded or funded<=0 or not slots or slots>funded or slots<=0 then return 0 end
if redis.call('HEXISTS',KEYS[1],'pending:'..ARGV[3])==1 or redis.call('HEXISTS',KEYS[1],'grant:'..ARGV[9])==1 then return 0 end
if charge>limit-reserved or (sourceCharge and sourceCharge>reserved-carried) then return 0 end
redis.call('HINCRBY',KEYS[1],slot,-1)
redis.call('HINCRBY',KEYS[1],'reserved',ARGV[5])
redis.call('HSET',KEYS[1],'pending:'..ARGV[3],ARGV[9])
redis.call('HSET',KEYS[1],'grant:'..ARGV[9],ARGV[10]..(sourceGrant and '|'..sourceGrant or ''))
return 1
`;
export type ContractGrant={sourceSubscriptionId:string|null;action:'checkout'|'switch'|'restart';id:string;reviewId:string;statsId:string;key:ContractKey;reservedCents:number;submitUntilSeconds:number;checkoutExpiresAtSeconds:number;activationUntilSeconds:number;liabilitiesThrough:string};
/** Single-use, full-cost grant. Failure or lost acknowledgement never frees
 * money, capacity or the store's pending lock. No initialization or expiry. */
export async function reserveContractFunding(statsId:string,tier:Tier,cycle:Cycle,action:'checkout'|'switch'|'restart',policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},nonce='ctr_'+randomUUID(),sourceSubscriptionId:string|null=null):Promise<ContractGrant|null>{
 if(typeof statsId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(statsId)||!['checkout','switch','restart'].includes(action)||typeof nonce!=='string'||!/^ctr_[A-Za-z0-9_-]{1,80}$/.test(nonce)||typeof tier!=='string'||typeof cycle!=='string'||!isRedisConfigured())return null;
 if(action==='restart'&&(!Boolean(CONTRACT_ADMISSION_COVERAGE.pauseRestart)||cycle!=='month'))return null;
 if((action==='switch'||action==='restart')?(typeof sourceSubscriptionId!=='string'||!/^sub_[A-Za-z0-9]{6,64}$/.test(sourceSubscriptionId)):sourceSubscriptionId!==null)return null;
 const key=(tier+'_'+cycle) as ContractKey;
 if(!customerTaxContractContextSupported(context,policy))return null;
 const encodedContext=canonicalFinancialSnapshot(context);
 if(!encodedContext)return null;
 context=JSON.parse(encodedContext) as ContractFundingContext;
 if(!context||typeof context!=='object'||Array.isArray(context))return null;
 if(!CONTRACT_KEYS.includes(key)||!commercialMarginReady(context.review))return null;
 const reservedAt=new Date();
 const config=contractFundingConfiguration(policy,context,reservedAt);
 if(!config||config.fundedGrants[key]===0)return null;
 const seconds=Math.floor(reservedAt.getTime()/1000),submitUntilSeconds=seconds+CONTRACT_FUNDING_RULES.submissionSeconds,checkoutExpiresAtSeconds=seconds+CONTRACT_FUNDING_RULES.checkoutLifetimeSeconds,activationUntilSeconds=seconds+CONTRACT_FUNDING_RULES.activationDelayDays*86400;
 const charge=config.grantCents[key],receipt=[config.reviewId,statsId,key,action,charge,submitUntilSeconds,checkoutExpiresAtSeconds,activationUntilSeconds,config.liabilitiesThroughMs].join('|');
 try{
  const result=await redisPipeline([['EVAL',RESERVE_CONTRACT,1,'nl:contract-reserve:v1',contractFundingBinding(config),config.reviewId,statsId,key,charge,config.cashLimitCents,config.carryForwardCents,config.fundedGrants[key],nonce,receipt,action,sourceSubscriptionId??'',seconds,...(action==='restart'?[CONTRACT_FUNDING_RULES.submissionSeconds]:[])]]);
  const ack=singleOwnContractAcknowledgement(result);
  const current=contractFundingConfiguration(policy,context,new Date()),ready=commercialMarginReady(context.review);
  const checkedAt=Date.now();
  const acknowledged=current!==null&&current.binding===config.binding&&ready&&checkedAt>=reservedAt.getTime()&&checkedAt<=config.admissionsUntilMs&&new Date(checkedAt).toISOString().slice(0,7)===context.review?.fundedExposure?.month&&ack!==null&&ack.value===1&&checkedAt<=submitUntilSeconds*1000;
  return acknowledged?{sourceSubscriptionId,action,id:nonce,reviewId:config.reviewId,statsId,key,reservedCents:charge,submitUntilSeconds,checkoutExpiresAtSeconds,activationUntilSeconds,liabilitiesThrough:new Date(config.liabilitiesThroughMs).toISOString()}:null;
 }catch{return null;}
}

/** A switch reserves a separate obligation against the existing funded
 * subscription. Legacy/unmigrated contracts keep their current rights. */
export async function reserveSwitchContractFunding(
 statsId:string,subscriptionId:string,tier:Tier,cycle:Cycle,
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
 nonce='ctr_'+randomUUID(),
):Promise<ContractGrant|null>{
 return reserveContractFunding(statsId,tier,cycle,'switch',policy,context,nonce,subscriptionId);
}


/** Reservation primitive only. The uncovered real lifecycle refuses before
 * Redis even with a supplied review. This cannot authorize ensurePrice,
 * a charge, a retry, or activation.
 */
export async function reserveRestartContractFunding(
 statsId:string,subscriptionId:string,tier:Tier,
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
 nonce='ctr_'+randomUUID(),
):Promise<ContractGrant|null>{
 return reserveContractFunding(statsId,tier,'month','restart',policy,context,nonce,subscriptionId);
}


/** Checkout activation binds an existing cash receipt to one subscription.
 * It never releases reserved money or replenishes grant slots. */
export const ACTIVATE_CONTRACT = `
local function amount(value)
 if not value or not string.match(value,'^%d+$') or (#value>1 and string.sub(value,1,1)=='0') then return nil end
 local n=tonumber(value)
 if not n or n<0 or n>1000000000000 or n~=math.floor(n) then return nil end
 return n
end
if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('TTL',KEYS[1])~=-1 then return 0 end
if redis.call('HGET',KEYS[1],'policy')~=ARGV[1] or redis.call('HGET',KEYS[1],'review')~=ARGV[2] then return 0 end
local raw=redis.call('HGET',KEYS[1],'grant:'..ARGV[5])
if not raw then return 0 end
local receipt={}
for field in string.gmatch(raw,'[^|]+') do table.insert(receipt,field) end
if #receipt~=9 or table.concat(receipt,'|')~=raw then return 0 end
local charge,submitted,expires,activation,through=amount(receipt[5]),amount(receipt[6]),amount(receipt[7]),amount(receipt[8]),tonumber(receipt[9])
local created,now,minimum,limit,carry,submission=amount(ARGV[7]),amount(ARGV[8]),amount(ARGV[9]),amount(ARGV[10]),amount(ARGV[11]),amount(ARGV[12])
local reserved,carried=amount(redis.call('HGET',KEYS[1],'reserved')),amount(redis.call('HGET',KEYS[1],'carried'))
local slots,funded=amount(redis.call('HGET',KEYS[1],'slots:'..ARGV[4])),amount(ARGV[13])
if receipt[1]~=ARGV[2] or receipt[2]~=ARGV[3] or receipt[3]~=ARGV[4] or receipt[4]~='checkout' then return 0 end
if not charge or not minimum or charge~=minimum or not submitted or not expires or not activation or not through or through<0 or through>9007199254740991 or through~=math.floor(through) or not string.match(receipt[9],'^%d+$') or (#receipt[9]>1 and string.sub(receipt[9],1,1)=='0') or not created or not now or not submission or not limit or not carry or not reserved or not carried or not slots or not funded or funded<=0 or slots>=funded then return 0 end
if carried~=carry or reserved<carried or reserved>limit or charge>reserved-carried or submitted<submission or created<submitted-submission or created>activation or created>now or through<now*1000 then return 0 end
local start,finish=amount(ARGV[15]),amount(ARGV[16])
if (ARGV[14]~='trial' and ARGV[14]~='paid') or not start or not finish or start<created or start>now or finish<=now or finish<=start or finish*1000>through then return 0 end
local binding=ARGV[5]..'|'..ARGV[6]..'|'..ARGV[4]..'|'..ARGV[7]..'|'..ARGV[14]..'|'..ARGV[15]..'|'..ARGV[16]
local consumed=redis.call('HGET',KEYS[1],'activated:'..ARGV[5])
local active=redis.call('HGET',KEYS[1],'active:'..ARGV[3])
if consumed then
 if consumed~=binding or active~=binding then return 0 end
 return {2,finish}
end
if now>activation then return 0 end
if redis.call('HGET',KEYS[1],'pending:'..ARGV[3])~=ARGV[5] then return 0 end
-- An already active subscription is reconciled by the switch/renewal lifecycle.
if active then return 0 end
redis.call('HSET',KEYS[1],'activated:'..ARGV[5],binding,'active:'..ARGV[3],binding)
redis.call('HDEL',KEYS[1],'pending:'..ARGV[3])
return {1,activation}
`;
export type CheckoutContractActivation={
 statsId:string;grantId:string;reviewId:string;subscriptionId:string;tier:Tier;cycle:Cycle;
 createdSeconds:number;trialing:boolean;periodStartSeconds:number;periodEndSeconds:number;
};
/** Trusted provider observations only, never request/session query parameters.
 * This covers checkout activation, not resource grants or renewal admission. */
export async function activateCheckoutContract(
 input:CheckoutContractActivation,
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
):Promise<boolean>{
 if(!customerTaxContractContextSupported(context,policy))return false;
 const encoded=canonicalFinancialSnapshot({input,context});
 if(!encoded)return false;
 ({input,context}=JSON.parse(encoded) as {input:CheckoutContractActivation;context:ContractFundingContext});
 if(!input||!context||typeof input!=='object'||typeof context!=='object')return false;
 const {statsId,grantId,reviewId,subscriptionId,tier,cycle,createdSeconds,trialing,periodStartSeconds,periodEndSeconds}=input;
 const key=(tier+'_'+cycle) as ContractKey;
 if(typeof statsId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(statsId)||typeof grantId!=='string'||!/^ctr_[A-Za-z0-9_-]{1,80}$/.test(grantId)||typeof reviewId!=='string'||typeof subscriptionId!=='string'||!/^sub_[A-Za-z0-9]{6,64}$/.test(subscriptionId)||!CONTRACT_KEYS.includes(key)||typeof trialing!=='boolean'||!isRedisConfigured())return false;
 if(![createdSeconds,periodStartSeconds,periodEndSeconds].every(n=>Number.isSafeInteger(n)&&n>0)||periodStartSeconds<createdSeconds||periodEndSeconds<=periodStartSeconds)return false;
 const paidDays=CONTRACT_FUNDING_RULES.paidMonths[cycle]*CONTRACT_FUNDING_RULES.longestMonthDays;
 const longest=(trialing?CONTRACT_FUNDING_RULES.trialDays:paidDays)*86400;
 const lastEnd=createdSeconds+(CONTRACT_FUNDING_RULES.trialDays+(trialing?0:paidDays))*86400;
 if(!Number.isSafeInteger(lastEnd)||periodEndSeconds-periodStartSeconds>longest||periodEndSeconds>lastEnd||!commercialMarginReady(context.review))return false;
 const now=new Date(),config=contractFundingConfiguration(policy,context,now);
 if(!config||config.reviewId!==reviewId)return false;
 const seconds=Math.floor(now.getTime()/1000);
 if(createdSeconds>seconds||periodEndSeconds<=seconds)return false;
 try{
  const result=await redisPipeline([['EVAL',ACTIVATE_CONTRACT,1,'nl:contract-reserve:v1',contractFundingBinding(config),reviewId,statsId,key,grantId,subscriptionId,createdSeconds,seconds,config.grantCents[key],config.cashLimitCents,config.carryForwardCents,CONTRACT_FUNDING_RULES.submissionSeconds,config.fundedGrants[key],trialing?'trial':'paid',periodStartSeconds,periodEndSeconds]]);
  const current=contractFundingConfiguration(policy,context,new Date());
  return current!==null&&current.binding===config.binding&&commercialMarginReady(context.review)&&Date.now()>=now.getTime()&&contractObservationAcknowledged(result,createdSeconds,periodStartSeconds,periodEndSeconds);
 }catch{return false;}
}

/** A switch replaces only the active pointer; all cash and prior proofs stay. */
export const ACTIVATE_SWITCH_CONTRACT = `
local function amount(value)
 if not value or not string.match(value,'^%d+$') or (#value>1 and string.sub(value,1,1)=='0') then return nil end
 local n=tonumber(value)
 if not n or n<0 or n>1000000000000 or n~=math.floor(n) then return nil end
 return n
end
local function parts(raw,max)
 if not raw or #raw>max then return nil end
 local result={}
 for field in string.gmatch(raw,'[^|]+') do table.insert(result,field) end
 if table.concat(result,'|')~=raw then return nil end
 return result
end
if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('TTL',KEYS[1])~=-1 then return 0 end
if redis.call('HGET',KEYS[1],'policy')~=ARGV[1] or redis.call('HGET',KEYS[1],'review')~=ARGV[2] then return 0 end
local receipt=parts(redis.call('HGET',KEYS[1],'grant:'..ARGV[5]),1024)
if not receipt or #receipt~=10 or receipt[1]~=ARGV[2] or receipt[2]~=ARGV[3] or receipt[3]~=ARGV[4] or receipt[4]~='switch' or #receipt[10]>84 or not string.match(receipt[10],'^ctr_[%w_-]+$') or receipt[10]==ARGV[5] then return 0 end
local charge,submitted,expires,deadline=amount(receipt[5]),amount(receipt[6]),amount(receipt[7]),amount(receipt[8])
local through=tonumber(receipt[9])
local created,now,minimum,limit,carry,submission,funded,start,finish,span=amount(ARGV[7]),amount(ARGV[8]),amount(ARGV[9]),amount(ARGV[10]),amount(ARGV[11]),amount(ARGV[12]),amount(ARGV[13]),amount(ARGV[15]),amount(ARGV[16]),amount(ARGV[17])
if not charge or charge<=0 or not submitted or not expires or not deadline or not through or through>9007199254740991 or through~=math.floor(through) or not string.match(receipt[9],'^%d+$') or (#receipt[9]>1 and string.sub(receipt[9],1,1)=='0') then return 0 end
if not created or not now or not minimum or not limit or not carry or not submission or not funded or not start or not finish or not span or span<=0 then return 0 end
if charge~=minimum or submitted<submission or expires<submitted or deadline<expires or now<submitted-submission or created>now or start<created or start>now or finish<=now or finish<=start or finish-start>span or finish>submitted-submission+span or finish*1000>through or (ARGV[14]~='trial' and ARGV[14]~='paid') then return 0 end
local reserved,carried,slots=amount(redis.call('HGET',KEYS[1],'reserved')),amount(redis.call('HGET',KEYS[1],'carried')),amount(redis.call('HGET',KEYS[1],'slots:'..ARGV[4]))
if not reserved or not carried or not slots or carried~=carry or reserved<carried or reserved>limit or funded<=0 or slots>=funded then return 0 end
local switchSource=redis.call('HGET',KEYS[1],'activated:'..receipt[10])
local source=parts(switchSource,256)
if not source or #source~=7 or source[1]~=receipt[10] or source[2]~=ARGV[6] or source[4]~=ARGV[7] then return 0 end
local sourceStart,sourceFinish=amount(source[6]),amount(source[7])
if not sourceStart or not sourceFinish or sourceStart<created or sourceStart>submitted-submission or sourceFinish<=submitted-submission or (source[5]~='trial' and source[5]~='paid') then return 0 end
if ARGV[14]=='trial' and (source[5]~='trial' or finish>sourceFinish) then return 0 end
local original=parts(redis.call('HGET',KEYS[1],'grant:'..receipt[10]),1024)
if not original or original[1]~=ARGV[2] or original[2]~=ARGV[3] or original[3]~=source[3] or not ((#original==9 and original[4]=='checkout') or (#original==10 and original[4]=='switch')) then return 0 end
local originalCharge=amount(original[5])
local originalThrough=tonumber(original[9])
if not amount(original[6]) or not amount(original[7]) or not amount(original[8]) or not originalThrough or not string.match(original[9],'^%d+$') or (#original[9]>1 and string.sub(original[9],1,1)=='0') or originalThrough>9007199254740991 or originalThrough~=math.floor(originalThrough) or sourceFinish*1000>originalThrough then return 0 end
if not originalCharge or originalCharge<=0 or charge+originalCharge>reserved-carried then return 0 end
local binding=ARGV[5]..'|'..ARGV[6]..'|'..ARGV[4]..'|'..ARGV[7]..'|'..ARGV[14]..'|'..ARGV[15]..'|'..ARGV[16]
if #binding>256 then return 0 end
local consumed=redis.call('HGET',KEYS[1],'activated:'..ARGV[5])
local active=redis.call('HGET',KEYS[1],'active:'..ARGV[3])
if consumed then
 if consumed~=binding or active~=binding then return 0 end
 return {2,finish}
end
if now>deadline then return 0 end
if active~=switchSource or redis.call('HGET',KEYS[1],'pending:'..ARGV[3])~=ARGV[5] then return 0 end
redis.call('HSET',KEYS[1],'activated:'..ARGV[5],binding,'active:'..ARGV[3],binding)
redis.call('HDEL',KEYS[1],'pending:'..ARGV[3])
return {1,deadline}
`;
export async function activateSwitchContract(
 input:CheckoutContractActivation,
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
):Promise<boolean>{
 if(!customerTaxContractContextSupported(context,policy))return false;
 const encoded=canonicalFinancialSnapshot({input,context});if(!encoded)return false;
 ({input,context}=JSON.parse(encoded) as {input:CheckoutContractActivation;context:ContractFundingContext});
 if(!input||!context||typeof input!=='object'||typeof context!=='object')return false;
 const {statsId,grantId,reviewId,subscriptionId,tier,cycle,createdSeconds,trialing,periodStartSeconds,periodEndSeconds}=input;
 const key=(tier+'_'+cycle) as ContractKey;
 if(typeof statsId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(statsId)||typeof grantId!=='string'||!/^ctr_[A-Za-z0-9_-]{1,80}$/.test(grantId)||typeof reviewId!=='string'||typeof subscriptionId!=='string'||!/^sub_[A-Za-z0-9]{6,64}$/.test(subscriptionId)||!CONTRACT_KEYS.includes(key)||typeof trialing!=='boolean'||!isRedisConfigured())return false;
 if(![createdSeconds,periodStartSeconds,periodEndSeconds].every(n=>Number.isSafeInteger(n)&&n>0)||periodStartSeconds<createdSeconds||periodEndSeconds<=periodStartSeconds)return false;
 const span=(trialing?CONTRACT_FUNDING_RULES.trialDays:CONTRACT_FUNDING_RULES.paidMonths[cycle]*CONTRACT_FUNDING_RULES.longestMonthDays)*86400;
 if(periodEndSeconds-periodStartSeconds>span||!commercialMarginReady(context.review))return false;
 const now=new Date(),config=contractFundingConfiguration(policy,context,now);if(!config||config.reviewId!==reviewId)return false;
 const seconds=Math.floor(now.getTime()/1000);if(createdSeconds>seconds||periodStartSeconds>seconds||periodEndSeconds<=seconds)return false;
 try{
  const result=await redisPipeline([['EVAL',ACTIVATE_SWITCH_CONTRACT,1,'nl:contract-reserve:v1',contractFundingBinding(config),reviewId,statsId,key,grantId,subscriptionId,createdSeconds,seconds,config.grantCents[key],config.cashLimitCents,config.carryForwardCents,CONTRACT_FUNDING_RULES.submissionSeconds,config.fundedGrants[key],trialing?'trial':'paid',periodStartSeconds,periodEndSeconds,span]]);
  const current=contractFundingConfiguration(policy,context,new Date());
  return current!==null&&current.binding===config.binding&&commercialMarginReady(context.review)&&Date.now()>=now.getTime()&&contractObservationAcknowledged(result,seconds,periodStartSeconds,periodEndSeconds);
 }catch{return false;}
}

/** A committed proof may be observed for its exact current period. This never
 * turns an expired, unconsumed grant into an activation or a renewal. Admission
 * policy and commercial review must still be current; archives are separate. */
function contractObservationAcknowledged(result:unknown,earliestDeadline:number,start:number,finish:number):boolean{
 const checkedAt=Date.now();
 try{
  if(!Array.isArray(result))return false;
  const length=Object.getOwnPropertyDescriptor(result,'length');
  if(!length||!Object.hasOwn(length,'value')||length.value!==1)return false;
  if(Object.getOwnPropertySymbols(result).length!==0)return false;
  const entry=Object.getOwnPropertyDescriptor(result,'0');
  if(!entry||!Object.hasOwn(entry,'value')||!Array.isArray(entry.value))return false;
  const ack=entry.value,innerLength=Object.getOwnPropertyDescriptor(ack,'length');
  if(!innerLength||!Object.hasOwn(innerLength,'value')||innerLength.value!==2)return false;
  if(Object.getOwnPropertySymbols(ack).length!==0)return false;
  const flag=Object.getOwnPropertyDescriptor(ack,'0'),deadline=Object.getOwnPropertyDescriptor(ack,'1');
  if(!flag||!deadline||!Object.hasOwn(flag,'value')||!Object.hasOwn(deadline,'value')||!Number.isSafeInteger(deadline.value)||checkedAt<start*1000||checkedAt>=finish*1000)return false;
  if(flag.value===2)return deadline.value===finish;
  return flag.value===1&&deadline.value>=earliestDeadline&&deadline.value<=earliestDeadline+CONTRACT_FUNDING_RULES.activationDelayDays*86400&&checkedAt<=deadline.value*1000;
 }catch{return false;}
}

/** Integrated preparation only; real funded restart remains uncovered. A claim
 * preserves its source, full cash and exact pause forever under the same ledger.
 * A lost acknowledgement or a duplicate never yields permission again.
 */
export const CLAIM_RESTART_INTENT = `
local function amount(value)
 if not value or not string.match(value,'^%d+$') or (#value>1 and string.sub(value,1,1)=='0') then return nil end
 local n=tonumber(value)
 if not n or n<0 or n>1000000000000 or n~=math.floor(n) then return nil end
 return n
end
local function parts(raw,maximum)
 if not raw or #raw>maximum then return nil end
 local out={}
 for field in string.gmatch(raw,'[^|]+') do out[#out+1]=field end
 if table.concat(out,'|')~=raw then return nil end
 return out
end
if #KEYS~=4 or #ARGV~=16 then return 0 end
if KEYS[2]~='nl:pause:'..ARGV[12] or KEYS[3]~='nl:pause:due' or KEYS[4]~='nl:pause:last:'..ARGV[12] then return 0 end
if #ARGV[12]>320 or #ARGV[13]>1536 or #ARGV[16]>4096 or #ARGV[14]>86 or not string.match(ARGV[14],'^claim_[%w_-]+$') then return 0 end
if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('TTL',KEYS[1])~=-1 then return 0 end
local policyReview=redis.call('HMGET',KEYS[1],'policy','review')
if policyReview[1]~=ARGV[1] or policyReview[2]~=ARGV[2] then return 0 end
if ARGV[4]~='creator_month' and ARGV[4]~='pro_month' and ARGV[4]~='scale_month' then return 0 end
local restartRaw=redis.call('HGET',KEYS[1],'grant:'..ARGV[5])
local receipt=parts(restartRaw,1024)
if not receipt or #receipt~=10 or receipt[1]~=ARGV[2] or receipt[2]~=ARGV[3] or receipt[3]~=ARGV[4] or receipt[4]~='restart' or receipt[10]==ARGV[5] then return 0 end
local charge,submitted,expires,activation=amount(receipt[5]),amount(receipt[6]),amount(receipt[7]),amount(receipt[8])
local now,minimum,limit,carry,submission=amount(ARGV[7]),amount(ARGV[8]),amount(ARGV[9]),amount(ARGV[10]),amount(ARGV[11])
local through=tonumber(receipt[9])
if not charge or charge<=0 or charge~=minimum or not submitted or not expires or not activation or not now or not limit or not carry or not submission or submission<=0 or submitted<submission or now<submitted-submission or now>submitted or expires<submitted or activation<expires then return 0 end
if not through or not string.match(receipt[9],'^%d+$') or (#receipt[9]>1 and string.sub(receipt[9],1,1)=='0') or through>9007199254740991 or through~=math.floor(through) or activation*1000>through then return 0 end
if redis.call('HGET',KEYS[1],'pending:'..ARGV[3])~=ARGV[5] then return 0 end
local active=redis.call('HGET',KEYS[1],'active:'..ARGV[3])
local source=parts(active,256)
if not source or #source~=7 or source[1]~=receipt[10] or source[2]~=ARGV[6] or source[3]~=ARGV[4] or source[5]~='paid' then return 0 end
local created,start,finish=amount(source[4]),amount(source[6]),amount(source[7])
if not created or created<=0 or not start or start<created or not finish or finish<=start or finish>now then return 0 end
if redis.call('HGET',KEYS[1],'activated:'..source[1])~=active then return 0 end
local sourceRaw=redis.call('HGET',KEYS[1],'grant:'..source[1])
local original=parts(sourceRaw,1024)
if not original or original[1]~=ARGV[2] or original[2]~=ARGV[3] or original[3]~=ARGV[4] or not ((#original==9 and original[4]=='checkout') or (#original==10 and (original[4]=='switch' or original[4]=='restart'))) then return 0 end
local oldCharge,oldSubmitted,oldExpires,oldActivation=amount(original[5]),amount(original[6]),amount(original[7]),amount(original[8])
local oldThrough=tonumber(original[9])
if not oldCharge or oldCharge<=0 or not oldSubmitted or not oldExpires or not oldActivation or not oldThrough or not string.match(original[9],'^%d+$') or (#original[9]>1 and string.sub(original[9],1,1)=='0') or oldThrough>9007199254740991 or oldThrough~=math.floor(oldThrough) or finish*1000>oldThrough then return 0 end
local reserved,carried=amount(redis.call('HGET',KEYS[1],'reserved')),amount(redis.call('HGET',KEYS[1],'carried'))
if not reserved or not carried or carried~=carry or reserved<carried or reserved>limit or oldCharge+charge>reserved-carried then return 0 end
-- Exact pause observation, including its funded marker, is part of ownership.
if redis.call('GET',KEYS[2])~=ARGV[13] then return 0 end
local ok,pause=pcall(cjson.decode,ARGV[13])
if not ok or type(pause)~='table' or type(pause.funding)~='table' or pause.funding.version~=1 or pause.funding.grantId~=source[1] or pause.subscription~=ARGV[6] or type(pause.customer)~='string' or not string.match(pause.customer,'^cus_[%w]+$') or type(pause.paymentMethod)~='string' or type(pause.tier)~='string' or pause.tier..'_month'~=ARGV[4] or type(pause.from)~='number' or pause.from~=finish or type(pause["until"])~='number' or pause["until"]<=pause.from or pause["until"]>now or pause["until"]~=math.floor(pause["until"]) then return 0 end
if tonumber(redis.call('ZSCORE',KEYS[3],ARGV[12]))~=pause["until"] then return 0 end
local annual=amount(redis.call('GET',KEYS[4]))
if not annual or annual<=0 or annual>pause.from then return 0 end
local valid,intent=pcall(cjson.decode,ARGV[16])
if not valid or type(intent)~='table' or intent.version~=1 or intent.grant~=ARGV[5] or intent.review~=ARGV[2] or intent.statsId~=ARGV[3] or intent.sourceSubscription~=ARGV[6] or intent.sourceGrant~=source[1] or intent.ref~=ARGV[12] or intent.handle~=ARGV[15] or intent.paused~=ARGV[13] or intent.claim~=ARGV[14] or intent.created~=now or intent.deadline~=submitted then return 0 end
-- The request cannot supply or overwrite the atomically observed source/cash.
local fields=0
for _ in pairs(intent) do fields=fields+1 end
if fields~=12 then return 0 end
-- Permanent single ownership: no TTL, release, overwrite, or repeated permission.
if #source[1]>84 or not string.match(source[1],'^ctr_[%w_-]+$') or #ARGV[5]>84 or not string.match(ARGV[5],'^ctr_[%w_-]+$') then return 0 end
if redis.call('HGET',KEYS[1],'restart-owner:'..source[1]) then return 0 end
if redis.call('HEXISTS',KEYS[1],'restart-intent:'..ARGV[5])==1 then return 0 end
intent.sourceBinding=active
intent.sourceReceipt=sourceRaw
intent.restartReceipt=restartRaw
intent.reservedCents=reserved
intent.carriedCents=carried
intent.annual=annual
local owned=cjson.encode(intent)
if #owned>4096 then return 0 end
redis.call('HSET',KEYS[1],'restart-intent:'..ARGV[5],owned,'restart-owner:'..source[1],ARGV[5])
return {1,owned}
`;
export type RestartIntentInput={
 grant:ContractGrant;ref:string;handle:string;paused:string;claim:string;sourceGrantId:string;
};

export type OwnedRestartIntent=Readonly<{
 claim:string;grant:Readonly<ContractGrant>;ref:string;handle:string;paused:string;claimedAtSeconds:number;
 source:Readonly<{binding:string;receipt:string;restartReceipt:string;reservedCents:number;carriedCents:number;annual:number}>;
}>;
/** Pure wire validation, not submission permission. Only claimRestartIntent's
 * first owned ACK and current financial checks can produce a live preparation.
 * Immutable strings retain the source observed in that same atomic operation;
 * reading a new mutable active pointer later would not prove this ownership.
 */
export function ownedRestartIntentFromAcknowledgement(
 input:RestartIntentInput,now:number,
 budget:{cashLimitCents:number;carryForwardCents:number},ack:unknown,
):OwnedRestartIntent|null{
 try{
  const encoded=canonicalFinancialSnapshot({input,budget,ack,now});if(!encoded)return null;
  ({input,budget,ack,now}=JSON.parse(encoded) as {input:RestartIntentInput;budget:{cashLimitCents:number;carryForwardCents:number};ack:unknown;now:number});
  const candidate=input?.grant;
  if(!candidate||typeof input.handle!=='string'||!HANDLE_PATTERN.test(input.handle)||candidate.action!=='restart'||!['creator_month','pro_month','scale_month'].includes(candidate.key)||!/^ctr_[A-Za-z0-9_-]{1,80}$/.test(candidate.id)||!/^sub_[A-Za-z0-9]{6,64}$/.test(candidate.sourceSubscriptionId??'')||!Number.isSafeInteger(now)||now<=0||now>candidate.submitUntilSeconds||now<candidate.submitUntilSeconds-CONTRACT_FUNDING_RULES.submissionSeconds||![budget.cashLimitCents,budget.carryForwardCents].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=CONTRACT_FUNDING_RULES.maxInteger)||budget.cashLimitCents<budget.carryForwardCents)return null;
  if(!Array.isArray(ack)||ack.length!==2||ack[0]!==1||typeof ack[1]!=='string'||Buffer.byteLength(ack[1])>CONTRACT_FUNDING_RULES.restartIntent.maxIntentBytes)return null;
  const owned=JSON.parse(ack[1]) as Record<string,unknown>;
  if(!owned||typeof owned!=='object'||Array.isArray(owned))return null;
  const {grant,ref,handle,paused,claim,sourceGrantId}=input;
  const expected={version:1,grant:grant.id,review:grant.reviewId,statsId:grant.statsId,sourceSubscription:grant.sourceSubscriptionId,sourceGrant:sourceGrantId,ref,handle,paused,claim,created:now,deadline:grant.submitUntilSeconds};
  const fields=[...Object.keys(expected),'sourceBinding','sourceReceipt','restartReceipt','reservedCents','carriedCents','annual'].sort();
  if(JSON.stringify(Object.keys(owned).sort())!==JSON.stringify(fields)||Object.entries(expected).some(([key,value])=>owned[key]!==value))return null;
  if(typeof owned.sourceBinding!=='string'||typeof owned.sourceReceipt!=='string'||typeof owned.restartReceipt!=='string'||owned.sourceBinding.length>256||owned.sourceReceipt.length>1024||owned.restartReceipt.length>1024)return null;
  const binding=owned.sourceBinding.split('|'),receipt=owned.sourceReceipt.split('|'),restart=owned.restartReceipt.split('|');
  const amount=(raw:string,max:number=CONTRACT_FUNDING_RULES.maxInteger):number|null=>{
   if(!/^(0|[1-9][0-9]*)$/.test(raw))return null;
   const n=Number(raw);return Number.isSafeInteger(n)&&n>=0&&n<=max?n:null;
  };
  const created=amount(binding[3]??''),start=amount(binding[5]??''),finish=amount(binding[6]??'');
  const pause=JSON.parse(paused) as {subscription?:unknown;from?:unknown;until?:unknown;funding?:{version?:unknown;grantId?:unknown}};
  if(binding.length!==7||binding[0]!==sourceGrantId||binding[1]!==grant.sourceSubscriptionId||binding[2]!==grant.key||binding[4]!=='paid'||created===null||created<=0||start===null||start<created||finish===null||finish<=start||finish>now||pause.subscription!==grant.sourceSubscriptionId||pause.from!==finish||typeof pause.until!=='number'||!Number.isSafeInteger(pause.until)||pause.until<=finish||pause.until>now||pause.funding?.version!==1||pause.funding.grantId!==sourceGrantId)return null;
  const sourceCharge=amount(receipt[4]??''),through=amount(receipt[8]??'',Number.MAX_SAFE_INTEGER);
  if(receipt[0]!==grant.reviewId||receipt[1]!==grant.statsId||receipt[2]!==grant.key||!((receipt.length===9&&receipt[3]==='checkout')||(receipt.length===10&&['switch','restart'].includes(receipt[3])&&/^ctr_[A-Za-z0-9_-]{1,80}$/.test(receipt[9])))||sourceCharge===null||sourceCharge<=0||[5,6,7].some(i=>amount(receipt[i]??'')===null)||through===null||finish*1000>through)return null;
  const expectedRestart=[grant.reviewId,grant.statsId,grant.key,'restart',grant.reservedCents,grant.submitUntilSeconds,grant.checkoutExpiresAtSeconds,grant.activationUntilSeconds,Date.parse(grant.liabilitiesThrough),sourceGrantId].join('|');
  if(restart.length!==10||owned.restartReceipt!==expectedRestart)return null;
  const annual=owned.annual;
  if(typeof annual!=='number'||!Number.isSafeInteger(annual)||annual<=0||annual>finish||annual>now)return null;
  const reserved=owned.reservedCents,carried=owned.carriedCents;
  if(typeof reserved!=='number'||typeof carried!=='number'||!Number.isSafeInteger(reserved)||!Number.isSafeInteger(carried)||carried!==budget.carryForwardCents||carried<0||reserved<carried||reserved>budget.cashLimitCents||sourceCharge+grant.reservedCents>reserved-carried)return null;
  return Object.freeze({claim,grant:Object.freeze({...grant}),ref,handle,paused,claimedAtSeconds:now,source:Object.freeze({binding:owned.sourceBinding,receipt:owned.sourceReceipt,restartReceipt:owned.restartReceipt,reservedCents:reserved,carriedCents:carried,annual})});
 }catch{return null;}
}
export async function claimRestartIntent(
 input:RestartIntentInput,
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
):Promise<OwnedRestartIntent|null>{
 // New IO is forbidden until the entire lifecycle/cost review is covered.
 if(!Boolean(CONTRACT_ADMISSION_COVERAGE.pauseRestart))return null;
 if(!customerTaxContractContextSupported(context,policy))return null;
 const encoded=canonicalFinancialSnapshot({input,context});if(!encoded)return null;
 ({input,context}=JSON.parse(encoded) as {input:RestartIntentInput;context:ContractFundingContext});
 if(!input||!context||typeof input!=='object'||typeof context!=='object')return null;
 const {grant,ref,handle,paused,claim,sourceGrantId}=input;
 if(!grant||typeof grant.statsId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(grant.statsId)||grant.action!=='restart'||!/^sub_[A-Za-z0-9]{6,64}$/.test(grant.sourceSubscriptionId??'')||!/^ctr_[A-Za-z0-9_-]{1,80}$/.test(grant.id)||!/^ctr_[A-Za-z0-9_-]{1,80}$/.test(sourceGrantId)||typeof ref!=='string'||ref.length===0||ref.length>320||typeof paused!=='string'||Buffer.byteLength(paused)>CONTRACT_FUNDING_RULES.restartIntent.maxPauseBytes||typeof handle!=='string'||!HANDLE_PATTERN.test(handle)||typeof claim!=='string'||!/^claim_[A-Za-z0-9_-]{1,80}$/.test(claim)||!isRedisConfigured())return null;
 if(!['creator_month','pro_month','scale_month'].includes(grant.key)||!commercialMarginReady(context.review))return null;
 const before=new Date(),config=contractFundingConfiguration(policy,context,before);
 if(!config||config.reviewId!==grant.reviewId||config.grantCents[grant.key]!==grant.reservedCents)return null;
 const now=Math.floor(before.getTime()/1000);
 const intent=JSON.stringify({version:1,grant:grant.id,review:grant.reviewId,statsId:grant.statsId,sourceSubscription:grant.sourceSubscriptionId,sourceGrant:sourceGrantId,ref,handle,paused,claim,created:now,deadline:grant.submitUntilSeconds});
 if(Buffer.byteLength(intent)>CONTRACT_FUNDING_RULES.restartIntent.maxIntentBytes)return null;
 try{
  const result=await redisPipeline([['EVAL',CLAIM_RESTART_INTENT,4,'nl:contract-reserve:v1','nl:pause:'+ref,'nl:pause:due','nl:pause:last:'+ref,contractFundingBinding(config),config.reviewId,grant.statsId,grant.key,grant.id,grant.sourceSubscriptionId!,now,grant.reservedCents,config.cashLimitCents,config.carryForwardCents,CONTRACT_FUNDING_RULES.submissionSeconds,ref,paused,claim,handle,intent]]);
  const ack=singleOwnContractAcknowledgement(result);
  const current=contractFundingConfiguration(policy,context,new Date()),checked=Date.now();
  if(current===null||current.binding!==config.binding||!commercialMarginReady(context.review)||checked<before.getTime()||checked>grant.submitUntilSeconds*1000||ack===null)return null;
  const owned=ownedRestartIntentFromAcknowledgement(input,now,{cashLimitCents:config.cashLimitCents,carryForwardCents:config.carryForwardCents},ack.value);
  const finished=Date.now();
  return owned&&finished>=checked&&finished<=grant.submitUntilSeconds*1000&&new Date(finished).toISOString().slice(0,7)===context.review?.fundedExposure?.month?owned:null;
 }catch{return null;}
}

export const ARM_RESTART_SUBMISSION = `
local function amount(v)
 if not v or not string.match(v,'^%d+$') or (#v>1 and string.sub(v,1,1)=='0') then return nil end
 local n=tonumber(v)
 if not n or n<0 or n>1000000000000 or n~=math.floor(n) then return nil end
 return n
end
local now,claimed,deadline=amount(ARGV[6]),amount(ARGV[7]),amount(ARGV[8])
if not now or not claimed or not deadline or now<claimed or now>deadline or deadline-claimed>300 then return 0 end
if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('TTL',KEYS[1])~=-1 then return 0 end
local policyReview=redis.call('HMGET',KEYS[1],'policy','review')
if policyReview[1]~=ARGV[1] or policyReview[2]~=ARGV[2] then return 0 end
local raw=redis.call('HGET',KEYS[1],'restart-intent:'..ARGV[4])
if not raw or #raw>4096 then return 0 end
local ok,intent=pcall(cjson.decode,raw)
if not ok or type(intent)~='table' or intent.submission~=nil then return 0 end
local fields=0
for _ in pairs(intent) do fields=fields+1 end
if fields~=18 then return 0 end
if intent.version~=1 or intent.review~=ARGV[2] or intent.statsId~=ARGV[3] or intent.grant~=ARGV[4] or intent.claim~=ARGV[5] or intent.created~=claimed or intent.deadline~=deadline or intent.ref~=ARGV[9] or intent.paused~=ARGV[10] or intent.sourceBinding~=ARGV[11] then return 0 end
if redis.call('HGET',KEYS[1],'active:'..ARGV[3])~=intent.sourceBinding or redis.call('HGET',KEYS[1],'pending:'..ARGV[3])~=ARGV[4] then return 0 end
if redis.call('HGET',KEYS[1],'grant:'..intent.sourceGrant)~=intent.sourceReceipt or redis.call('HGET',KEYS[1],'grant:'..ARGV[4])~=intent.restartReceipt then return 0 end
if redis.call('HGET',KEYS[1],'restart-owner:'..intent.sourceGrant)~=ARGV[4] then return 0 end
local reserved,carried=amount(redis.call('HGET',KEYS[1],'reserved')),amount(redis.call('HGET',KEYS[1],'carried'))
if not reserved or not carried or reserved~=intent.reservedCents or carried~=intent.carriedCents then return 0 end
local annual=amount(redis.call('GET',KEYS[4]))
if redis.call('GET',KEYS[2])~=ARGV[10] or not annual or annual<=0 or annual>now or annual~=intent.annual then return 0 end
local parsed,pause=pcall(cjson.decode,ARGV[10])
if not parsed or type(pause)~='table' or type(pause["until"])~='number' or pause["until"]>now then return 0 end
if tonumber(redis.call('ZSCORE',KEYS[3],ARGV[9]))~=pause["until"] then return 0 end
if not string.match(ARGV[12],'^price_[A-Za-z0-9]+$') or #ARGV[12]>106 or #ARGV[13]~=64 or not string.match(ARGV[13],'^[a-f0-9]+$') then return 0 end
intent.submission={version=1,phase='uncertain',priceId=ARGV[12],bodyHash=ARGV[13],armedAt=now,idempotencyKey='restart:'..ARGV[4]..':'..ARGV[5]}
local encoded=cjson.encode(intent)
if #encoded+256>4096 then return 0 end
redis.call('HSET',KEYS[1],'restart-intent:'..ARGV[4],encoded)
return {1,encoded}
`;
export type ArmedRestartSubmission=Readonly<{intent:OwnedRestartIntent;priceId:string;bodyHash:string;armedAtSeconds:number;idempotencyKey:string;policyBinding:string}>;
/** First durable submission barrier ACK only; no provider IO or activation.
 * Lost ACK keeps phase=uncertain forever, never a fresh submission permission.
 */
/** A submission ACK grants provider permission only from bounded own data.
 * Unknown replies keep the possibly committed one-way uncertain barrier held. */
function restartSubmissionAcknowledged(reply:unknown):string|null{
 try{
  if(!Array.isArray(reply))return null;
  const length=Object.getOwnPropertyDescriptor(reply,'length');
  if(!length||!Object.hasOwn(length,'value')||length.value!==1)return null;
  const entry=Object.getOwnPropertyDescriptor(reply,'0');
  if(!entry||!Object.hasOwn(entry,'value')||!Array.isArray(entry.value))return null;
  const ack=entry.value,innerLength=Object.getOwnPropertyDescriptor(ack,'length');
  if(!innerLength||!Object.hasOwn(innerLength,'value')||innerLength.value!==2)return null;
  const flag=Object.getOwnPropertyDescriptor(ack,'0'),body=Object.getOwnPropertyDescriptor(ack,'1');
  if(!flag||!Object.hasOwn(flag,'value')||flag.value!==1||!body||!Object.hasOwn(body,'value')||typeof body.value!=='string'||body.value.length>CONTRACT_FUNDING_RULES.restartIntent.maxIntentBytes)return null;
  return Buffer.byteLength(body.value)<=CONTRACT_FUNDING_RULES.restartIntent.maxIntentBytes?body.value:null;
 }catch{return null;}
}
export async function armRestartSubmission(
 input:{intent:OwnedRestartIntent;priceId:string;bodyHash:string},
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
):Promise<ArmedRestartSubmission|null>{
 if(!Boolean(CONTRACT_ADMISSION_COVERAGE.pauseRestart))return null;
 if(!customerTaxContractContextSupported(context,policy))return null;
 const encoded=canonicalFinancialSnapshot({input,context});if(!encoded)return null;
 ({input,context}=JSON.parse(encoded));
 const {intent,priceId,bodyHash}=input;
 if(!intent||!/^price_[A-Za-z0-9]{6,100}$/.test(priceId)||!/^[a-f0-9]{64}$/.test(bodyHash)||!isRedisConfigured())return null;
 const before=new Date(),config=contractFundingConfiguration(policy,context,before);
 if(!config||!commercialMarginReady(context.review)||config.reviewId!==intent.grant.reviewId||config.grantCents[intent.grant.key]!==intent.grant.reservedCents)return null;
 const now=Math.floor(before.getTime()/1000),grant=intent.grant;
 if(now<intent.claimedAtSeconds||now>grant.submitUntilSeconds)return null;
 try{
  const result:unknown=await redisPipeline([['EVAL',ARM_RESTART_SUBMISSION,4,'nl:contract-reserve:v1','nl:pause:'+intent.ref,'nl:pause:due','nl:pause:last:'+intent.ref,contractFundingBinding(config),config.reviewId,grant.statsId,grant.id,intent.claim,now,intent.claimedAtSeconds,grant.submitUntilSeconds,intent.ref,intent.paused,intent.source.binding,priceId,bodyHash]]);
  const after=Date.now(),current=contractFundingConfiguration(policy,context,new Date(after));
  if(current===null||current.binding!==config.binding||!commercialMarginReady(context.review)||after<before.getTime()||after>grant.submitUntilSeconds*1000||new Date(after).toISOString().slice(0,7)!==context.review?.fundedExposure?.month )return null;
  const acknowledged=restartSubmissionAcknowledged(result);if(acknowledged===null)return null;
  const stored=JSON.parse(acknowledged),{submission,...original}=stored;
  const owned=ownedRestartIntentFromAcknowledgement({grant,ref:intent.ref,handle:intent.handle,paused:intent.paused,claim:intent.claim,sourceGrantId:intent.source.binding.split('|')[0]},intent.claimedAtSeconds,{cashLimitCents:config.cashLimitCents,carryForwardCents:config.carryForwardCents},[1,JSON.stringify(original)]);
  const expected={version:1,phase:'uncertain',priceId,bodyHash,armedAt:now,idempotencyKey:'restart:'+grant.id+':'+intent.claim};
  if(!owned||canonicalFinancialSnapshot(owned)!==canonicalFinancialSnapshot(intent)||canonicalFinancialSnapshot(submission)!==canonicalFinancialSnapshot(expected))return null;
  const finished=Date.now();if(finished<after||finished>grant.submitUntilSeconds*1000||new Date(finished).toISOString().slice(0,7)!==context.review?.fundedExposure?.month)return null;
  return Object.freeze({intent:owned,priceId,bodyHash,armedAtSeconds:now,idempotencyKey:expected.idempotencyKey,policyBinding:contractFundingBinding(config)});
 }catch{return null;}
}

export const RECORD_RESTART_RESULT = `
local function amount(v)
 if not v or not string.match(v,'^%d+$') or (#v>1 and string.sub(v,1,1)=='0') then return nil end
 local n=tonumber(v)
 if not n or n<0 or n>1000000000000 or n~=math.floor(n) then return nil end
 return n
end
local now,armed=amount(ARGV[8]),amount(ARGV[9])
if not now or not armed or now<armed or not string.match(ARGV[7],'^sub_[A-Za-z0-9]+$') or #ARGV[7]<10 or #ARGV[7]>68 then return 0 end
if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('TTL',KEYS[1])~=-1 then return 0 end
local raw=redis.call('HGET',KEYS[1],'restart-intent:'..ARGV[1])
if not raw or #raw>4096 then return 0 end
local ok,intent=pcall(cjson.decode,raw)
if not ok or type(intent)~='table' or type(intent.submission)~='table' then return 0 end
local s=intent.submission
if intent.grant~=ARGV[1] or intent.review~=ARGV[2] or intent.statsId~=ARGV[3] or intent.claim~=ARGV[4] or s.version~=1 or s.priceId~=ARGV[5] or s.bodyHash~=ARGV[6] or s.armedAt~=armed or s.idempotencyKey~='restart:'..ARGV[1]..':'..ARGV[4] then return 0 end
-- Retain evidence even after the submission deadline or policy month changed.
-- This never activates rights, moves cash, clears a pending lock or permits POST.
if s.phase=='observed' then
 if s.subscriptionId==ARGV[7] and type(s.observedAt)=='number' and s.observedAt==math.floor(s.observedAt) and s.observedAt>=armed and s.observedAt<=now then return 2 end
 return 0
end
if s.phase~='uncertain' or s.subscriptionId~=nil or s.observedAt~=nil then return 0 end
s.phase='observed'
s.subscriptionId=ARGV[7]
s.observedAt=now
local encoded=cjson.encode(intent)
if #encoded>4096 then return 0 end
redis.call('HSET',KEYS[1],'restart-intent:'..ARGV[1],encoded)
return 1
`;
/** Evidence retention only. No current-month admission or activation decision.
 * The first owner already spent its one POST attempt; recording an observed ID
 * after the deadline cannot restore that permission or authorize adoption.
 */
export async function recordRestartResult(input:{armed:ArmedRestartSubmission;subscriptionId:string}):Promise<boolean>{
 if(!Boolean(CONTRACT_ADMISSION_COVERAGE.pauseRestart))return false;
 const encoded=canonicalFinancialSnapshot(input);if(!encoded)return false;
 input=JSON.parse(encoded);
 const {armed,subscriptionId}=input,now=Math.floor(Date.now()/1000);
 if(!armed||!/^sub_[A-Za-z0-9]{6,64}$/.test(subscriptionId)||!/^price_[A-Za-z0-9]{6,100}$/.test(armed.priceId)||
    !/^[a-f0-9]{64}$/.test(armed.bodyHash)||!Number.isSafeInteger(armed.armedAtSeconds)||armed.armedAtSeconds<=0||
    armed.idempotencyKey!=='restart:'+armed.intent.grant.id+':'+armed.intent.claim||now<armed.armedAtSeconds||!isRedisConfigured())return false;
 try{
  const {intent}=armed;
  const reply=await redisPipeline([['EVAL',RECORD_RESTART_RESULT,1,'nl:contract-reserve:v1',intent.grant.id,intent.grant.reviewId,intent.grant.statsId,intent.claim,armed.priceId,armed.bodyHash,subscriptionId,now,armed.armedAtSeconds]]);
  if(!Array.isArray(reply))return false;
  const length=Object.getOwnPropertyDescriptor(reply,'length');
  if(!length||!Object.hasOwn(length,'value')||length.value!==1)return false;
  const ack=Object.getOwnPropertyDescriptor(reply,'0');
  return Boolean(ack&&Object.hasOwn(ack,'value')&&(ack.value===1||ack.value===2));
 }catch{return false;}
}

/** Final synchronous admission check immediately before the sole POST.
 * Pure validation; an armed ACK is still required separately by its caller.
 */
export function restartSubmissionOpenNow(
 armed:ArmedRestartSubmission,nowMs=Date.now(),
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
):boolean{
 if(!Boolean(CONTRACT_ADMISSION_COVERAGE.pauseRestart))return false;
 if(!customerTaxContractContextSupported(context,policy,new Date(nowMs)))return false;
 const encoded=canonicalFinancialSnapshot({armed,nowMs,policy,context});if(!encoded)return false;
 ({armed,nowMs,policy,context}=JSON.parse(encoded));
 if(!Number.isSafeInteger(nowMs)||nowMs<=0||!armed?.intent)return false;
 const config=contractFundingConfiguration(policy,context,new Date(nowMs)),grant=armed.intent.grant;
 return config!==null&&commercialMarginReady(context.review)&&contractFundingBinding(config)===armed.policyBinding&&
  config.reviewId===grant.reviewId&&config.grantCents[grant.key]===grant.reservedCents&&grant.action==='restart'&&
  ['creator_month','pro_month','scale_month'].includes(grant.key)&&Number.isSafeInteger(armed.armedAtSeconds)&&
  nowMs>=armed.armedAtSeconds*1000&&nowMs<=(grant.submitUntilSeconds*1000)&&
  new Date(nowMs).toISOString().slice(0,7)===context.review?.fundedExposure?.month;
}

export const TAKE_RESTART_RECOVERY = `
local function number(v)
 if not v or not string.match(v,'^%d+$') or (#v>1 and string.sub(v,1,1)=='0') then return nil end
 local n=tonumber(v)
 if not n or n<0 or n>1000000000000 or n~=math.floor(n) then return nil end
 return n
end
local function integer(v) return type(v)=='number' and v>=0 and v<=1000000000000 and v==math.floor(v) end
if #KEYS~=4 or #ARGV~=9 or #ARGV[1]<1 or #ARGV[1]>128 or #ARGV[3]>84 or not string.match(ARGV[3],'^ctr_[%w_-]+$') or #ARGV[4]<1 or #ARGV[4]>320 or #ARGV[5]<3 or #ARGV[5]>24 or #ARGV[6]>1536 then return 0 end
if KEYS[2]~='nl:pause:'..ARGV[4] or KEYS[3]~='nl:pause:due' or KEYS[4]~='nl:pause:last:'..ARGV[4] then return 0 end
local now=number(ARGV[7])
if not now or now<=0 or redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('TTL',KEYS[1])~=-1 then return 0 end
if redis.call('GET',KEYS[2])~=ARGV[6] then return 0 end
local ok,pause=pcall(cjson.decode,ARGV[6])
local annual=number(redis.call('GET',KEYS[4]))
if not ok or type(pause)~='table' or not integer(pause["until"]) or pause["until"]>now or not annual or annual<=0 or annual>now then return 0 end
if tonumber(redis.call('ZSCORE',KEYS[3],ARGV[4]))~=pause["until"] then return 0 end
local active=redis.call('HGET',KEYS[1],'active:'..ARGV[1])
local sourceBinding=redis.call('HGET',KEYS[1],'activated:'..ARGV[3])
if not active or #active>256 or not sourceBinding or #sourceBinding>256 then return 0 end
local source={}
for field in string.gmatch(sourceBinding,'[^|]+') do source[#source+1]=field end
if #source~=7 or table.concat(source,'|')~=sourceBinding or source[1]~=ARGV[3] or source[2]~=ARGV[2] or source[5]~='paid' or number(source[7])~=pause.from or pause.subscription~=ARGV[2] or type(pause.funding)~='table' or pause.funding.version~=1 or pause.funding.grantId~=ARGV[3] then return 0 end
if source[3]~='creator_month' and source[3]~='pro_month' and source[3]~='scale_month' then return 0 end
local owner=redis.call('HGET',KEYS[1],'restart-owner:'..ARGV[3])
local pending=redis.call('HGET',KEYS[1],'pending:'..ARGV[1])
if not owner then
 -- A pre-index pending lock is unknown, never permission to submit again.
 if pending or active~=sourceBinding or ARGV[8]=='' or ARGV[9]=='' then return 0 end
 local current=redis.call('HMGET',KEYS[1],'policy','review')
 if current[1]~=ARGV[8] or current[2]~=ARGV[9] then return 0 end
 return {'absent'}
end
if #owner>84 or not string.match(owner,'^ctr_[%w_-]+$') or pending~=owner then return 0 end
local raw=redis.call('HGET',KEYS[1],'restart-intent:'..owner)
if not raw or #raw>4096 then return 0 end
local valid,intent=pcall(cjson.decode,raw)
if not valid or type(intent)~='table' or intent.version~=1 or intent.grant~=owner or intent.statsId~=ARGV[1] or intent.sourceSubscription~=ARGV[2] or intent.sourceGrant~=ARGV[3] or intent.ref~=ARGV[4] or intent.handle~=ARGV[5] or intent.paused~=ARGV[6] or intent.sourceBinding~=sourceBinding or not integer(intent.annual) or intent.annual<=0 or intent.annual~=annual then return 0 end
if redis.call('HGET',KEYS[1],'grant:'..owner)~=intent.restartReceipt or redis.call('HGET',KEYS[1],'grant:'..ARGV[3])~=intent.sourceReceipt then return 0 end
local reserved,carried=number(redis.call('HGET',KEYS[1],'reserved')),number(redis.call('HGET',KEYS[1],'carried'))
if not reserved or not carried or reserved<carried or not integer(intent.reservedCents) or not integer(intent.carriedCents) or reserved<intent.reservedCents or carried<intent.carriedCents then return 0 end
local activated=redis.call('HGET',KEYS[1],'activated:'..owner)
if active==sourceBinding and activated then return 0 end
local s=intent.submission
if s==nil then
 if active~=sourceBinding then return 0 end
 return {'held'}
end
if type(s)~='table' or s.version~=1 or (s.phase~='uncertain' and s.phase~='observed') or not integer(s.armedAt) or now<s.armedAt or type(s.priceId)~='string' or type(s.bodyHash)~='string' or #s.bodyHash~=64 or s.idempotencyKey~='restart:'..owner..':'..intent.claim then return 0 end
if s.phase=='observed' and (type(s.subscriptionId)~='string' or not string.match(s.subscriptionId,'^sub_[A-Za-z0-9]+$') or #s.subscriptionId>68) then return 0 end
if s.phase=='uncertain' and s.subscriptionId~=nil then return 0 end
local reads=s.recoveryReads
if reads==nil then reads=0 end
if not integer(reads) or reads>3 or (s.lastRecoveryAt~=nil and (not integer(s.lastRecoveryAt) or now<s.lastRecoveryAt)) then return 0 end
-- An already committed activation may be reconciled after a lost ACK.
-- It never permits another POST or another owner. The original activated
-- source and all three provider-read allowances remain unchanged.
if active~=sourceBinding then
 if s.phase~='observed' or activated~=active then return 0 end
 local bound={}
 for field in string.gmatch(active,'[^|]+') do bound[#bound+1]=field end
 local receipt={}
 for field in string.gmatch(intent.restartReceipt,'[^|]+') do receipt[#receipt+1]=field end
 local created,start,finish=number(bound[4]),number(bound[6]),number(bound[7])
 local deadline,through=number(receipt[8]),tonumber(receipt[9])
 if #bound~=7 or table.concat(bound,'|')~=active or bound[1]~=owner or bound[2]~=s.subscriptionId or bound[3]~=source[3] or bound[5]~='paid' or not created or not start or not finish or created<s.armedAt or created>now or start<created or start>now or finish<=now or finish<=start or finish-start>31*86400 then return 0 end
 if #receipt~=10 or table.concat(receipt,'|')~=intent.restartReceipt or receipt[1]~=intent.review or receipt[2]~=intent.statsId or receipt[3]~=source[3] or receipt[4]~='restart' or receipt[10]~=ARGV[3] or not deadline or created>deadline or not through or through<=0 or not string.match(receipt[9],'^%d+$') or (#receipt[9]>1 and string.sub(receipt[9],1,1)=='0') or through~=math.floor(through) or through>9007199254740991 or finish*1000>through then return 0 end
 local checkpointRaw=redis.call('HGET',KEYS[1],'restart-publication:'..owner)
 if not checkpointRaw or #checkpointRaw>384 then return 0 end
 local validCheckpoint,checkpoint=pcall(cjson.decode,checkpointRaw)
 if not validCheckpoint or type(checkpoint)~='table' then return 0 end
 local checkpointFields=0 for _ in pairs(checkpoint) do checkpointFields=checkpointFields+1 end
 if checkpointFields~=4 or checkpoint.version~=1 or checkpoint.binding~=active or type(checkpoint.renews)~='boolean' or type(checkpoint.shared)~='boolean' then return 0 end
 local retained=s.publication
 if type(retained)~='table' then return 0 end
 local retainedFields=0 for _ in pairs(retained) do retainedFields=retainedFields+1 end
 if retainedFields~=2 or retained.renews~=checkpoint.renews or retained.shared~=checkpoint.shared then return 0 end
 return {'activated',raw,active,checkpointRaw}
end
if s.publication~=nil then return 0 end
if reads>=3 then return {'held'} end
s.recoveryReads=reads+1
s.lastRecoveryAt=now
local encoded=cjson.encode(intent)
if #encoded>4096 then return 0 end
redis.call('HSET',KEYS[1],'restart-intent:'..owner,encoded)
return {'read',encoded}
`;
/** Bound the recovery ACK before traversing data or encoding strings. */
function boundedRestartRecoveryAcknowledgement(reply: unknown): unknown[] | null {
 try {
  if(!Array.isArray(reply))return null;
  const outerLength=Object.getOwnPropertyDescriptor(reply,'length');
  if(!outerLength||!Object.hasOwn(outerLength,'value')||outerLength.value!==1)return null;
  const outer=Object.getOwnPropertyDescriptor(reply,'0');
  if(!outer||!Object.hasOwn(outer,'value')||!Array.isArray(outer.value))return null;
  const inner:unknown[]=outer.value,length=Object.getOwnPropertyDescriptor(inner,'length');
  if(!length||!Object.hasOwn(length,'value')||![1,2,4].includes(length.value))return null;
  const values:unknown[]=[];
  for(let index=0;index<length.value;index++){
   const field=Object.getOwnPropertyDescriptor(inner,String(index));
   if(!field||!Object.hasOwn(field,'value'))return null;
   values.push(field.value);
  }
  if(values.length===1)return values[0]==='absent'||values[0]==='held'?values:null;
  if(values.length===2?values[0]!=='read':values[0]!=='activated')return null;
  if(typeof values[1]!=='string'||values[1].length>4096)return null;
  if(values.length===4&&(typeof values[2]!=='string'||values[2].length>256||typeof values[3]!=='string'||values[3].length>384))return null;
  return values;
 }catch{return null;}
}
export type RestartRecoveryInput={statsId:string;sourceSubscriptionId:string;sourceGrantId:string;ref:string;handle:string;paused:string};
export type RestartRecovery={kind:'absent'}|{kind:'held'}|{kind:'read';armed:ArmedRestartSubmission;subscriptionId:string|null}|{kind:'activated';armed:ArmedRestartSubmission;subscriptionId:string;createdSeconds:number;periodStartSeconds:number;periodEndSeconds:number;renews:boolean;shared:boolean};
/** At most three lifetime provider reads per source owner. Lost ACK consumes
 * a provider-read allowance; committed paid evidence returns without consuming one.
 * No POST, new owner, reserve, release or activation.
 */
export async function takeRestartRecovery(
 input:RestartRecoveryInput,
 policy:ContractFundingPolicy|null=CURRENT_CONTRACT_FUNDING_POLICY,
 context:ContractFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW},
):Promise<RestartRecovery|null>{
 if(!Boolean(CONTRACT_ADMISSION_COVERAGE.pauseRestart))return null;
 if(!customerTaxContractContextSupported(context,policy))return null;
 const encoded=canonicalFinancialSnapshot({input,policy,context});if(!encoded)return null;
 ({input,policy,context}=JSON.parse(encoded));
 if(!input||!/^[A-Za-z0-9_-]{1,128}$/.test(input.statsId)||!/^sub_[A-Za-z0-9]{6,64}$/.test(input.sourceSubscriptionId)||!/^ctr_[A-Za-z0-9_-]{1,80}$/.test(input.sourceGrantId)||typeof input.ref!=='string'||input.ref.length===0||input.ref.length>320||!HANDLE_PATTERN.test(input.handle)||typeof input.paused!=='string'||Buffer.byteLength(input.paused)>1536||!isRedisConfigured())return null;
 try{
  const before=new Date(),now=Math.floor(before.getTime()/1000),config=contractFundingConfiguration(policy,context,before);
  const reply=await redisPipeline([['EVAL',TAKE_RESTART_RECOVERY,4,'nl:contract-reserve:v1','nl:pause:'+input.ref,'nl:pause:due','nl:pause:last:'+input.ref,input.statsId,input.sourceSubscriptionId,input.sourceGrantId,input.ref,input.handle,input.paused,now,config?contractFundingBinding(config):'',config?.reviewId??'']]);
  const ack=boundedRestartRecoveryAcknowledgement(reply);if(!ack)return null;
  if(ack.length===1&&(ack[0]==='absent'||ack[0]==='held'))return {kind:ack[0]};
  const activated=ack[0]==='activated';
  if((activated?ack.length!==4||typeof ack[2]!=='string'||Buffer.byteLength(ack[2])>256||typeof ack[3]!=='string'||Buffer.byteLength(ack[3])>384:ack.length!==2||ack[0]!=='read')||typeof ack[1]!=='string'||Buffer.byteLength(ack[1])>4096)return null;
  const {submission,...original}=JSON.parse(ack[1]);
  if(typeof original.claim!=='string'||!/^claim_[A-Za-z0-9_-]{1,80}$/.test(original.claim))return null;
  const receipt=original.restartReceipt.split('|'),through=Number(receipt[8]);
  if(receipt.length!==10||!['creator_month','pro_month','scale_month'].includes(receipt[2])||!Number.isSafeInteger(through)||through<=0)return null;
  const grant:ContractGrant={id:original.grant,reviewId:original.review,statsId:input.statsId,key:receipt[2] as ContractGrant['key'],action:'restart',sourceSubscriptionId:input.sourceSubscriptionId,reservedCents:Number(receipt[4]),submitUntilSeconds:Number(receipt[5]),checkoutExpiresAtSeconds:Number(receipt[6]),activationUntilSeconds:Number(receipt[7]),liabilitiesThrough:new Date(through).toISOString()};
  const intent=ownedRestartIntentFromAcknowledgement({grant,ref:input.ref,handle:input.handle,paused:input.paused,claim:original.claim,sourceGrantId:input.sourceGrantId},original.created,{cashLimitCents:original.reservedCents,carryForwardCents:original.carriedCents},[1,JSON.stringify(original)]);
  if(!intent||!submission||submission.version!==1||!['uncertain','observed'].includes(submission.phase)||!/^price_[A-Za-z0-9]{6,100}$/.test(submission.priceId)||!/^[a-f0-9]{64}$/.test(submission.bodyHash)||!Number.isSafeInteger(submission.armedAt)||submission.armedAt<intent.claimedAtSeconds||submission.armedAt>intent.grant.submitUntilSeconds||submission.idempotencyKey!=='restart:'+grant.id+':'+intent.claim||(activated?(!Number.isSafeInteger(submission.recoveryReads??0)||(submission.recoveryReads??0)<0||(submission.recoveryReads??0)>3||(submission.lastRecoveryAt!==undefined&&(!Number.isSafeInteger(submission.lastRecoveryAt)||submission.lastRecoveryAt>now))):(!Number.isSafeInteger(submission.recoveryReads)||submission.recoveryReads<1||submission.recoveryReads>3||submission.lastRecoveryAt!==now)))return null;
  const id=submission.phase==='observed'?submission.subscriptionId:null;
  if(id!==null&&(typeof id!=='string'||!/^sub_[A-Za-z0-9]{6,64}$/.test(id)))return null;
  const armed=Object.freeze({intent,priceId:submission.priceId,bodyHash:submission.bodyHash,armedAtSeconds:submission.armedAt,idempotencyKey:submission.idempotencyKey,
   // Recovery cannot carry a live submission permission from a current policy.
   policyBinding:''});
  if(activated){
   const bound=(ack[2] as string).split('|'),created=Number(bound[3]),start=Number(bound[5]),finish=Number(bound[6]);
   if(!id||submission.phase!=='observed'||bound.length!==7||bound.join('|')!==ack[2]||bound[0]!==grant.id||bound[1]!==id||bound[2]!==grant.key||bound[4]!=='paid'||![created,start,finish].every(n=>Number.isSafeInteger(n)&&n>0)||created<submission.armedAt||created>grant.activationUntilSeconds||start<created||start>now||finish<=now||finish-start>31*86400||finish*1000>through||Math.floor(Date.now()/1000)>=finish)return null;
   const checkpoint=JSON.parse(ack[3] as string);
   if(!checkpoint||typeof checkpoint!=='object'||Array.isArray(checkpoint)||Object.keys(checkpoint).length!==4||checkpoint.version!==1||checkpoint.binding!==ack[2]||typeof checkpoint.renews!=='boolean'||typeof checkpoint.shared!=='boolean')return null;
   const retained=submission.publication;
   if(!retained||typeof retained!=='object'||Array.isArray(retained)||Object.keys(retained).length!==2||retained.renews!==checkpoint.renews||retained.shared!==checkpoint.shared)return null;
   return {kind:'activated',armed,subscriptionId:id,createdSeconds:created,periodStartSeconds:start,periodEndSeconds:finish,renews:checkpoint.renews,shared:checkpoint.shared};
  }
  if(submission.publication!==undefined)return null;
  return {kind:'read',armed,subscriptionId:id};
 }catch{return null;}
}
