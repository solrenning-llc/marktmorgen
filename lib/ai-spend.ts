import { costStandingOf, type PlanFields } from '@/lib/plan-standing';
import type { Tier } from '@/lib/plan';
import { isRedisConfigured, redisPipeline } from '@/lib/redis';
import { AI_BUDGET_TIERS, AUTOMATIC_AI_SPEND_REVIEW_ID, aiSpendLedgerKey, aiSpendOpenedKey, aiSpendPolicySnapshot, currentAiSpendPolicy, isAiSpendPolicyValid, type AiBudgetTier, type AiSpendPolicy } from '@/lib/ai-spend-policy';
import { SUPPORTED_AI_MODELS } from '@/lib/ai-request-rules';
import type { AllowanceWindow } from '@/lib/allowance-window';

/** Acquisition and ended accounts never consume a paid-tier allocation. */
export function aiBudgetScopeFor(store: PlanFields & { tier: Tier }, nowSeconds = Date.now() / 1000): AiBudgetTier {
  // A paid plan whose renewal is unpaid is spent as an ended one (232 [CA1] unit 4).
  const standing = costStandingOf(store, nowSeconds);
  return standing === 'paid' ? store.tier : standing === 'none' ? 'setup' : standing;
}

export function isAiBudgetConfigured(policy: AiSpendPolicy | null = currentAiSpendPolicy(), now = new Date()): policy is AiSpendPolicy {
  return isAiSpendPolicyValid(policy, now);
}

/** A single hash keeps both counters in the same Redis cluster slot. Read and
 * validate everything before writing. Missing/corrupt/expiring ledgers deny.
 * This script never creates a ledger; OPEN_AI_SPEND_LEDGER opens the
 * automatic policy's month once and never recreates it.
 */
export const RESERVE_AI_SPEND = `
local function amount(value)
  if not value or not string.match(value, '^%d+$') or (#value > 1 and string.sub(value, 1, 1) == '0') then return nil end
  local n = tonumber(value)
  if not n or n < 0 or n > 1000000000000 or n ~= math.floor(n) then return nil end
  return n
end
if redis.call('TYPE', KEYS[1]).ok ~= 'hash' then return 0 end
if redis.call('TTL', KEYS[1]) ~= -1 then return 0 end
if redis.call('HGET', KEYS[1], 'review') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'policy') ~= ARGV[6] then return 0 end
local company = amount(redis.call('HGET', KEYS[1], 'company'))
local raw = redis.call('HGET', KEYS[1], ARGV[2])
local scopeField = 'tier:' .. ARGV[2]
local scope = redis.call('HGET', KEYS[1], scopeField)
if scope and (scope ~= ARGV[7] or not raw) then return 0 end
if not scope and raw then return 0 end
local store = raw and amount(raw) or 0
if raw and not amount(raw) then return 0 end
local funded = amount(ARGV[8])
local slotsField = 'slots:' .. ARGV[7]
local slots = amount(redis.call('HGET', KEYS[1], slotsField))
if not funded or not slots or slots > funded or (not scope and slots <= 0) then return 0 end
local charge, storeLimit, companyLimit = amount(ARGV[3]), amount(ARGV[4]), amount(ARGV[5])
if not company or not charge or charge <= 0 or not storeLimit or not companyLimit then return 0 end
if store > company or store > storeLimit or company > companyLimit or charge > storeLimit - store or charge > companyLimit - company then return 0 end
if not scope then
  redis.call('HINCRBY', KEYS[1], slotsField, -1)
  redis.call('HSET', KEYS[1], scopeField, ARGV[7])
end
redis.call('HINCRBY', KEYS[1], ARGV[2], ARGV[3])
redis.call('HINCRBY', KEYS[1], 'company', ARGV[3])
return 1
`;

/** Opens the automatic policy's month once, and carries a changed automatic
 * policy onto the same counters. It never resets or recreates anything: a
 * month whose ledger was opened and later went missing stays refused, a
 * ledger that belongs to any other review is left alone, and changed ceilings
 * keep every spent amount and every claimed allocation. Reservation itself
 * stays in RESERVE_AI_SPEND, unchanged.
 */
export const OPEN_AI_SPEND_LEDGER = `
local function amount(value)
  if not value or not string.match(value, '^%d+$') or (#value > 1 and string.sub(value, 1, 1) == '0') then return nil end
  local n = tonumber(value)
  if not n or n < 0 or n > 1000000000000 or n ~= math.floor(n) then return nil end
  return n
end
local tiers = {'creator', 'pro', 'scale', 'trial', 'setup', 'ended'}
local funded = {}
for i = 1, 6 do
  funded[i] = amount(ARGV[2 + i])
  if not funded[i] then return 0 end
end
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then
  if redis.call('EXISTS', KEYS[2]) ~= 0 then return 0 end
  redis.call('SET', KEYS[2], ARGV[1])
  redis.call('HSET', KEYS[1], 'review', ARGV[1], 'policy', ARGV[2], 'company', '0')
  for i = 1, 6 do
    redis.call('HSET', KEYS[1], 'slots:' .. tiers[i], funded[i], 'funded:' .. tiers[i], funded[i])
  end
  return 1
end
if kind ~= 'hash' or redis.call('TTL', KEYS[1]) ~= -1 then return 0 end
if redis.call('HGET', KEYS[1], 'review') ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[1], 'policy') == ARGV[2] then return 1 end
if not amount(redis.call('HGET', KEYS[1], 'company')) then return 0 end
local slots = {}
for i = 1, 6 do
  local was = amount(redis.call('HGET', KEYS[1], 'funded:' .. tiers[i]))
  local left = amount(redis.call('HGET', KEYS[1], 'slots:' .. tiers[i]))
  if not was or not left or left > was then return 0 end
  local claimed = was - left
  if funded[i] > claimed then slots[i] = funded[i] - claimed else slots[i] = 0 end
end
-- No writes until every field has been read and checked.
for i = 1, 6 do
  redis.call('HSET', KEYS[1], 'slots:' .. tiers[i], slots[i], 'funded:' .. tiers[i], funded[i])
end
redis.call('HSET', KEYS[1], 'policy', ARGV[2])
return 1
`;

/** The reservation is final before fetch. Never refund on timeout, provider
 * rejection, invalid output, response loss or a failed creator job. A retry is
 * a new paid call with a new reservation. Caller-supplied historical dates
 * cannot choose a fresh spending month.
 *
 * `window` (17 October 2026): the store's allowance window
 * (lib/allowance-window.ts). A paying store's monthly ceiling follows its
 * billing month, not the calendar: the month is reserved in the ledger of
 * the calendar month it began in, under a field of its own, so one payment
 * buys one month's ceiling however many calendar months the billing month
 * touches. The window is worked out from the store's record, never from the
 * request. Without one, the calendar month of the policy, as before.
 */
export async function reserveAiSpend(
  statsId: string, tier: AiBudgetTier, model: string,
  given: AiSpendPolicy | null = currentAiSpendPolicy(),
  requestHoldMicroUsd?: number,
  window?: AllowanceWindow,
): Promise<boolean> {
  // The ledger of the month a billing month began in, at most a month back.
  const began = window?.billing ? new Date(window.start) : null;
  if (began && (!Number.isFinite(began.getTime()) || Date.now() - began.getTime() > 32 * 86_400_000 || began.getTime() - Date.now() > 300_000)) return false;
  const policy = began && given?.reviewId === AUTOMATIC_AI_SPEND_REVIEW_ID ? currentAiSpendPolicy(began) : given;
  if (!isAiBudgetConfigured(policy, began ?? new Date())) return false;
  if (!isRedisConfigured() || typeof statsId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(statsId)
    || !(AI_BUDGET_TIERS as readonly string[]).includes(tier) || !(SUPPORTED_AI_MODELS as readonly string[]).includes(model)) return false;
  const ceiling = policy.requestMicroUsd[model as keyof typeof policy.requestMicroUsd];
  // The automatic policy reserves the hard bound of this very request
  // (lib/spend-cost-table.ts), never above the model's largest request. A
  // separately reviewed policy keeps its flat per-model ceiling.
  const automatic = policy.reviewId === AUTOMATIC_AI_SPEND_REVIEW_ID;
  if (automatic && requestHoldMicroUsd !== undefined && (!Number.isSafeInteger(requestHoldMicroUsd) || requestHoldMicroUsd < 1 || requestHoldMicroUsd > ceiling)) return false;
  const charge = automatic && requestHoldMicroUsd !== undefined ? requestHoldMicroUsd : ceiling;
  if (policy.fundedStores[tier] === 0 || charge > policy.storeMicroUsd[tier] || charge > policy.companyMicroUsd) return false;
  const key = aiSpendLedgerKey(policy.month), snapshot = aiSpendPolicySnapshot(policy);
  const field = 'store:' + statsId + (window?.billing ? ':' + window.id : '');
  const reserve: (string | number)[] = ['EVAL', RESERVE_AI_SPEND, 1, key, policy.reviewId, field,
    charge, policy.storeMicroUsd[tier], policy.companyMicroUsd, snapshot, tier, policy.fundedStores[tier]];
  try {
    if (!automatic) {
      const result = await redisPipeline([reserve]);
      return result.length === 1 && result[0] === 1;
    }
    const open: (string | number)[] = ['EVAL', OPEN_AI_SPEND_LEDGER, 2, key, aiSpendOpenedKey(policy.month), policy.reviewId, snapshot,
      ...AI_BUDGET_TIERS.map(scope => policy.fundedStores[scope])];
    const result = await redisPipeline([open, reserve]);
    return result.length === 2 && result[0] === 1 && result[1] === 1;
  } catch { return false; }
}
