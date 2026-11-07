/**
 * The affiliate directory (opened 11 October 2026): one page on
 * marktmorgen.com where people looking for something to promote find the
 * programs of the creators who said theirs may be listed
 * (lib/directory-index.ts keeps who said yes).
 *
 * What a row says is what an affiliate needs before applying, and nothing
 * that is not true of the program today: the store, the share of each sale,
 * how long after a click a sale still counts and which click wins, whether a
 * buyer stays theirs for later purchases, the day the creator pays and how
 * long a sale waits first, and the products that earn, each with what one
 * sale of it earns at today's price. Read from the store's own record, never
 * typed for the directory.
 *
 * And, only when the creator allows it too (a second box, apart from being
 * listed), the program's own numbers (lib/affiliates.ts, programNumbers):
 * its affiliates and since when, the clicks they brought and the sales those
 * clicks made, what they earned before refunds and what the creator recorded
 * as paid. A rate per click is shown only from MIN_CLICKS_FOR_RATES clicks.
 *
 * What it never says. No earnings an affiliate "can make", no ranking for
 * money, no score whose formula is kept from the people ranked by it: the
 * order is written on the page (DIRECTORY_ORDER), and nobody can pay to be
 * placed higher.
 *
 * Who is in it. A store whose creator said yes, whose program is on with a
 * share above 0, that can take a card today (lib/store-checkout.ts,
 * canSell), and that has at least one product an affiliate earns on. The
 * demo store never: it is a made-up store, and a made-up program in a list of
 * real ones would be a lie to every affiliate who applied to it.
 *
 * Money. Marktmorgen does not pay affiliates and never holds a sale: every
 * creator pays their own affiliates on the day they promise, as their program
 * page says. The directory says so too.
 *
 *   nl:dir:page   the rows, as JSON, kept 10 minutes; dropped whenever a
 *                 creator saves their program, so taking a store out is
 *                 immediate
 *   nl:dir:build  the claim of the last build, kept DIRECTORY_BUILD_SECONDS:
 *                 the page is built at most once in that time, site-wide
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { type Store, storeForId } from "@/lib/store";
import { recordListings, type Listing } from "@/lib/catalog";
import { RECURRING_ALWAYS, commissionOn, commissionRate } from "@/lib/affiliate-setting";
import { activeIntro } from "@/lib/intro-price";
import { activePlan } from "@/lib/product-extras";
import { canSell } from "@/lib/store-checkout";
import { isHouseStore } from "@/lib/house-store";
import { imageUrl } from "@/lib/product-image";
import { DIRECTORY_BUILD, DIRECTORY_CACHE, listedStores, wouldList } from "@/lib/directory-index";
import type { LanguageCode } from "@/lib/store-language";
import { programNumbers } from "@/lib/affiliates";
import { MIN_CLICKS_FOR_RATES } from "@/lib/affiliate-directory-rules";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";

export { MIN_CLICKS_FOR_RATES };

/** Products shown under one program: the rest are on its store. */
export const PRODUCTS_PER_ROW = 4;

/** How long the rows are kept before they are read again. */
const KEEP_SECONDS = 600;

/** The most programs read for the page: far past what one page lists. */
const MAX_ROWS = 2_000;

/** Sids asked of the listed set in one SSCAN page. */
const SCAN_COUNT = 200;

/**
 * The most SSCAN pages one build of the directory reads, so its Redis commands
 * have a ceiling before they are sent (MR: a ceiling before every spend). A
 * healthy walk takes MAX_ROWS / SCAN_COUNT = 10 pages at the most; the rest is
 * room for a set whose table is still sparse after many removals, where SCAN
 * legally answers pages with few or no members (R2/C4 on #2921 measured about
 * one more page per 15,000 members of past peak, so 64 covers a peak near a
 * million). A cursor still not back at "0" after these pages, with fewer than
 * MAX_ROWS stores read, is unknown: the read fails and nothing is kept, never a
 * partial list kept as the whole one. Counted in tests/plan-cost-registry.ts
 * (NOT_A_COST.DIRECTORY_SCAN_PAGES).
 */
export const DIRECTORY_SCAN_PAGES = 64;

/**
 * The fewest seconds between two builds of the directory, for the whole site (MR: a ceiling before every spend).
 * A save drops the kept page and a build that could not read every program's numbers keeps none, so without it
 * every visit after either would build again, and concurrent visits would all build at once. Each build first
 * claims DIRECTORY_BUILD for this long (SET NX EX): the claim is the single-flight lock and the interval in one key,
 * never released early. A visit that finds no kept page while the claim is held is told the list is unavailable
 * just now (DirectoryBusyError): never the page from before the save, which may still list a store whose creator
 * has just taken it out, and never an empty or partial list. Counted in tests/plan-cost-registry.ts
 * (NOT_A_COST.DIRECTORY_BUILDS_PER_HOUR).
 */
export const DIRECTORY_BUILD_SECONDS = 60;

/** The most builds of the directory in an hour, for the whole site. */
export const DIRECTORY_BUILDS_PER_HOUR = 3_600 / DIRECTORY_BUILD_SECONDS;

/** The page is not kept and another build holds the claim, or one ran less than DIRECTORY_BUILD_SECONDS ago. */
export class DirectoryBusyError extends Error {
  constructor() {
    super("The affiliate directory was built less than a minute ago and is not kept: unavailable just now");
    this.name = "DirectoryBusyError";
  }
}

export type DirectoryProduct = {
  id: string;
  title: string;
  priceCents: number;
  /** The share this product earns, in percent. */
  rate: number;
  /** What one sale earns at today's price, before any refund; for a membership, what one of its payments earns. */
  earnCents: number;
  /**
   * A membership, when the store credits them (lib/affiliate-setting.ts,
   * recurring): how many months of its payments earn, RECURRING_ALWAYS for as
   * long as the member pays. Absent for a product sold once (397 [SL1]).
   */
  months?: number;
  /** A membership's billing interval, so "a monthly payment" says how often (lib/product-recurring.ts). */
  interval?: "day" | "week" | "month" | "year";
  /** A membership's free days: the months above count from sign-up, the free days included (lib/affiliates.ts withinMonths). */
  trialDays?: number;
  /** Its first payments are at an introductory price, which earns less than the price shown. */
  intro?: boolean;
  /** It can also be paid in a payment plan, which earns nothing while the store does not credit memberships: only a sale paid in full earns. */
  paidInFull?: boolean;
  /** The product's picture, small, when it has one. */
  image: string | null;
};

export type DirectoryRow = {
  handle: string;
  name: string;
  language: LanguageCode;
  currency: string;
  /** The store-wide share, and the highest any listed product earns. */
  percent: number;
  topRate: number;
  /** What the best-paying product shown earns on one sale. */
  topEarnCents: number;
  days: number;
  rule: "first" | "last";
  lifetime: boolean;
  payday: number;
  hold: number;
  /** Whether a buyer may join at once, without applying. */
  buyers: boolean;
  products: DirectoryProduct[];
  /** How many products earn in all, of which `products` shows the first few. */
  earning: number;
  /** The program's own numbers, when its creator allowed them (lib/affiliates.ts, programNumbers); null otherwise. */
  numbers: DirectoryNumbers | null;
};

export type DirectoryNumbers = {
  affiliates: number;
  /** When the first affiliate was approved, in ms; 0 when none is yet. */
  since: number;
  clicks: number;
  /** Sales credited to a click, and what share of the clicks became one: null below MIN_CLICKS_FOR_RATES. */
  clickSales: number;
  conversion: number | null;
  /** What 100 clicks earned, before refunds: null below MIN_CLICKS_FOR_RATES. */
  per100Cents: number | null;
  /** Every sale credited to an affiliate, what they earned before refunds, and what the creator recorded as paid. */
  sales: number;
  earnedCents: number;
  paidCents: number;
};

/**
 * A product an affiliate earns on: paid, on the store, and not left out of the
 * program. A product sold once earns on each sale, also when it can be paid in
 * a payment plan (its one-time sale earns; 397 [SL1]); a membership earns on
 * its payments only when the store credits them (affiliates.recurring).
 */
function earns(store: Store, listing: Listing): DirectoryProduct | null {
  if (listing.priceCents <= 0 || listing.hidden) return null;
  const months = store.affiliates.recurring;
  if (listing.recurring && months <= 0) return null;
  // The months count from sign-up (lib/affiliates.ts withinMonths): a free trial as long as them leaves no payment that earns.
  const trialDays = listing.recurring?.trialDays ?? 0;
  if (listing.recurring && months < RECURRING_ALWAYS && trialDays >= months * 28) return null;
  const rate = commissionRate(store.affiliates, listing.id);
  if (rate <= 0) return null;
  const price = listing.options.length ? Math.min(...listing.options.map((option) => option.priceCents)) : listing.priceCents;
  if (!(price > 0)) return null;
  return {
    id: listing.id,
    title: listing.title,
    priceCents: price,
    rate,
    earnCents: commissionOn(price, rate),
    ...(listing.recurring ? { months, interval: listing.recurring.interval, ...(trialDays > 0 ? { trialDays } : {}) } : {}),
    ...(activeIntro(listing, store.tiers) ? { intro: true } : {}),
    ...(!listing.recurring && activePlan(listing) && months <= 0 ? { paidInFull: true } : {}),
    image: listing.image ? imageUrl(listing.image.small ? { path: listing.image.small.path } : listing.image) : null,
  };
}

/** The row a store gets, or null when it does not belong in the directory today. */
export function directoryRow(store: Store): DirectoryRow | null {
  if (!wouldList(store) || isHouseStore(store) || !canSell(store)) return null;
  const products = recordListings(store)
    .map((listing) => earns(store, listing))
    .filter((product): product is DirectoryProduct => product !== null);
  if (!products.length) return null;
  const best = products.reduce((top, product) => (product.earnCents > top.earnCents ? product : top), products[0]);
  const s = store.affiliates;
  return {
    handle: store.handle,
    name: store.name,
    language: store.language,
    currency: store.currency,
    percent: s.percent,
    topRate: Math.max(...products.map((product) => product.rate)),
    topEarnCents: best.earnCents,
    days: s.days,
    rule: s.rule,
    lifetime: s.lifetime,
    payday: s.payday,
    hold: s.hold,
    buyers: s.buyers,
    products: products.slice(0, PRODUCTS_PER_ROW),
    earning: products.length,
    numbers: null,
  };
}

/** A program's numbers as the directory shows them: rates only once there are enough clicks to mean something. */
export function directoryNumbers(raw: Awaited<ReturnType<typeof programNumbers>>): DirectoryNumbers | null {
  if (!raw) return null;
  const enough = raw.clicks >= MIN_CLICKS_FOR_RATES;
  return {
    affiliates: raw.affiliates,
    since: raw.since,
    clicks: raw.clicks,
    clickSales: raw.clickSales,
    conversion: enough ? Math.round((raw.clickSales / raw.clicks) * 1000) / 10 : null,
    per100Cents: enough ? Math.floor((raw.clickEarnedCents * 100) / raw.clicks) : null,
    sales: raw.sales,
    earnedCents: raw.earnedCents,
    paidCents: raw.paidCents,
  };
}

/**
 * The order the page lists programs in, as the page states it: the highest
 * share first; then the store with more products that earn; then by name.
 * Nothing about who pays Marktmorgen what, and no score of our own.
 */
export const DIRECTORY_ORDER =
  "Programs are listed by the highest share of a sale they pay, then by how many of their products earn, then by name. Nobody can pay to be placed higher, and the plan a creator is on plays no part.";

export function sortRows(rows: DirectoryRow[]): DirectoryRow[] {
  return [...rows].sort((a, b) => b.topRate - a.topRate || b.earning - a.earning || a.name.localeCompare(b.name, "en"));
}

/** Every listed program, read from the stores themselves, kept a few minutes. */
export async function readDirectory(): Promise<DirectoryRow[]> {
  if (!isRedisConfigured()) return [];
  const [kept] = await redisPipeline([["GET", DIRECTORY_CACHE]]);
  if (typeof kept === "string") {
    try {
      const rows = JSON.parse(kept) as DirectoryRow[];
      if (Array.isArray(rows)) return rows;
    } catch {
      // Read again below.
    }
  }
  // One build at a time, and at most one per DIRECTORY_BUILD_SECONDS: "OK" is ours, null (NX) is held by another or a
  // recent build, anything else is unknown and nothing is built.
  const claimed = repliesFor(await redisPipeline([["SET", DIRECTORY_BUILD, "1", "NX", "EX", DIRECTORY_BUILD_SECONDS]]), 1);
  if (!claimed || (claimed[0] !== "OK" && claimed[0] !== null)) throw new UnknownReplyError("the directory's build claim (SET NX)");
  if (claimed[0] === null) throw new DirectoryBusyError();
  // SSCAN may return a member more than once, in a page or across pages: each store is one row (Codex T on #2921).
  const sids = new Set<string>();
  let cursor = "0";
  let pages = 0;
  do {
    // Repeats and empty pages do not grow `sids`, so only a page count bounds a cursor that never ends (R2/C4 on #2921).
    if (pages === DIRECTORY_SCAN_PAGES) throw new UnknownReplyError(`the directory's SSCAN, not at its end after ${DIRECTORY_SCAN_PAGES} pages,`);
    const page = await listedStores(cursor, SCAN_COUNT);
    pages += 1;
    for (const sid of page.sids) sids.add(sid);
    cursor = page.next;
  } while (cursor !== "0" && sids.size < MAX_ROWS);
  // A store read that failed is not a program that is not there: the read fails
  // and nothing is kept, and the page says the list could not be checked.
  const stores = await Promise.all([...sids].slice(0, MAX_ROWS).map((sid) => storeForId(sid)));
  // A failed numbers read still shows the row without numbers, but that page is
  // not kept for the next visitors.
  let partial = false;
  const rows = sortRows(
    (
      await Promise.all(
        stores.map(async (store) => {
          const row = store ? directoryRow(store) : null;
          if (!row || !store || !store.affiliates.numbers) return row;
          const numbers = await programNumbers(store).catch(() => {
            partial = true;
            return null;
          });
          return { ...row, numbers: directoryNumbers(numbers) };
        }),
      )
    ).filter((row): row is DirectoryRow => row !== null),
  );
  if (!partial) await redisPipeline([["SET", DIRECTORY_CACHE, JSON.stringify(rows), "EX", KEEP_SECONDS]]).catch(() => null);
  return rows;
}
