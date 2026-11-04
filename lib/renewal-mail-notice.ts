/** Aggregate only: pending capsules and email bodies never leave Redis. */
import { redisPipeline } from "@/lib/redis";
import { CURRENT_SHIPMENT_MAIL_LIFECYCLE, CURRENT_SHIPMENT_MAIL_POLICY, SHIPMENT_MAIL_MAX_ROW_BYTES, shipmentMailPolicy, type ShipmentMailRuntime } from "@/lib/shipment-mail-outbox";
import type { Store } from "@/lib/store";

export const RENEWAL_NOTICE_ROWS = 8;
/** One atomic index read: bounded before SMEMBERS, then at most eight rows.
 * Internal JSON reads are bounded too; no capsule, recipient or row is returned. */
export const RENEWAL_NOTICE_SCRIPT = `
local kind=redis.call('TYPE',KEYS[1]).ok
if kind=='none' then return {'ok',0,0,0} end
if kind~='set' then return {'unknown'} end
local count=redis.call('SCARD',KEYS[1])
if count>8 then return {'unknown'} end
local ids=redis.call('SMEMBERS',KEYS[1])
local uncertain,held=0,0
for _,id in ipairs(ids) do
 if #id~=64 or string.find(id,'[^a-f0-9]') then return {'unknown'} end
 local raw=redis.call('GETRANGE','nl:order-confirmation:row:'..id,0,tonumber(ARGV[3]))
 if #raw==0 or #raw>tonumber(ARGV[3]) then return {'unknown'} end
 local ok,row=pcall(cjson.decode,raw)
 if not ok or type(row)~='table' or row.id~=id or row.originKind~='single_digital_renewal' or row.statsId~=ARGV[1] or row.accountId~=ARGV[2] then return {'unknown'} end
 if type(row.next)~='number' or row.next<0 or row.next%1~=0 then return {'unknown'} end
 if row.state=='dispatching' then uncertain=uncertain+1
 elseif row.state=='refused' or row.state=='queued' and row.next==0 then held=held+1
 elseif row.state~='queued' and row.state~='preparing' then return {'unknown'} end
end
return {'ok',#ids,uncertain,held}
`;
export type RenewalMailSummary = { pending: number; unconfirmed: number; held: number } | { unavailable: true };
export async function renewalMailSummary(store: Pick<Store,"statsId"|"stripeAccountId">, runtime: ShipmentMailRuntime = {}): Promise<RenewalMailSummary | null> {
  if ((runtime.lifecycle ?? CURRENT_SHIPMENT_MAIL_LIFECYCLE) === "never_activated") return null;
  // No unpriced read from a missing policy, including after retirement.
  if (!shipmentMailPolicy(runtime.policy === undefined ? CURRENT_SHIPMENT_MAIL_POLICY : runtime.policy, (runtime.now ?? Date.now)(), false) ||
      !store.statsId || !/^[A-Za-z0-9_-]{1,128}$/.test(store.statsId) || !store.stripeAccountId || !/^acct_[A-Za-z0-9]+$/.test(store.stripeAccountId)) return { unavailable:true };
  try {
    const reply: unknown = await (runtime.pipeline ?? redisPipeline)([["EVAL",RENEWAL_NOTICE_SCRIPT,1,`nl:order-confirmation:renewal:store:${store.statsId}`,store.statsId,store.stripeAccountId,SHIPMENT_MAIL_MAX_ROW_BYTES]]);
    if (!Array.isArray(reply) || reply.length !== 1 || !Array.isArray(reply[0])) return { unavailable:true };
    const row = reply[0];
    if (row.length !== 4 || row[0] !== "ok" || !row.slice(1).every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= RENEWAL_NOTICE_ROWS) || row[2]+row[3] > row[1]) return { unavailable:true };
    return { pending:row[1],unconfirmed:row[2],held:row[3] };
  } catch { return { unavailable:true }; }
}
