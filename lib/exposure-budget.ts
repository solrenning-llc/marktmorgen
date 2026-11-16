import { isRedisConfigured, redisPipeline } from '@/lib/redis';
import { CURRENT_COMMERCIAL_MARGIN_REVIEW, CURRENT_PRICE_AND_RIGHTS_SNAPSHOT } from '@/lib/commercial-margin';
import { EXPOSURE_SCOPES, type ExposureScope } from '@/lib/funded-exposure-rules';
import { CURRENT_EXPOSURE_BUDGET_POLICY, exposureBudgetConfiguration, type ExposureBudgetPolicy, type ExposureFundingContext } from '@/lib/exposure-budget-policy';
/** Static Lua is executed against disposable real Redis in CI. Never initialize
 * or expire a ledger here; only a reviewed funding migration can seed it. */
export const RESERVE_EXPOSURE = `
local function amount(value)
  if not value or not string.match(value, '^%d+$') or (#value > 1 and string.sub(value, 1, 1) == '0') then return nil end
  local n=tonumber(value)
  if not n or n<0 or n>1000000000000 or n~=math.floor(n) then return nil end
  return n
end
if redis.call('TYPE',KEYS[1]).ok~='hash' or redis.call('TTL',KEYS[1])~=-1 then return 0 end
if redis.call('HGET',KEYS[1],'review')~=ARGV[1] or redis.call('HGET',KEYS[1],'policy')~=ARGV[2] then return 0 end
local reserved=amount(redis.call('HGET',KEYS[1],'reserved'))
local charge,limit,funded=amount(ARGV[5]),amount(ARGV[6]),amount(ARGV[7])
local slotField='slots:'..ARGV[3]
local slots=amount(redis.call('HGET',KEYS[1],slotField))
local receiptField='case:'..ARGV[3]..':'..ARGV[4]
local raw=redis.call('HGET',KEYS[1],receiptField)
if not reserved or not charge or not limit or not funded or funded<=0 or not slots or slots>funded or reserved>limit then return 0 end
if raw then
 local receipt=amount(raw)
 if not receipt or receipt~=charge or reserved<charge or slots>=funded then return 0 end
 return 1
end
if slots<=0 or charge>limit-reserved then return 0 end
redis.call('HINCRBY',KEYS[1],slotField,-1)
redis.call('HSET',KEYS[1],receiptField,ARGV[5])
redis.call('HINCRBY',KEYS[1],'reserved',ARGV[5])
return 1
`;
/** An allocation is permanent for this store/scope/month, including lost replies.
 * This reserves reviewed exposure, not permission to change existing rights. */
export async function reserveFundedExposure(statsId:string,scope:ExposureScope,policy:ExposureBudgetPolicy|null=CURRENT_EXPOSURE_BUDGET_POLICY,context:ExposureFundingContext={termsSnapshot:CURRENT_PRICE_AND_RIGHTS_SNAPSHOT,review:CURRENT_COMMERCIAL_MARGIN_REVIEW?.fundedExposure??null}):Promise<boolean>{
 if(typeof statsId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(statsId)||!EXPOSURE_SCOPES.includes(scope)||!isRedisConfigured())return false;
 const config=exposureBudgetConfiguration(policy,context);
 if(!config)return false;
 const allocation=config.allocations[scope];
 if(allocation.slots===0)return false;
 try{
  const result=await redisPipeline([['EVAL',RESERVE_EXPOSURE,1,'nl:exposure:v1:'+config.month,config.reviewId,config.binding,scope,statsId,allocation.cents,config.budgetCents,allocation.slots]]);
  // Only an own numeric Redis ACK admits spending; never execute a getter
  // or accept an inherited entry while inspecting financial evidence.
  if(!Array.isArray(result)||Object.getPrototypeOf(result)!==Array.prototype||Reflect.ownKeys(result).length!==2)return false;
  const length=Object.getOwnPropertyDescriptor(result,'length');
  if(!length||!Object.hasOwn(length,'value')||length.value!==1)return false;
  const ack=Object.getOwnPropertyDescriptor(result,'0');
  if(!ack||!ack.enumerable||!Object.hasOwn(ack,'value')||ack.value!==1)return false;
  // Native serialization rejects Proxy-forged descriptors. The only admitted
  // slot is already validated numeric data, so no unknown getter is cloned.
  structuredClone(result);
  // A delayed acknowledgement cannot authorize work under changed or expired
  // evidence. Keep the committed reservation even when revalidation refuses.
  const current=exposureBudgetConfiguration(policy,context);
  return current!==null&&current.month===config.month&&current.binding===config.binding;
 }catch{return false;}
}
