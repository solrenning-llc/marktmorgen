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
 * When. The store's usual pace is its sales over the last 60 days (or, for a
 * store with more completed checkouts in them than one look reads, over the
 * stretch those it read cover: saleHistory). At that
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
 * the sales of the last `windowDays` days (milliseconds; QUIET_PACE_DAYS
 * unless the store had more completed checkouts than one look reads,
 * saleHistory). Pure, so the rule is held by a test.
 */
export function isQuiet(sales: number[], now: number, windowDays = QUIET_PACE_DAYS): { quiet: boolean; days: number; perWeek: number; last: number } {
  const recent = sales.filter((at) => at <= now && at > now - windowDays * DAY_MS);
  const last = recent.length ? Math.max(...recent) : 0;
  const days = last ? (now - last) / DAY_MS : 0;
  const pace = recent.length / windowDays;
  const quiet = recent.length >= QUIET_MIN_SALES && days >= 2 && pace * days >= UNLIKELY;
  return { quiet, days: Math.floor(days), perWeek: Math.round(pace * 7 * 10) / 10, last };
}

/**
 * At most this many pages of a hundred completed checkouts are read for one store's look, once a UTC day: so at most
 * three GET /checkout/sessions a store a day, and no store command of its own (tests/plan-cost-registry.ts,
 * NOT_A_COST.QUIET_PAGES_PER_STORE).
 */
export const QUIET_PAGES_PER_STORE = 3;

/**
 * The store's paid checkouts that its pace is read from, as times (milliseconds), and the days they cover. Only
 * completed checkouts are listed (Stripe's own `status`), never the open or expired ones, which a store has many more
 * of (9 November 2026, beside the checkout sweep's audit A2: every status was listed, three pages at most, so a store
 * with 300 unpaid checkouts in 60 days, or one that sold five a day, was never read and never heard its sales stop).
 *
 * When the last QUIET_PACE_DAYS days hold more completed checkouts than QUIET_PAGES_PER_STORE pages, the pace is read
 * over the stretch the pages cover: newest first, they hold every completed checkout newer than the oldest one read,
 * so the count over that stretch is exact, and a quiet stretch inside it is measured against the store's own pace
 * just before. Unknown (null) when an answer is not a list, a session is answered twice, a sale has no date, or the
 * stretch read holds fewer than QUIET_MIN_SALES of this store's sales (they may be past it, so nothing is decided).
 */
export async function saleHistory(store: Store, now: number): Promise<{ times: number[]; days: number; whole: boolean } | null> {
  const handles = saleHandles(store);
  const since = Math.floor(now / 1000) - QUIET_PACE_DAYS * 86400;
  const times: number[] = [];
  const seen = new Set<string>();
  let after = "";
  let oldest = Number.POSITIVE_INFINITY;
  for (let page = 0; page < QUIET_PAGES_PER_STORE; page += 1) {
    const list = (await onAccount(
      "GET",
      store.stripeAccountId as string,
      `/checkout/sessions?limit=100&status=complete&created[gte]=${since}${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`,
    )) as { data?: unknown; has_more?: unknown };
    if (!Array.isArray(list.data) || typeof list.has_more !== "boolean") return null;
    const rows = list.data as Record<string, unknown>[];
    for (const row of rows) {
      // Stripe never answers a session twice in one walk: a page that does is not the next one.
      if (typeof row.id === "string") {
        if (seen.has(row.id)) return null;
        seen.add(row.id);
      }
      if (typeof row.created === "number" && Number.isFinite(row.created)) oldest = Math.min(oldest, row.created);
      const meta = (row.metadata ?? {}) as Record<string, string>;
      if (row.status !== "complete" || row.payment_status !== "paid" || !handles.has(meta.store ?? "")) continue;
      if (typeof row.created !== "number" || !Number.isFinite(row.created)) return null;
      times.push(row.created * 1000);
    }
    if (!list.has_more) return { times, days: QUIET_PACE_DAYS, whole: true };
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    after = typeof last.id === "string" ? last.id : "";
    // The last session of a page is the oldest read so far (newest first), and where the stretch read begins.
    if (!after || last.created !== oldest) return null;
  }
  // More than the pages hold: the stretch from the oldest one read (left out, since others of its second may be past
  // the pages) to now.
  const from = oldest * 1000;
  const within = times.filter((at) => at > from);
  const days = (now - from) / DAY_MS;
  if (!(days > 0) || within.length < QUIET_MIN_SALES) return null;
  return { times: within, days, whole: false };
}

/** The paid checkouts of this store over the last QUIET_PACE_DAYS days, as times; null unless they all fit in the pages read. */
export async function saleTimes(store: Store, now: number): Promise<number[] | null> {
  const history = await saleHistory(store, now);
  return history?.whole ? history.times : null;
}

const checkedKey = (day: string, handle: string) => `nl:quiet:seen:${day}:${handle}`;
const sentKey = (handle: string, last: number) => `nl:quiet:sent:${handle}:${last}`;

export type QuietOutcome = "sent" | "fine" | "skipped" | "seen" | "failed";

/** Looks at one store, once a day, and writes to its creator when its sales have stopped. */
export async function checkQuiet(store: Store, now = Date.now()): Promise<QuietOutcome> {
  if (!isRedisConfigured() || !isSenderConfigured() || !store.stripeAccountId) return "skipped";
  const standing = standingOf(store);
  if (standing !== "paid" && standing !== "trial") return "skipped";
  if (await weeklyOff(store.handle)) return "skipped";
  const day = new Date(now).toISOString().slice(0, 10);
  // The day's look and the email are ours only on an exact claim (lib/claim-mark.ts): an unknown answer
  // reads nothing and sends nothing this run, and lets nothing go.
  const first = await claimMark(checkedKey(day, store.handle), 2 * 86400);
  if (first === "taken") return "seen";
  if (first !== "ours") return "skipped";
  const history = await saleHistory(store, now).catch(() => null);
  if (history === null) {
    // Said, never passed over as a store that sells as usual (CX-123 rule 24): its sales are looked at again tomorrow.
    console.error("quiet: a store's sales could not be read; no email about them today", store.handle);
    return "skipped";
  }
  const verdict = isQuiet(history.times, now, history.days);
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
