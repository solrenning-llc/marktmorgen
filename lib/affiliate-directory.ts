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
 *   nl:dir:page   the rows, as JSON, kept an hour; dropped whenever a
 *                 creator saves their program, so taking a store out is
 *                 immediate
 *   nl:dir:build  the build mark (lib/directory-index.ts, DIRECTORY_BUILD):
 *                 one build at a time, and none for ten minutes after one
 *                 that could not finish
 *   nl:dir:builds the builds counted in the window's hour, at most
 *                 DIRECTORY_BUILDS_PER_HOUR (DIRECTORY_BUILDS)
 *   nl:dir:last   the last good build's rows with the sid of each, kept
 *                 LAST_KEEP_SECONDS and never dropped by a save: past the
 *                 ceiling, a visit is shown them without every store no
 *                 longer listed (DIRECTORY_LAST)
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
import { DIRECTORY_BUILD, DIRECTORY_BUILDS, DIRECTORY_CACHE, DIRECTORY_LAST, listedStores, stillListed, wouldList } from "@/lib/directory-index";
import type { LanguageCode } from "@/lib/store-language";
import { programNumbers } from "@/lib/affiliates";
import { MIN_CLICKS_FOR_RATES } from "@/lib/affiliate-directory-rules";
import { UnknownReplyError, repliesFor } from "@/lib/redis-reply";

export { MIN_CLICKS_FOR_RATES };

/** Products shown under one program: the rest are on its store. */
export const PRODUCTS_PER_ROW = 4;

/**
 * The window the builds of the directory are counted in, for the whole site, and the most builds in it (MR: a ceiling
 * before every spend): one an hour. The owner's decision through the coordinator (C1-20261109-1603-TODOS-71, on
 * #3118): "US$ 69,51/mês é custo fixo da empresa e não aprovo. Use 1 montagem por hora (DIRECTORY_BUILD_SECONDS =
 * 3600) ... Loja retirada continua saindo na hora. Listagem nova pode levar até 1 hora, e a tela não deve prometer
 * menos." #2921's mark lets one build run at a time, but a save of a listed program drops the kept page; each build
 * reserves its place in the window's count (DIRECTORY_BUILDS, INCR) once it holds the mark and before it reads
 * anything. Past DIRECTORY_BUILDS_PER_HOUR, or with a count whose reply is unknown, nothing is built and the visit is
 * shown the last good build without every store no longer in the listed set (lastDirectory), so a store taken out
 * leaves at once and a new listing or a change shows at the next build, within the hour. At most 720 builds in 30
 * days, priced in tests/plan-cost-registry.ts (NOT_A_COST.DIRECTORY_BUILDS_PER_HOUR); the count's end is set once,
 * on a count that has none.
 */
export const DIRECTORY_BUILD_SECONDS = 3_600;

/** The most builds of the directory in one window of DIRECTORY_BUILD_SECONDS, for the whole site. */
export const DIRECTORY_BUILDS_PER_HOUR = 1;

/** The window the builds are counted in. */
const BUILD_WINDOW_SECONDS = DIRECTORY_BUILD_SECONDS;

/** How long the rows are kept before they are read again: the window, since no build may come sooner. */
const KEEP_SECONDS = DIRECTORY_BUILD_SECONDS;

/**
 * How long one build holds the build mark before another may start: past the
 * longest a healthy build takes, so a build cut short (a function stopped
 * mid-way) holds the page "unavailable" for at most this long.
 */
const BUILD_HOLD_SECONDS = 60;

/**
 * How long, after a build that could not finish, the page answers "could not
 * be checked" without building again: ten minutes. The failed build has
 * already spent the window's place, so this only spares the count's reads; it
 * is not the window, so after it a visit is shown the last good build rather
 * than "unavailable" for the rest of the hour.
 */
const FAILED_SECONDS = 600;

/**
 * How long the last good build is kept (nl:dir:last): the kept page's hour and one more window, so a visit
 * past the ceiling has it whenever in the window the ceiling was reached. Older than that, the visit is told the
 * list is unavailable rather than shown rows from longer ago.
 */
const LAST_KEEP_SECONDS = KEEP_SECONDS + BUILD_WINDOW_SECONDS;

/** Past the window's ceiling with no last good build kept: the page says the list is unavailable just now. */
export class DirectoryBusyError extends Error {
  constructor() {
    super("The affiliate directory was built as often as a window allows and no last build is kept: unavailable just now");
    this.name = "DirectoryBusyError";
  }
}

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

/**
 * Every listed program, read from the stores themselves, kept a few minutes.
 *
 * At most one build runs at a time, and none for FAILED_SECONDS after one that
 * could not finish (a store read that failed, a numbers read that failed, the
 * SSCAN page ceiling; #2921, CX-116 A1): before building, the build mark
 * (DIRECTORY_BUILD) is taken with SET NX. A read that finds no kept page and
 * cannot take the mark throws UnknownReplyError, so the page shows its own
 * "The program list is unavailable just now" state; it never builds again and
 * never shows a list that was not read whole. A finished build keeps the page
 * and drops the mark; one that could not finish sets the mark to "failed" for
 * FAILED_SECONDS. A failed numbers read still shows that build's rows without
 * those numbers to the one request that built them, and keeps no page.
 *
 * Once the mark is taken, the build reserves its place in the window's count
 * (reserveBuild). Past DIRECTORY_BUILDS_PER_HOUR, or when the count's
 * reply is unknown (rule 24: never room to build), nothing is built: the mark is
 * dropped in the same pipeline as the last good build is read, and the visit is
 * shown that build without every store no longer listed (lastDirectory). A
 * finished build keeps that last build too, with the sid of each row.
 */
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
  const [claim] = await redisPipeline([["SET", DIRECTORY_BUILD, "building", "EX", BUILD_HOLD_SECONDS, "NX"]]);
  // null: another build is running, or one could not finish FAILED_SECONDS ago. Any other shape is unknown, and builds nothing either.
  if (claim !== "OK") throw new UnknownReplyError(claim === null ? "the directory's build mark, held," : "the directory's build mark");
  const room = await reserveBuild().catch(() => "unknown" as const);
  if (room !== "build") return lastDirectory(room);
  let built: { rows: DirectoryRow[]; sids: string[]; partial: boolean };
  try {
    built = await buildDirectory();
  } catch (error) {
    await markFailed();
    throw error;
  }
  if (built.partial) {
    await markFailed();
  } else {
    await redisPipeline([
      ["SET", DIRECTORY_CACHE, JSON.stringify(built.rows), "EX", KEEP_SECONDS],
      ["SET", DIRECTORY_LAST, JSON.stringify({ sids: built.sids, rows: built.rows }), "EX", LAST_KEEP_SECONDS],
      ["DEL", DIRECTORY_BUILD],
    ]).catch(() => null);
  }
  return listedAfterBuild(built);
}

/**
 * A creator who unchecked "List my program" while this build ran leaves the page at once (Claude 6 on #3118): the
 * build read the store before the save's SREM and DEL, and its SET may have written the store back, to be kept the
 * whole hour. So the listed set is asked once, after the SETs (one SMISMEMBER of the sids it built): a store no longer
 * in it drops the kept page, and so does a reply in any other shape (rule 24: then the build is unknown and says so,
 * never the rows unchecked). Against the save's SREM-then-DEL this is linearizable: an SREM before this check is seen
 * here; one after it is followed by the save's own DEL. The last good build (nl:dir:last) is filtered the same way
 * whenever it is shown (lastDirectory).
 */
async function listedAfterBuild(built: { rows: DirectoryRow[]; sids: string[]; partial: boolean }): Promise<DirectoryRow[]> {
  if (!built.sids.length) return built.rows;
  let listed: boolean[] | null = null;
  try {
    listed = await stillListed(built.sids);
  } catch {
    listed = null;
  }
  if (listed && listed.every(Boolean)) return built.rows;
  if (!built.partial) await redisPipeline([["DEL", DIRECTORY_CACHE]]);
  if (!listed) throw new UnknownReplyError("the directory's listed set after a build (SMISMEMBER)");
  const still = listed;
  return built.rows.filter((_, at) => still[at]);
}

/**
 * This build's place in the window's count: "build" inside DIRECTORY_BUILDS_PER_HOUR, "full" past it,
 * "unknown" for any reply not in the exact shape asked for (a count that is a positive whole number, a TTL that is a
 * whole number of -1 or more; -2, the count gone, is unknown). A count with no end (TTL -1: just made, or left so by
 * a write cut short) gets the window's seconds, and an EXPIRE that does not answer 1 is unknown.
 */
async function reserveBuild(): Promise<"build" | "full" | "unknown"> {
  const counted = repliesFor(await redisPipeline([["INCR", DIRECTORY_BUILDS], ["TTL", DIRECTORY_BUILDS]]), 2);
  if (!counted) return "unknown";
  const [count, left] = counted;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) return "unknown";
  if (typeof left !== "number" || !Number.isSafeInteger(left) || left < -1) return "unknown";
  if (left === -1) {
    const ended = repliesFor(await redisPipeline([["EXPIRE", DIRECTORY_BUILDS, BUILD_WINDOW_SECONDS]]), 1);
    if (!ended || ended[0] !== 1) return "unknown";
  }
  return count <= DIRECTORY_BUILDS_PER_HOUR ? "build" : "full";
}

/**
 * The last good build, without every store no longer in the listed set, for a visit that may not build: nothing is
 * kept from it. The build mark is dropped in the same pipeline, so the next visit is not held by a build that never
 * ran (the DEL's own reply changes nothing: a mark it did not drop ends by its BUILD_HOLD_SECONDS). No last build is
 * DirectoryBusyError past the ceiling and UnknownReplyError after an unknown count; a reply in any other shape, or
 * rows that do not match their sids, is UnknownReplyError, never the rows unfiltered or an empty list.
 */
async function lastDirectory(room: "full" | "unknown"): Promise<DirectoryRow[]> {
  const replies = repliesFor(await redisPipeline([["DEL", DIRECTORY_BUILD], ["GET", DIRECTORY_LAST]]), 2);
  if (!replies) throw new UnknownReplyError("the directory's last build (GET)");
  const reply = replies[1];
  if (reply === null) {
    if (room === "full") throw new DirectoryBusyError();
    throw new UnknownReplyError("the directory's build count");
  }
  let last: unknown = null;
  try {
    last = typeof reply === "string" ? JSON.parse(reply) : null;
  } catch {
    last = null;
  }
  const { sids, rows } = (last ?? {}) as { sids?: unknown; rows?: unknown };
  if (!Array.isArray(sids) || !Array.isArray(rows) || sids.length !== rows.length || sids.some((sid) => typeof sid !== "string" || !sid)) {
    throw new UnknownReplyError("the directory's last build (GET)");
  }
  const listed = await stillListed(sids as string[]);
  return (rows as DirectoryRow[]).filter((_, at) => listed[at]);
}

/** A build that could not finish: the next ones wait FAILED_SECONDS. A mark that cannot be written still ends by its BUILD_HOLD_SECONDS. */
async function markFailed(): Promise<void> {
  await redisPipeline([["SET", DIRECTORY_BUILD, "failed", "EX", FAILED_SECONDS]]).catch(() => null);
}

/** One build of the rows from the listed set and the stores, with each row's sid; `partial` when a numbers read failed. */
async function buildDirectory(): Promise<{ rows: DirectoryRow[]; sids: string[]; partial: boolean }> {
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
  // Each row's sid, kept with the last good build so a visit past the ceiling can drop a store taken out.
  const sidOf = new Map<DirectoryRow, string>();
  const rows = sortRows(
    (
      await Promise.all(
        stores.map(async (store) => {
          const row = store ? directoryRow(store) : null;
          if (!row || !store) return row;
          if (!store.affiliates.numbers) {
            sidOf.set(row, store.sid);
            return row;
          }
          const numbers = await programNumbers(store).catch(() => {
            partial = true;
            return null;
          });
          const counted = { ...row, numbers: directoryNumbers(numbers) };
          sidOf.set(counted, store.sid);
          return counted;
        }),
      )
    ).filter((row): row is DirectoryRow => row !== null),
  );
  return { rows, sids: rows.map((row) => sidOf.get(row) ?? ""), partial };
}
