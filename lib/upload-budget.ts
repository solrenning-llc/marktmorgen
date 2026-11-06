import {reservePaidResourceWindow} from '@/lib/contract-resource-window';
import { isRedisConfigured, redisPipeline } from '@/lib/redis';
import { costStandingOf } from '@/lib/plan-standing';
import { type AllowanceWindow, type WindowFields, allowanceWindow } from '@/lib/allowance-window';
import type { Tier } from '@/lib/plan';
import { AUTOMATIC_UPLOAD_REVIEW_ID, UPLOAD_BUDGET_RULES, UPLOAD_BUDGET_SCOPES, currentUploadBudgetPolicy, isUploadBudgetConfigured, uploadBudgetSnapshot, uploadLedgerKey, uploadOpenedKey, type UploadBudgetPolicy, type UploadBudgetScope } from '@/lib/upload-budget-policy';

export type UploadBackend = 'r2'|'blob'|'stream';
export type UploadStore = WindowFields & { statsId: string|null; tier: Tier };
export function uploadScopeFor(store: UploadStore): UploadBudgetScope {
  // A paid plan whose renewal is unpaid uploads as an ended one (232 [CA1] unit 4).
  const standing=costStandingOf(store);
  return standing==='paid'?store.tier:standing==='none'?'setup':standing;
}
/** One persistent cluster-slot hash covers all providers and all customers.
 * Under the automatic policy OPEN_UPLOAD_BUDGET opens each month's ledger
 * once; this script never initializes a missing ledger.
 */
export const RESERVE_UPLOAD_BUDGET = `
local function amount(value)
  if not value or not string.match(value, '^%d+$') or (#value > 1 and string.sub(value, 1, 1) == '0') then return nil end
  local n = tonumber(value)
  if not n or n < 0 or n > 9000000000000000 or n ~= math.floor(n) then return nil end
  return n
end
if redis.call('TYPE', KEYS[1]).ok ~= 'hash' or redis.call('TTL', KEYS[1]) ~= -1 then return 0 end
if redis.call('HGET', KEYS[1], 'policy') ~= ARGV[1] then return 0 end
local action, bytes = ARGV[4], amount(ARGV[5])
if not bytes or (action ~= 'open' and action ~= 'control') then return 0 end
if (action == 'open' and bytes <= 0) or (action == 'control' and bytes ~= 0) then return 0 end
local storeLimit = {amount(ARGV[6]), amount(ARGV[7]), amount(ARGV[8])}
local companyLimit = {amount(ARGV[9]), amount(ARGV[10]), amount(ARGV[11])}
local funded = amount(ARGV[12])
if not funded then return 0 end
local names = {'opens','bytes','controls'}
local company, used = {}, {}
local prefix = 'store:' .. ARGV[2] .. ':'
local scope = redis.call('HGET', KEYS[1], prefix .. 'scope')
for i = 1, 3 do
  if not storeLimit[i] or not companyLimit[i] then return 0 end
  company[i] = amount(redis.call('HGET', KEYS[1], 'company:' .. names[i]))
  if not company[i] or company[i] > companyLimit[i] then return 0 end
  local raw = redis.call('HGET', KEYS[1], prefix .. names[i])
  if not scope then
    if raw then return 0 end
    used[i] = 0
  else
    used[i] = amount(raw)
    if not used[i] or used[i] > storeLimit[i] or used[i] > company[i] then return 0 end
  end
end
if scope and scope ~= ARGV[3] then return 0 end
local slots
if not scope then
  slots = amount(redis.call('HGET', KEYS[1], 'slots:' .. ARGV[3]))
  if not slots or slots <= 0 or slots > funded then return 0 end
end
local charge = {action == 'open' and 1 or 0, bytes, 1}
for i = 1, 3 do
  if charge[i] > storeLimit[i] - used[i] or charge[i] > companyLimit[i] - company[i] then return 0 end
end
-- No writes until every field and every ceiling has been checked.
if not scope then
  redis.call('HINCRBY', KEYS[1], 'slots:' .. ARGV[3], -1)
  redis.call('HSET', KEYS[1], prefix .. 'scope', ARGV[3])
end
for i = 1, 3 do
  redis.call('HINCRBY', KEYS[1], prefix .. names[i], charge[i])
  redis.call('HINCRBY', KEYS[1], 'company:' .. names[i], charge[i])
end
return 1
`;

/** Opens the automatic policy's month once, and carries a changed automatic
 * policy onto the same counters. It never resets or recreates anything: a
 * month whose ledger was opened and later went missing stays refused, a
 * ledger without the automatic review is left alone, and changed allowances
 * keep every used amount and every claimed allocation. RESERVE_UPLOAD_BUDGET
 * is unchanged.
 */
export const OPEN_UPLOAD_BUDGET = `
local function amount(value)
  if not value or not string.match(value, '^%d+$') or (#value > 1 and string.sub(value, 1, 1) == '0') then return nil end
  local n = tonumber(value)
  if not n or n < 0 or n > 9000000000000000 or n ~= math.floor(n) then return nil end
  return n
end
local scopes = {'creator', 'pro', 'scale', 'trial', 'setup', 'ended'}
local funded = {}
for i = 1, 6 do
  funded[i] = amount(ARGV[2 + i])
  if not funded[i] then return 0 end
end
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then
  if redis.call('EXISTS', KEYS[2]) ~= 0 then return 0 end
  redis.call('SET', KEYS[2], ARGV[1])
  redis.call('HSET', KEYS[1], 'review', ARGV[1], 'policy', ARGV[2], 'company:opens', '0', 'company:bytes', '0', 'company:controls', '0')
  for i = 1, 6 do
    redis.call('HSET', KEYS[1], 'slots:' .. scopes[i], funded[i], 'funded:' .. scopes[i], funded[i])
  end
  return 1
end
if kind ~= 'hash' or redis.call('TTL', KEYS[1]) ~= -1 then return 0 end
if redis.call('HGET', KEYS[1], 'review') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'policy') == ARGV[2] then return 1 end
for _, name in ipairs({'opens', 'bytes', 'controls'}) do
  if not amount(redis.call('HGET', KEYS[1], 'company:' .. name)) then return 0 end
end
local slots = {}
for i = 1, 6 do
  local was = amount(redis.call('HGET', KEYS[1], 'funded:' .. scopes[i]))
  local left = amount(redis.call('HGET', KEYS[1], 'slots:' .. scopes[i]))
  if not was or not left or left > was then return 0 end
  local claimed = was - left
  if funded[i] > claimed then slots[i] = funded[i] - claimed else slots[i] = 0 end
end
-- No writes until every field has been read and checked.
for i = 1, 6 do
  redis.call('HSET', KEYS[1], 'slots:' .. scopes[i], slots[i], 'funded:' .. scopes[i], funded[i])
end
redis.call('HSET', KEYS[1], 'policy', ARGV[2])
return 1
`;

/**
 * `window` (17 October 2026): the store's allowance window
 * (lib/allowance-window.ts). A paying store's monthly allowance follows its
 * billing month: it is reserved in the ledger of the calendar month that
 * month began in, under the store and the month's own name, so one payment
 * buys one month of uploads however many calendar months it touches.
 */
async function reserve(statsId: string, scope: UploadBudgetScope, action: 'open'|'control', bytes: number, given: UploadBudgetPolicy|null, window: AllowanceWindow|null): Promise<boolean> {
  if(!window)return false;
  const began=window.billing?new Date(window.start):null;
  if(began && (Date.now()-window.start>32*86_400_000 || window.start-Date.now()>300_000))return false;
  const policy=began && given?.reviewId===AUTOMATIC_UPLOAD_REVIEW_ID?currentUploadBudgetPolicy(began):given;
  if(!isUploadBudgetConfigured(policy,began??new Date()) || !isRedisConfigured() || !/^[a-f0-9]{32}$/.test(statsId)
    || !(UPLOAD_BUDGET_SCOPES as readonly string[]).includes(scope)
    || !Number.isSafeInteger(bytes) || bytes<0 || bytes>UPLOAD_BUDGET_RULES.maxInteger
    || (action==='open' && bytes===0) || (action==='control' && bytes!==0))return false;
  const cap=policy.perStore[scope], company=policy.company;
  if(cap.controlRequests<1 || (action==='open' && (cap.opens<1 || bytes>cap.authorizedBytes)))return false;
  const key=uploadLedgerKey(policy.month), snapshot=uploadBudgetSnapshot(policy);
  const take:(string|number)[]=['EVAL',RESERVE_UPLOAD_BUDGET,1,key,
      snapshot,window.billing?statsId+'@'+window.id:statsId,scope,action,bytes,cap.opens,cap.authorizedBytes,cap.controlRequests,
      company.opens,company.authorizedBytes,company.controlRequests,policy.fundedStores[scope]];
  try{
    if(policy.reviewId!==AUTOMATIC_UPLOAD_REVIEW_ID){
      const result=await redisPipeline([take]);
      return result.length===1 && result[0]===1;
    }
    const open:(string|number)[]=['EVAL',OPEN_UPLOAD_BUDGET,2,key,uploadOpenedKey(policy.month),policy.reviewId,snapshot,
      ...UPLOAD_BUDGET_SCOPES.map(name=>policy.fundedStores[name])];
    const result=await redisPipeline([open,take]);
    return result.length===2 && result[0]===1 && result[1]===1;
  }catch{return false;}
}
/** The full authorized size is retained on abort, timeout, rejection or lost
 * acknowledgement. Reopening is a new reservation; deleting a file never
 * refunds monthly upload capacity. This is not a supplier-dollar ceiling.
 */
export async function reserveStoreUpload(store: UploadStore, bytes: number, backend: UploadBackend, policy: UploadBudgetPolicy|null=currentUploadBudgetPolicy()): Promise<boolean> {
  // Direct Blob/Bunny grants do not establish the same revocable, size-bound
  // session contract. Keep them closed until that provider path is proven.
  if(backend!=='r2'||!Number.isSafeInteger(bytes)||bytes<=0)return false;
  if(store?.period?.funded===true&&!(await reservePaidResourceWindow(store)))return false;
  return !!store?.statsId && reserve(store.statsId,uploadScopeFor(store),'open',bytes,policy,allowanceWindow(store));
}
/** Signing requests share the store's monthly control ceiling.
 * Completing or canceling an existing grant remains accessible; the reviewed
 * per-open liability must include that work and month-boundary carryover.
 */
export async function reserveUploadControl(store: UploadStore, policy: UploadBudgetPolicy|null=currentUploadBudgetPolicy()): Promise<boolean> {
  if(store?.period?.funded===true&&!(await reservePaidResourceWindow(store)))return false;
  return !!store?.statsId && reserve(store.statsId,uploadScopeFor(store),'control',0,policy,allowanceWindow(store));
}
