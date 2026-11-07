/**
 * Benefits handed over by hand on a membership, who is still owed each one,
 * and the creator's marks of what they gave (422 [PT2], unit 1; the rules
 * are in lib/tier-benefit-rules.ts).
 *
 *   nl:tben:<statsId>                  hash: benefit id -> JSON { product, text, cadence, since, retired }
 *   nl:tben:given:<statsId>:<person>   hash: "<benefit>:<sub>:<period>" -> JSON { at, by }
 *   nl:tben:who:<statsId>              set of the people with marks, so a deleted store's go with it
 *
 * <person> is lib/person-key.ts personKey, never the address. The benefits
 * are bounded in the code (MAX_BENEFITS_KEPT); the marks are counted in the
 * store's data room (lib/store-data.ts, slot "tb") before they are written,
 * and refused past it.
 *
 * Who is owed what is read, every time, from the running memberships on the
 * creator's own Stripe account: at most MAX_PAGES pages of 100, each read in
 * its exact shape (lib/stripe-list.ts). Stripe down, a page in another shape,
 * a membership that cannot be read or one page too many is said as such:
 * the list is "unknown" or "incomplete", never "nobody waiting". Whether a
 * membership was ever paid for is read from its invoices, never from its
 * status (lib/tier-benefit-rules.ts): its newest invoice comes with the list;
 * a one-time benefit on a membership whose newest invoice is not paid reads
 * its newest paid invoice, one read each, at most MAX_PROOF_READS a list,
 * and one that cannot be read keeps it "unknown", never owed. A person's
 * marks that cannot be read (lib/redis-reply.ts) are "unknown" on each of
 * their rows, never "given" and never "waiting", and nothing is written for
 * them until they can be read.
 *
 * Unit 1 lists what is owed for the memberships running now. A benefit owed
 * for an earlier month, or to a member who has since left or switched to
 * another membership, is not listed yet (the next unit keeps each owed
 * benefit as it falls due); nor are reminders or emails.
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { onAccount } from "@/lib/stripe-account";
import { STRIPE_LIST_VERSION, StripeListUnreadable, ownField, plainObject, readStripePage } from "@/lib/stripe-list";
import { countOf, repliesFor, stringList, UnknownReplyError } from "@/lib/redis-reply";
import { type Store, saleHandles } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { productOfSub } from "@/lib/tier-rules";
import { type PauseSub, pausedNow } from "@/lib/membership-pause-rules";
import { normaliseEmail } from "@/lib/auth";
import { personKey } from "@/lib/person-key";
import { giveData, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import {
  BENEFIT_ID,
  MAX_BENEFITS_KEPT,
  MAX_BENEFITS_PER_TIER,
  MAX_GIVE_AT_ONCE,
  PERIOD,
  type Benefit,
  type MemberLike,
  benefitJson,
  benefitText,
  isCadence,
  needsPaymentProof,
  owedNow,
  paidAfterTrial,
  parseBenefit,
} from "@/lib/tier-benefit-rules";

/** Pages of 100 running memberships read at most, for the list and for each press. */
const MAX_PAGES = 10;
/** Where the marks are counted in the store's data room. */
const SLOT = "tb";
/** Memberships whose earlier payment is read one by one, at most, for the list and for each press; past it they are unknown. */
const MAX_PROOF_READS = 100;
/** Of those, read at once. */
const PROOF_AT_ONCE = 10;
const SUB_ID = /^sub_[A-Za-z0-9]{6,64}$/;
const INVOICE_ID = /^in_[A-Za-z0-9]{6,64}$/;
const PERSON = /^[0-9a-f]{32}$/;
/** What a running membership can be in on Stripe; the rules decide which of them are owed anything. */
const RUNNING = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

const benefitsKey = (statsId: string) => `nl:tben:${statsId}`;
const marksKey = (statsId: string, person: string) => `nl:tben:given:${statsId}:${person}`;
const whoKey = (statsId: string) => `nl:tben:who:${statsId}`;
const field = (benefit: string, sub: string, period: string) => `${benefit}:${sub}:${period}`;

// ------------------------------------------------------------------ the benefits

/** The store's benefits, retired ones included, oldest first; null when they cannot be read. */
export async function readBenefits(store: Store): Promise<Benefit[] | null> {
  if (!store.statsId || !isRedisConfigured()) return [];
  const replies = repliesFor(await redisPipeline([["HGETALL", benefitsKey(store.statsId)]]).catch(() => null), 1);
  const flat = replies ? stringList(replies[0]) : null;
  if (!flat || flat.length % 2 !== 0) return null;
  const out: Benefit[] = [];
  for (let i = 0; i < flat.length; i += 2) {
    const benefit = parseBenefit(flat[i], flat[i + 1]);
    if (!benefit) return null;
    out.push(benefit);
  }
  return out.sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
}

export type AddResult = { ok: true; benefit: Benefit } | { ok: false; reason: "product" | "text" | "cadence" | "full_tier" | "full_store" | "unknown" };

/** Adds a benefit to one of the store's memberships. */
export async function addBenefit(store: Store, input: { product: unknown; text: unknown; cadence: unknown }, now = Date.now()): Promise<AddResult> {
  const text = benefitText(input.text);
  if (text === null) return { ok: false, reason: "text" };
  if (!isCadence(input.cadence)) return { ok: false, reason: "cadence" };
  if (typeof input.product !== "string" || !store.statsId || !isRedisConfigured()) return { ok: false, reason: "product" };
  const [listing] = await readListings(store, [input.product]).catch(() => []);
  if (!listing || listing.id !== input.product || !listing.recurring) return { ok: false, reason: "product" };
  const kept = await readBenefits(store);
  if (kept === null) return { ok: false, reason: "unknown" };
  const live = (list: Benefit[]) => list.filter((b) => b.product === listing.id && !b.retired).length;
  if (live(kept) >= MAX_BENEFITS_PER_TIER) return { ok: false, reason: "full_tier" };
  if (kept.length >= MAX_BENEFITS_KEPT) return { ok: false, reason: "full_store" };
  const benefit: Benefit = { id: `b${randomBytes(6).toString("hex")}`, product: listing.id, text, cadence: input.cadence, since: Math.floor(now / 1000), retired: 0 };
  const written = repliesFor(await redisPipeline([["HSET", benefitsKey(store.statsId), benefit.id, benefitJson(benefit)]]).catch(() => null), 1);
  if (!written || countOf(written[0]) !== 1) return { ok: false, reason: "unknown" };
  // Two added at once could pass the count together: the one past it is taken back.
  const after = await readBenefits(store);
  if (after === null || live(after) > MAX_BENEFITS_PER_TIER || after.length > MAX_BENEFITS_KEPT) {
    await redisPipeline([["HDEL", benefitsKey(store.statsId), benefit.id]]).catch(() => undefined);
    return { ok: false, reason: after === null ? "unknown" : live(after) > MAX_BENEFITS_PER_TIER ? "full_tier" : "full_store" };
  }
  return { ok: true, benefit };
}

/** Retires a benefit: it is owed no more from now on, and still owed for what was owed before. Once only. */
export async function retireBenefit(store: Store, id: unknown, now = Date.now()): Promise<{ ok: true } | { ok: false; reason: "missing" | "unknown" }> {
  if (typeof id !== "string" || !BENEFIT_ID.test(id) || !store.statsId) return { ok: false, reason: "missing" };
  const kept = await readBenefits(store);
  if (kept === null) return { ok: false, reason: "unknown" };
  const benefit = kept.find((b) => b.id === id);
  if (!benefit) return { ok: false, reason: "missing" };
  if (benefit.retired) return { ok: true };
  const replies = repliesFor(await redisPipeline([["HSET", benefitsKey(store.statsId), id, benefitJson({ ...benefit, retired: Math.floor(now / 1000) })]]).catch(() => null), 1);
  return replies && countOf(replies[0]) !== null ? { ok: true } : { ok: false, reason: "unknown" };
}

// ------------------------------------------------------------------ the members

type Member = MemberLike & { email: string; person: string; trialEnd: number };

const safeWhole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Whether one invoice of this membership, in its exact shape, proves a
 * payment (lib/tier-benefit-rules.ts paidAfterTrial); null when it is not
 * one of this membership's invoices as Stripe gives them.
 */
function invoiceProof(raw: unknown, sub: string, trialEnd: number): boolean | null {
  if (!plainObject(raw)) return null;
  const id = ownField(raw, "id");
  const status = ownField(raw, "status");
  const created = ownField(raw, "created");
  if (typeof id !== "string" || !INVOICE_ID.test(id) || typeof status !== "string" || !safeWhole(created)) return null;
  const parent = ownField(raw, "parent");
  const details = plainObject(parent) ? ownField(parent, "subscription_details") : undefined;
  const owner = plainObject(details) ? ownField(details, "subscription") : undefined;
  const ownerId = typeof owner === "string" ? owner : plainObject(owner) ? ownField(owner, "id") : undefined;
  if (ownerId !== sub) return null;
  return paidAfterTrial({ status, created }, trialEnd);
}

/** Whether a membership was paid for after its trial: its newest paid invoice, read in its exact shape; null when not known. */
async function paidBefore(account: string, member: Member): Promise<boolean | null> {
  try {
    const query = new URLSearchParams({ subscription: member.sub, status: "paid", limit: "1" });
    const read = readStripePage(
      await onAccount("GET", account, `/invoices?${query}`, undefined, STRIPE_LIST_VERSION),
      (row) => ownField(row, "status") === "paid" && invoiceProof(row, member.sub, member.trialEnd) !== null,
      INVOICE_ID,
    );
    if (read.unreadable) return null;
    // Newest first: when the newest paid one is the trial's own, none came after it.
    if (read.rows.length) return invoiceProof(read.rows[0], member.sub, member.trialEnd);
    return read.hasMore ? null : false;
  } catch (error) {
    if (!(error instanceof StripeListUnreadable)) console.error("reading a membership's paid invoices failed", error);
    return null;
  }
}

/** Reads, for each member who needs it, whether they ever paid; past MAX_PROOF_READS, unknown. */
async function proveEarlierPayments(account: string | null | undefined, members: Member[]): Promise<void> {
  const reads = account ? members.slice(0, MAX_PROOF_READS) : [];
  for (const member of members.slice(reads.length)) member.paidEver = null;
  for (let i = 0; i < reads.length; i += PROOF_AT_ONCE) {
    await Promise.all(reads.slice(i, i + PROOF_AT_ONCE).map(async (member) => {
      member.paidEver = await paidBefore(account!, member);
    }));
  }
}

/** The parts of a subscription row read here; a row without them is unreadable. */
function legible(row: Record<string, unknown>): boolean {
  const meta = ownField(row, "metadata");
  return typeof ownField(row, "status") === "string" && (meta === null || meta === undefined || plainObject(meta));
}

/** The store's running memberships on its Stripe account, at most MAX_PAGES pages; null when Stripe could not be read. */
async function runningMemberships(store: Store, statsId: string, nowSeconds: number): Promise<{ members: Member[]; complete: boolean; unreadable: number } | null> {
  const account = store.stripeAccountId;
  if (!account) return { members: [], complete: true, unreadable: 0 };
  const handles = saleHandles(store);
  const members: Member[] = [];
  let unreadable = 0;
  let after = "";
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: "100" });
      query.append("expand[]", "data.customer");
      // Its newest invoice: whether the period running now is paid for (lib/tier-benefit-rules.ts).
      query.append("expand[]", "data.latest_invoice");
      if (after) query.set("starting_after", after);
      const read = readStripePage(await onAccount("GET", account, `/subscriptions?${query}`, undefined, STRIPE_LIST_VERSION), legible, SUB_ID);
      unreadable += read.unreadable;
      for (const row of read.rows) {
        const meta = (ownField(row, "metadata") ?? {}) as Record<string, unknown>;
        const status = String(ownField(row, "status"));
        if (!handles.has(String(meta.store ?? "")) || meta.kind === "plan" || !RUNNING.has(status)) continue;
        const customer = ownField(row, "customer");
        const email = plainObject(customer) && typeof ownField(customer, "email") === "string" ? normaliseEmail(String(ownField(customer, "email"))) : "";
        const startRaw = ownField(row, "start_date");
        const anchorRaw = ownField(row, "billing_cycle_anchor");
        const start = typeof startRaw === "number" && Number.isSafeInteger(startRaw) ? startRaw : 0;
        const anchor = typeof anchorRaw === "number" && Number.isSafeInteger(anchorRaw) ? anchorRaw : start;
        const product = productOfSub(row);
        // No free trial is null; anything else than a time is another shape.
        const trialRaw = ownField(row, "trial_end");
        const trialEnd = trialRaw === null ? 0 : safeWhole(trialRaw) ? trialRaw : -1;
        // Expanded as asked, or null before any invoice; an id alone or anything else is another shape.
        const latest = ownField(row, "latest_invoice");
        const paidNow = latest === null ? false : trialEnd < 0 ? null : invoiceProof(latest, row.id, trialEnd);
        // A running membership of this store that cannot be placed proves nothing: counted, so the list says it is not whole.
        if (!email || !start || !anchor || !product || trialEnd < 0 || paidNow === null) {
          unreadable += 1;
          continue;
        }
        members.push({ sub: row.id, status, product, anchor, start, paused: pausedNow(row as PauseSub, nowSeconds), paidNow, paidEver: paidNow, trialEnd, email, person: personKey(statsId, email) });
      }
      if (!read.hasMore) return { members, complete: true, unreadable };
      // The last row unreadable: the next page cannot be found from it.
      if (!read.lastId) return { members, complete: false, unreadable };
      after = read.lastId;
    }
    return { members, complete: false, unreadable };
  } catch (error) {
    if (!(error instanceof StripeListUnreadable)) console.error("reading memberships for benefits failed", error);
    return null;
  }
}

type Given = { at: number; by: string };

/** Each person's marks, by field; "unknown" for a person whose marks could not be read in their exact shape. */
async function readMarks(statsId: string, people: string[]): Promise<Map<string, Map<string, Given> | "unknown">> {
  const out = new Map<string, Map<string, Given> | "unknown">();
  for (let i = 0; i < people.length; i += 200) {
    const slice = people.slice(i, i + 200);
    const replies = repliesFor(await redisPipeline(slice.map((p) => ["HGETALL", marksKey(statsId, p)])).catch(() => null), slice.length);
    slice.forEach((person, n) => {
      const flat = replies ? stringList(replies[n]) : null;
      if (!flat || flat.length % 2 !== 0) return out.set(person, "unknown");
      const marks = new Map<string, Given>();
      for (let j = 0; j < flat.length; j += 2) {
        const given = parseGiven(flat[j + 1]);
        if (!given) return out.set(person, "unknown");
        marks.set(flat[j], given);
      }
      out.set(person, marks);
    });
  }
  return out;
}

function parseGiven(raw: string): Given | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const { at, by } = value as Record<string, unknown>;
    return typeof at === "number" && Number.isSafeInteger(at) && at > 0 && typeof by === "string" && by.length <= 320 ? { at, by } : null;
  } catch {
    return null;
  }
}

const givenJson = (g: Given) => JSON.stringify({ at: g.at, by: g.by });
const markBytes = (f: string, g: Given) => dataBytes([f, givenJson(g)], 1);

export type DueRow = {
  benefit: string;
  sub: string;
  email: string;
  person: string;
  period: string;
  /** When it fell due: the membership's start for a one-time benefit, the month's start for a monthly one. */
  from: number;
  /** The end of the month it belongs to; null for a one-time benefit, whose creator promised no date. */
  until: number | null;
  /** The creator's mark; null while waiting; "unknown" when the marks could not be read. */
  given: Given | null | "unknown";
};

export type Waiting = { trial: number; unpaid: number; paused: number };

export type DueView =
  | { state: "none" }
  | { state: "unknown"; why: "benefits" | "stripe" }
  | {
      state: "ok";
      benefits: Benefit[];
      rows: DueRow[];
      /** By benefit: members on its membership not owed it yet, and why. */
      waiting: Record<string, Waiting>;
      /** Every running membership was read to the end. */
      complete: boolean;
      /** Rows Stripe gave that could not be read: they keep the list from being called whole. */
      unreadable: number;
    };

/** Who is owed each benefit right now, read from Stripe and the marks. */
export async function benefitsDue(store: Store, now = Date.now()): Promise<DueView> {
  return (await readDue(store, now)).view;
}

/** The view, and the memberships whose payment could not be read (a press says those as unknown, not as not owed). */
async function readDue(store: Store, now: number): Promise<{ view: DueView; unknown: Set<string> }> {
  const unknown = new Set<string>();
  const benefits = await readBenefits(store);
  if (benefits === null) return { view: { state: "unknown", why: "benefits" }, unknown };
  if (!benefits.length || !store.statsId) return { view: { state: "none" }, unknown };
  const nowSeconds = Math.floor(now / 1000);
  const read = await runningMemberships(store, store.statsId, nowSeconds);
  if (read === null) return { view: { state: "unknown", why: "stripe" }, unknown };
  // Only where a one-time benefit could be owed: a monthly one goes by the newest invoice alone.
  const onceOn = new Set(benefits.filter((b) => b.cadence === "once").map((b) => b.product));
  await proveEarlierPayments(store.stripeAccountId, read.members.filter((m) => onceOn.has(m.product) && needsPaymentProof(m)));
  for (const member of read.members) if (member.paidEver === null) unknown.add(member.sub);
  const waiting: Record<string, Waiting> = {};
  const owed: Omit<DueRow, "given">[] = [];
  for (const benefit of benefits) {
    waiting[benefit.id] = { trial: 0, unpaid: 0, paused: 0 };
    for (const member of read.members) {
      const due = owedNow(benefit, member, nowSeconds);
      if (due.owed) owed.push({ benefit: benefit.id, sub: member.sub, email: member.email, person: member.person, period: due.period, from: due.from, until: due.until });
      else if (due.why === "trial" || due.why === "unpaid" || due.why === "paused") waiting[benefit.id][due.why] += 1;
    }
  }
  const marks = await readMarks(store.statsId, [...new Set(owed.map((r) => r.person))]);
  const rows: DueRow[] = owed.map((r) => {
    const held = marks.get(r.person);
    return { ...r, given: held === undefined || held === "unknown" ? "unknown" : (held.get(field(r.benefit, r.sub, r.period)) ?? null) };
  });
  rows.sort((a, b) => (a.until ?? Number.MAX_SAFE_INTEGER) - (b.until ?? Number.MAX_SAFE_INTEGER) || a.from - b.from || a.sub.localeCompare(b.sub));
  // A membership whose payment could not be read keeps the list from being called whole, like a row that cannot be read.
  return { view: { state: "ok", benefits, rows, waiting, complete: read.complete, unreadable: read.unreadable + unknown.size }, unknown };
}

// ------------------------------------------------------------------ the marks

export type GiveResult =
  | { ok: true; given: number; already: number; notOwed: number; unknown: number }
  | { ok: false; reason: "too_many" | "missing" | "benefits" | "stripe" | "full" | "room"; message?: string };

/**
 * Marks one benefit given to the members named, each read again first: only
 * a row owed right now is marked, the first mark kept (HSETNX), so pressing
 * twice, or two people pressing at once, marks it once. Says exactly how
 * many were marked, were already, were not owed, or could not be read.
 */
export async function giveBenefit(store: Store, by: string, benefit: unknown, items: unknown, now = Date.now()): Promise<GiveResult> {
  if (!Array.isArray(items) || items.length > MAX_GIVE_AT_ONCE) return { ok: false, reason: "too_many" };
  if (typeof benefit !== "string" || !BENEFIT_ID.test(benefit) || !store.statsId) return { ok: false, reason: "missing" };
  const statsId = store.statsId;
  const { view: due, unknown } = await readDue(store, now);
  if (due.state === "unknown") return { ok: false, reason: due.why };
  if (due.state === "none" || !due.benefits.some((b) => b.id === benefit)) return { ok: false, reason: "missing" };
  const rows = new Map(due.rows.filter((r) => r.benefit === benefit).map((r) => [`${r.sub}:${r.period}`, r]));
  const seen = new Set<string>();
  const result = { ok: true as const, given: 0, already: 0, notOwed: 0, unknown: 0 };
  const mark: Given = { at: Math.floor(now / 1000), by: normaliseEmail(by).slice(0, 320) };
  const writes: { row: DueRow; field: string; bytes: number }[] = [];
  for (const item of items) {
    const sub = item && typeof item === "object" ? (item as Record<string, unknown>).sub : undefined;
    const period = item && typeof item === "object" ? (item as Record<string, unknown>).period : undefined;
    if (typeof sub !== "string" || !SUB_ID.test(sub) || typeof period !== "string" || !PERIOD.test(period)) {
      result.notOwed += 1;
      continue;
    }
    if (seen.has(`${sub}:${period}`)) continue;
    seen.add(`${sub}:${period}`);
    const row = rows.get(`${sub}:${period}`);
    if (!row && unknown.has(sub)) result.unknown += 1;
    else if (!row) result.notOwed += 1;
    else if (row.given === "unknown") result.unknown += 1;
    else if (row.given) result.already += 1;
    else {
      const f = field(benefit, sub, period);
      writes.push({ row, field: f, bytes: markBytes(f, mark) });
    }
  }
  if (!writes.length) return result;
  const people = [...new Set(writes.map((w) => w.row.person))];
  // Each person's place in the list is counted before it is known whether they are in it already; given back below when they were.
  const bytes = writes.reduce((sum, w) => sum + w.bytes, 0) + people.reduce((sum, p) => sum + dataBytes([p], 1), 0);
  // Its room first; nothing is written when it does not fit or cannot be counted.
  const taken = await takeData(store, [{ slot: SLOT, bytes }], now);
  if (!taken.ok) return taken.reason === "full" ? { ok: false, reason: "full", message: taken.message } : { ok: false, reason: "room" };
  const commands: (string | number)[][] = writes.map((w) => ["HSETNX", marksKey(statsId, w.row.person), w.field, givenJson(mark)]);
  for (const person of people) commands.push(["SADD", whoKey(statsId), person]);
  const replies = repliesFor(await redisPipeline(commands).catch(() => null), commands.length);
  let giveBack = 0;
  writes.forEach((w, i) => {
    const reply = replies ? countOf(replies[i]) : null;
    if (reply === 1) result.given += 1;
    else if (reply === 0) {
      // Marked by someone else in the meantime: theirs is kept, and so is its room.
      result.already += 1;
      giveBack += w.bytes;
    } else result.unknown += 1;
  });
  // Already in the list: their place was counted when they went into it (an unknown answer keeps it counted, fuller, never short).
  people.forEach((person, j) => {
    if (replies && countOf(replies[writes.length + j]) === 0) giveBack += dataBytes([person], 1);
  });
  if (giveBack) await giveData(store, [{ slot: SLOT, bytes: giveBack }], now);
  return result;
}

/** Takes one mark back, for a row owed right now; says whether there was one. */
export async function undoGiven(store: Store, benefit: unknown, sub: unknown, period: unknown, now = Date.now()): Promise<{ ok: true; undone: boolean } | { ok: false; reason: "missing" | "not_owed" | "benefits" | "stripe" | "unknown" }> {
  if (typeof benefit !== "string" || !BENEFIT_ID.test(benefit) || !store.statsId) return { ok: false, reason: "missing" };
  if (typeof sub !== "string" || !SUB_ID.test(sub) || typeof period !== "string" || !PERIOD.test(period)) return { ok: false, reason: "not_owed" };
  const due = await benefitsDue(store, now);
  if (due.state === "unknown") return { ok: false, reason: due.why };
  const row = due.state === "ok" ? due.rows.find((r) => r.benefit === benefit && r.sub === sub && r.period === period) : undefined;
  if (!row) return { ok: false, reason: "not_owed" };
  const f = field(benefit, sub, period);
  const replies = repliesFor(await redisPipeline([["HDEL", marksKey(store.statsId, row.person), f]]).catch(() => null), 1);
  const removed = replies ? countOf(replies[0]) : null;
  if (removed === null) return { ok: false, reason: "unknown" };
  if (removed === 1 && row.given && row.given !== "unknown") await giveData(store, [{ slot: SLOT, bytes: markBytes(f, row.given) }], now);
  return { ok: true, undone: removed === 1 };
}

// ------------------------------------------------------------------ erasure

/** A deleted person's marks (lib/person-erasure.ts): how many keys went. Throws when the answer cannot be read. */
export async function forgetBenefitPerson(store: Store, person: string): Promise<number> {
  if (!store.statsId || !PERSON.test(person) || !isRedisConfigured()) return 0;
  const key = marksKey(store.statsId, person);
  const [held] = repliesFor(await redisPipeline([["HGETALL", key]]), 1) ?? [];
  const flat = stringList(held);
  const replies = repliesFor(await redisPipeline([["DEL", key], ["SREM", whoKey(store.statsId), person]]), 2);
  const gone = replies ? countOf(replies[0]) : null;
  if (gone === null || !replies || countOf(replies[1]) === null) throw new UnknownReplyError("deleting a person's benefit marks");
  // Their place in the list too, when it was there to take out.
  let bytes = countOf(replies[1]) === 1 ? dataBytes([person], 1) : 0;
  if (flat) for (let i = 0; i + 1 < flat.length; i += 2) bytes += dataBytes([flat[i], flat[i + 1]], 1);
  if (bytes) await giveData(store, [{ slot: SLOT, bytes }]);
  return gone;
}

/** Everything a deleted store kept here. */
export async function forgetStoreBenefits(statsId: string | null): Promise<void> {
  if (!statsId || !isRedisConfigured()) return;
  const [raw] = repliesFor(await redisPipeline([["SMEMBERS", whoKey(statsId)]]), 1) ?? [];
  const listed = stringList(raw);
  // Who has marks unread: nothing is deleted blind, so the marks are not left without their list.
  if (!listed) throw new UnknownReplyError("the people with benefit marks");
  const people = listed.filter((p) => PERSON.test(p));
  const deleted = async (keys: string[], what: string) => {
    const [reply] = repliesFor(await redisPipeline([["DEL", ...keys]]), 1) ?? [];
    // An answer in another shape is not done: thrown, so the store's deletion says so; the list stays until the marks went.
    if (countOf(reply) === null) throw new UnknownReplyError(what);
  };
  for (let i = 0; i < people.length; i += 500) await deleted(people.slice(i, i + 500).map((p) => marksKey(statsId, p)), "deleting a deleted store's benefit marks");
  await deleted([whoKey(statsId), benefitsKey(statsId)], "deleting a deleted store's benefits");
}
