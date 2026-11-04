/**
 * A pass over each store's recent checkouts, for what the thanks page cannot
 * be trusted to do alone.
 *
 * The thanks page confirms a purchase the moment the buyer lands on it. A
 * buyer who closes the tab while Stripe is sending them there never lands,
 * and a checkout that closes unpaid has no page at all. So the five-minute
 * job walks the stores a slice at a time and, for each one that sells, asks
 * the creator's own Stripe account for the checkouts of the last day — one
 * request per hundred — and hands each on:
 *
 *   - a settled one that has not been confirmed gets its confirmation
 *     (lib/purchase-email.ts);
 *   - a closed, unpaid one on a store with reminders on is offered to
 *     lib/checkout-recovery.ts, which sends only if the buyer agreed;
 *   - a settled one that came through an affiliate's link is written down
 *     for that affiliate (lib/affiliates.ts), once;
 *   - a settled one not yet told to the creator's phone or email platform
 *     is told now (lib/sale-events.ts), once, on a store that connected
 *     either;
 *   - a settled one not yet put on the creator's list is put there, with
 *     what it bought, and its sequences started (lib/buyer-list.ts), once;
 *   - a settled one whose buyer allowed ad measurement is sent to the
 *     creator's ad platforms (lib/ad-events.ts), once, and so is each
 *     renewal of a membership bought that way.
 *
 * A store that hands out license keys also has its refunds read, and the
 * key of every sale refunded in full is revoked (lib/licence-keys.ts), so
 * the creator's software hears about a refund within minutes, without the
 * creator having to go and revoke it by hand. A store whose buyers have
 * written reviews has its refunds read in the same way, and each review a
 * payment refunded in full paid for is marked "refunded", which takes its
 * stars out of the average (lib/reviews.ts).
 *
 * Bounded three ways, so it can never run away with the job: a time budget
 * the caller sets, at most three pages of a hundred checkouts per store, and
 * a place in the list of stores kept in Redis, so each run carries on where
 * the last one stopped and every store is reached in turn. Both emails are
 * guarded by their own marks, so a store seen twice is only work, never a
 * second email.
 */
import { noteFirstSale } from "@/lib/yearly-offer";
import { noteTestSales } from "@/lib/headline-test";
import { revokeRefundedGifts } from "@/lib/gifts";
import { revokeRefundedPreorders } from "@/lib/preorders";
import { revokeRefundedGroups } from "@/lib/group-buy";
import { sweepPayPal } from "@/lib/paypal-delivery";
import { dropEnrollment } from "@/lib/learn";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount, platformKey } from "@/lib/stripe-account";
import { isSettled } from "@/lib/instant-pay";
import { CONFIRM_WITHIN_SECONDS, type SessionRecord, canConfirm, confirmPurchase, confirmationKey } from "@/lib/purchase-email";
import { REMIND_WITHIN_SECONDS, remindAbandoned } from "@/lib/checkout-recovery";
import { enroll, readFlows } from "@/lib/flows";
import { recoveryOn } from "@/lib/recovery-setting";
import { type Store, ensureStoreId, saleHandles, storeRef, storesAfter } from "@/lib/store";
import { listingsNamed, sellsThings } from "@/lib/catalog";
import { affiliatesOn, listPartners, noteSession } from "@/lib/affiliates";
import { affiliateForCodes, codeOwners } from "@/lib/affiliate-codes";
import { revokeRefunded, storeHasKeys } from "@/lib/licence-keys";
import { markRefundedReviews, storeHasReviews } from "@/lib/review-proof";
import { listensToSales, noteSales } from "@/lib/sale-events";
import { listOrder, listedAlready } from "@/lib/buyer-list";
import { rememberBuyers } from "@/lib/buyer-library";
import { isHouseStore } from "@/lib/house-store";
import { deliveredIds } from "@/lib/bundle-rules";
import { sendPaidOrders, sendRenewals, sendsFromServer } from "@/lib/ad-events";
import { settleStoreList, storesWithRequests } from "@/lib/payment-request-store";
import { createHash } from "node:crypto";
import { TAKE_DATA, dataKey, monthOf, type DataStore } from "@/lib/store-data";
import { contentRoomFor } from "@/lib/store-data-rules";

const CURSOR_KEY = "nl:sweep:cursor";

/** A diagnostic observation policy, never legal coverage or a sales gate.
 * This stage has no production policy, environment setting or request input.
 * A future policy needs reviewed scope, absolute retention and the cost of
 * storage for its ENTIRE lifetime, in addition to bounded per-pass work.
 */
export type TaxObservationPolicy = {
  schema: 1; purpose: "incomplete-checkout-observations";
  reviewId: string; storeSid: string; stripeAccountId: string;
  scopeEvidence: string; retentionEvidence: string; storageEvidence: string; costEvidence: string;
  reviewedAtMs: number; expiresAtMs: number;
  maxEntries: number; maxRecordBytes: number; maxDocumentBytes: number; maxRetainedBytes: number;
  storageMicroUsdPerGiBMonth: number; retentionCostCeilingMicroUsd: number;
  commandMicroUsdPerMillion: number; transferMicroUsdPerGiB: number;
  maxChargedCommandsPerPass: number; maxTransferredBytesPerPass: number;
  computeCeilingMicroUsdPerPass: number; ioCostCeilingMicroUsdPerPass: number;
};
export const CURRENT_TAX_OBSERVATION_POLICY: TaxObservationPolicy | null = null;
/** Absolute diagnostic lifetime, not statutory retention or a customer entitlement. */
export const TAX_OBSERVATION_KEEP_SECONDS = 86_400;
/** Processing/diagnostic bounds, not statutory retention or customer rights. */
export const TAX_OBSERVATION_LIMITS = Object.freeze({
  maxEntries: 300, maxRecordBytes: 512, maxDocumentBytes: 512 * 1024,
  maxLifetimeMs: TAX_OBSERVATION_KEEP_SECONDS * 1000, maxBudgetMonths: 32,
  chargedCommandsPerPass: 720, transferredBytesPerPass: 1024 * 1024,
});
export type TaxObservationResult = {
  legalCoverage: "incomplete";
  state: "not-recorded" | "recorded" | "unknown";
  reason: "policy" | "scope" | "source" | "budget" | "storage" | "confirmed" | "duplicate";
  entries: number | null;
};
const taxResult = (state: TaxObservationResult["state"], reason: TaxObservationResult["reason"], entries: number | null = null): TaxObservationResult =>
  ({ legalCoverage: "incomplete", state, reason, entries });
const taxOwn = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key);
  return field && Object.hasOwn(field, "value") ? field.value : undefined;
};
const taxInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const taxText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 1000;
const taxHash = (value: string) => createHash("sha256").update(value).digest("hex");
function taxDataRecord(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length <= 160 && keys.every(key => typeof key === "string"
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));
}

function taxPolicy(value: unknown, now: number): TaxObservationPolicy | null {
  if (!taxDataRecord(value) || !taxInteger(now)) return null;
  const keys = ["schema", "purpose", "reviewId", "storeSid", "stripeAccountId", "scopeEvidence", "retentionEvidence", "storageEvidence", "costEvidence", "reviewedAtMs", "expiresAtMs", "maxEntries", "maxRecordBytes", "maxDocumentBytes", "maxRetainedBytes", "storageMicroUsdPerGiBMonth", "retentionCostCeilingMicroUsd", "commandMicroUsdPerMillion", "transferMicroUsdPerGiB", "maxChargedCommandsPerPass", "maxTransferredBytesPerPass", "computeCeilingMicroUsdPerPass", "ioCostCeilingMicroUsdPerPass"] as const;
  if (Reflect.ownKeys(value as object).length !== keys.length) return null;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) out[key] = taxOwn(value, key);
  if (out.schema !== 1 || out.purpose !== "incomplete-checkout-observations") return null;
  for (const key of ["reviewId", "storeSid", "stripeAccountId", "scopeEvidence", "retentionEvidence", "storageEvidence", "costEvidence"] as const) if (!taxText(out[key])) return null;
  for (const key of keys.filter(key => !["purpose", "reviewId", "storeSid", "stripeAccountId", "scopeEvidence", "retentionEvidence", "storageEvidence", "costEvidence"].includes(key))) if (!taxInteger(out[key])) return null;
  const p = out as TaxObservationPolicy;
  if (p.reviewedAtMs > now || p.expiresAtMs <= now || p.expiresAtMs > 253_402_300_799_999
    || p.expiresAtMs - p.reviewedAtMs > TAX_OBSERVATION_LIMITS.maxLifetimeMs
    || p.maxEntries < 1 || p.maxEntries > TAX_OBSERVATION_LIMITS.maxEntries
    || p.maxRecordBytes < 1 || p.maxRecordBytes > TAX_OBSERVATION_LIMITS.maxRecordBytes
    || p.maxDocumentBytes < 256 || p.maxDocumentBytes > TAX_OBSERVATION_LIMITS.maxDocumentBytes
    || p.maxRetainedBytes < Math.ceil((p.maxDocumentBytes + 512) * 5 / 4)
    || p.maxRetainedBytes > 1024 * 1024
    || p.storageMicroUsdPerGiBMonth < 1 || p.commandMicroUsdPerMillion < 1 || p.transferMicroUsdPerGiB < 1
    || p.computeCeilingMicroUsdPerPass < 1
    || p.maxChargedCommandsPerPass < TAX_OBSERVATION_LIMITS.chargedCommandsPerPass
    || p.maxTransferredBytesPerPass < TAX_OBSERVATION_LIMITS.transferredBytesPerPass) return null;
  const ceiling = (n: bigint, d: bigint) => (n + d - BigInt(1)) / d;
  // 28 days is the shortest calendar month: this errs upward, not toward a
  // free quota. The quote and complete paid-cost review remain external facts.
  const retained = ceiling(BigInt(p.maxRetainedBytes) * BigInt(p.storageMicroUsdPerGiBMonth) * BigInt(p.expiresAtMs - p.reviewedAtMs), BigInt(1024 ** 3) * BigInt(28 * 86_400_000));
  const work = ceiling(BigInt(p.maxChargedCommandsPerPass) * BigInt(p.commandMicroUsdPerMillion), BigInt(1_000_000))
    + ceiling(BigInt(p.maxTransferredBytesPerPass) * BigInt(p.transferMicroUsdPerGiB), BigInt(1024 ** 3))
    + BigInt(p.computeCeilingMicroUsdPerPass);
  return BigInt(p.retentionCostCeilingMicroUsd) >= retained && BigInt(p.ioCostCeilingMicroUsdPerPass) >= work ? p : null;
}

/** One SET with PXAT persists data, index and byte count together. A script
 * error before it cannot leave a new journal without an expiry. The existing
 * data-room reservation is reused BEFORE that SET, inside the same execution;
 * uncertain acknowledgement retains the whole reservation, never releases it.
 * The month list is validated and bounded before TAKE_DATA can enumerate it.
 */
export const WRITE_TAX_OBSERVATIONS = `-- marktmorgen:tax-observations:v1
local journal, room = KEYS[1], KEYS[2]
local expiry, maxRows, maxBytes = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3])
local reserve, limit, month, untilMonth, scope = tonumber(ARGV[4]), tonumber(ARGV[5]), ARGV[6], ARGV[7], ARGV[8]
local n = tonumber(ARGV[9])
local function integer(v) return v and v >= 0 and v % 1 == 0 and v <= 9007199254740991 end
if not integer(tonumber(expiry)) or not integer(maxRows) or maxRows < 1 or maxRows > 300
  or not integer(maxBytes) or maxBytes > 524288 or not integer(reserve) or not integer(limit)
  or not integer(n) or n < 1 or n > 100 or #ARGV ~= 9 + n * 2 then return {-1} end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if tonumber(expiry) <= now or tonumber(expiry) > now + 86400000 then return {-1} end
local kind = redis.call('TYPE', journal)['ok']
if kind ~= 'none' and kind ~= 'string' then return {-1} end
local raw = redis.call('GET', journal)
local doc = {schema=1, scope=scope, expiresAt=expiry, rows={}, order={}, bytes=0}
if raw then
  if #raw > maxBytes or redis.call('PEXPIRETIME', journal) ~= tonumber(expiry) then return {-1} end
  local good, old = pcall(cjson.decode, raw)
  if not good or type(old) ~= 'table' or old.schema ~= 1 or old.scope ~= scope or old.expiresAt ~= expiry
    or type(old.rows) ~= 'table' or type(old.order) ~= 'table' or old.bytes ~= #raw then return {-1} end
  doc = old
end
local fields = 0
for _ in pairs(doc) do fields = fields + 1 end
if fields ~= 6 then return {-1} end
local ids, count = {}, 0
for _, id in ipairs(doc.order) do
  if type(id) ~= 'string' or #id ~= 64 or ids[id] or type(doc.rows[id]) ~= 'string' then return {-1} end
  ids[id], count = true, count + 1
  if count > maxRows then return {-1} end
end
local orderFields = 0
for key in pairs(doc.order) do
  if not integer(key) or key < 1 or key > count then return {-1} end
  orderFields = orderFields + 1
end
if orderFields ~= count then return {-1} end
local actual = 0
for id, value in pairs(doc.rows) do
  if not ids[id] or type(value) ~= 'string' or #value > 512 then return {-1} end
  actual = actual + 1
end
if actual ~= count or count > maxRows then return {-1} end
local changed = false
for i = 1, n do
  local id, value = ARGV[8 + i * 2], ARGV[9 + i * 2]
  if #id ~= 64 or not string.match(id, '^[a-f0-9]+$') or #value > 512 then return {-1} end
  local old = doc.rows[id]
  if old and old ~= value then return {-1} end
  if not old then
    doc.rows[id] = value
    table.insert(doc.order, id)
    count, changed = count + 1, true
  end
end
if count > maxRows then return {0} end
if not changed then return {2, count, #raw, expiry} end
local encoded
for i = 1, 4 do
  encoded = cjson.encode(doc)
  if doc.bytes == #encoded then break end
  doc.bytes = #encoded
end
encoded = cjson.encode(doc)
if doc.bytes ~= #encoded or #encoded > maxBytes then return {0} end
if redis.call('TYPE', room)['ok'] ~= 'hash' then return {-1} end
local total = tonumber(redis.call('HGET', room, '#'))
if not integer(total) or total > limit then return {-1} end
local months = redis.call('HGET', room, '~') or ''
if #months > 256 then return {-1} end
local seen, monthsCount, heldSum = {}, 0, 0
for m in string.gmatch(months, '[^,]+') do
  if #m ~= 7 or not string.match(m, '^%d%d%d%d%-%d%d$') or seen[m] then return {-1} end
  seen[m], monthsCount = true, monthsCount + 1
  local held = tonumber(redis.call('HGET', room, '~' .. m))
  if not integer(held) or held > total or monthsCount > 32 then return {-1} end
  heldSum = heldSum + held + 64
  if heldSum > total then return {-1} end
end
local held = redis.call('HGET', room, '~' .. untilMonth)
if held and (not integer(tonumber(held)) or not seen[untilMonth]) then return {-1} end
local function take()
  local KEYS = {room}
  local ARGV = {tostring(limit), '0', month, 'a', '~' .. untilMonth, tostring(reserve)}
  ${TAKE_DATA}
end
local took = take()
if type(took) ~= 'table' or took[1] ~= 1 then return {0} end
redis.call('SET', journal, encoded, 'PXAT', expiry)
return {1, count, #encoded, expiry}`;

/** Called for the provider page the real sweep already read. This records
 * diagnostic source facts only: creation is not the fiscal supply date,
 * gross is not classified applicable revenue, and coverage never becomes true.
 */
export async function observeCheckoutTaxPage(store: Store, rows: unknown, value: unknown = CURRENT_TAX_OBSERVATION_POLICY, now = Date.now()): Promise<TaxObservationResult> {
  try {
    const policy = taxPolicy(value, now);
    if (!policy) return taxResult("not-recorded", "policy");
    const sid = taxOwn(store, "sid"), account = taxOwn(store, "stripeAccountId");
    if (sid !== policy.storeSid || account !== policy.stripeAccountId) return taxResult("not-recorded", "scope");
    const fields = ["sid", "statsId", "handle", "tier", "subscriptionActive", "subscriptionId", "trialEnds", "planEndedAt"] as const;
    const owner: Record<string, unknown> = Object.create(null);
    for (const key of fields) owner[key] = taxOwn(store, key);
    if (typeof owner.sid !== "string" || typeof owner.statsId !== "string" || typeof owner.handle !== "string"
      || typeof owner.tier !== "string" || !["creator", "pro", "scale"].includes(owner.tier) || typeof owner.subscriptionActive !== "boolean"
      || !(owner.subscriptionId === null || typeof owner.subscriptionId === "string") || !taxInteger(owner.trialEnds)
      || typeof owner.planEndedAt !== "string") return taxResult("not-recorded", "scope");
    const dataOwner = owner as DataStore;
    const room = dataKey(dataOwner);
    const limit = contentRoomFor(dataOwner, now / 1000);
    if (!room || policy.maxRetainedBytes > limit) return taxResult("not-recorded", "budget");
    if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype || rows.length > 100
      || Reflect.ownKeys(rows).length !== rows.length + 1) return taxResult("not-recorded", "source");
    const entries: (string | number)[] = [];
    const ids = new Set<string>();
    for (let index = 0; index < rows.length; index += 1) {
      const row = taxOwn(rows, String(index));
      if (!taxDataRecord(row)) return taxResult("not-recorded", "source");
      const id = taxOwn(row, "id"), status = taxOwn(row, "payment_status"), meta = taxOwn(row, "metadata");
      if (typeof id !== "string" || !/^cs_(?:test|live)_[A-Za-z0-9]{10,200}$/.test(id) || ids.has(id)
        || status !== "paid" || !taxDataRecord(meta) || taxOwn(meta, "store") !== owner.handle) return taxResult("not-recorded", "source");
      ids.add(id);
      const details = taxOwn(row, "customer_details"), address = taxOwn(details, "address");
      if (details != null && !taxDataRecord(details) || address != null && !taxDataRecord(address)) return taxResult("not-recorded", "source");
      const country = taxOwn(address, "country"), state = taxOwn(address, "state");
      const currency = taxOwn(row, "currency"), amount = taxOwn(row, "amount_total"), created = taxOwn(row, "created");
      const observation = JSON.stringify({
        checkoutCreatedAt: taxInteger(created) ? created : null,
        country: typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : null,
        state: typeof state === "string" && /^[A-Z0-9]{1,8}$/.test(state) ? state : null,
        currency: typeof currency === "string" && /^[a-z]{3}$/.test(currency) ? currency.toUpperCase() : null,
        amountTotalMinor: taxInteger(amount) ? amount : null,
        supplyOn: null, applicable: null,
      });
      if (Buffer.byteLength(observation) > policy.maxRecordBytes) return taxResult("not-recorded", "source");
      entries.push(taxHash(`${account}|${id}`), observation);
    }
    if (!entries.length) return taxResult("not-recorded", "source");
    const scope = taxHash(JSON.stringify(policy));
    const key = `nl:taxobs:v1:${scope}:${taxHash(policy.storeSid)}`;
    const reply = await redisPipeline([["EVAL", WRITE_TAX_OBSERVATIONS, 2, key, room,
      String(policy.expiresAtMs), policy.maxEntries, policy.maxDocumentBytes, policy.maxRetainedBytes,
      limit, monthOf(now), monthOf(policy.expiresAtMs), scope, entries.length / 2, ...entries]]);
    const result = taxOwn(reply, "0");
    if (!Array.isArray(reply) || reply.length !== 1 || !Array.isArray(result) || result.length !== 4
      || ![1, 2].includes(taxOwn(result, "0") as number) || !taxInteger(taxOwn(result, "1"))
      || (taxOwn(result, "1") as number) < entries.length / 2 || (taxOwn(result, "1") as number) > policy.maxEntries
      || !taxInteger(taxOwn(result, "2")) || (taxOwn(result, "2") as number) < 1
      || (taxOwn(result, "2") as number) > policy.maxDocumentBytes
      || taxOwn(result, "3") !== String(policy.expiresAtMs)) return taxResult("unknown", "storage");
    return taxResult("recorded", taxOwn(result, "0") === 2 ? "duplicate" : "confirmed", taxOwn(result, "1") as number);
  } catch { return taxResult("unknown", "storage"); }
}
/** At most this many pages of a hundred checkouts are read per store per pass. */
export const MAX_PAGES_PER_STORE = 3;

export type SweepCounts = {
  stores: number;
  confirmed: number;
  reminded: number;
  failed: number;
  revoked: number;
  /** Reviews marked refunded. */
  unrated: number;
  /** Paid orders put on the creator's list here, their buyer never having reached the thanks page. */
  listed: number;
};

/**
 * Whether a store has anything this pass could send about. `requesting`:
 * it has open payment requests (lib/payment-request-store.ts), whose
 * receipts are confirmed here like any sale's, even with nothing listed.
 */
function worthAsking(store: Store, requesting = false): boolean {
  return (
    (canConfirm(store) && (sellsThings(store) || requesting)) ||
    (Boolean(store.stripeAccountId) && affiliatesOn(store)) ||
    storeHasKeys(store) ||
    listensToSales(store) ||
    (Boolean(store.stripeAccountId) && Boolean(store.listId) && sellsThings(store)) ||
    (Boolean(store.stripeAccountId) && sendsFromServer(store))
  );
}

/** One store: its checkouts of the last day, each handed to what it needs. */
async function sweepStore(store: Store, counts: SweepCounts, deadline: number, reviewed: boolean, requesting: boolean, taxPass: { policy: unknown; pagesLeft: number }): Promise<void> {
  // Refunds first: a key that should no longer open anything matters more
  // than a reminder. One failing never stops the checkouts below.
  if (storeHasKeys(store)) {
    try {
      counts.revoked += await revokeRefunded(store, deadline);
    } catch (error) {
      console.error("reading a store's refunds failed", store.handle, error);
    }
  }
  // A gift refunded in full is taken back from whoever it was given to
  // (lib/gifts.ts). Nothing is asked of a store that never sold one.
  try {
    counts.revoked += await revokeRefundedGifts(store, deadline, (email, productId) => dropEnrollment(store, email, productId));
  } catch (error) {
    console.error("reading a store's refunds for gifts failed", store.handle, error);
  }
  // And so is a pre-order, handed over or still waiting (lib/preorders.ts).
  try {
    counts.revoked += await revokeRefundedPreorders(store, deadline, (email, productId) => dropEnrollment(store, email, productId));
  } catch (error) {
    console.error("reading a store's refunds for pre-orders failed", store.handle, error);
  }
  // And so is every place of a purchase for several people (lib/group-buy.ts).
  try {
    counts.revoked += await revokeRefundedGroups(store, deadline, (email, productId) => dropEnrollment(store, email, productId));
  } catch (error) {
    console.error("reading a store's refunds for places failed", store.handle, error);
  }
  // Sold through the creator's PayPal (lib/paypal-sales.ts): a payment PayPal
  // held as pending is handed over once it completes, and a full refund takes
  // the purchase back.
  if (store.paypalSeller) {
    try {
      const paypal = await sweepPayPal(store, deadline);
      counts.confirmed += paypal.cleared;
      counts.revoked += paypal.revoked;
    } catch (error) {
      console.error("asking PayPal about a store's orders failed", store.handle, error);
    }
  }
  if (reviewed) {
    try {
      counts.unrated += await markRefundedReviews(store, deadline);
    } catch (error) {
      console.error("reading a store's refunds for reviews failed", store.handle, error);
    }
  }
  if (!worthAsking(store, requesting)) return;
  // A membership's renewals, sent to the creator's ad platforms as purchases
  // of their own (lib/ad-events.ts): one read of the day's invoices, only on
  // a store that sends from the server.
  if (store.stripeAccountId && sendsFromServer(store)) {
    await sendRenewals(store, Date.now(), deadline).catch((error) => console.error("sending renewals to ad platforms failed", store.handle, error));
  }
  const now = Math.floor(Date.now() / 1000);
  const since = now - CONFIRM_WITHIN_SECONDS;
  const reminding = recoveryOn(store);
  let after = "";
  for (let page = 0; page < MAX_PAGES_PER_STORE && Date.now() < deadline; page += 1) {
    const listed = await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/checkout/sessions?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    );
    const rows = Array.isArray(listed.data) ? (listed.data as SessionRecord[]) : [];

    // Asked in one round trip: which of the paid ones were already confirmed.
    const paid = rows.filter((row) => isSettled(row) && typeof row.id === "string");
    // This is independent of the email's sent mark and cannot hold up an
    // existing buyer's confirmation. Without the reviewed policy it does no IO.
    // SCAN may repeat an owner. The optional diagnostic work has a budget
    // across the ENTIRE sweep, not a fresh three pages for a repeated owner.
    if (taxPass.pagesLeft > 0 && taxOwn(taxPass.policy, "storeSid") === taxOwn(store, "sid")
      && taxOwn(taxPass.policy, "stripeAccountId") === taxOwn(store, "stripeAccountId")) {
      taxPass.pagesLeft -= 1;
      await observeCheckoutTaxPage(store, paid, taxPass.policy);
    }
    // An affiliate's sale is written down whether or not its buyer came back —
    // through a link, and through a discount code given to an affiliate, which
    // is the only trace left by a sale made on a podcast or from a stage. The
    // store's given-away codes are read once, not once an order.
    // A partner's standing share has to be written for every sale, not only
    // the ones somebody referred, so the store's partners are read once here
    // and a sale is passed on when a link, a code or a partner touches it.
    if (affiliatesOn(store)) {
      const [owners, partners] = paid.length
        ? await Promise.all([codeOwners(store), listPartners(store)])
        : [new Map<string, string>(), []];
      for (const row of paid) {
        // A gift through "Support my work" sold nothing, so it earns nobody a share (lib/store-tips.ts),
        // and a payment request is the creator's own bill to someone they already deal with (lib/payment-requests.ts).
        if (row.metadata?.kind === "tip" || row.metadata?.kind === "request") continue;
        const code = owners.size ? affiliateForCodes(row as { discounts?: unknown }, owners) : "";
        if (row.metadata?.via || code || partners.length) {
          await noteSession(store, row as Parameters<typeof noteSession>[1], owners, partners);
        }
      }
    }
    // The store's first sale ever, noted once, with the yearly plan offered
    // at the moment it is most worth keeping (lib/yearly-offer.ts). Not on the
    // demo's account, which canConfirm leaves out.
    if (paid.length && canConfirm(store)) {
      await noteFirstSale(store, paid).catch((error) => console.error("noting a first sale failed", store.handle, error));
    }
    // A sale paid from a page running a test counts for the version its buyer was shown, once (lib/headline-test.ts).
    if (paid.some((row) => row.metadata?.ab)) {
      await noteTestSales(store.statsId, store.currency, paid).catch((error) => console.error("counting a tested page's sales failed", store.handle, error));
    }
    // The creator's ad platforms, sent each sale whose buyer allowed ad
    // measurement, whether or not the buyer came back from Stripe (lib/ad-events.ts).
    if (sendsFromServer(store) && paid.some((row) => row.metadata?.ads)) {
      await sendPaidOrders(store, paid, Date.now(), deadline).catch((error) => console.error("sending sales to ad platforms failed", store.handle, error));
    }
    // The creator's phone and email platform, told of each sale once.
    if (listensToSales(store)) {
      await noteSales(store, paid).catch((error) => console.error("telling about sales failed", store.handle, error));
    }
    const confirming = canConfirm(store);
    const marks = paid.length && confirming
      ? await redisPipeline(paid.map((row) => ["EXISTS", confirmationKey(row.id as string)]))
      : [];
    for (let i = 0; confirming && i < paid.length && Date.now() < deadline; i += 1) {
      if (Number(marks[i]) === 1) continue;
      const outcome = await confirmPurchase(store, paid[i].id as string, paid[i]);
      if (outcome === "sent") counts.confirmed += 1;
      if (outcome === "failed") counts.failed += 1;
    }

    // Every buyer of an ordinary order finds this store in their library,
    // whether or not they reached the thanks page (lib/buyer-library.ts).
    {
      const handles = saleHandles(store);
      const buyers = paid.flatMap((row) => {
        const meta = row.metadata ?? {};
        const email = typeof row.customer_details?.email === "string" ? row.customer_details.email : "";
        return email && handles.has(meta.store ?? "") && meta.kind !== "tip" && deliveredIds(meta).length > 0 ? [email] : [];
      });
      // Never the demo store's, whose checkout takes any address (lib/house-store.ts).
      if (buyers.length && !isHouseStore(store)) {
        // A store made before stores had ids is given its own now.
        const sid = store.sid || (await ensureStoreId(storeRef(store)).catch(() => null))?.sid || "";
        await rememberBuyers(sid, buyers);
      }
    }
    // A buyer who never reached the thanks page is put on the list all the
    // same, with what they bought, and their sequences start (lib/buyer-list.ts).
    if (store.listId && paid.length && Date.now() < deadline) {
      const handles = saleHandles(store);
      const ordinary = paid.filter((row) => {
        const meta = row.metadata ?? {};
        return handles.has(meta.store ?? "") && meta.kind !== "tip" && deliveredIds(meta).length > 0;
      });
      const listed = await listedAlready(ordinary.map((row) => row.id as string));
      for (let i = 0; i < ordinary.length && Date.now() < deadline; i += 1) {
        if (listed[i]) continue;
        const row = ordinary[i];
        const email = typeof row.customer_details?.email === "string" ? row.customer_details.email : typeof row.customer_email === "string" ? row.customer_email : "";
        if (!email) continue;
        const products = await listingsNamed(store, row.metadata);
        if ((await listOrder(store, {
          sessionId: row.id as string,
          email,
          news: row.metadata?.news === "yes",
          clicks: row.metadata?.news === "yes" && row.metadata?.clicks === "yes",
          created: typeof row.created === "number" ? row.created : Math.floor(Date.now() / 1000),
          products: products.map((p) => ({ id: p.id, title: p.title })),
        })) === "done") counts.listed += 1;
      }
    }

    if (reminding) {
      for (const row of rows) {
        if (Date.now() >= deadline) break;
        if (row.status !== "expired" || row.consent?.promotions !== "opt_in") continue;
        const outcome = await remindAbandoned(store, row);
        if (outcome === "sent") counts.reminded += 1;
        if (outcome === "failed") counts.failed += 1;
      }
    }

    // Workflows that start on an abandoned checkout (lib/flows.ts, trigger
    // "abandoned"): only for a buyer who agreed on Stripe's page to hear from
    // the creator and who is on the creator's list, once per checkout, and
    // only for a store that has such a workflow switched on.
    if (store.listId && rows.some((row) => row.status === "expired" && row.consent?.promotions === "opt_in") && Date.now() < deadline) {
      await startAbandonedWorkflows(store, rows).catch((error) => console.error("starting abandoned-checkout workflows failed", store.handle, error));
    }

    const last = rows[rows.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") break;
    after = last.id;
  }
  // A store with no open payment request left comes off their list, once this pass has confirmed the day's.
  if (requesting) await settleStoreList(store.sid).catch(() => undefined);
}

/**
 * Walks stores until the deadline or the end of the list, whichever comes
 * first, and remembers where it stopped.
 *
 * The place is the Redis cursor of the batch being read and how many stores
 * of that batch were done, so a run that stops half way through a batch
 * starts the next one at the store after the last it finished.
 */
export async function sweepCheckouts(deadline: number, taxPolicyValue: unknown = CURRENT_TAX_OBSERVATION_POLICY): Promise<SweepCounts> {
  const counts: SweepCounts = { stores: 0, confirmed: 0, reminded: 0, failed: 0, revoked: 0, unrated: 0, listed: 0 };
  if (!isRedisConfigured() || !platformKey()) return counts;
  const taxPass = { policy: taxPolicyValue, pagesLeft: MAX_PAGES_PER_STORE };

  const [saved] = await redisPipeline([["GET", CURSOR_KEY]]);
  const [savedCursor, savedDone] = typeof saved === "string" ? saved.split("|") : ["0", "0"];
  let cursor = /^\d+$/.test(savedCursor ?? "") ? savedCursor : "0";
  let skip = Number(savedDone) || 0;
  // The stores with open payment requests, read once a run.
  const requesting = await storesWithRequests().catch(() => new Set<string>());

  while (Date.now() < deadline) {
    const { stores, next } = await storesAfter(cursor);
    let done = 0;
    for (const store of stores) {
      if (done < skip) {
        done += 1;
        continue;
      }
      if (Date.now() >= deadline) break;
      const reviewed = Boolean(store.stripeAccountId) && (await storeHasReviews(store).catch(() => false));
      const asks = Boolean(store.sid) && requesting.has(store.sid);
      if (worthAsking(store, asks) || reviewed || store.paypalSeller) {
        counts.stores += 1;
        try {
          await sweepStore(store, counts, deadline, reviewed, asks, taxPass);
        } catch (error) {
          // One store's account refusing, or Stripe having a moment, does not
          // hold up everyone after it. It is reached again next time round.
          console.error("reading a store's checkouts failed", store.handle, error);
        }
      }
      done += 1;
    }
    if (done < stores.length) {
      await redisPipeline([["SET", CURSOR_KEY, `${cursor}|${done}`]]);
      return counts;
    }
    skip = 0;
    cursor = next;
    // The end of the list: the next run starts again from the top, rather
    // than this one reading the first stores twice in a row.
    if (next === "0") break;
  }
  await redisPipeline([["SET", CURSOR_KEY, `${cursor}|0`]]);
  return counts;
}

/**
 * Starts the workflows about an abandoned checkout, for each closed, unpaid
 * checkout of the last few hours whose buyer agreed to hear from the creator
 * on Stripe's own page. enroll() then also requires them to be on the
 * creator's list and still written to. Each checkout is handed on once.
 */
async function startAbandonedWorkflows(store: Store, rows: SessionRecord[]): Promise<void> {
  // Never the demo store's, whose checkout takes any address (lib/house-store.ts).
  if (!store.listId || isHouseStore(store)) return;
  const flows = (await readFlows(store.listId)).filter((f) => f.active && f.trigger === "abandoned");
  if (!flows.length) return;
  const handles = saleHandles(store);
  const now = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    if (row.status !== "expired" || row.consent?.promotions !== "opt_in") continue;
    const meta = row.metadata ?? {};
    const closed = typeof row.expires_at === "number" ? row.expires_at : 0;
    if (!closed || now - closed > REMIND_WITHIN_SECONDS || closed > now) continue;
    if (!handles.has(meta.store ?? "") || !meta.product || !flows.some((f) => f.productId === meta.product)) continue;
    const email = typeof row.customer_details?.email === "string" ? row.customer_details.email : typeof row.customer_email === "string" ? row.customer_email : "";
    if (!email || typeof row.id !== "string") continue;
    const [fresh] = await redisPipeline([["SET", `nl:wf:abandoned:${row.id}`, "1", "NX", "EX", 2 * 86_400]]);
    if (fresh === null) continue;
    await enroll(store, email, { joined: false, abandoned: meta.product });
  }
}
