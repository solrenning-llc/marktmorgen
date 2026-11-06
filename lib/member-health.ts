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
import { onAccount } from "@/lib/stripe-account";
import { type Store, saleHandles } from "@/lib/store";
import { readListings } from "@/lib/catalog";
import { productOfSub } from "@/lib/tier-rules";
import { type PauseSub, pausedNow } from "@/lib/membership-pause-rules";
import { lastSeenMany } from "@/lib/learn";
import { lastSeenIn, readConfig } from "@/lib/community";
import { normaliseEmail } from "@/lib/auth";
import { type Band, type HealthFactor, bandOf, scoreOf } from "@/lib/member-health-rules";

const MAX_PAGES = 10;
const CACHE_SECONDS = 10 * 60;
const LIVE = new Set(["active", "trialing", "past_due"]);
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

/** A payment turned into a month: a year counts a twelfth, a week 52 twelfths. */
export function monthlyOf(amount: number, interval: string, count: number): number {
  const per = interval === "year" ? 1 / 12 : interval === "week" ? 52 / 12 : interval === "day" ? 365 / 12 : 1;
  return Math.round((amount * per) / Math.max(1, count));
}

/** The store's running memberships, as Stripe holds them, with the member's address. */
export async function runningMembers(store: Store): Promise<{ rows: Raw[]; complete: boolean }> {
  const account = store.stripeAccountId;
  if (!account) return { rows: [], complete: true };
  const handles = saleHandles(store);
  const rows: Raw[] = [];
  let after = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const query = new URLSearchParams({ status: "all", limit: "100" });
    query.append("expand[]", "data.customer");
    if (after) query.set("starting_after", after);
    const listed = (await onAccount("GET", account, `/subscriptions?${query}`)) as { data?: unknown; has_more?: unknown };
    const data = (Array.isArray(listed.data) ? listed.data : []) as Raw[];
    for (const raw of data) {
      const meta = raw.metadata ?? {};
      if (handles.has(meta.store ?? "") && meta.kind !== "plan" && LIVE.has(String(raw.status))) rows.push(raw);
    }
    const last = data[data.length - 1];
    if (listed.has_more !== true || !last || typeof last.id !== "string") return { rows, complete: true };
    after = last.id;
  }
  return { rows, complete: false };
}

/** Every running member with a score, the lowest first. */
export async function scoreMembers(store: Store, rows: Raw[], now = Date.now()): Promise<MemberRow[]> {
  const nowSeconds = Math.floor(now / 1000);
  const members = rows
    .map((raw) => {
      const email = raw.customer && typeof raw.customer === "object" && typeof raw.customer.email === "string" ? normaliseEmail(raw.customer.email) : "";
      return { raw, email, product: productOfSub(raw) };
    })
    .filter((m) => m.email && m.product);
  const ids = [...new Set(members.map((m) => m.product))];
  const listings = new Map((ids.length ? await readListings(store, ids).catch(() => []) : []).map((p) => [p.id, p]));

  // The community, and which memberships open it.
  const community = store.community?.on ? store.community.id : "";
  const config = community ? await readConfig(community).catch(() => null) : null;
  const opens = new Set(config?.access ?? []);
  const inCommunity = members.filter((m) => opens.has(m.product)).map((m) => m.email);
  const communitySeen = community && inCommunity.length ? await lastSeenIn(community, inCommunity).catch(() => new Map<string, number>()) : new Map<string, number>();

  // Each course, and the members whose membership is it.
  const courseSeen = new Map<string, number>();
  const byCourse = new Map<string, string[]>();
  for (const m of members) {
    const course = listings.get(m.product)?.course?.id;
    if (course) byCourse.set(course, [...(byCourse.get(course) ?? []), m.email]);
  }
  for (const [course, emails] of byCourse) {
    const seen = await lastSeenMany(course, [...new Set(emails)]).catch(() => new Map<string, number>());
    for (const [email, at] of seen) courseSeen.set(`${course}|${email}`, at);
  }

  return members
    .map(({ raw, email, product }) => {
      const listing = listings.get(product);
      const course = listing?.course?.id ?? "";
      const meta = raw.metadata ?? {};
      const item = raw.items?.data?.[0];
      const amount = num(item?.price?.unit_amount) * (num(item?.quantity) || 1);
      const interval = typeof item?.price?.recurring?.interval === "string" ? item.price.recurring.interval : "month";
      const count = num(item?.price?.recurring?.interval_count) || 1;
      // A membership sold to end after a set number of payments has its end from the start: that is not a choice to leave.
      const ending = !meta.ends_after && (raw.cancel_at_period_end === true || num(raw.cancel_at) > 0);
      const { score, factors } = scoreOf(
        {
          status: String(raw.status),
          setToEnd: ending,
          paused: pausedNow(raw, nowSeconds),
          courseSeen: course ? (courseSeen.get(`${course}|${email}`) ?? 0) : null,
          communitySeen: opens.has(product) ? (communitySeen.get(email) ?? 0) : null,
          since: num(raw.start_date),
        },
        nowSeconds,
      );
      // The currency it pays in, lowercased; the store's when Stripe says none, so a missing one is never counted apart.
      const currency = typeof raw.currency === "string" && raw.currency ? raw.currency.toLowerCase() : store.currency;
      const cents = monthlyOf(amount, interval, count);
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
        periodEnd: num(item?.current_period_end) || num(raw.current_period_end),
        ending,
        status: String(raw.status),
      };
    })
    .sort((a, b) => a.score - b.score || b.monthly - a.monthly);
}

export async function memberHealth(store: Store, fresh = false, now = Date.now()): Promise<Health | null> {
  if (!store.stripeAccountId || !store.statsId) return null;
  if (!fresh && isRedisConfigured()) {
    const [cached] = await redisPipeline([["GET", cacheKey(store)]]);
    if (typeof cached === "string") {
      try {
        return JSON.parse(cached) as Health;
      } catch {
        // Read again below.
      }
    }
  }
  const { rows, complete } = await runningMembers(store);
  const members = await scoreMembers(store, rows, now);
  const counts: Record<Band, number> = { well: 0, slipping: 0, risk: 0 };
  let atRisk = 0;
  let atRiskElsewhere = 0;
  for (const m of members) {
    counts[m.band] += 1;
    if (m.band !== "risk") continue;
    if (m.own && m.own.currency !== store.currency) atRiskElsewhere += 1;
    else atRisk += m.monthly;
  }
  const health: Health = { at: Math.floor(now / 1000), currency: store.currency, members, counts, atRisk, atRiskElsewhere, complete };
  if (isRedisConfigured()) await redisPipeline([["SET", cacheKey(store), JSON.stringify(health), "EX", CACHE_SECONDS]]).catch(() => {});
  return health;
}

/** Lets the ten-minute copy of the members' scores go, so a deleted person is not in it (lib/person-erasure.ts). */
export async function forgetHealthCopy(store: Store): Promise<number> {
  if (!store.statsId || !isRedisConfigured()) return 0;
  const [gone] = await redisPipeline([["DEL", cacheKey(store)]]);
  return Number(gone) || 0;
}
