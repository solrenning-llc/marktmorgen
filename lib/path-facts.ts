/**
 * The facts Marktmorgen Path is read from (lib/path-rules.ts, PathFacts),
 * each from a record the store already keeps (docs/marktmorgen-path.md has
 * the inventory). Nothing here writes, and nothing new is counted for it:
 *
 *   title, line    the store's own record (name, bio)
 *   products       the store's catalog: items not hidden, and the first
 *                  page's listings for what each hands over
 *   social visits  the all-time record of the store's numbers (lib/stats.ts):
 *   visitors       r:<source> for every social network, and u; one command
 *   leads          the same record's fs:<channel>: addresses asked for on the
 *                  store (a free product, the sign-up box, a waitlist)
 *   post links     the store's short links (lib/short-links.ts): one command
 *   sales, money   the creator's own Stripe account, the ledger: paid
 *                  checkouts and one-click extras of this store, each with
 *                  Stripe's livemode, less the refunds made on them
 *
 * Money is counted the way only Stripe can confirm it: a checkout Stripe says
 * is complete and paid, in live mode for a real sale and test mode for the
 * test purchase, never a page that said "thanks". A refund in full takes a
 * sale off; refunds are taken off the money; what Stripe could not be asked
 * about leaves the money unknown (null), so no level moves on it. PayPal's
 * sales carry no test mode and are not counted here (docs/marktmorgen-path.md).
 */
import { KIND } from "@/lib/catalog";
import {saleHandles,type Store} from "@/lib/store";
import {pathGrowthMoney,type PathGrowthMoney} from "@/lib/path-growth-money";
import { readLifeRecord, readPaidSales, readStoreRefunds } from "@/lib/stats";
import { countLinks } from "@/lib/short-links";
import { sellsInTestMode } from "@/lib/stripe-connect";
import { type PathFacts, SOCIAL_SOURCES } from "@/lib/path-rules";

/** Pages of a hundred checkouts read for the path, and of refunds: bounded like every reading of the ledger. */
export const PATH_SALE_PAGES = 3;
export const PATH_REFUND_PAGES = 3;
/** How long a reading of the money is reused before Stripe is asked again. */
export const PATH_MONEY_SECONDS = 600;

/** What the path keeps of a reading of Stripe (lib/path.ts keeps it in the store's path record). */
export type PathMoney = {
  /** Non-identifying post-sale witnesses from the same bounded Stripe reading. */
  growth?:PathGrowthMoney;
  /** When it was read, in milliseconds. */
  at: number;
  /** A paid checkout in test mode was seen. */
  test: boolean;
  /** Real paid orders not refunded in full. */
  real: number;
  /** Real money kept in the store's currency, refunds taken off; null when not known in full. */
  cents: number | null;
  /** The currency `cents` is in. */
  currency: string;
};

type Sold = { cents: number; currency: string; intent: string; live: boolean | null };

/** What the path counts from the sales and refunds read. Pure, for the tests. */
export function moneyFrom(sold: Sold[], refunds: { cents: number; currency: string; paymentIntent: string }[] | null, currency: string, at: number): PathMoney {
  const test = sold.some((s) => s.live === false);
  const real = sold.filter((s) => s.live === true);
  const back = new Map<string, number>();
  let unmatched = 0;
  let unmatchedRows = 0;
  const intents = new Set(real.map((s) => s.intent).filter(Boolean));
  for (const r of refunds ?? []) {
    if (r.paymentIntent && intents.has(r.paymentIntent)) back.set(r.paymentIntent, (back.get(r.paymentIntent) ?? 0) + r.cents);
    else if (r.currency === currency) {
      unmatched += r.cents;
      unmatchedRows += 1;
    }
  }
  // A sale Stripe names a payment for is judged by that payment's refunds. A
  // membership's first payment carries none on its checkout: the refunds no
  // read sale claims may be theirs, so they are taken off those, never left out.
  const named = real.filter((s) => s.intent);
  const unnamed = real.filter((s) => !s.intent);
  const keptNamed = named.filter((s) => (back.get(s.intent) ?? 0) < s.cents).length;
  const keptUnnamed = Math.max(0, unnamed.length - unmatchedRows);
  let cents: number | null = null;
  if (refunds !== null) {
    const own = (list: Sold[]) => list.filter((s) => s.currency === currency);
    const fromNamed = own(named).reduce((n, s) => n + Math.max(0, s.cents - (back.get(s.intent) ?? 0)), 0);
    const fromUnnamed = Math.max(0, own(unnamed).reduce((n, s) => n + s.cents, 0) - unmatched);
    cents = fromNamed + fromUnnamed;
  }
  return { at, test, real: keptNamed + keptUnnamed, cents, currency };
}

/**
 * Reads the store's sales and refunds from its Stripe account. Null when
 * Stripe could not be asked at all: the path then shows the last reading it
 * kept, never a guess.
 */
export async function readPathMoney(store: Store, now = Date.now()): Promise<PathMoney | null> {
  if (!store.stripeAccountId) return { at: now, test: false, real: 0, cents: 0, currency: store.currency };
  let sales;let partial=false;
  try {
    ({ sales,partial } = await readPaidSales(store, 0, PATH_SALE_PAGES));
  } catch (error) {
    console.error("reading a store's sales for its path failed", store.handle, error);
    return null;
  }
  const sold: Sold[] = sales
    .filter((s) => {
      const meta = (s.row.metadata ?? {}) as Record<string, unknown>;
      // A gift through "Support my work" sold nothing, and a payment request is a bill, not an order from the store.
      return s.cents > 0 && meta.kind !== "tip" && meta.kind !== "request";
    })
    .map((s) => ({ cents: s.cents, currency: s.currency, intent: s.paymentIntent, live: typeof s.row.livemode === "boolean" ? s.row.livemode : null }));
  const realOnes = sold.filter((s) => s.live === true);
  let refunds: { cents: number; currency: string; paymentIntent: string }[] | null = [];
  if (realOnes.length) {
    const since = Math.floor(Math.min(...sales.filter((s) => s.row.livemode === true).map((s) => s.created)) / 1000);
    try {
      const read = await readStoreRefunds(store, since, PATH_REFUND_PAGES);
      // Refunds not all read: the money is not known, and no level moves on it.
      refunds = read.partial ? null : read.rows;
    } catch (error) {
      console.error("reading a store's refunds for its path failed", store.handle, error);
      refunds = null;
    }
  }
  return {...moneyFrom(sold, refunds, store.currency, now),growth:pathGrowthMoney(sales,refunds,saleHandles(store),partial)};
}

/** Whether a kept reading is still fresh enough to show without asking Stripe again. */
export function moneyFresh(money: PathMoney | null, store: Pick<Store, "currency">, now = Date.now()): boolean {
  return Boolean(money && money.currency === store.currency && now - money.at >= 0 && now - money.at < PATH_MONEY_SECONDS * 1000);
}

/**
 * The counts the path reads from the store's numbers and its short links,
 * kept with the path's record and read again at most every
 * PATH_MONEY_SECONDS, like the money: what the numbers' all-time record
 * holds can weigh up to LIFE_WRITE_MAX fields (lib/stats.ts), so it is not
 * read on every opening.
 */
export type PathCounts = {
  /** When they were read, in milliseconds. */
  at: number;
  /** Visits from social networks, all time. */
  social: number;
  /** Visitors, all time. */
  visitors: number;
  /** Short links made. */
  links: number;
  /** Addresses that used their confirmation link on the store, each once (lib/path-lead.ts, 13 [D10]). */
  leads: number;
};

/** What the path counts from the all-time record and the links. Pure, for the tests. */
export function countsFrom(life: Map<string, number>, links: number, at: number): PathCounts {
  let social = 0;
  let leads = 0;
  for (const [field, count] of life) {
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (field.startsWith("r:") && SOCIAL_SOURCES.includes(field.slice(2))) social += n;
    // Only addresses that used their confirmation link, each counted once for the store (lib/path-lead.ts, 13 [D10]),
    // never the ones only asked for (fs:<channel>), which the store's numbers keep.
    if (field === "lc") leads += n;
  }
  const visitors = Number(life.get("u") ?? 0);
  return { at, social, visitors: Number.isFinite(visitors) ? Math.max(0, Math.floor(visitors)) : 0, links: Math.max(0, Math.floor(links)), leads };
}

/** Reads the counts: two commands. Null when the database could not be read, so the last reading is shown instead of zeros. */
export async function readPathCounts(store: Store, now = Date.now()): Promise<PathCounts | null> {
  try {
    const [life, links] = await Promise.all([readLifeRecord(store.statsId), countLinks(store.statsId)]);
    return countsFrom(life, links, now);
  } catch (error) {
    console.error("reading a store's numbers for its path failed", store.handle, error);
    return null;
  }
}

/** Whether kept counts are fresh enough to show without reading them again. */
export function countsFresh(counts: PathCounts | null, now = Date.now()): boolean {
  return Boolean(counts && now - counts.at >= 0 && now - counts.at < PATH_MONEY_SECONDS * 1000);
}

/** The facts, read now: the counts and, when given none, nothing of the money. For the tests and the reminder job's checks. */
export async function readPathFacts(store: Store, money: PathMoney | null): Promise<PathFacts> {
  return factsFrom(store, await readPathCounts(store), money);
}

/** The facts from the store's own record, the counts and the money as kept. Pure, for the tests. */
export function factsFrom(store: Store, counts: PathCounts | null, money: PathMoney | null): PathFacts {
  const listed = store.catalog.items.filter((item) => (item.kind & KIND.hidden) === 0);
  const shelf = [...store.catalog.head, ...(store.catalog.inline ?? [])].filter((p) => !p.hidden);
  const handsOver = shelf.some((p) => Boolean(p.file || p.link || p.course || p.options.some((o) => o.file || o.link)));
  const testMode = sellsInTestMode(store);
  const sameCurrency = money !== null && money.currency === store.currency;
  return {
    titlePublished: store.name.trim().length > 0 && store.bio.trim().length > 0,
    listedProducts: listed.length,
    productWithFile: listed.length > 0 && handsOver,
    testPurchase: money?.test ? "done" : testMode ? "open" : "unavailable",
    socialVisits: counts?.social ?? 0,
    visitors: counts?.visitors ?? 0,
    postLinks: counts?.links ?? 0,
    leads: counts?.leads ?? 0,
    realSales: money?.real ?? 0,
    revenueCents: sameCurrency ? money.cents : null,
    currency: store.currency,
    testMode,
  };
}
