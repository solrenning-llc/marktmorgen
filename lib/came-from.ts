/**
 * Which marketing channel a sale came from.
 *
 * The store already counts visitors by where they came from, and the money
 * is already read from the creator's own Stripe account. The two were never
 * joined, so a creator could see that four hundred people arrived from a
 * newsletter and that they made six hundred dollars, and never which of
 * those four hundred were the six hundred.
 *
 * Joining them needs no new record of anybody. The tags the creator puts on
 * their own links — utm_source, utm_medium, utm_campaign — are carried by
 * the page the buyer presses the button on, and the browser sends that page's
 * address as the Referer of the checkout. So the tags are read from there,
 * at the moment the checkout opens, and written into the Stripe session's
 * metadata. They come back attached to the money when the sale is read.
 *
 * Nothing is stored here, nothing is tracked across days, no cookie is set
 * and no visitor is identified. The record of the channel lives where the
 * record of the payment lives, which is the creator's own Stripe account.
 *
 * What this does not do, said plainly because the difference matters: it is
 * the tag on the page the buyer bought from, not a journey followed across
 * visits. Somebody who arrives from a newsletter on Monday, comes back
 * untagged on Friday and buys then is counted as direct. Tools that follow a
 * person over days do it with a cookie and a stored profile, which is the
 * thing this store has never had and is not worth having for a report.
 */

/** The tags, as they are counted. Matches how lib/stats.ts cleans them. */
import { sourceAlias } from "@/lib/source-rules";

export type CameFrom = { source: string; medium: string; campaign: string; content?: string };

export const NO_SOURCE: CameFrom = { source: "", medium: "", campaign: "" };

/** The longest campaign tag the store keeps, in characters. */
export const CAMPAIGN_TAG_MAX = 40;

/** Lower case, letters, digits and a few marks, and short. Nothing else survives. */
function tidy(raw: string | null, max = 30): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, max);
}

/**
 * The tags on the page a checkout was opened from.
 *
 * `referer` is that page's address, which the browser sends on the form
 * post. It is only read for its utm tags, and only when it is this site's
 * own page — a referer from anywhere else is somebody posting the form from
 * another site, which is refused long before this, and is ignored here too.
 */
export function cameFrom(referer: string | null, ownHost: string): CameFrom {
  if (!referer) return NO_SOURCE;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return NO_SOURCE;
  }
  if (ownHost && url.hostname.toLowerCase() !== ownHost.toLowerCase()) return NO_SOURCE;
  return {
    // The same word the visit was counted under (lib/source-rules.ts): ChatGPT's own tag is "chatgpt".
    source: sourceAlias(tidy(url.searchParams.get("utm_source"))),
    medium: tidy(url.searchParams.get("utm_medium")),
    campaign: tidy(url.searchParams.get("utm_campaign"), CAMPAIGN_TAG_MAX),
    content: tidy(url.searchParams.get("utm_content"), 40),
  };
}

/** Whether anything was found worth writing down. */
export function hasSource(from: CameFrom): boolean {
  return Boolean(from.source || from.medium || from.campaign || from.content);
}

/** What a sale with no tag on it is called in a report. */
export const DIRECT = "direct";

/**
 * Money by channel, from sales that already carry their tag.
 *
 * Sales in different currencies are kept apart rather than added up: a store
 * selling in dollars and euros has two totals, and inventing an exchange
 * rate to merge them would be making up a number.
 */
export function revenueBySource(
  sales: { cents: number; currency: string; source: string }[],
): { source: string; currency: string; cents: number; sales: number }[] {
  const by = new Map<string, { source: string; currency: string; cents: number; sales: number }>();
  for (const sale of sales) {
    const source = sale.source || DIRECT;
    const key = `${source}|${sale.currency}`;
    const row = by.get(key) ?? { source, currency: sale.currency, cents: 0, sales: 0 };
    row.cents += sale.cents;
    row.sales += 1;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => b.cents - a.cents || a.source.localeCompare(b.source));
}
