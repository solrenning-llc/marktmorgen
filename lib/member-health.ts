/**
 * Each running member of a store with its score (lib/member-health-rules.ts),
 * read when the studio's Membership numbers page opens and kept ten minutes.
 *
 * Everything it reads is already kept: the memberships on the creator's own
 * Stripe account, when each member last opened the membership's course
 * (lib/learn.ts) and last came into the community (lib/community.ts). Nothing
 * is written about anybody to work it out, and nothing is read on a visit to
 * the store.
 *
 *   nl:health:<statsId>   JSON Health, ten minutes
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { onAccount } from "@/lib/stripe-account";
import { type Store, saleHandles } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { productOfSub } from "@/lib/tier-rules";
import { type PauseSub, pausedNow } from "@/lib/membership-pause-rules";
import { lastSeenMany } from "@/lib/learn";
import { lastSeenIn, readConfig } from "@/lib/community";
import { normaliseEmail } from "@/lib/auth";
import { type Band, type HealthFactor, bandOf, scoreOf } from "@/lib/member-health-rules";

/** Pages of a hundred read for each live status. */
const MAX_PAGES = 10;
const CACHE_SECONDS = 10 * 60;
/**
 * The states of a running membership, each read on its own (Stripe filters a list by one status): never status=all
 * filtered here, where every ended membership takes a place in the pages and an older running member is never reached.
 */
const LIVE = ["active", "trialing", "past_due"] as const;
const SUBSCRIPTION_STATES = new Set(["active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]);
const cacheKey = (store: Store) => `nl:health:${store.statsId}`;

export type MemberRow = {
  sub: string;
  email: string;
  product: string;
  title: string;
  /** What it brings in a month, in the store's currency; 0 for one in another currency, so no total mixes two. */
  monthly: number;
  /** What it brings in a month in its own currency, to show beside it (22 [E5], unit 2e); absent on a copy kept before. */
  own?: { cents: number; currency: string };
  score: number;
  band: Band;
  factors: HealthFactor[];
  /** When the next payment is due, or the membership ends (seconds). */
  periodEnd: number;
  /** Whether the period runs out to an end the member chose. */
  ending: boolean;
  /** Stripe's state: "active", "trialing" or "past_due". */
  status: string;
};

export type Health = {
  at: number;
  currency: string;
  members: MemberRow[];
  counts: Record<Band, number>;
  /** The monthly revenue of the members at risk, in the store's currency. */
  atRisk: number;
  /** Members at risk paying in another currency than the store's: counted, never added to atRisk (22 [E5], unit 2e). */
  atRiskElsewhere?: number;
  /** Running memberships omitted because their own reporting evidence was incomplete. */
  unscored: number;
  complete: boolean;
};

type Raw = PauseSub & {
  id?: unknown;
  status?: unknown;
  currency?: unknown;
  start_date?: unknown;
  cancel_at_period_end?: unknown;
  cancel_at?: unknown;
  current_period_end?: unknown;
  metadata?: Record<string, string> | null;
  customer?: { email?: unknown } | string | null;
  items?: { data?: { quantity?: unknown; current_period_end?: unknown; price?: { unit_amount?: unknown; metadata?: Record<string, string> | null; recurring?: { interval?: unknown; interval_count?: unknown } | null } | null }[] };
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const natural = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const positive = (v: unknown): v is number => natural(v) && v > 0;
const INTERVALS = new Set(["day", "week", "month", "year"]);

/** Facts needed to count and price one known running member. */
function memberEvidence(raw: Raw) {
  const email = raw.customer && typeof raw.customer === "object" && !Array.isArray(raw.customer) && typeof raw.customer.email === "string"
    ? normaliseEmail(raw.customer.email)
    : "";
  const product = productOfSub(raw);
  const item = Array.isArray(raw.items?.data) ? raw.items.data[0] : undefined;
  const unitAmount = item?.price?.unit_amount;
  const quantity = item?.quantity;
  const interval = item?.price?.recurring?.interval;
  const intervalCount = item?.price?.recurring?.interval_count;
  const periodEnd = positive(item?.current_period_end) ? item.current_period_end : positive(raw.current_period_end) ? raw.current_period_end : 0;
  const currency = raw.currency;
  const startDate = raw.start_date;
  const amount = natural(unitAmount) && positive(quantity) ? unitAmount * quantity : NaN;
  if (!email || !product || typeof currency !== "string" || !/^[a-z]{3}$/.test(currency) ||
      !natural(amount) || typeof interval !== "string" || !INTERVALS.has(interval) || !positive(intervalCount) ||
      !positive(startDate) || !periodEnd || (raw.cancel_at_period_end !== undefined && typeof raw.cancel_at_period_end !== "boolean") ||
      (raw.cancel_at != null && !natural(raw.cancel_at))) throw new Error("Membership reporting evidence could not be confirmed");
  return { raw, email, product, amount, interval, intervalCount, periodEnd, currency };
}

/** A payment turned into a month: a year counts a twelfth, a week 52 twelfths. */
export function monthlyOf(amount: number, interval: string, count: number): number {
  const per = interval === "year" ? 1 / 12 : interval === "week" ? 52 / 12 : interval === "day" ? 365 / 12 : 1;
  return Math.round((amount * per) / Math.max(1, count));
}

/**
 * The store's running memberships, as Stripe holds them, with the member's address: each live status read on its own,
 * MAX_PAGES pages each. Not complete when a status had more than that, or when `deadline` (a daily run's, in ms) came
 * before the reading finished: no page is asked for once it has passed. The rows read are still returned.
 */
export async function runningMembers(store: Store, deadline = Infinity): Promise<{ rows: Raw[]; complete: boolean }> {
  const account = store.stripeAccountId;
  if (!account) return { rows: [], complete: true };
  const handles = saleHandles(store);
  const rows: Raw[] = [];
  const kept = new Set<string>();
  let complete = true;
  for (const status of LIVE) {
    const seen = new Set<string>();
    let after = "";
    let listDone = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      if (Date.now() >= deadline) break;
      const query = new URLSearchParams({ status, limit: "100" });
      query.append("expand[]", "data.customer");
      if (after) query.set("starting_after", after);
      const listed = await onAccount("GET", account, `/subscriptions?${query}`);
      if (!listed || listed.object !== "list" || !Array.isArray(listed.data) || listed.data.length > 100 ||
          typeof listed.has_more !== "boolean" || (listed.has_more && listed.data.length === 0)) throw new Error("Membership list could not be confirmed");
      const data = listed.data as Raw[];
      // Validate the entire page, including records filtered out below, before counting.
      for (const raw of data) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.id !== "string" || !/^sub_[A-Za-z0-9]+$/.test(raw.id) ||
            seen.has(raw.id) || typeof raw.status !== "string" || !SUBSCRIPTION_STATES.has(raw.status) ||
            !raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata) || Object.values(raw.metadata).some(value => typeof value !== "string")) throw new Error("Membership record could not be confirmed");
        seen.add(raw.id);
      }
      for (const raw of data) {
        const meta = raw.metadata ?? {};
        // Counted only in the reading of its own status, and once: one that moved between two readings is not counted twice.
        if (raw.status !== status || kept.has(raw.id as string)) continue;
        if (handles.has(meta.store ?? "") && meta.kind !== "plan") {
          kept.add(raw.id as string);
          rows.push(raw);
        }
      }
      if (!listed.has_more) {
        listDone = true;
        break;
      }
      after = data[data.length - 1].id as string;
    }
    if (!listDone) complete = false;
  }
  return { rows, complete };
}

/** Every evidenced running member with a score, plus the number omitted. */
async function scoredMembers(store: Store, rows: Raw[], now = Date.now()): Promise<{ members: MemberRow[]; unscored: number }> {
  const nowSeconds = Math.floor(now / 1000);
  const members: ReturnType<typeof memberEvidence>[] = [];
  let unscored = 0;
  for (const row of rows) {
    try {
      members.push(memberEvidence(row));
    } catch {
      unscored += 1;
    }
  }
  const ids = [...new Set(members.map((m) => m.product))];
  const listings = new Map((ids.length ? await readListings(store, ids) : []).map((p) => [p.id, p]));

  // The community, and which memberships open it.
  const community = store.community?.on ? store.community.id : "";
  const config = community ? await readConfig(community) : null;
  const opens = new Set(config?.access ?? []);
  const inCommunity = members.filter((m) => opens.has(m.product)).map((m) => m.email);
  // An unavailable activity reading is not evidence that every member never visited.
  // Refuse the report before it can be cached or used by the return-email job.
  const communitySeen = community && inCommunity.length ? await lastSeenIn(community, inCommunity) : new Map<string, number>();

  // Each course, and the members whose membership is it.
  const courseSeen = new Map<string, number>();
  const byCourse = new Map<string, string[]>();
  for (const m of members) {
    const course = listings.get(m.product)?.course?.id;
    if (course) byCourse.set(course, [...(byCourse.get(course) ?? []), m.email]);
  }
  for (const [course, emails] of byCourse) {
    const seen = await lastSeenMany(course, [...new Set(emails)]);
    for (const [email, at] of seen) courseSeen.set(`${course}|${email}`, at);
  }

  const scored = members
    .map(({ raw, email, product, amount, interval, intervalCount, periodEnd, currency }) => {
      const listing = listings.get(product);
      const course = listing?.course?.id ?? "";
      const meta = raw.metadata ?? {};
      // A membership sold to end after a set number of payments has its end from the start: that is not a choice to leave.
      const ending = !meta.ends_after && (raw.cancel_at_period_end === true || num(raw.cancel_at) > 0);
      const { score, factors } = scoreOf(
        {
          status: String(raw.status),
          setToEnd: ending,
          paused: pausedNow(raw, nowSeconds),
          courseSeen: course ? (courseSeen.get(`${course}|${email}`) ?? 0) : null,
          communitySeen: opens.has(product) ? (communitySeen.get(email) ?? 0) : null,
          since: raw.start_date as number,
        },
        nowSeconds,
      );
      const cents = monthlyOf(amount, interval, intervalCount);
      if (!natural(cents)) throw new Error("Membership reporting amount could not be confirmed");
      return {
        sub: String(raw.id),
        email,
        product,
        title: listing?.title ?? "",
        monthly: currency === store.currency ? cents : 0,
        own: { cents, currency },
        score,
        band: bandOf(score),
        factors,
        periodEnd,
        ending,
        status: String(raw.status),
      };
    })
    .sort((a, b) => a.score - b.score || b.monthly - a.monthly);
  return { members: scored, unscored };
}

/** Every evidenced running member with a score, the lowest first. */
export async function scoreMembers(store: Store, rows: Raw[], now = Date.now()): Promise<MemberRow[]> {
  return (await scoredMembers(store, rows, now)).members;
}

export async function memberHealth(store: Store, fresh = false, now = Date.now()): Promise<Health | null> {
  if (!store.stripeAccountId || !store.statsId) return null;
  if (!fresh && isRedisConfigured()) {
    const [cached] = await redisPipeline([["GET", cacheKey(store)]]);
    if (typeof cached === "string") {
      try {
        const health = JSON.parse(cached) as Health;
        // Copies written before omitted rows were counted cannot certify that
        // their zeroes are complete. Read the source again instead.
        if (natural(health.unscored)) return health;
      } catch {
        // Read again below.
      }
    }
  }
  const { rows, complete } = await runningMembers(store);
  const { members, unscored } = await scoredMembers(store, rows, now);
  const counts: Record<Band, number> = { well: 0, slipping: 0, risk: 0 };
  let atRisk = 0;
  let atRiskElsewhere = 0;
  for (const m of members) {
    counts[m.band] += 1;
    if (m.band !== "risk") continue;
    if (m.own && m.own.currency !== store.currency) atRiskElsewhere += 1;
    else atRisk += m.monthly;
  }
  const health: Health = { at: Math.floor(now / 1000), currency: store.currency, members, counts, atRisk, atRiskElsewhere, unscored, complete };
  if (isRedisConfigured()) await redisPipeline([["SET", cacheKey(store), JSON.stringify(health), "EX", CACHE_SECONDS]]).catch(() => {});
  return health;
}

/** Lets the ten-minute copy of the members' scores go, so a deleted person is not in it (lib/person-erasure.ts). */
export async function forgetHealthCopy(store: Store): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const replies = repliesFor(await redisPipeline([["DEL", cacheKey(store)]]), 1);
  const gone = countOf(replies?.[0]);
  // One key: 0 (it was not there) or 1 (deleted). Any other reply is unknown, so the step is not done and the
  // erasure says so, never a copy with the person in it counted as gone (CX-123 rule 24).
  if (gone === null || gone > 1) throw new UnknownReplyError("the deletion of the members' scores copy");
  return gone;
}
