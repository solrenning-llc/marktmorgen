/**
 * The refund and dispute reserve, read incrementally (306 [SY2] unit 3a,
 * design approved by Claude 3, 13/11/2026). Only reads; the payout of what is
 * above the reserve waits on the owner (Depende do dono) and nothing calls
 * this yet.
 *
 * Why: one full reading (lib/refund-reserve-read.ts, unit 2b) stops at 2,000
 * charges in the lookback, which would close sales by growth once unit 4
 * locks them on the reserve. Inside the refund and dispute windows any charge
 * can get a refund or a dispute at any moment, so "reread what can still
 * change" is rereading nearly everything. What changed is known from
 * Stripe's events instead (GET /v1/events, kept 30 days).
 *
 * State, one company hash (SYNC_KEY): "v" the format; "c:<charge>" each
 * charge's reading, compact (the ReserveRead lib/refund-reserve-charge.ts
 * takes, and whether it had a known kind); "cursor:charges" the newest charge
 * applied; "cursor:events" the newest event applied; "backfill" while the
 * first state is built. The reading is kept, never the amount: the windows
 * (the guarantee, a year's months not started, the 120 dispute days) depend
 * on now, so every run counts every kept reading with the same rule as the
 * full reading (reserveChargeOf, refundReserve). The total is the full
 * reading's by construction, and the tests hold it so through a history.
 *
 * A run, under the crons' lock (lib/claim-mark.ts) and its own budget:
 *   1. building, when there is no state: the lookback's charges, newest
 *      first, SYNC_LIMITS.newPages pages a run, resumed on the next run; the
 *      events cursor is fixed when building starts, so a change made while it
 *      runs is applied afterwards. Unknown ("building") until done;
 *   2. the kept readings (HSCAN), then the events since the cursor: each
 *      charge an event names that is kept is reread by id (GET
 *      /v1/charges/{id}, its dispute too), at most SYNC_LIMITS.rereads; a
 *      charge not kept is new (step 3 reads it) or older than the lookback;
 *   3. the charges newer than the charges cursor;
 *   4. the readings older than the lookback are let go, and the reserve is
 *      counted.
 * Each page's readings and its cursor are one HSET: a run that stops keeps
 * what it applied and repeats nothing wrong (every write is idempotent).
 *
 * Unknown, never a partial sum, when: the key is missing, the lock is busy
 * or unreadable, the state is unreadable or of another format (it is let go
 * and built again: "state"), the events cursor is older than Stripe keeps
 * (built again: "stale"), a ceiling of the run is passed ("too_many", the
 * next runs converge), the budget ends ("deadline"), or any Redis or Stripe
 * answer is not in its exact shape (CX-123 rules 24 and 30: "unreadable").
 *
 * Cost, the company's (fixed, never a plan's allowance), registered in
 * tests/plan-cost-registry.ts (NOT_A_COST) and tests/store-data-registry.ts
 * (FAMILIES): at most RESERVE_SYNC_STRIPE_GETS_PER_DAY Stripe GETs and
 * RESERVE_SYNC_REDIS_COMMANDS_PER_DAY Redis commands a run, one run a day,
 * and at most RESERVE_SYNC_STORED_BYTES kept.
 */
import { isBillingConfigured, onPlatformAt } from "@/lib/billing";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { redisPipeline } from "@/lib/redis";
import type { ReserveRead } from "@/lib/refund-reserve-charge";
import { reserveChargeOf } from "@/lib/refund-reserve-charge";
import { CHARGE_ID, EXPAND, LOOKBACK_DAYS, PAGE_SIZE, READ_VERSION, atCeiling, disputeOf, legibleCharge, readOf } from "@/lib/refund-reserve-read";
import { type Reserve, type ReserveCharge, refundReserve } from "@/lib/refund-reserve-rules";
import { ownField, plainObject, readStripePage } from "@/lib/stripe-list";

export const SYNC_KEY = "nl:refund-reserve:v1";
export const SYNC_LOCK_KEY = "nl:refund-reserve:lock";
/** The kept format and the Stripe version its readings were made at. */
export const SYNC_FORMAT = `1|${READ_VERSION}`;
/** The lock outlives the run's budget with room. */
export const SYNC_LOCK_SECONDS = 120;
/** A run's own budget, inside a 60-second cron (withCutoff 57 s). */
export const SYNC_BUDGET_MS = 40_000;
export const SYNC_LIMITS = { newPages: 20, eventPages: 10, rereads: 200, disputes: 50, stored: 50_000, scanCount: 1000, recordBytes: 400, eventRetentionDays: 29 };
export type SyncLimits = typeof SYNC_LIMITS;
/** Charge list pages, event pages (the first one included), one tie page of each, rereads by id and disputes read, at most, in one run. */
export const RESERVE_SYNC_STRIPE_GETS_PER_DAY = SYNC_LIMITS.newPages + SYNC_LIMITS.eventPages + 2 + SYNC_LIMITS.rereads + SYNC_LIMITS.disputes;
/**
 * Lock (SET, and a GET when its answer is ambiguous) 2, HMGET 1, building's first HSET 1, one HSET a charge page,
 * building's end (HSET, HDEL) 2, one HSET an event page, one HSET each tie page 2, HSCAN stored/scanCount + 1, HDEL of
 * what left the lookback 1, DEL of a state let go 1, lock release 1.
 */
export const RESERVE_SYNC_REDIS_COMMANDS_PER_DAY = 2 + 1 + 1 + SYNC_LIMITS.newPages + 2 + SYNC_LIMITS.eventPages + 2 + (SYNC_LIMITS.stored / SYNC_LIMITS.scanCount + 1) + 1 + 1 + 1;
/** The kept readings at their most. */
export const RESERVE_SYNC_STORED_BYTES = SYNC_LIMITS.stored * SYNC_LIMITS.recordBytes;

const DAY_SECONDS = 86_400;
const CONTROL_FIELDS = new Set(["v", "cursor:charges", "cursor:events", "backfill"]);
const EVENT_ID = /^evt_[A-Za-z0-9]{6,64}$/;
const EVENT_TYPES = [
  "charge.succeeded", "charge.failed", "charge.pending", "charge.captured", "charge.expired", "charge.updated", "charge.refunded",
  "charge.refund.updated", "charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed",
  "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated", "refund.created", "refund.updated", "refund.failed",
];
const CHARGE_EXPAND = EXPAND.map((field) => field.replace(/^data\./, ""));

type Why = null | "billing_off" | "locked" | "state" | "stale" | "building" | "deadline" | "too_many" | "unreadable";
export type SyncReading = {
  reserve: Reserve;
  why: Why;
  /** Readings kept after the run, charges read new, event pages read, charges reread, and kept charges of no known kind. */
  stored: number;
  newCharges: number;
  eventPages: number;
  rereads: number;
  unclassified: number;
};

type Kept = { created: number; unclassified: boolean; read: ReserveRead };
/**
 * The newest applied (id), its second (at) and the ids already applied in that second (a tie Stripe may list on either
 * side of it), and when the list was last read to its end (checked): an events cursor not checked within Stripe's
 * retention cannot be followed.
 */
type Cursor = { id: string | null; since: number; at: number; seen: string[]; checked: number };
type Backfill = { after: string | null; top: string | null; topAt: number; since: number; events: Cursor };

class Unknown extends Error {
  constructor(readonly why: Exclude<Why, null>) {
    super(why);
  }
}

const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const num = (value: number): number | "NaN" => (Number.isFinite(value) ? value : "NaN");
const back = (value: unknown): number => (value === "NaN" ? Number.NaN : typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);

/** A kept reading, compact: one fixed array, every number that could not be read kept as "NaN". */
export function encodeKept(kept: Kept): string {
  const r = kept.read, c = r.charge;
  return JSON.stringify([
    kept.created, kept.unclassified ? 1 : 0, r.kind === "plan" ? "p" : "n", r.status, r.cycle, r.monthlyCents === null ? null : num(r.monthlyCents), r.monthlyCurrency ?? null,
    num(r.periodStartSeconds), num(r.periodEndSeconds), r.refunds === null ? null : r.refunds.map((x) => [x.status, num(x.amount)]),
    c.currency, c.succeeded ? 1 : 0, num(c.amountCents), num(c.invoiceTotalCents), c.billingReason, num(c.refundedCents), num(c.taxCents),
    c.feeCents === null ? null : num(c.feeCents), c.feeCurrency, num(c.paidAtSeconds), c.disputeStatus, c.disputedCents === null ? null : num(c.disputedCents),
  ]);
}

const numeric = (value: unknown) => value === "NaN" || (typeof value === "number" && Number.isFinite(value));
const textOrNull = (value: unknown) => value === null || typeof value === "string";

/** The reading back, or null when the record is not exactly one this code wrote. */
export function decodeKept(raw: string): Kept | null {
  let a: unknown;
  try {
    a = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(a) || a.length !== 22) return null;
  const [created, unclassified, kind, status, cycle, monthly, monthlyCurrency, start, end, refunds, currency, succeeded, amount, total, reason, refunded, tax, fee, feeCurrency, paidAt, disputeStatus, disputed] = a;
  if (!whole(created) || (unclassified !== 0 && unclassified !== 1) || (kind !== "p" && kind !== "n") || typeof status !== "string" || (cycle !== null && cycle !== "month" && cycle !== "year")) return null;
  if ((monthly !== null && !numeric(monthly)) || !textOrNull(monthlyCurrency) || !numeric(start) || !numeric(end) || typeof currency !== "string" || (succeeded !== 0 && succeeded !== 1)) return null;
  if (![amount, total, refunded, tax, paidAt].every(numeric) || typeof reason !== "string" || (fee !== null && !numeric(fee)) || !textOrNull(feeCurrency) || !textOrNull(disputeStatus) || (disputed !== null && !numeric(disputed))) return null;
  if (refunds !== null && (!Array.isArray(refunds) || !refunds.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && numeric(x[1])))) return null;
  const read: ReserveRead = {
    kind: kind === "p" ? "plan" : "not-refunded",
    status,
    cycle: cycle as ReserveRead["cycle"],
    monthlyCents: monthly === null ? null : back(monthly),
    ...(monthlyCurrency === null ? {} : { monthlyCurrency: monthlyCurrency as string }),
    periodStartSeconds: back(start),
    periodEndSeconds: back(end),
    refunds: refunds === null ? null : (refunds as [string, unknown][]).map(([s, x]) => ({ status: s, amount: back(x) })),
    charge: {
      currency, succeeded: succeeded === 1, amountCents: back(amount), invoiceTotalCents: back(total), billingReason: reason, refundedCents: back(refunded), taxCents: back(tax),
      feeCents: fee === null ? null : back(fee), feeCurrency: feeCurrency as string | null, paidAtSeconds: back(paidAt), disputeStatus: disputeStatus as string | null, disputedCents: disputed === null ? null : back(disputed),
    },
  };
  const kept = { created, unclassified: unclassified === 1, read };
  // Exactly what this code writes, nothing else.
  return encodeKept(kept) === raw ? kept : null;
}

function cursorOf(raw: unknown): Cursor | null {
  if (typeof raw !== "string") return null;
  try {
    const c = JSON.parse(raw) as Record<string, unknown>;
    const seen = c.seen;
    if (!plainObject(c) || Object.keys(c).length !== 5 || !(c.id === null || (typeof c.id === "string" && (EVENT_ID.test(c.id) || CHARGE_ID.test(c.id)))) || !whole(c.since) || !whole(c.at) || !whole(c.checked)) return null;
    if (!Array.isArray(seen) || seen.length > PAGE_SIZE || !seen.every((x) => typeof x === "string" && (EVENT_ID.test(x) || CHARGE_ID.test(x)))) return null;
    return { id: c.id as string | null, since: c.since as number, at: c.at as number, seen: seen as string[], checked: c.checked as number };
  } catch {
    return null;
  }
}

function backfillOf(raw: unknown): Backfill | null {
  if (typeof raw !== "string") return null;
  try {
    const b = JSON.parse(raw) as Record<string, unknown>;
    const events = cursorOf(JSON.stringify(b.events));
    const id = (v: unknown) => v === null || (typeof v === "string" && CHARGE_ID.test(v));
    if (!plainObject(b) || Object.keys(b).length !== 5 || !id(b.after) || !id(b.top) || !whole(b.topAt) || !whole(b.since) || !events) return null;
    return { after: b.after as string | null, top: b.top as string | null, topAt: b.topAt as number, since: b.since as number, events };
  } catch {
    return null;
  }
}

/** One Redis command and its exact answer (rule 24): an integer for HSET, HDEL and DEL. */
async function counted(command: (string | number)[]): Promise<number> {
  const replies = await redisPipeline([command]);
  if (!Array.isArray(replies) || replies.length !== 1 || !whole(replies[0])) throw new Unknown("unreadable");
  return replies[0];
}

/** One GET at the pinned version. */
const get = (path: string) => onPlatformAt(READ_VERSION, "GET", path);

export async function syncRefundReserve(nowSeconds: number, deadlineMs: number, limits: SyncLimits = SYNC_LIMITS): Promise<SyncReading> {
  const tally = { stored: 0, newCharges: 0, eventPages: 0, rereads: 0, unclassified: 0 };
  const result = (why: Exclude<Why, null>): SyncReading => ({ reserve: { kind: "unknown", reason: "unreadable", index: -1 }, why, ...tally });
  if (!isBillingConfigured()) return result("billing_off");
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= LOOKBACK_DAYS * DAY_SECONDS || !Number.isFinite(deadlineMs) || limits.rereads < PAGE_SIZE || limits.newPages < 2 || limits.eventPages < 2) return result("unreadable");
  // A page and the whole second it ends in are read together: fewer than two pages a run could never move past one.
  const deadline = Math.min(deadlineMs, Date.now() + SYNC_BUDGET_MS);
  const lock = claimValue();
  const claimed = await claimMark(SYNC_LOCK_KEY, SYNC_LOCK_SECONDS, lock);
  if (claimed !== "ours") return result("locked");
  let disputes = 0;
  const lookback = nowSeconds - LOOKBACK_DAYS * DAY_SECONDS;
  const inTime = () => {
    if (Date.now() >= deadline) throw new Unknown("deadline");
  };
  /** One charge row read and kept, its dispute read when it is disputed. */
  const keptOf = async (row: Record<string, unknown> & { id: string }): Promise<Kept> => {
    let dispute: { status: string; amount: number } | null = null;
    if (ownField(row, "disputed") === true) {
      if (disputes >= limits.disputes) throw new Unknown("too_many");
      inTime();
      disputes += 1;
      dispute = await disputeOf(row.id);
      if (!dispute) throw new Unknown("unreadable");
    }
    const { read, unclassified } = readOf(row, dispute);
    const kept = { created: ownField(row, "created") as number, unclassified, read };
    if (encodeKept(kept).length > limits.recordBytes) throw new Unknown("too_many");
    return kept;
  };
  const chargeQuery = (extra: Record<string, string>) => {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE), ...extra });
    for (const field of EXPAND) query.append("expand[]", field);
    return query;
  };
  let chargePages = 0;
  const chargePage = async (query: URLSearchParams, tie = false) => {
    inTime();
    if (!tie) chargePages += 1;
    const page = readStripePage(await get(`/charges?${query}`), legibleCharge, CHARGE_ID);
    if (page.unreadable > 0) throw new Unknown("unreadable");
    return page;
  };
  const fields = (records: [string, Kept][]) => records.flatMap(([id, kept]) => [`c:${id}`, encodeKept(kept)]);

  try {
    const head = await redisPipeline([["HMGET", SYNC_KEY, "v", "cursor:charges", "cursor:events", "backfill"]]);
    const values = Array.isArray(head) && head.length === 1 ? head[0] : null;
    if (!Array.isArray(values) || values.length !== 4 || !values.every((v) => v === null || typeof v === "string")) return result("unreadable");
    const [format, chargesRaw, eventsRaw, backfillRaw] = values as (string | null)[];

    // 1. Building the first state.
    if (format === null && chargesRaw === null && eventsRaw === null && backfillRaw === null) {
      inTime();
      tally.eventPages += 1;
      const probe = readStripePage(await get(`/events?${eventQuery({ limit: "1" })}`), (row) => whole(ownField(row, "created")), EVENT_ID);
      if (probe.unreadable > 0) throw new Unknown("unreadable");
      const newest = probe.rows[0] ?? null;
      const events: Cursor = { id: newest ? newest.id : null, since: nowSeconds, at: newest ? (ownField(newest, "created") as number) : nowSeconds, seen: newest ? [newest.id] : [], checked: nowSeconds };
      const backfill: Backfill = { after: null, top: null, topAt: 0, since: lookback, events };
      await counted(["HSET", SYNC_KEY, "v", SYNC_FORMAT, "backfill", JSON.stringify(backfill)]);
      return await build(backfill);
    }
    if (format !== SYNC_FORMAT) throw new Unknown("state");
    if (backfillRaw !== null) {
      const backfill = backfillOf(backfillRaw);
      if (!backfill) throw new Unknown("state");
      return await build(backfill);
    }
    const chargesCursor = cursorOf(chargesRaw), eventsCursor = cursorOf(eventsRaw);
    if (!chargesCursor || !eventsCursor) throw new Unknown("state");
    return await run(chargesCursor, eventsCursor);
  } catch (error) {
    if (error instanceof Unknown) {
      // A state that cannot be trusted, or an events cursor Stripe no longer keeps: let go, and built again next run.
      if (error.why === "state" || error.why === "stale") {
        try {
          await counted(["DEL", SYNC_KEY]);
        } catch {
          return result("unreadable");
        }
      }
      return result(error.why);
    }
    console.error("reading the refund reserve incrementally failed", error);
    return result("unreadable");
  } finally {
    await releaseMark(SYNC_LOCK_KEY, lock);
  }

  function eventQuery(extra: Record<string, string>): URLSearchParams {
    const query = new URLSearchParams(extra);
    for (const type of EVENT_TYPES) query.append("types[]", type);
    return query;
  }

  /** The lookback's charges, newest first, resumed from `after`; then the normal run once done. */
  async function build(backfill: Backfill): Promise<SyncReading> {
    let { after, top, topAt } = backfill;
    for (;;) {
      if (chargePages >= limits.newPages) return result("building");
      const page = await chargePage(chargeQuery({ "created[gte]": String(backfill.since), ...(after ? { starting_after: after } : {}) }));
      const records: [string, Kept][] = [];
      for (const row of page.rows) records.push([row.id, await keptOf(row)]);
      if (top === null && page.rows[0]) {
        top = page.rows[0].id;
        topAt = ownField(page.rows[0], "created") as number;
      }
      tally.newCharges += records.length;
      if (!page.hasMore) {
        const charges: Cursor = { id: top, since: backfill.since, at: top ? topAt : backfill.since, seen: [], checked: nowSeconds };
        await counted(["HSET", SYNC_KEY, ...fields(records), "cursor:charges", JSON.stringify(charges), "cursor:events", JSON.stringify(backfill.events)]);
        await counted(["HDEL", SYNC_KEY, "backfill"]);
        // Built. The normal steps run now only while this run has charge pages left; otherwise the next run does.
        return chargePages >= limits.newPages ? result("building") : run(charges, backfill.events);
      }
      if (!page.lastId) throw new Unknown("unreadable");
      // The page ends inside a second whose items Stripe may list in another order on the next request: that whole
      // second is read before going past it (kept twice is harmless, missed is not). Without a page left for it,
      // this run keeps what it read and the next one starts again from the same place.
      const boundary = ownField(page.rows[page.rows.length - 1], "created") as number;
      if (chargePages >= limits.newPages) {
        await counted(["HSET", SYNC_KEY, ...fields(records)]);
        return result("building");
      }
      for (const row of (await secondOf(boundary)).rows) records.push([row.id, await keptOf(row)]);
      after = page.lastId;
      await counted(["HSET", SYNC_KEY, ...fields(records), "backfill", JSON.stringify({ after, top, topAt, since: backfill.since, events: backfill.events })]);
    }
  }

  /** Every charge of one second, in one page (more than PAGE_SIZE in one second is unknown). */
  async function secondOf(second: number, tie = false) {
    const page = await chargePage(chargeQuery({ "created[gte]": String(second), "created[lte]": String(second) }), tie);
    if (page.hasMore) throw new Unknown("too_many");
    return page;
  }

  /** Steps 2 to 4. */
  async function run(chargesCursor: Cursor, eventsCursor: Cursor): Promise<SyncReading> {
    // Stripe keeps events 30 days: a cursor older than that cannot be followed.
    if (eventsCursor.checked < nowSeconds - limits.eventRetentionDays * DAY_SECONDS) throw new Unknown("stale");
    // 2a. Every kept reading.
    const kept = new Map<string, Kept>();
    let cursor = "0";
    for (let scans = 0; ; scans += 1) {
      if (scans > limits.stored / limits.scanCount) throw new Unknown("too_many");
      const replies = await redisPipeline([["HSCAN", SYNC_KEY, cursor, "MATCH", "c:*", "COUNT", limits.scanCount]]);
      const reply = Array.isArray(replies) && replies.length === 1 ? replies[0] : null;
      if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[0] !== "string" || !/^\d+$/.test(reply[0]) || !Array.isArray(reply[1]) || reply[1].length % 2 !== 0) throw new Unknown("unreadable");
      const flat = reply[1] as unknown[];
      for (let i = 0; i < flat.length; i += 2) {
        const field = flat[i], value = flat[i + 1];
        // MATCH is a filter a server may answer without: the state's own fields are passed over, anything else is not ours.
        if (typeof field === "string" && CONTROL_FIELDS.has(field)) continue;
        const id = typeof field === "string" && field.startsWith("c:") ? field.slice(2) : "";
        const reading = typeof value === "string" ? decodeKept(value) : null;
        if (!CHARGE_ID.test(id) || !reading) throw new Unknown("state");
        kept.set(id, reading);
      }
      if (kept.size > limits.stored) throw new Unknown("too_many");
      cursor = reply[0];
      if (cursor === "0") break;
    }

    // 2b. The events since the cursor; each kept charge they name is reread.
    type Row = Record<string, unknown> & { id: string };
    const createdOf = (row: Row) => ownField(row, "created") as number;
    const eventPage = async (extra: Record<string, string>, tie = false) => {
      // The cursor's own second has its own GET, outside the page budget.
      if (!tie && tally.eventPages >= limits.eventPages) throw new Unknown("too_many");
      inTime();
      if (!tie) tally.eventPages += 1;
      let raw: Record<string, unknown>;
      try {
        raw = await get(`/events?${eventQuery({ limit: String(PAGE_SIZE), ...extra })}`);
      } catch (error) {
        // An event Stripe no longer keeps.
        if ((error as { status?: unknown }).status === 404) throw new Unknown("stale");
        throw error;
      }
      const page = readStripePage(raw, (row) => whole(ownField(row, "created")) && plainObject(ownField(row, "data")), EVENT_ID);
      if (page.unreadable > 0) throw new Unknown("unreadable");
      return page;
    };
    /** Every event of one second, in one page (more than PAGE_SIZE in one second is unknown). */
    const eventsOf = async (second: number, tie = false) => {
      const page = await eventPage({ "created[gte]": String(second), "created[lte]": String(second) }, tie);
      if (page.hasMore) throw new Unknown("too_many");
      return page.rows;
    };
    // Events already applied: those of the cursor's second from earlier runs, and every one of this run.
    const applied = new Map<string, number>(eventsCursor.seen.map((id) => [id, eventsCursor.at]));
    const rereadAt = new Map<string, number>();
    const seenAt = (second: number) => [...applied].filter(([, at]) => at === second).map(([id]) => id).slice(-PAGE_SIZE);
    /** Rereads the kept charges these events name, then writes them and the next events cursor in one HSET. */
    const apply = async (rows: Row[], next: () => Cursor): Promise<Cursor> => {
      const fresh = [...new Map(rows.filter((row) => !applied.has(row.id)).map((row) => [row.id, row])).values()];
      const ids = new Set<string>();
      for (const event of fresh) {
        const object = ownField(ownField(event, "data") as Record<string, unknown>, "object");
        if (!plainObject(object)) throw new Unknown("unreadable");
        const id = ownField(object, "object") === "charge" ? ownField(object, "id") : ownField(object, "charge");
        if (typeof id !== "string" || !CHARGE_ID.test(id)) throw new Unknown("unreadable");
        // A charge not kept is new (step 3 reads it as it is then) or older than the lookback. One reread in this run
        // shows an event only if it was made after the event, with two seconds for the clocks.
        const at = rereadAt.get(id);
        if (kept.has(id) && !(at !== undefined && createdOf(event) + 2 < at)) ids.add(id);
      }
      if (tally.rereads + ids.size > limits.rereads) throw new Unknown("too_many");
      const records: [string, Kept][] = [];
      for (const id of ids) {
        inTime();
        tally.rereads += 1;
        const query = new URLSearchParams();
        for (const field of CHARGE_EXPAND) query.append("expand[]", field);
        const row = await get(`/charges/${encodeURIComponent(id)}?${query}`);
        // Rule 30: the answer is this very charge, in its shape.
        if (!plainObject(row) || ownField(row, "id") !== id || !legibleCharge(row)) throw new Unknown("unreadable");
        const reading = await keptOf(row as Row);
        records.push([id, reading]);
        kept.set(id, reading);
        rereadAt.set(id, Math.floor(Date.now() / 1000));
      }
      for (const event of fresh) applied.set(event.id, createdOf(event));
      const cursor = next();
      await counted(["HSET", SYNC_KEY, ...fields(records), "cursor:events", JSON.stringify(cursor)]);
      return cursor;
    };
    /** The events cursor at a newest row: its id, its second and every event applied in that second. */
    const eventsAt = (row: Row | undefined, from: Cursor, checked: number): Cursor =>
      row ? { id: row.id, since: from.since, at: createdOf(row), seen: seenAt(createdOf(row)), checked } : { ...from, seen: seenAt(from.at), checked };
    let events = eventsCursor;
    if (events.id) {
      // The cursor's own second: an event Stripe lists beside it is not after it in the list.
      const tie = await eventsOf(events.at, true);
      if (tie.some((row) => !applied.has(row.id))) events = await apply(tie, () => eventsAt(undefined, events, events.checked));
      for (;;) {
        const page = await eventPage({ ending_before: events.id! });
        const newest = page.rows[0];
        // The next page starts inside the newest row's second, which Stripe may order otherwise: read it whole.
        const second = page.hasMore && newest ? await eventsOf(createdOf(newest)) : [];
        const from = events;
        events = await apply([...page.rows, ...second], () => eventsAt(newest, from, page.hasMore ? from.checked : nowSeconds));
        if (!page.hasMore) break;
      }
    } else {
      // No event yet when building began: everything since, read whole (newest first, each page's last second read
      // whole too), then applied at once.
      const rows: Row[] = [];
      let from: string | null = null;
      for (;;) {
        const page = await eventPage({ "created[gte]": String(events.since), ...(from ? { starting_after: from } : {}) });
        rows.push(...page.rows);
        if (!page.hasMore) break;
        if (!page.lastId) throw new Unknown("unreadable");
        rows.push(...(await eventsOf(createdOf(page.rows[page.rows.length - 1]))));
        from = page.lastId;
      }
      const newest = rows.reduce<Row | undefined>((a, r) => (!a || createdOf(r) > createdOf(a) ? r : a), undefined);
      const before = events;
      events = await apply(rows, () => eventsAt(newest, before, nowSeconds));
    }

    // 3. The charges newer than the charges cursor (each read once: a charge already kept is not read again here).
    const keepAll = async (rows: Row[], next: Cursor | null) => {
      // The callers pass only charges not kept; one read each, however many times a page and its second list it.
      const records = new Map<string, Kept>();
      for (const row of rows) {
        if (records.has(row.id)) continue;
        const reading = await keptOf(row);
        records.set(row.id, reading);
        kept.set(row.id, reading);
      }
      tally.newCharges += records.size;
      if (records.size || next) await counted(["HSET", SYNC_KEY, ...fields([...records]), ...(next ? ["cursor:charges", JSON.stringify(next)] : [])]);
    };
    const chargesBudget = () => {
      if (chargePages >= limits.newPages) throw new Unknown("too_many");
    };
    const chargesAt = (row: Row | undefined, from: Cursor): Cursor => (row ? { id: row.id, since: from.since, at: createdOf(row), seen: [], checked: nowSeconds } : from);
    let charges = chargesCursor;
    if (charges.id) {
      // The cursor's own second, for a charge Stripe lists beside it: its own GET, outside the page budget.
      await keepAll((await secondOf(charges.at, true)).rows.filter((row) => !kept.has(row.id)), null);
      for (;;) {
        chargesBudget();
        const page = await chargePage(chargeQuery({ ending_before: charges.id! }));
        const newest = page.rows[0];
        let second: Row[] = [];
        if (page.hasMore && newest) {
          chargesBudget();
          second = (await secondOf(createdOf(newest))).rows;
        }
        const next = chargesAt(newest, charges);
        await keepAll([...page.rows, ...second].filter((row) => !kept.has(row.id)), next !== charges ? next : null);
        charges = next;
        if (!page.hasMore) break;
      }
    } else {
      const rows: Row[] = [];
      let from: string | null = null;
      for (;;) {
        chargesBudget();
        const page = await chargePage(chargeQuery({ "created[gte]": String(charges.since), ...(from ? { starting_after: from } : {}) }));
        rows.push(...page.rows);
        if (!page.hasMore) break;
        if (!page.lastId) throw new Unknown("unreadable");
        chargesBudget();
        rows.push(...(await secondOf(createdOf(page.rows[page.rows.length - 1]))).rows);
        from = page.lastId;
      }
      const newest = rows.reduce<Row | undefined>((a, r) => (!a || createdOf(r) > createdOf(a) ? r : a), undefined);
      const next = chargesAt(newest, charges);
      await keepAll(rows.filter((row) => !kept.has(row.id)), next !== charges ? next : null);
      charges = next;
    }

    // 4. Let go of what left the lookback; count the rest as the full reading counts it.
    const gone = [...kept].filter(([, k]) => k.created < lookback).map(([id]) => `c:${id}`);
    if (gone.length) await counted(["HDEL", SYNC_KEY, ...gone]);
    const counts: ReserveCharge[] = [];
    for (const [id, k] of kept) {
      if (k.created < lookback) {
        kept.delete(id);
        continue;
      }
      const charge = reserveChargeOf(k.read, nowSeconds);
      if (!charge) continue;
      if (k.unclassified) tally.unclassified += 1;
      counts.push(k.unclassified ? atCeiling(charge, k.read.charge) : charge);
    }
    tally.stored = kept.size;
    return { reserve: refundReserve(counts, nowSeconds), why: null, ...tally };
  }
}
