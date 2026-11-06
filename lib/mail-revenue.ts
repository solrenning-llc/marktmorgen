/**
 * What each email sold, read from the creator's own Stripe account.
 *
 * Links to the store in an email arrive tagged with the email they came from
 * (lib/mail-links.ts); the checkout writes the tag on the sale
 * (lib/came-from.ts); this adds the sales up by tag. Nothing here is kept
 * about anybody: the figures are a count and a sum, cached for ten minutes
 * so that opening the email page does not ask Stripe every time.
 *
 *   nl:stats:<statsId>:mailsales:v2 the last reading (JSON), for ten minutes
 *   nl:stats:<statsId>:mailvisits   the same for visits, for ten minutes
 *
 * What a figure means, exactly: checkouts paid on the page one of that
 * email's links opened, in the store's own currency, over the last
 * STATS_DAYS days; sales in another currency are counted apart
 * (`elsewhere`), never added. A one-click extra taken after such a checkout is not
 * added, and neither is somebody who came back later by themselves.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { STATS_DAYS, campaignViews, readPaidSales } from "@/lib/stats";
import { MAIL_SOURCE, broadcastCampaigns, flowCampaignPrefix } from "@/lib/mail-links";
import type { Store } from "@/lib/store";

/** Sales and their money in the store's currency; `elsewhere` counts the sales in another currency than the store's, never added (22 [E5], unit 2d). */
export type MailMoney = { sales: number; cents: number; elsewhere?: number };
export type MailRevenue = { by: Record<string, MailMoney>; partial: boolean };

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const hasOnlyKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []): boolean => {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function mailRevenueEvidence(value: unknown): MailRevenue | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ["by", "partial"]) || typeof value.partial !== "boolean" || !isPlainRecord(value.by)) return null;
  const by: Record<string, MailMoney> = Object.create(null) as Record<string, MailMoney>;
  for (const [campaign, raw] of Object.entries(value.by)) {
    if (!campaign || !isPlainRecord(raw) || !hasOnlyKeys(raw, ["sales", "cents"], ["elsewhere"]) || !count(raw.sales) || !count(raw.cents)) return null;
    if (Object.hasOwn(raw, "elsewhere") && !count(raw.elsewhere)) return null;
    by[campaign] = Object.hasOwn(raw, "elsewhere")
      ? { sales: raw.sales, cents: raw.cents, elsewhere: raw.elsewhere as number }
      : { sales: raw.sales, cents: raw.cents };
  }
  return { by, partial: value.partial };
}

type VisitEvidence = { known: true; value: Record<string, number>; complete: boolean } | { known: false };

function visitEvidence(value: unknown, broadcastIds: string[]): VisitEvidence {
  if (!isPlainRecord(value)) return { known: false };
  const by: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [broadcastId, raw] of Object.entries(value)) {
    if (!broadcastId || !count(raw)) return { known: false };
    by[broadcastId] = raw;
  }
  return { known: true, value: by, complete: broadcastIds.every((id) => Object.hasOwn(by, id)) };
}

type CacheReply = { known: true; value: string | null } | { known: false };
function oneCacheReply(reply: unknown): CacheReply {
  if (!Array.isArray(reply) || reply.length !== 1) return { known: false };
  const value = reply[0];
  return value === null || typeof value === "string" ? { known: true, value } : { known: false };
}

// v2: with the sales in another currency counted apart (22 [E5], unit 2d).
const cacheKey = (statsId: string) => `nl:stats:${statsId}:mailsales:v2`;
const CACHE_SECONDS = 600;
/** Pages of a hundred sales read from Stripe for one reading, the same as the studio's own numbers. */
const PAGES = 10;

/** Sales that arrived from an email, added up by which email. Other currencies are counted apart, never converted or added. */
export function moneyByCampaign(
  sales: { source: string; campaign: string; cents: number; currency: string }[],
  currency: string,
): Record<string, MailMoney> {
  const by: Record<string, MailMoney> = {};
  for (const sale of sales) {
    if (sale.source !== MAIL_SOURCE || !sale.campaign) continue;
    const row = (by[sale.campaign] ??= { sales: 0, cents: 0 });
    if (sale.currency !== currency) {
      row.elsewhere = (row.elsewhere ?? 0) + 1;
      continue;
    }
    row.sales += 1;
    row.cents += sale.cents;
  }
  return by;
}

/**
 * What one one-off email sold; null when nothing is counted for it. An email
 * that tried two subject lines is the sum of every tag its links carried.
 */
export function broadcastMoney(revenue: MailRevenue | null, broadcastId: string): MailMoney | null {
  if (!revenue) return null;
  const total: MailMoney = { sales: 0, cents: 0 };
  for (const campaign of broadcastCampaigns(broadcastId)) {
    const money = revenue.by[campaign];
    if (!money) continue;
    total.sales += money.sales;
    total.cents += money.cents;
    if (money.elsewhere) total.elsewhere = (total.elsewhere ?? 0) + money.elsewhere;
  }
  return total.sales || total.elsewhere ? total : null;
}

/** What every email of one sequence sold together. */
export function flowMoney(revenue: MailRevenue | null, flowId: string): MailMoney | null {
  if (!revenue) return null;
  const start = flowCampaignPrefix(flowId);
  const total: MailMoney = { sales: 0, cents: 0 };
  for (const [campaign, money] of Object.entries(revenue.by)) {
    if (!campaign.startsWith(start)) continue;
    total.sales += money.sales;
    total.cents += money.cents;
    if (money.elsewhere) total.elsewhere = (total.elsewhere ?? 0) + money.elsewhere;
  }
  return total.sales || total.elsewhere ? total : null;
}

/**
 * How many bytes what the emails sold holds as kept, 0 when it is not kept,
 * looked up before it is read by a reading that pays for its size
 * (lib/mcp-tools.ts, emailsTool); null when it did not come back.
 */
export async function keptMailRevenueBytes(store: Store): Promise<number | null> {
  if (!store.stripeAccountId || !store.statsId || !isRedisConfigured()) return 0;
  const reply: unknown = await redisPipeline([["STRLEN", cacheKey(store.statsId)]]);
  return Array.isArray(reply) && reply.length === 1 && count(reply[0]) ? reply[0] : null;
}

/** The store's email sales, from the cache when it is fresh. Never throws: a page is not lost over a number. */
export async function readMailRevenue(store: Store): Promise<MailRevenue | null> {
  const read = await readMailRevenuePaid(store, null);
  return read === "refused" ? null : read;
}

/**
 * readMailRevenue, asking `beforeStripe` first when it is not kept and the
 * sales are about to be read, so a reading that pays for its size
 * (lib/mcp-tools.ts, emailsTool) takes it then: "refused" when it says no,
 * with nothing read. Never throws otherwise. `sized` hears the bytes the kept
 * copy was read at, or, when it was made again, the bytes of the copy kept,
 * so that reading settles at them.
 */
export async function readMailRevenuePaid(
  store: Store,
  beforeStripe: (() => Promise<boolean>) | null,
  sized?: (bytes: { read: number } | { kept: number }) => void,
): Promise<MailRevenue | null | "refused"> {
  if (!store.stripeAccountId || !store.statsId) return null;
  try {
    if (isRedisConfigured()) {
      const cached = oneCacheReply(await redisPipeline([["GET", cacheKey(store.statsId)]]));
      if (!cached.known) return null;
      if (cached.value !== null) {
        sized?.({ read: Buffer.byteLength(cached.value) });
        return mailRevenueEvidence(JSON.parse(cached.value));
      }
    }
    if (beforeStripe && !(await beforeStripe())) return "refused";
    const since = Math.floor(Date.now() / 1000) - STATS_DAYS * 86400;
    const { sales, partial } = await readPaidSales(store, since, PAGES);
    const out: MailRevenue = { by: moneyByCampaign(sales, store.currency), partial };
    const text = JSON.stringify(out);
    sized?.({ kept: Buffer.byteLength(text) });
    if (isRedisConfigured()) {
      await redisPipeline([["SET", cacheKey(store.statsId), text, "EX", CACHE_SECONDS]]).catch(() => {});
    }
    return out;
  } catch (error) {
    console.error("reading what the emails sold failed", error);
    return null;
  }
}

const visitsKey = (statsId: string) => `nl:stats:${statsId}:mailvisits`;

/**
 * How many times each one-off email's links opened a page of the store, over
 * the last STATS_DAYS days: the count the store already keeps of visits by
 * the tag they arrive with (lib/stats.ts), added up for each email.
 *
 * Not an open rate and not a click rate. Nothing in the email reports back
 * (app/privacy says so), so what is counted is a page of the store being
 * loaded through one of the email's links, by nobody in particular. Null for
 * an email, or altogether, when it could not be read: the studio then says
 * nothing rather than "no visits".
 */
export async function readMailVisits(store: Pick<Store, "statsId">, broadcastIds: string[]): Promise<Record<string, number> | null> {
  if (!store.statsId || !isRedisConfigured() || !broadcastIds.length) return null;
  try {
    const cached = oneCacheReply(await redisPipeline([["GET", visitsKey(store.statsId)]]));
    if (!cached.known) return null;
    let by: Record<string, number> | null = null;
    if (cached.value !== null) {
      const kept = visitEvidence(JSON.parse(cached.value), broadcastIds);
      if (!kept.known) return null;
      // The cache answers only when it was made for every email asked about:
      // one sent a minute ago is read afresh rather than shown as nothing.
      if (kept.complete) by = kept.value;
    }
    if (!by) {
      const views = await campaignViews(store.statsId, broadcastIds.flatMap(broadcastCampaigns));
      if (!views) return null;
      by = {};
      for (const id of broadcastIds) by[id] = broadcastCampaigns(id).reduce((sum, campaign) => sum + (views[campaign] ?? 0), 0);
      await redisPipeline([["SET", visitsKey(store.statsId), JSON.stringify(by), "EX", CACHE_SECONDS]]).catch(() => {});
    }
    return by;
  } catch (error) {
    console.error("reading the visits the emails brought failed", error);
    return null;
  }
}
