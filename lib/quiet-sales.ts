/**
 * The email when sales stop (added 11 October 2026): a store that sells
 * regularly and has gone clearly longer than usual without a sale.
 *
 * The busy-day email (lib/stats-report.ts) says when things go well; this
 * says when they may have broken. A checkout that stopped opening, a product
 * hidden by mistake, a Stripe account that asks for something, a link in a
 * bio that points at the wrong page: each looks, from the creator's side,
 * exactly like a quiet week, and is found out a week or a month later. Matomo
 * sells alerts on any figure for this reason; here it is the one figure that
 * is money.
 *
 * When. The store's usual pace is its sales over the last 60 days. At that
 * pace, the chance of a stretch of `d` days with none is e^(−pace × d); the
 * email goes when that is under one in a hundred, after at least two days,
 * and only for a store with at least QUIET_MIN_SALES sales to read a pace
 * from. So a store that sells ten a day hears after two quiet days, one that
 * sells six a week after six, and one that sells twice a month never — its
 * quiet weeks are its usual ones. Once per quiet stretch: the claim is on the
 * last sale before it.
 *
 * Who. Only a store with a plan running and Stripe connected, and never one
 * whose creator stopped the numbers emails (the weekly one stops all three).
 * Read once a day per store by an hourly job (app/api/cron/quiet).
 */
import { type Store, saleHandles } from "@/lib/store";
import { onAccount } from "@/lib/stripe-account";
import { isRedisConfigured } from "@/lib/redis";
import { claimMark } from "@/lib/claim-mark";
import { NIMBUS_FROM, isSenderConfigured, sendEmail } from "@/lib/email";
import { standingOf } from "@/lib/plan-standing";
import { SITE_URL } from "@/lib/site-url";
import { weeklyOff, weeklyToken } from "@/lib/stats-report";
import { daysCounts } from "@/lib/stats";

/** Days of sales the usual pace is read from. */
export const QUIET_PACE_DAYS = 60;
/** The fewest sales in those days for a pace to mean anything. */
export const QUIET_MIN_SALES = 8;
/** How unlikely a quiet stretch must be at the usual pace: one in a hundred. */
const UNLIKELY = Math.log(100);
const DAY_MS = 86_400_000;

/**
 * Whether a stretch without sales is out of the ordinary, from the times of
 * the sales of the last QUIET_PACE_DAYS days (milliseconds). Pure, so the
 * rule is held by a test.
 */
export function isQuiet(sales: number[], now: number): { quiet: boolean; days: number; perWeek: number; last: number } {
  const recent = sales.filter((at) => at <= now && at > now - QUIET_PACE_DAYS * DAY_MS);
  const last = recent.length ? Math.max(...recent) : 0;
  const days = last ? (now - last) / DAY_MS : 0;
  const pace = recent.length / QUIET_PACE_DAYS;
  const quiet = recent.length >= QUIET_MIN_SALES && days >= 2 && pace * days >= UNLIKELY;
  return { quiet, days: Math.floor(days), perWeek: Math.round(pace * 7 * 10) / 10, last };
}

/** The paid checkouts of this store over the last QUIET_PACE_DAYS days, as times; at most three pages of a hundred. */
export async function saleTimes(store: Store, now: number): Promise<number[] | null> {
  const handles = saleHandles(store);
  const since = Math.floor(now / 1000) - QUIET_PACE_DAYS * 86400;
  const times: number[] = [];
  let after = "";
  for (let page = 0; page < 3; page += 1) {
    const list = (await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/checkout/sessions?limit=100&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    )) as { data?: unknown; has_more?: unknown };
    if (!Array.isArray(list.data) || typeof list.has_more !== "boolean") return null;
    const rows = list.data as Record<string, unknown>[];
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, string>;
      if (row.status !== "complete" || row.payment_status !== "paid" || !handles.has(meta.store ?? "")) continue;
      if (typeof row.created !== "number" || !Number.isFinite(row.created)) return null;
      times.push(row.created * 1000);
    }
    if (!list.has_more) return times;
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    after = typeof last.id === "string" ? last.id : "";
    if (!after) return null;
  }
  return null;
}

const checkedKey = (day: string, handle: string) => `nl:quiet:seen:${day}:${handle}`;
const sentKey = (handle: string, last: number) => `nl:quiet:sent:${handle}:${last}`;

export type QuietOutcome = "sent" | "fine" | "skipped" | "seen" | "failed";

/** Looks at one store, once a day, and writes to its creator when its sales have stopped. */
export async function checkQuiet(store: Store, now = Date.now()): Promise<QuietOutcome> {
  if (!isRedisConfigured() || !isSenderConfigured() || !store.stripeAccountId) return "skipped";
  const standing = standingOf(store);
  if (standing !== "paid" && standing !== "trial") return "skipped";
  if (await weeklyOff(store)) return "skipped";
  const day = new Date(now).toISOString().slice(0, 10);
  // The day's look and the email are ours only on an exact claim (lib/claim-mark.ts): an unknown answer
  // reads nothing and sends nothing this run, and lets nothing go.
  const first = await claimMark(checkedKey(day, store.handle), 2 * 86400);
  if (first === "taken") return "seen";
  if (first !== "ours") return "skipped";
  const times = await saleTimes(store, now).catch(() => null);
  if (times === null) return "skipped";
  const verdict = isQuiet(times, now);
  if (!verdict.quiet) return "fine";
  const claimed = await claimMark(sentKey(store.handle, verdict.last), 90 * 86400);
  if (claimed === "taken") return "fine";
  if (claimed !== "ours") return "skipped";

  // What the quiet days look like from the store's side: people still coming,
  // people starting to pay and not finishing, or nobody coming at all.
  const since = new Date(verdict.last).toISOString().slice(0, 10);
  const counts = store.statsId ? await daysCounts(store.statsId, since, day).catch(() => null) : null;
  const lastDay = new Date(verdict.last).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const token = weeklyToken(store.handle);
  const stopUrl = `${SITE_URL}/api/store/weekly?h=${encodeURIComponent(store.handle)}&t=${encodeURIComponent(token)}`;
  const usual = verdict.perWeek >= 1 ? `about ${verdict.perWeek} sales a week` : `about ${Math.round(verdict.perWeek * 30)} sales a month`;
  const lines = [
    `${store.name} usually makes ${usual}, and has made none since ${lastDay}: ${verdict.days} days. A stretch that long happens less than once in a hundred times at your usual pace, so it is worth a look.`,
    "",
  ];
  if (counts) {
    lines.push(`Since then: ${counts.views.toLocaleString("en-US")} visits to your store page and ${counts.checkouts.toLocaleString("en-US")} checkouts started.`);
    if (counts.checkouts > 0) {
      lines.push("People are starting to pay and not finishing. Open one of your products as a buyer and go as far as the payment page: check that it opens, and that the price and the currency are right.");
    } else if (counts.views > 0) {
      lines.push("People are visiting and nobody is starting to pay. Check that your products are shown and can be bought, and that their buttons work.");
    } else {
      lines.push("Nobody has visited. Check that the link in your bio and in your posts still points at your store.");
    }
    lines.push("");
  }
  lines.push(
    "It is also worth opening your Stripe dashboard: if Stripe needs something from you, payments can stop until it is given.",
    "",
    `Your numbers, day by day: ${SITE_URL}/studio`,
    "",
    `This comes once for each quiet stretch. To stop these emails, the busy-day one and the weekly one: ${stopUrl}`,
  );
  const ok = await sendEmail({ meter: { by: "store", store: store, kind: "email" },
    from: NIMBUS_FROM,
    to: store.email,
    subject: `${store.name}: no sales in ${verdict.days} days`.slice(0, 180),
    text: lines.join("\n"),
    headers: { "List-Unsubscribe": `<${stopUrl}>` },
  }).catch(() => false);
  return ok ? "sent" : "failed";
}
