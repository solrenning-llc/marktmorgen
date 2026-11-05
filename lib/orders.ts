/**
 * How many orders a store handed over this month.
 *
 * lib/order-rules.ts says what an order is and why it is counted. This file
 * keeps the count.
 *
 *   nl:orders:seen:<hash>         an order already counted, by its reference
 *   nl:orders:n:<folder>:<month>  orders counted, that month
 *   nl:orders:folders:<month>     the stores that had any, that month
 *
 * An order is counted where its email goes out, because the email is what
 * it costs and goes out once: a checkout confirmed (lib/purchase-email.ts),
 * an offer taken after paying (the same file), a place taken in a purchase
 * for several people (lib/group-buy.ts), a free copy (lib/free.ts). Each is
 * marked by its own reference before it is added, so a confirmation sent
 * again, or noticed by two paths at once, counts once.
 *
 * What this errs toward. A count that cannot be written is not made, and an
 * order that paid a share of its sale is not counted at all. Both are in the
 * creator's favor, which is the way round a figure that is billed from has
 * to err.
 */
import { createHash } from "node:crypto";
import { rememberFolderOwner } from "@/lib/delivery";
import { allowanceWindow, calendarWindow } from "@/lib/allowance-window";
import { shareBps } from "@/lib/platform-share";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Store, storeFolder, storeRef } from "@/lib/store";
import { canSeal, seal, unseal } from "@/lib/secret-box";
import { type Admission, orderConfirmationAdmission, orderConfirmationHoldKeys } from "@/lib/order-admission";

const seenKey = (reference: string) => `nl:orders:seen:${createHash("sha256").update(reference).digest("hex").slice(0, 32)}`;
const countKey = (folder: string, month: string) => `nl:orders:n:${folder}:${month}`;
const foldersKey = (month: string) => `nl:orders:folders:${month}`;

/** An order's mark lasts longer than the month it is counted in, and the days that month is still settled. */
const SEEN_SECONDS = 45 * 24 * 60 * 60;
/** A month's figures are kept long enough to be billed, asked about and answered for. */
const KEEP_SECONDS = 400 * 24 * 60 * 60;

const FOLDER_PATTERN = /^[0-9a-f]{32}$/;

type Command = (string | number)[];
export type OrderConfirmationRuntime = { now?: () => number; pipeline?: (commands: Command[]) => Promise<unknown[]> };
type ConfirmationSnapshot = {
  version: 1; reference: string; folder: string; owner: string; window: string;
  month: string; hour: number | null; bytes: number; share: number; captured: number; until: number;
};
const CHECKOUT_REFERENCE = /^checkout:cs_(?:test|live)_[A-Za-z0-9]{10,200}$/;
const snapshotContext = (reference: string) => `order-confirmation-settlement|${reference}`;
const SHA256 = /^[a-f0-9]{64}$/;
const STRIPE_ACCOUNT = /^acct_[A-Za-z0-9]{6,128}$/;
export type OrderConfirmationPreintentIdentity = { nonce: string; accountId: string; bodyDigest: string };
export type OrderConfirmationSessionIdentity = OrderConfirmationPreintentIdentity & { sessionId: string };
export type OrderConfirmationPreintent = { token: string; expiresAtMs: number; intentFingerprint: string };
export type OrderConfirmationSettlementCandidate = {
  sessionId: string; settlementToken: string; intentFingerprint: string; bindingFingerprint: string; expiresAtMs: number;
};
const preintentContext = (nonce: string) => `order-confirmation-preintent|${nonce}`;
const preintentReference = (identity: OrderConfirmationPreintentIdentity) => `preintent:${identity.accountId}:${identity.nonce}:${identity.bodyDigest}`;
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

function preintentIdentity(value: unknown, session: boolean): OrderConfirmationSessionIdentity | OrderConfirmationPreintentIdentity | null {
  try {
    if (!value || typeof value!=="object" || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return null;
    const names=session?["nonce","accountId","bodyDigest","sessionId"]:["nonce","accountId","bodyDigest"];
    const keys=Reflect.ownKeys(value);
    if(keys.length!==names.length || keys.some(key=>typeof key!=="string" || !names.includes(key))) return null;
    const out:Record<string,string>=Object.create(null);
    for(const name of names) {
      const field=Object.getOwnPropertyDescriptor(value,name);
      if(!field || !field.enumerable || !("value" in field) || typeof field.value!=="string") return null;
      out[name]=field.value;
    }
    if(!SHA256.test(out.nonce) || !SHA256.test(out.bodyDigest) || !STRIPE_ACCOUNT.test(out.accountId) ||
      (session && !CHECKOUT_REFERENCE.test(`checkout:${out.sessionId}`))) return null;
    return out as OrderConfirmationPreintentIdentity;
  } catch {return null;}
}

function confirmationOwner(store: Store): string | null {
  try {
    const source: Record<string,unknown>=Object.create(null);
    for (const key of ["email","sid","extra"]) {
      const d=Object.getOwnPropertyDescriptor(store,key);
      if(d && !("value" in d)) return null;
      if(d) source[key]=d.value;
    }
    if(typeof source.email!=="string" || !source.email || source.email.length>320 || typeof source.sid!=="string" ||
        (source.extra!==undefined && typeof source.extra!=="boolean")) return null;
    return storeRef(source as unknown as Store).toLowerCase();
  } catch {return null;}
}

function originalStore(store: Store): Store | null {
  try {
    if (!store || ![Object.prototype,null].includes(Object.getPrototypeOf(store))) return null;
    const out: Record<string,unknown> = Object.create(null);
    for (const key of ["email","sid","extra","shared","subscriptionActive","subscriptionId","trialEnds","tier","planEndedAt","cycle","period"]) {
      const d = Object.getOwnPropertyDescriptor(store,key);
      if (d && !("value" in d)) return null;
      if (d) out[key]=d.value;
    }
    if (typeof out.email!=="string" || !out.email || typeof out.sid!=="string" ||
        (out.extra!==undefined && typeof out.extra!=="boolean") || typeof out.shared!=="boolean" ||
        typeof out.subscriptionActive!=="boolean" || (out.subscriptionId!==null && typeof out.subscriptionId!=="string") ||
        !Number.isSafeInteger(out.trialEnds) || Number(out.trialEnds)<0 || typeof out.tier!=="string" || !["creator","pro","scale"].includes(out.tier) ||
        typeof out.planEndedAt!=="string" || (out.cycle!==undefined && (typeof out.cycle!=="string" || !["month","year"].includes(out.cycle)))) return null;
    if (out.period!==undefined && out.period!==null) {
      const value=out.period;
      if (!value || typeof value!=="object" || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return null;
      const period: Record<string,unknown>=Object.create(null);
      for (const key of ["start","end","renews","funded"]) {
        const d=Object.getOwnPropertyDescriptor(value,key);
        if (d && !("value" in d)) return null;
        if (d) period[key]=d.value;
      }
      out.period=period;
    }
    return out as unknown as Store;
  } catch { return null; }
}

async function captureConfirmationSnapshot(store: Store, reference: string, admission: Admission, now: number, accountId?:string): Promise<ConfirmationSnapshot | null> {
  try {
    const source = originalStore(store);
    if (!source) return null;
    const original = orderConfirmationAdmission(source, admission, reference,accountId);
    if (!original || (accountId!==undefined && original.accountId!==accountId) || !Number.isSafeInteger(now) || now < original.captured) return null;
    const owner = storeRef(source).toLowerCase();
    const folder = await storeFolder(owner);
    if (!FOLDER_PATTERN.test(folder) || (original.folder!==null && original.folder!==folder)) return null;
    const snapshot: ConfirmationSnapshot = { version: 1, reference, folder, owner, window: original.window, month: calendarWindow(original.captured).id,
      hour: original.hour, bytes: original.bytes, share:original.share, captured: original.captured, until: original.windowEnd + KEEP_SECONDS * 1000 };
    return now < snapshot.until ? snapshot : null;
  } catch { return null; }
}

/** Same-process compatibility only; it cannot recover a lost create-session
 * response. New checkout integrations must prepare a preintent BEFORE POST.
 */
export async function prepareOrderConfirmationSettlement(store: Store, reference: string, admission: Admission, runtime: Pick<OrderConfirmationRuntime, "now"> = {}): Promise<string | null> {
  try {
    if (typeof reference!=="string" || !CHECKOUT_REFERENCE.test(reference) || !canSeal()) return null;
    const snapshot=await captureConfirmationSnapshot(store,reference,admission,(runtime.now??Date.now)());
    return snapshot ? seal(JSON.stringify(snapshot),snapshotContext(reference)) : null;
  } catch {return null;}
}

/** BEFORE create-session POST: seal this actual admission, stable nonce,
 * connected account and exact canonical original body digest. Persist this
 * token with the protected, funded source BEFORE POST. The digest excludes
 * only metadata[mm_order_hash], its own self-reference. Neither an unknown
 * create ACK nor a new process may recreate admission/window/share from today.
 * This hook writes no key and grants no Stripe attempt or URL by itself.
 */
export async function prepareOrderConfirmationPreintent(store: Store, admission: Admission, supplied: OrderConfirmationPreintentIdentity, runtime: Pick<OrderConfirmationRuntime,"now"> = {}): Promise<OrderConfirmationPreintent|null> {
  try {
    const identity=preintentIdentity(supplied,false);
    if(!identity || !canSeal()) return null;
    const account=Object.getOwnPropertyDescriptor(store,"stripeAccountId");
    if(!account || !("value" in account) || account.value!==identity.accountId) return null;
    const original=await captureConfirmationSnapshot(store,preintentReference(identity),admission,(runtime.now??Date.now)(),identity.accountId);
    if(!original) return null;
    const token=seal(JSON.stringify({version:1,...identity,original}),preintentContext(identity.nonce));
    return {token,expiresAtMs:original.until,intentFingerprint:fingerprint(token)};
  } catch {return null;}
}

/** Recover using ONLY the persisted original token and an independently
 * verified Stripe session, read from its original connected account. nonce and
 * bodyDigest must come from that session's mm_order_intent/mm_order_hash, not
 * a caller echo. The account-specific lookup and exact body/rights comparison
 * belong to the source integration, which must never repeat POST after the
 * provider's idempotency window merely because no session was found yet.
 *
 * This is a CANDIDATE, not an immutable binding or an accounting authority.
 * The protected source MUST atomically compare its original intent fingerprint,
 * body/account/nonce and bind sessionId+bindingFingerprint+settlementToken once.
 * Before URL or settlement, use the persisted winner returned by that CAS,
 * never this losing candidate. Different sessions yield different candidates;
 * only the source CAS can decide their immutable ownership. No parallel key or
 * storage funding is invented here. Original time/window/share stay untouched.
 */
export async function bindOrderConfirmationPreintent(store: Store, intentToken: string, supplied: OrderConfirmationSessionIdentity, runtime: Pick<OrderConfirmationRuntime,"now"> = {}): Promise<OrderConfirmationSettlementCandidate|null> {
  try {
    const identity=preintentIdentity(supplied,true) as OrderConfirmationSessionIdentity|null;
    const now=(runtime.now??Date.now)();
    if(!identity || typeof intentToken!=="string" || intentToken.length>4_000 || !Number.isSafeInteger(now)) return null;
    const opened=unseal(intentToken,preintentContext(identity.nonce));
    if(!opened.ok || opened.value.length>2_500) return null;
    const original=JSON.parse(opened.value);
    if(!original || typeof original!=="object" || Array.isArray(original) || Object.keys(original).length!==5 ||
      !["version","nonce","accountId","bodyDigest","original"].every(key=>Object.hasOwn(original,key)) || original.version!==1 ||
      original.nonce!==identity.nonce || original.accountId!==identity.accountId || original.bodyDigest!==identity.bodyDigest) return null;
    const snapshot=confirmationSnapshot(JSON.stringify(original.original),preintentReference(identity));
    if(!snapshot || now<snapshot.captured || now>=snapshot.until || snapshot.owner!==confirmationOwner(store) ||
      snapshot.folder!==await storeFolder(snapshot.owner)) return null;
    const reference=`checkout:${identity.sessionId}`;
    const bound={...snapshot,reference};
    return {sessionId:identity.sessionId,settlementToken:seal(JSON.stringify(bound),snapshotContext(reference)),
      intentFingerprint:fingerprint(intentToken),bindingFingerprint:fingerprint(`${opened.value}\n${reference}`),expiresAtMs:snapshot.until};
  } catch {return null;}
}

/** One transaction owns BOTH the reference mark and its effects. A lost ACK
 * can be read back by repeating the identical snapshot, without releasing a
 * second checkout from the same aggregate hour. Existing legacy marks are
 * ambiguous and refuse migration. Validate all types/numbers before writing:
 * Redis Lua does not roll back writes after a runtime error. A durable intent
 * precedes effects; a partial failure stays unknown and never reapplies them.
 * KEYS: seen, count, open hours, held bytes, calendar folders, folder owner.
 * ARGV: receipt, original hour (or empty), bytes, count (0/1), folder, owner,
 * absolute receipt expiry ms, current time ms, counter retention seconds.
 */
export const COMMIT_ORDER_CONFIRMATION = `-- marktmorgen:order-confirmation-settlement:v1
local types = {'string','string','hash','hash','set','string'}
local seen,present = {},{}
for i=1,6 do
 if not KEYS[i] or seen[KEYS[i]] then return -1 end
 seen[KEYS[i]]=true
 local kind=redis.call('TYPE',KEYS[i]).ok
 present[i]=kind
 if kind~='none' and kind~=types[i] then return -1 end
end
local receipt,hour,bytes,n,folder,owner = ARGV[1],ARGV[2],tonumber(ARGV[3]),tonumber(ARGV[4]),ARGV[5],ARGV[6]
local untilAt,now,keep = tonumber(ARGV[7]),tonumber(ARGV[8]),tonumber(ARGV[9])
if not receipt or #receipt~=68 or string.sub(receipt,1,4)~='oc1:' or not bytes or bytes<1 or bytes%1~=0 or bytes>1000000000 or
 (n~=0 and n~=1) or not folder or #folder~=32 or not owner or #owner<1 or #owner>320 or
 not untilAt or not now or untilAt<=now or not keep or keep~=34560000 then return -1 end
-- PXAT uses Redis's clock, not the worker's. A lagging worker must never
-- create an already-expired intent/receipt and then apply the effects again.
local serverTime=redis.call('TIME')
local serverNow=tonumber(serverTime[1])*1000+math.floor(tonumber(serverTime[2])/1000)
if untilAt<=serverNow then return -1 end
local prior=redis.call('GETRANGE',KEYS[1],0,68)
if prior~='' then if prior==receipt then return 2 else return -1 end end
if present[1]~='none' then return -1 end
local function number(raw)
 if not raw then return 0 end
 if not string.match(raw,'^%d+$') or #raw>13 then return nil end
 local v=tonumber(raw)
 if not v or v<0 or v>1000000000000 or v%1~=0 or tostring(v)~=raw then return nil end
 return v
end
local count=number(redis.call('GETRANGE',KEYS[2],0,16))
-- Missing GETRANGE is the empty string, unlike HGET's false.
if redis.call('EXISTS',KEYS[2])==0 then count=0 end
if not count or count+n>1000000000000 then return -1 end
local priorOwner=redis.call('GETRANGE',KEYS[6],0,320)
if present[6]~='none' and priorOwner~=owner then return -1 end
local held,kept=0,0
if hour~='' then
 if not string.match(hour,'^%d+$') or #hour>9 then return -1 end
 held=number(redis.call('HGET',KEYS[3],hour)); kept=number(redis.call('HGET',KEYS[4],hour))
 if not held or not kept or (held==0 and kept~=0) or (held>0 and kept<bytes) then return -1 end
end
-- Every possible refusal above happens before the first mutation.
-- A runtime failure after this intent cannot authorize another application.
redis.call('SET',KEYS[1],'oci:'..string.sub(receipt,5),'PXAT',untilAt)
if n==1 then
 redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],keep)
 if count==0 or (count+1)%100==0 then
  redis.call('SADD',KEYS[5],folder); redis.call('EXPIRE',KEYS[5],keep); redis.call('SET',KEYS[6],owner)
 end
end
if hour~='' and held>0 then
 if held==1 then redis.call('HDEL',KEYS[3],hour) else redis.call('HINCRBY',KEYS[3],hour,-1) end
 if kept==bytes then redis.call('HDEL',KEYS[4],hour) else redis.call('HINCRBY',KEYS[4],hour,-bytes) end
end
redis.call('SET',KEYS[1],receipt,'PXAT',untilAt)
return 1`;

function confirmationSnapshot(raw: string, reference: string): ConfirmationSnapshot | null {
  try {
    if (raw.length > 2_000) return null;
    const s = JSON.parse(raw) as ConfirmationSnapshot;
    const fields = ["version", "reference", "folder", "owner", "window", "month", "hour", "bytes", "share", "captured", "until"];
    if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).length !== fields.length || !fields.every(key => Object.hasOwn(s,key)) ||
        s.version !== 1 || s.reference !== reference || typeof s.folder !== "string" || !FOLDER_PATTERN.test(s.folder) ||
        typeof s.owner !== "string" || !s.owner || s.owner.length > 320 || typeof s.window !== "string" || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(s.window) ||
        typeof s.month !== "string" || !/^\d{4}-\d{2}$/.test(s.month) ||
        ![s.bytes,s.share,s.captured,s.until].every(Number.isSafeInteger) || s.bytes < 1 || s.bytes > 1_000_000_000 || s.share < 0 || s.share > 10_000 ||
        s.captured <= 0 || s.until <= s.captured || s.until-s.captured > (KEEP_SECONDS+367*86_400)*1000 ||
        (s.hour !== null && (!Number.isSafeInteger(s.hour) || s.hour !== Math.floor(s.captured/3_600_000)))) return null;
    return s;
  } catch { return null; }
}

/** Invoke only for a source with verified settled Stripe payment (or a valid
 * completed zero-value checkout). Accounting must not depend on SES acceptance
 * or delivery. Does no sending and has no live caller in this unit. Replays keep the sealed
 * source's original billing window, calendar index, share and admission hour.
 * At the fixed retention horizon refuse forever, even after the mark expires;
 * extending durable work beyond it needs separately funded retention, not a
 * fresh timestamp or a reconstructed snapshot. No legacy mark is a checkpoint.
 */
export async function commitOrderConfirmationSettlement(store: Store, reference: string, token: string, paidCents: number, runtime: OrderConfirmationRuntime = {}): Promise<"committed" | "already" | "unknown"> {
  try {
    const now = (runtime.now ?? Date.now)();
    if (!isRedisConfigured() || typeof reference!=="string" || !CHECKOUT_REFERENCE.test(reference) || typeof token !== "string" || token.length > 4_000 ||
        !Number.isSafeInteger(paidCents) || paidCents < 0 || !Number.isSafeInteger(now)) return "unknown";
    const opened = unseal(token, snapshotContext(reference));
    const s = opened.ok ? confirmationSnapshot(opened.value, reference) : null;
    if (!s || now < s.captured || now >= s.until || s.owner !== confirmationOwner(store) || s.folder !== await storeFolder(s.owner)) return "unknown";
    const count = paidCents > 0 && s.share > 0 ? 0 : 1;
    const receipt = `oc1:${createHash("sha256").update(`${opened.ok ? opened.value : ""}\n${paidCents}`).digest("hex")}`;
    const [open, held] = orderConfirmationHoldKeys(s.folder);
    const reply: unknown = await (runtime.pipeline ?? redisPipeline)([["EVAL", COMMIT_ORDER_CONFIRMATION, 6, seenKey(reference), countKey(s.folder,s.window), open, held,
      foldersKey(s.month), `nl:store:folder-owner:${s.folder}`, receipt, s.hour === null ? "" : String(s.hour), s.bytes, count, s.folder, s.owner, s.until, now, KEEP_SECONDS]]);
    if (!Array.isArray(reply)) return "unknown";
    const length = Object.getOwnPropertyDescriptor(reply,"length"), value = Object.getOwnPropertyDescriptor(reply,"0");
    if (!length || !("value" in length) || length.value !== 1 || !value || !("value" in value)) return "unknown";
    return value.value === 1 ? "committed" : value.value === 2 ? "already" : "unknown";
  } catch { return "unknown"; }
}

/**
 * Whether an order is covered by the share its sale paid, and so is not
 * counted: something was paid, and the store's sales pay a share right now.
 */
export function coveredByShare(store: Parameters<typeof shareBps>[0], paidCents: number, nowSeconds = Date.now() / 1000, live?: boolean): boolean {
  return Number.isFinite(paidCents) && paidCents > 0 && shareBps(store, nowSeconds, live) > 0;
}

/**
 * One order handed over. `reference` names it (a checkout, a payment, a
 * place, a free copy) and `paidCents` is what was paid for it, zero for
 * nothing. Answers whether it was counted.
 *
 * Never throws: a count that cannot be written must not cost a buyer their
 * email.
 */
export async function countOrder(store: Store, reference: string, paidCents: number, now = Date.now()): Promise<boolean> {
  if (!isRedisConfigured() || !reference) return false;
  try {
    const [fresh] = await redisPipeline([["SET", seenKey(reference), "1", "NX", "EX", SEEN_SECONDS]]);
    if (fresh === null) return false;
    // What the order leaves in the database is counted in the store's data
    // room by the writes that leave it, at what each really adds
    // (lib/order-data.ts), never refused: its room was held when its checkout
    // was admitted (lib/order-admission.ts), at the most an order can take.
    if (coveredByShare(store, paidCents, now / 1000)) return false;
    const owner = storeRef(store);
    const folder = await storeFolder(owner);
    // Counted in the store's window (lib/allowance-window.ts). An order paid
    // for when no window is known (its checkout was opened before) still
    // counts, in the calendar month, rather than nowhere.
    const window = (allowanceWindow(store, now) ?? calendarWindow(now)).id;
    const month = calendarWindow(now).id;
    const [count] = await redisPipeline([
      ["INCR", countKey(folder, window)],
      ["EXPIRE", countKey(folder, window), KEEP_SECONDS],
    ]);
    // Written with the month's first order, and again at every hundredth, so
    // one write lost to a bad moment mends itself long before a bill could be
    // made from the count: no plan covers fewer than a hundred orders.
    const n = Number(count);
    if (n === 1 || n % 100 === 0) {
      await redisPipeline([
        ["SADD", foldersKey(month), folder],
        ["EXPIRE", foldersKey(month), KEEP_SECONDS],
      ]);
      // Whose folder this is, for the daily job that bills and writes (lib/usage-billing.ts, storeOf).
      await rememberFolderOwner(folder, owner);
    }
    return true;
  } catch (error) {
    console.error("could not count an order", error);
    return false;
  }
}

/** The orders a store had in a window: a calendar month ("2026-10"), this one by default, or a billing month ("2026-10-19"). Zero when it cannot be read. */
export async function ordersIn(folder: string, month = calendarWindow().id): Promise<number> {
  if (!isRedisConfigured() || !folder) return 0;
  try {
    const [raw] = await redisPipeline([["GET", countKey(folder, month)]]);
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch (error) {
    console.error("could not read a store's orders", error);
    return 0;
  }
}

/** The orders a store has had in its window (its billing month when it pays), by the store. */
export async function storeOrdersThisMonth(store: Store, now = Date.now()): Promise<number> {
  return ordersIn(await storeFolder(storeRef(store)), (allowanceWindow(store, now) ?? calendarWindow(now)).id);
}

/** The stores that had any order counted in a month. */
export async function orderedFolders(month = calendarWindow().id): Promise<string[]> {
  if (!isRedisConfigured()) return [];
  const [raw] = await redisPipeline([["SMEMBERS", foldersKey(month)]]);
  return Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string" && FOLDER_PATTERN.test(f)).sort() : [];
}
