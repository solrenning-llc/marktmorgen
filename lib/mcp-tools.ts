import { ledgerPaymentsComplete } from "@/lib/payment-ledger-coverage";
import { paidFiguresComplete } from "@/lib/paid-coverage";
/**
 * The read-only tools of the MCP server beyond the first three (added 12
 * October 2026): revenue by channel, the funnel, each product, memberships,
 * emails, affiliates, buyers in numbers and what is worth knowing — each the
 * same numbers the studio shows, read by the same functions and their caches
 * (app/api/mcp/route.ts).
 *
 * Read before it was built: DataFast's 67 MCP tools, Umami's 23 read-only
 * ones (run_funnel, run_attribution, get_revenue), ChartMogul's, Matomo's,
 * Northbeam's and Polar's. What they share is that the assistant gets the
 * numbers the product already shows, each tool narrow enough to answer one
 * kind of question.
 *
 * Nobody is named. No tool here returns a buyer's, member's, subscriber's or
 * affiliate's address, name or words: an assistant's conversation is kept by
 * whoever runs the assistant, and those people never agreed to be read there.
 * Affiliates are their link's code; members' reasons for leaving are counted,
 * not quoted. Money is in the smallest unit of the store's currency.
 */
import type { Store } from "@/lib/store";
import { type StatsData, readsSales, productsInStats, readSales, readStats, studioStats } from "@/lib/stats";
import { readListing, readListings } from "@/lib/catalog";
import { listingsToRead } from "@/lib/catalog-read-count";
import { readAboutExact } from "@/lib/product-about";
import { type Course, findLesson, readBodyExact, readCourseExact } from "@/lib/course";
import { UnknownReplyError } from "@/lib/redis-reply";
import { readQuizForExact } from "@/lib/quiz";
import { readTaskForExact } from "@/lib/assignment";
import { MAX_VERSIONS, countVersions, readPageExact, readVersionsExact } from "@/lib/sales-page-store";
import { countSections, readSectionsExact } from "@/lib/saved-block-store";
import type { PageBlock } from "@/lib/sales-page";
import { EMPTY_PAGE, type SalesPage, declaredMeasure, runningTest } from "@/lib/sales-page";
import { expectedShareB, readCounts } from "@/lib/headline-test";
import { type Counts, testState } from "@/lib/headline-test-rules";
import { reachShares, readDepthExact } from "@/lib/page-depth";
import { isFree } from "@/lib/store-field-rules";
import { keptMembershipBytes, membershipNumbersPaid } from "@/lib/membership-numbers";
import { broadcastSizes, listBroadcasts } from "@/lib/broadcasts";
import { broadcastMoney, flowMoney, keptMailRevenueBytes, readMailRevenuePaid } from "@/lib/mail-revenue";
import { flowsBytes, readFlows } from "@/lib/flows";
import { readFlowStatsStrict } from "@/lib/flow-stats";
import { listCounts } from "@/lib/contacts";
import { affiliatesOn, readBook } from "@/lib/affiliates";
import { type Charge, type Hold, chargeBook } from "@/lib/api-read";
import {
  EMAILS_BROADCASTS, EMAILS_PROBE_WORK, MEMBERSHIPS_COLD_WORK, addWork, apiReadUnits, boughtNextWork, courseOutlineWork, emailsWork, lessonWork, listingsWork, mailRevenueColdWork,
  membershipsWork, pageReadingWork, pageTestWork, pageVersionsWork, productTextWork, salesPageWork, savedBlocksWork, settledUnits,
  COUNT_REPLY_BYTES, SAVED_SECTIONS_MAX, type ReadWork,
} from "@/lib/api-read-rules";
import { paypalCounts } from "@/lib/paypal-sales";
import { insightsFrom } from "@/lib/insights";
import { pathsBytes, readPaths } from "@/lib/next-bought";
import { campaignResultsFrom } from "@/lib/campaign-results";
import { paymentComparisonFrom } from "@/lib/payment-comparison";
import { paymentMixFrom } from "@/lib/payment-mix";
import { dailyCashflowRows } from "@/lib/daily-cashflow";
import { refundActivityFrom } from "@/lib/refund-activity";
import { channelCashflows } from "@/lib/channel-cashflow";

export type Window = "d7" | "d30" | "d90";
const NAMES: Record<Window, string> = { d7: "last_7_days", d30: "last_30_days", d90: "last_90_days" };

/** `days`: 7, 30 or 90; anything else is 30. */
export function windowOf(raw: unknown): Window {
  const n = Number(raw);
  return n === 7 ? "d7" : n === 90 ? "d90" : "d30";
}

/** The studio's numbers, with the products, for one store. */
export async function readFullNumbers(store: Store, now = Date.now()): Promise<StatsData | null> {
  return (await readFullNumbersPaid(store, null, now))?.data ?? null;
}

/**
 * readFullNumbers, taking what reading the listings of the products the
 * numbers name costs (lib/api-read-rules.ts, listingsWork) once they are
 * known and before they are read. When the requests left do not cover them,
 * the numbers come without them (`listed` false), as /api/v1/stats always
 * comes: the numbers already read and paid for are never thrown away. The
 * numbers themselves are taken before this, by the caller
 * (lib/api-numbers.ts); `taken` is what that took.
 */
export async function readFullNumbersPaid(store: Store, charge: Charge | null, now = Date.now(), taken = 0): Promise<{ data: StatsData; listed: boolean } | null> {
  const stats = await readStats(store, now);
  if (!stats) return null;
  let state: StatsData["sales"] = readsSales(store) ? "ok" : "none";
  const sales = readsSales(store)
    ? await readSales(store, now).catch(() => {
        state = "error";
        return null;
      })
    : null;
  const named = productsInStats(store, stats, sales);
  const refused = charge ? await charge(apiReadUnits(listingsWork(listingsToRead(store, named))), taken) : null;
  if (refused) return { data: studioStats(store, stats, sales, state, []), listed: false };
  // Listings that could not be read are not listed: the answer says so and the hour's copy is not kept without them,
  // never "this store has no products" (CX-123 rule 24).
  const listings = await readListings(store, named).catch(() => null);
  return { data: studioStats(store, stats, sales, state, listings ?? []), listed: listings !== null };
}

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null);

/** Revenue by channel for the window, three ways, with ads and posts. */
export function channelsTool(data: StatsData, w: Window) {
  const known = paidFiguresComplete(data);
  const table = data.attribution?.[w];
  const days = (data.days ?? []).slice(-(w === "d7" ? 7 : w === "d30" ? 30 : 90));
  const cash = known && days.length ? channelCashflows(data, w, data.channels?.[w] ?? [], new Map(), days[0].date, days[days.length - 1].date) : [];
  const refundActivity = known && days.length ? refundActivityFrom(data, w, days[0].date, days[days.length - 1].date) : null;
  const campaignReport = campaignResultsFrom(data, w);
  const mix = paymentMixFrom(data,w);
  const comparison=paymentComparisonFrom(data,w);
  return {
    window: NAMES[w],
    currency: data.currency,
    sales_read: data.sales,
    partial: data.partial === true,
    paid_figures_complete: known,
    coverage_note: "Paid totals require a successful, non-partial reading. Null or omitted figures and empty ad/post lists with paid_figures_complete false mean unavailable, not zero sales. Traffic counts may remain available. Money is in the currency smallest unit.",
    payments_complete: ledgerPaymentsComplete(data),
    cashflow_complete: ledgerPaymentsComplete(data) && data.cashflowComplete === true && data.refunds?.[w] != null,
    payment_comparison: comparison ? {current_from_utc:comparison.current.from,current_to_utc:comparison.current.to,current_payments:comparison.current.total,previous_available:comparison.previous!==null,previous_period:comparison.previous ? {from_utc:comparison.previous.from,to_utc:comparison.previous.to,payments:comparison.previous.total} : null,difference:comparison.delta,relative_change:comparison.change,channels:comparison.rows,
      note:"Money in smallest currency units; relative changes and shares are fractions. shareChange is current share minus previous share; multiply by 100 for percentage points. Equal consecutive UTC periods including today as recorded so far. Comparisons fit only 7 and 30 days within the complete 90-day payment reading, independently of refund coverage. Null means unavailable or no valid denominator, never zero. Gross recorded payments include renewals, before refunds, fees and ads; not customers, profit or causal marketing lift."} : null,
    payment_mix: mix ? {from_utc:mix.from,to_utc:mix.to,total_payments:mix.total,unidentified_payments:mix.unidentified,unidentified_share:mix.unidentifiedShare,largest_identified_channel:mix.largest,top_three_identified_share:mix.topThreeShare,channels:mix.rows,
      note:"Money in smallest currency units; shares are fractions of all recorded payments. Includes renewals at recorded subscription channel, before refunds, fees and ads. Direct, unrecorded and imported origins excluded from largest and top-three identified channels. Complete payment coverage required, independently of refund coverage; null is unavailable. Not customer acquisition, profit or causal ad lift."} : null,
    cashflow: known && cash.length ? {
      note: "Payments include renewals. Refunds include pending refunds in the days recorded. After refunds is before ad spend, fees, tax, commissions and other costs; not profit or causal lift. Null means incomplete.",
      channels: cash.map((c) => ({ channel: c.source, payments_received: c.receipts, refunds: c.refunds, after_refunds: c.afterRefunds })),
    } : null,
    ...(refundActivity ? { refund_activity: {
      payments_received: refundActivity.payments, refunds_recorded: refundActivity.refunds, refund_records: refundActivity.records,
      note: "Money is in the currency smallest unit. Same-period payments including renewals, and recorded refunds including pending refunds. Not a refund rate for purchases or buyers: refunded purchases may be earlier and records are not unique buyers or orders. Ratio is refunded amount / received amount, may exceed 1; null means no payments. Only complete, matched readings.",
      channels: refundActivity.rows.map((row) => ({ channel: row.source, payments_received: row.payments, refunds_recorded: row.refunds, refund_records: row.records, recorded_refunds_over_payments: row.share })),
    } } : {}),
    ...(known ? { daily_recorded_cashflow: {
      note: "UTC days; money is in the currency smallest unit. Payments include renewals. Refunds include pending refunds on their recorded day, even for older purchases. Null means incomplete or unavailable readings. Before ad spend, fees and other costs; not profit. This tool does not load recorded ad spend.",
      days: dailyCashflowRows(data, w).map((row) => ({ day: row.date, payments_received: row.payments, refunds_recorded: row.refunds, after_refunds: row.afterRefunds })),
    } } : {}),
    ...(campaignReport ? { campaign_recorded_results: {
      from_utc: campaignReport.from, to_utc: campaignReport.to, complete_paid_records: campaignReport.salesKnown,
      note: "Same campaign tag totals across channels; visits are not split by payment channel. Paid records include purchases and one-click extras, not unique buyers; renewals excluded. Gross amounts are in the currency smallest unit, before refunds and other costs. This tool does not load ad spend. Null is unavailable or incomplete; no profit, acquisition cost or causal lift is inferred.",
      campaigns: campaignReport.rows.map((row) => ({ campaign: row.campaign, payment_channels: row.paymentChannels, visits: row.visits, paid_records: row.paidRecords, gross_amount: row.gross })),
    } } : {}),
    buyer_cohorts: known && data.buyerChannels ? {
      history_partial: data.buyerChannels.historyPartial,
      unidentified_orders: data.buyerChannels[w].unidentifiedOrders,
      note: "First purchase observed in up to 180 days; not lifetime acquisition. Renewals are not repurchases. Revenue is gross; the 30-day rate uses only buyers observed for 30 days.",
      channels: data.buyerChannels[w].rows.map((c) => ({ ...c })),
    } : null,
    ...(known && data.buyerChannels?.weekly ? { weekly_repurchase_cohorts: {
      as_of_utc: data.buyerChannels.weekly.asOf,
      history_partial: data.buyerChannels.historyPartial,
      unidentified_orders: data.buyerChannels.weekly.unidentifiedOrders,
      note: "UTC first observed purchase weeks from up to 180 days of history, independent of the selected window. Cumulative repurchases within 7/30/60/90 days, not product activity retention or lifetime acquisition. Only buyers observed for the full period enter the denominator. Null rate means no eligible buyers; renewals and one-click extras do not count. Small groups fluctuate; partial history may miss purchases.",
      weeks: data.buyerChannels.weekly.rows.map((row) => ({ week: row.week, buyers: row.buyers,
        periods: Object.entries(row.observations).map(([days, cell]) => ({ days: Number(days), eligible: cell.eligible, repeated: cell.repeated, percent: cell.eligible ? Math.round(cell.repeated / cell.eligible * 100) : null })),
      })),
    } } : {}),
    channels: (data.channels?.[w] ?? []).map((c) => ({
      channel: c.source,
      visits: c.visits,
      checkouts_started: c.checkouts,
      free_signups: c.free,
      sales: known ? c.sales : null,
      revenue: known ? c.cents : null,
      sales_per_visit: known ? share(c.sales, c.visits) : null,
    })),
    three_ways: known && table
      ? {
          note: "Alternative visit models for the same purchases; include the no-channel amount in each column and never add the columns together. Buyer answers cover only respondents and belong to the day answered, which may differ from purchase days. Gross before refunds and fees; extras excluded. Missing first-visit coverage stays null, not zero. No causal marketing lift.",
          first_visit_complete: table.unknownFirst != null,
          attribution_days: data.attributionDays ?? 30,
          rows: table.rows.map((r) => ({ channel: r.name, last_visit: r.last, first_visit: table.unknownFirst ? r.first : null, buyers_said: r.said })),
          no_channel: table.unknown,
          no_first_visit_channel: table.unknownFirst ?? null,
          no_channel_buyers_said: table.unknownSaid.map((r) => ({ answer: r.name, buyers: r.buyers, revenue: r.cents })),
        }
      : null,
    ad_records_note: "Variants are grouped by channel, campaign and content tag. Paid records include purchases and one-click extras, not unique buyers; renewals excluded. Amounts are gross before refunds and fees. At most 25 variants are returned; empty with ad_records_complete false means unavailable, not zero.",
    ad_records_complete: known && data.ads?.[w] != null,
    ads_total: known && data.ads?.[w] != null ? data.ads[w].length : null,
    ads: known ? (data.ads?.[w] ?? []).slice(0, 25).map((r) => ({ ad: r.content, channel: r.source, campaign: r.campaign, sales: r.sales, revenue: r.cents })) : [],
    posts: known ? (data.posts?.[w] ?? []).slice(0, 25).map((r) => ({ post: r.campaign, channel: r.sources?.length === 1 ? r.sources[0] : "", payment_channels: r.sources ?? null, visits: r.visits, sales: r.sales, revenue: r.cents })) : [],
  };
}

/** From visit to sale for the window, beside the stretch before, and how far down the store page is read. */
export function funnelTool(data: StatsData, w: Window) {
  const known = paidFiguresComplete(data);
  const t = data.totals[w];
  const p = data.previous?.[w];
  const trafficKnown = p != null && data.previousTrafficAvailable?.[w] !== false;
  const reach = data.reach?.[w];
  return {
    window: NAMES[w],
    currency: data.currency,
    paid_figures_complete: known,
    partial: data.partial === true,
    coverage_note: "Paid totals and paid conversion rates require a successful non-partial reading. Null is unavailable, not zero. Visits, page views and checkout starts remain available. Previous traffic with traffic_available false is unavailable, not zero; confirmed previous paid figures remain independent.",
    visitors: t.visitors,
    page_views: t.views,
    checkouts_started: t.checkouts,
    sales: known ? t.sales : null,
    revenue: known ? t.cents : null,
    checkouts_per_visitor: share(t.checkouts, t.visitors),
    sales_per_checkout: known ? share(t.sales, t.checkouts) : null,
    sales_per_visitor: known ? share(t.sales, t.visitors) : null,
    previous_traffic_available: trafficKnown,
    the_same_days_before: p
      ? { traffic_available: trafficKnown, visitors: trafficKnown ? p.visitors : null, page_views: trafficKnown ? p.views : null, checkouts_started: trafficKnown ? p.checkouts : null, sales: known ? p.sales : null, revenue: known ? p.cents : null }
      : null,
    store_page: reach
      ? {
          note: "Of the visitors measured, how many reached each item of the store page and how many clicked it, in the page's order.",
          visitors_measured: reach.visitors,
          items: reach.rows.map((r) => ({ item: r.title, kind: r.kind, reached: r.reached, clicked: r.clicks })),
        }
      : null,
  };
}

/**
 * The titles of the products `ids` names, for an answer: those already known
 * (the numbers carry the products they name), and the rest from their
 * listings, once what reading them costs is taken (lib/api-read-rules.ts,
 * listingsWork, counted first). When that is not left, those are named by
 * their id (`named` false): what was already read and paid for is never lost.
 * Listings that could not be read name them by their id too, and say so
 * (`named` false), never that their names were read (CX-123 rule 24).
 * Without `charge` (not the API), they are read as they are.
 */
async function titlesFor(store: Store, ids: Iterable<string>, known: Map<string, string>, charge: Charge | null, taken: number): Promise<{ titles: Map<string, string>; named: boolean }> {
  const titles = new Map(known);
  const missing = [...new Set(ids)].filter((id) => !titles.has(id));
  if (!missing.length) return { titles, named: true };
  if (charge && (await charge(apiReadUnits(listingsWork(listingsToRead(store, missing))), taken))) return { titles, named: false };
  const listings = await readListings(store, missing).catch(() => null);
  for (const listing of listings ?? []) titles.set(listing.id, listing.title);
  return { titles, named: listings !== null };
}

/**
 * Each product for the window, and what its buyers went on to buy
 * (lib/next-bought.ts). With `meter` (the MCP tool), what buyers bought next
 * is measured, set aside at its most and settled at what is sent
 * (lib/api-read-rules.ts, boughtNextWork); the products it names that the
 * numbers do not are read once their listings are taken (titlesFor). When the
 * requests left do not cover it, the products' numbers come without it
 * (`bought_next` null), or with those products named by their id.
 */
export async function productsTool(store: Store, data: StatsData, w: Window, meter: { hold: Hold; charge: Charge } | null = null) {
  const known = paidFiguresComplete(data);
  let settle: ((actual: number) => Promise<Response | null>) | null = null;
  let most = 0;
  let pathSize = 0;
  let skipped = false;
  if (meter) {
    const bytes = await pathsBytes(store.statsId);
    if (bytes === null) throw new Error("what buyers bought next could not be measured");
    pathSize = bytes;
    most = apiReadUnits(boughtNextWork(pathSize));
    const held = await meter.hold(most);
    if (held instanceof Response) skipped = true;
    else settle = held;
  }
  const paths = skipped ? null : await readPaths(store.statsId).catch(() => null);
  const ids = paths ? [...Object.keys(paths.starts), ...Object.entries(paths.next).flatMap(([from, steps]) => [from, ...steps.map((step) => step.id)])] : [];
  const { titles, named } = await titlesFor(store, ids, new Map(data.products.map((p) => [p.id, p.title])), meter?.charge ?? null, most);
  const name = (id: string) => titles.get(id) ?? id;
  const boughtNext = paths
    ? {
        note: "From all sales: what the same buyers bought on a later visit, from three buyers up, with the median days between.",
        bought_first_most: Object.entries(paths.starts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([id, buyers]) => ({ product: name(id), buyers })),
        sequences: Object.entries(paths.next).flatMap(([from, steps]) => steps.map((s) => ({ first: name(from), then: name(s.id), buyers: s.buyers, days_later: s.days }))),
        ...(named ? {} : { names_note: "Some products are named by their id: your store's API requests left did not cover reading their names, or they could not be read just now." }),
      }
    : null;
  // What was set aside is settled at what is sent of it; past it (it never is, at its most), it is not sent.
  const over = settle ? await settle(settledUnits(boughtNextWork(pathSize, Buffer.byteLength(JSON.stringify(boughtNext, null, 2) ?? "")), most)) : null;
  const shown = skipped || over ? null : boughtNext;
  return {
    window: NAMES[w],
    currency: data.currency,
    paid_figures_complete: known,
    partial: data.partial === true,
    coverage_note: "Paid totals and paid conversion rates require a successful non-partial reading. Null is unavailable, not zero. Visits, page views and checkout starts remain available.",
    products: data.products
      .map((row) => ({
        id: row.id,
        title: row.title,
        page_views: row[w].views,
        checkouts_started: row[w].checkouts,
        sales: known ? row[w].sales : null,
        revenue: known ? row[w].cents : null,
        sales_per_page_view: known ? share(row[w].sales, row[w].views) : null,
      }))
      .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0) || b.page_views - a.page_views),
    bought_next: shown,
    ...(skipped || over ? { bought_next_note: "What buyers bought next was not read: your store's API requests left did not cover it." } : {}),
  };
}

/**
 * Memberships as the Membership numbers page shows them, without anybody's
 * address or words. Whether they are kept and how big is looked up first;
 * then all that reading them costs is taken in one go, before anything is
 * read: the kept numbers and the answer and, when they are not kept, every
 * page of the creator's Stripe account they read (lib/api-read-rules.ts).
 * Only a copy that was kept when measured and is gone a moment later takes
 * its pages of Stripe as a second step (refused with its own words, nothing
 * shown). The products they name are read once their listings are taken, or
 * named by their id (titlesFor).
 */
export async function membershipsTool(store: Store, charge: Charge) {
  if (!store.stripeAccountId || !store.statsId) return { memberships: null, note: "No memberships could be read: the store has no Stripe account connected, or sells none." };
  const keptBytes = await keptMembershipBytes(store);
  if (keptBytes === null) throw new Error("the memberships could not be measured");
  const units = apiReadUnits(keptBytes > 0 ? membershipsWork(keptBytes) : addWork(membershipsWork(0), MEMBERSHIPS_COLD_WORK));
  const first = await charge(units);
  if (first) return first;
  const said: { refused: Response | null } = { refused: null };
  const read = await membershipNumbersPaid(store, async () => {
    // Not kept when measured: its pages of Stripe were taken with the rest.
    if (keptBytes === 0) return true;
    said.refused = await charge(apiReadUnits(MEMBERSHIPS_COLD_WORK), units);
    return said.refused === null;
  });
  if (said.refused) return said.refused;
  const n = read === "refused" ? null : read;
  if (!n) return { memberships: null, note: "No memberships could be read: the store has no Stripe account connected, or sells none." };
  // The products they name, from their listings once those are taken; else by their id.
  const { titles, named } = await titlesFor(store, n.byProduct.map((p) => p.product), new Map(), charge, units);
  return {
    currency: n.currency,
    mrr: Math.round(n.mrr),
    arr: Math.round(n.mrr * 12),
    paying: n.paying,
    trialing: n.trialing,
    payment_being_retried: { members: n.atRisk, mrr: Math.round(n.atRiskMrr) },
    ended_last_30_days: { members: n.ended30, mrr: Math.round(n.endedMrr30) },
    churn_last_30_days: n.churn30,
    trials_ended_last_90_days: { ended: n.trialsEnded, became_paying: n.trialsConverted },
    by_product: n.byProduct.map((p) => ({ product: titles.get(p.product) ?? p.product, members: p.members, trialing: p.trialing, mrr: Math.round(p.mrr) })),
    // False when the products are named by their id: the store's API requests left did not cover reading their names, or they could not be read.
    by_product_named: named,
    // Null when the reading does not hold it, never an empty list (CX-123 rule 24).
    by_channel: n.byChannel ? n.byChannel.map((c) => ({ channel: c.channel, started: c.started, running: c.running, still_running_at_3_months: c.stayed3, average_months: c.months })) : null,
    why_members_left: n.leaving ? { canceled: n.leaving.canceled, answered: n.leaving.answered, reasons: n.leaving.reasons.map((r) => ({ reason: r.reason, members: r.members, mrr: Math.round(r.mrr) })), payment_failed: n.leaving.paymentFailed } : null,
    // Null when the invoices could not be read (lib/membership-numbers.ts keeps the reading without movements), never [].
    mrr_by_month: n.movements ? n.movements.months : null,
    arpu: n.movements?.arpu ?? null,
    net_revenue_retention: n.movements?.nrr ?? null,
    forecast_next_3_months: n.forecast ?? null,
    complete: n.complete,
  };
}

/**
 * The list and what each email sent to it did. Its broadcasts and sequences
 * are measured by their bytes, what they sold is looked up (kept or not, the
 * bytes it is kept at, and the PayPal sales it would read), and all that
 * reading them can cost is set aside in one go before anything is read
 * (lib/api-read-rules.ts, emailsWork and, when what they sold is not kept,
 * mailRevenueColdWork), then settled at what was read: the kept copy at the
 * bytes it was read at, a copy made again at the bytes it was kept at
 * (lib/api-guard.ts, holdMoreApi). Only a copy that was kept when measured
 * and is gone a moment later takes its sales as a second step, before
 * Stripe is asked (refused with its own words, nothing shown).
 */
export async function emailsTool(store: Store, meter: { charge: Charge; hold: Hold }) {
  if (!store.listId) return { list: null, note: "This store keeps no list yet." };
  const [sizes, flowBytes, revenueBytes, paypal] = await Promise.all([
    broadcastSizes(store.listId, EMAILS_BROADCASTS),
    flowsBytes(store.listId),
    keptMailRevenueBytes(store),
    paypalCounts(store.statsId),
  ]);
  if (!sizes || flowBytes === null || revenueBytes === null || !paypal) throw new Error("the emails could not be measured");
  // What they sold is read when there is an email or a sequence to credit, and from Stripe when it is not kept.
  const salesRead = Boolean(store.stripeAccountId && store.statsId) && revenueBytes === 0 && (sizes.count > 0 || flowBytes > 0);
  const emailsAt = (revenue: number) => addWork(EMAILS_PROBE_WORK, emailsWork({ broadcasts: sizes.count, broadcastBytes: sizes.bytes, flowBytes, revenueBytes: revenue }));
  const held = apiReadUnits(salesRead ? addWork(emailsAt(0), mailRevenueColdWork(paypal.sales)) : emailsAt(revenueBytes));
  const settle = await meter.hold(held);
  if (settle instanceof Response) return settle;
  const [counts, broadcasts, flows] = await Promise.all([listCounts(store.listId), listBroadcasts(store.listId, EMAILS_BROADCASTS), readFlows(store.listId)]);
  const said: { refused: Response | null; second: number; read: number; kept: number | null } = { refused: null, second: 0, read: 0, kept: null };
  const [revenueRead, flowCounts] = await Promise.all([
    broadcasts.length || flows.length
      ? readMailRevenuePaid(
          store,
          async () => {
            if (salesRead) return true;
            said.second = apiReadUnits(mailRevenueColdWork(paypal.sales));
            said.refused = await meter.charge(said.second, held);
            return said.refused === null;
          },
          (bytes) => {
            if ("read" in bytes) said.read = bytes.read;
            else said.kept = bytes.kept;
          },
        ).catch(() => null)
      : Promise.resolve(null),
    // Read by the studio's own strict reader, one rule for what a tally may be (Claude 4 on #3176). A reading that
    // failed or answered in another shape is unknown: each sequence says null, never 0 (CX-123 rule 24).
    readFlowStatsStrict(flows).catch(() => null),
  ]);
  if (said.refused) return said.refused;
  // Settled at what was read: the copy at the bytes it was read at, or the sales and the copy made of them. What a
  // second step already took is counted against it, so it is not taken twice.
  const read = said.kept === null ? emailsAt(said.read) : addWork(emailsAt(0), mailRevenueColdWork(paypal.sales, said.kept));
  const due = Math.max(0, settledUnits(read, held + said.second) - said.second);
  const refused = await settle(due);
  if (refused) return refused;
  const revenue = revenueRead === "refused" ? null : revenueRead;
  return {
    currency: store.currency,
    list: { people: counts.total, agreed_to_hear: counts.agreed, left: counts.left, can_be_emailed: counts.mailable },
    emails: broadcasts.map((b) => {
      const money = broadcastMoney(revenue, b.id);
      return {
        subject: b.subject,
        status: b.status,
        // Seconds, as lib/broadcasts.ts keeps them.
        sent_at: b.finishedAt || b.sendAt ? new Date((b.finishedAt || b.sendAt) * 1000).toISOString() : null,
        to: b.total,
        sent: b.sent,
        sales: b.tagged && money ? money.sales : null,
        revenue: b.tagged && money ? money.cents : null,
        // Sales in another currency than the store's, counted, never added to revenue (22 [E5], unit 2d).
        sales_in_another_currency: b.tagged && money ? money.elsewhere ?? 0 : null,
      };
    }),
    sequences: flows.map((f) => {
      const c = flowCounts?.get(f.id) ?? null;
      const money = flowMoney(revenue, f.id);
      return { name: f.name, trigger: f.trigger, started: c ? c.started : null, emails_sent: c ? c.sent : null, reached_the_end: c ? c.reached : null, counts_unavailable: c === null, sales: money?.sales ?? null, revenue: money?.cents ?? null, sales_in_another_currency: money ? money.elsewhere ?? 0 : null };
    }),
  };
}

/**
 * The affiliate program, each affiliate by their link's code, never their
 * address. Reading it takes the further API requests its size costs first
 * (lib/api-read.ts, chargeBook), as /api/v1/affiliates does: the refusal is
 * handed back as it is, with nothing read.
 */
export async function affiliatesTool(store: Store, charge: Charge) {
  if (!affiliatesOn(store)) return { program: null, note: "The affiliate program is off." };
  const refused = await chargeBook(store, charge);
  if (refused) return refused;
  const book = await readBook(store);
  return {
    currency: book.currency,
    program: { percent: store.affiliates.percent, days: store.affiliates.days, rule: store.affiliates.rule, memberships_months: store.affiliates.recurring, bonuses: store.affiliates.bonuses },
    affiliates: book.rows.map((r) => ({
      code: r.affiliate.code,
      status: r.affiliate.status,
      clicks: r.clicks,
      sales: r.sales,
      earned: r.earned,
      paid: r.paid,
      owed: r.owed,
      payable_now: r.payable,
      held_for_review: r.held,
      held_because: r.flags,
    })),
    refunds_checked: book.refundsChecked,
  };
}

/** Who bought, in numbers only. */
export function buyersTool(data: StatsData, w: Window) {
  const b = data.buyers?.[w];
  return {
    window: NAMES[w],
    currency: data.currency,
    buyers: b ? { people: b.buyers, orders: b.orders, revenue: b.cents, had_bought_before: b.returning, bought_more_than_once: b.repeat } : null,
  };
}

/** What changed that is worth acting on, by the studio's own rules (lib/insights.ts). */
export function insightsTool(data: StatsData, w: Window) {
  return {
    window: NAMES[w],
    worth_knowing: insightsFrom(data, w, [], 6).map((i) => ({ text: i.text, tone: i.tone, arithmetic: i.math ?? null })),
  };
}

/** A block as an agent may read it: testimonials counted, never quoted. */
export function blockForAgent(block: PageBlock) {
  return block.kind === "quotes" ? { id: block.id, kind: block.kind, heading: block.heading, testimonials: block.items.length } : block;
}

/**
 * A product's sales page as the creator saved it, block by block, so an agent
 * sees what is there before it prepares any change (631 [AA1] (a), unit 9).
 * Testimonials are counted, never quoted: a buyer's words stay out of an
 * assistant's conversation, as everywhere on this server.
 */
export function salesPageTool(productId: string, title: string, page: SalesPage) {
  return {
    product: productId,
    title,
    note: "Blocks in page order, as saved. Testimonials (kind quotes) are counted, not quoted. Reviews blocks name review ids only. An empty list means the product has no sales page of its own yet.",
    seo_title: page.seoTitle,
    seo_description: page.seoDescription,
    blocks: page.blocks.map(blockForAgent),
  };
}

/**
 * What reading one product's listing and then `work` takes, paid before
 * anything is read (lib/api-read-rules.ts): the listing only when the store's
 * own record does not hold it (lib/catalog-read-count.ts).
 */
async function payFor(store: Store, id: string, work: Parameters<typeof addWork>[1], charge: Charge): Promise<Response | null> {
  return charge(apiReadUnits(addWork(listingsWork(listingsToRead(store, [id])), work)));
}

/** One product's long description, or null for an unknown product; the refusal when the store's API requests are used up. */
export async function productTextTool(store: Store, id: string, charge: Charge): Promise<Response | { product: string; title: string; description: string } | null> {
  const refused = await payFor(store, id, productTextWork(), charge);
  if (refused) return refused;
  const listing = await readListing(store, id);
  if (!listing) return null;
  if (!listing.about) return { product: listing.id, title: listing.title, description: "" };
  // Read exactly: a description the listing says exists that does not read is unknown and throws, never "" (CX-123 rule 24).
  if (!store.statsId) throw new Error("the description could not be read");
  return { product: listing.id, title: listing.title, description: await readAboutExact(store.statsId, listing.id) };
}

/** A product's sales page, or null when the store has no such product; the refusal when the store's API requests are used up. */
export async function readSalesPageTool(store: Store, id: string, charge: Charge) {
  const refused = await payFor(store, id, salesPageWork(), charge);
  if (refused) return refused;
  const listing = await readListing(store, id);
  if (!listing) return null;
  // Read exactly: an answer that is not known is "unavailable", never an empty page (Codex J on #1821).
  const kept = store.statsId ? await readPageExact(store.statsId, listing.id).catch(() => undefined) : { page: null, bytes: 0 };
  if (kept === undefined) return { error: "The sales page could not be read just now. Try again in a moment." };
  return salesPageTool(listing.id, listing.title, kept.page ?? { ...EMPTY_PAGE, blocks: [] });
}

/**
 * A course's outline as the studio edits it (631 [AA1] (a), unit 10): modules
 * and lessons in order, with what each lesson holds. Files and videos by
 * their names only, never where they are kept: a paid course's files are
 * private, and their place in the store is the only handle to them.
 */
export function courseOutlineTool(productId: string, title: string, course: Course) {
  return {
    product: productId,
    title,
    certificate: course.certificate,
    note: "Modules and lessons in order. drip_days counts from the course's start. Files and videos are named, never located. Read a lesson's text, quiz and task with get_lesson.",
    modules: course.modules.map((unit) => ({
      id: unit.id,
      title: unit.title,
      drip_days: unit.dripDays,
      lessons: unit.lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        preview: lesson.preview,
        has_text: lesson.hasBody,
        video: lesson.video ? lesson.video.name : null,
        files: lesson.files.map((file) => file.name),
        link: lesson.link,
      })),
    })),
  };
}

/** The course of one of this store's products, or null; the refusal when the store's API requests are used up. */
export async function readCourseTool(store: Store, id: string, charge: Charge) {
  const refused = await payFor(store, id, courseOutlineWork(), charge);
  if (refused) return refused;
  const listing = await readListing(store, id);
  // Read exactly: only a course Redis says is not there is none; another answer throws, never "no course" (CX-123 rule 24).
  const course = listing?.course ? await readCourseExact(listing.course.id) : null;
  return listing && course ? courseOutlineTool(listing.id, listing.title, course) : null;
}

/** One lesson's text, its quiz with the right answers and its task, as the studio edits them; null when there is no such lesson. */
export async function readLessonTool(store: Store, id: string, lessonId: string, charge: Charge) {
  const refused = await payFor(store, id, lessonWork(), charge);
  if (refused) return refused;
  const listing = await readListing(store, id);
  const course = listing?.course ? await readCourseExact(listing.course.id) : null;
  const found = course ? findLesson(course, lessonId) : null;
  if (!listing || !course || !found) return null;
  // Read exactly: only what Redis says is not there is no text, quiz or task; another answer throws, never "" or none (CX-123 rule 24).
  const [text, quiz, task] = await Promise.all([readBodyExact(course.id, lessonId), readQuizForExact(course.id, lessonId), readTaskForExact(course.id, lessonId)]);
  // readBodyExact answers null for a reply it cannot read: unknown, never a lesson with no text.
  if (text === null) throw new UnknownReplyError("a lesson's text");
  return { product: listing.id, module: found.unit.title, lesson: found.lesson.id, title: found.lesson.title, text, quiz, task };
}

/**
 * How a product's page test stands (631 [AA1] (a), unit 12): the views,
 * checkouts, sales and money of each version, and the state the studio's own
 * rule gives (lib/headline-test-rules.ts testState), never a winner of this
 * tool's own making.
 */
export function pageTestTool(productId: string, page: SalesPage, counts: Counts, measure: "money" | "checkouts", shareB: number, now = Date.now()) {
  const state = testState(counts, measure, { declared: declaredMeasure(page), shareB, now });
  const version = (v: "a" | "b") => ({ views: counts[`v${v}`], checkouts_started: counts[`c${v}`], sales: counts[`s${v}`] ?? null, revenue: counts[`r${v}`] ?? null });
  return {
    product: productId,
    test: page.variant ? "whole_page" : "headline",
    headlines: page.test && !page.variant ? { b: page.test.headline, b_line: page.test.sub } : null,
    measure,
    note: "a is the page as saved, b the version tested against it. state is the studio's own rule: won, running, too_few, split, maturing, measure_changed or unavailable. Money is in the store currency's smallest unit; null is not counted.",
    state: state.state,
    winner: state.winner,
    a: version("a"),
    b: version("b"),
  };
}

/** A product's page test as the studio reads it, or why there is none; the refusal when the store's API requests are used up. */
export async function readPageTestTool(store: Store, id: string, charge: Charge): Promise<Response | { found: false; error: string } | { found: true; value: ReturnType<typeof pageTestTool> }> {
  const refused = await payFor(store, id, pageTestWork(), charge);
  if (refused) return refused;
  const listing = await readListing(store, id);
  if (!listing) return { found: false, error: "There is no product with that id in this store. Use list_products for the ids." };
  // Read exactly: an answer that is not known is "unavailable", never a page with no test.
  const kept = store.statsId ? await readPageExact(store.statsId, listing.id).catch(() => undefined) : { page: null, bytes: 0 };
  if (kept === undefined) return { found: false, error: "The page could not be read just now. Try again in a moment." };
  const page = kept.page ?? { ...EMPTY_PAGE, blocks: [] };
  const test = runningTest(page);
  if (!test) return { found: false, error: "This product's page is not running a test." };
  const counts = await readCounts(store.statsId, listing.id, test);
  if (counts.unavailable) return { found: false, error: "The test's numbers could not be read just now. Try again in a moment." };
  return { found: true, value: pageTestTool(listing.id, page, counts, isFree(listing) ? "checkouts" : "money", expectedShareB(test)) };
}

/** How far down a product's sales page visitors read, block by block, as the studio shows it; null for an unknown product. */
export async function readPageReadingTool(store: Store, id: string, charge: Charge) {
  const refused = await payFor(store, id, pageReadingWork(), charge);
  if (refused) return refused;
  const listing = await readListing(store, id);
  if (!listing) return null;
  // The page and its counts read exactly: an answer that is not known is "unavailable", never a page with no blocks
  // or no visitors measured (CX-123 rule 24). A store with no stats id has never counted a visitor.
  const nothing = { visitors: 0, stopped: {}, whyNot: {}, videos: {} };
  const [kept, depth] = await Promise.all([
    store.statsId ? readPageExact(store.statsId, listing.id).catch(() => undefined) : { page: null, bytes: 0 },
    store.statsId ? readDepthExact(store.statsId, listing.id).catch(() => undefined) : nothing,
  ]);
  if (kept === undefined) return { error: "The page could not be read just now. Try again in a moment." };
  if (depth === undefined) return { error: "How far visitors read could not be read just now. Try again in a moment." };
  const page = kept.page ?? { ...EMPTY_PAGE, blocks: [] };
  // While a whole second version is tested, each visitor reads one of two pages: no single depth means anything.
  const reach = page.variant ? null : reachShares(page.blocks.map((b) => b.id), depth.stopped, depth.visitors);
  return {
    product: listing.id,
    note: "reached is the percent of measured visitors who scrolled to each block, in page order. Null while a whole second version of the page is tested. why_not counts the reasons visitors picked for not buying; videos count how far each video was watched.",
    visitors_measured: reach ? reach.visitors : null,
    blocks: reach ? page.blocks.map((b) => ({ id: b.id, kind: b.kind, reached_percent: reach.shares[b.id] ?? 0 })) : null,
    why_not: depth.whyNot,
    videos: depth.videos,
  };
}

/**
 * A product's sales page as it was before its last saves (631 [AA1] (a),
 * unit 13): the list, or one version block by block, with testimonials
 * counted as on get_sales_page. What an agent shows as "before" when it
 * prepares a change, and how a creator can ask to bring one back.
 */
export async function readPageVersionsTool(store: Store, id: string, version: number | null, hold: Hold) {
  // Set aside at its most before anything is read: the listing and every version the page may keep. Counted and read
  // afterwards, and settled at the larger of that ceiling for what was read and what was really read and sent, so a
  // version saved between the count and the read is paid for (Codex J on #1821).
  const listings = listingsWork(listingsToRead(store, [id]));
  const most = apiReadUnits(addWork(listings, pageVersionsWork(MAX_VERSIONS, version !== null)));
  const settle = await hold(most);
  if (settle instanceof Response) return settle;
  const unavailable = { found: false as const, error: "The page's versions could not be read just now. Try again in a moment." };
  const listing = await readListing(store, id);
  if (!listing) {
    const refused = await settle(settledUnits(listings, most));
    return refused ?? { found: false as const, error: "There is no product with that id in this store. Use list_products for the ids." };
  }
  const kept = store.statsId ? await countVersions(store.statsId, listing.id) : 0;
  if (kept === null || !store.statsId) {
    // Nothing of the versions was read: only the listing and the count are kept.
    const refused = await settle(settledUnits(addWork(listings, pageVersionsWork(0, false)), most));
    return refused ?? unavailable;
  }
  const read = await readVersionsExact(store.statsId, listing.id).catch(() => null);
  // Read but not known: how much was read is not known either, so all that was set aside is kept (Codex J on #1821).
  if (!read) return (await settle(most)) ?? unavailable;
  const { versions } = read;
  let value: unknown;
  let answer: { found: true; value: unknown } | { found: false; error: string };
  if (version === null) {
    value = {
      product: listing.id,
      note: "Newest first. at is when that version was saved over, in milliseconds since 1970 (UTC). Read one with version.",
      versions: versions.map((v, index) => ({ version: index, at: v.at, blocks: v.page.blocks.length, headline: v.page.blocks[0]?.kind === "hero" ? v.page.blocks[0].headline : "" })),
    };
    answer = { found: true as const, value };
  } else {
    const one = versions[version];
    value = one ? { ...salesPageTool(listing.id, listing.title, one.page), version, at: one.at } : null;
    answer = one ? { found: true as const, value } : { found: false as const, error: "There is no such version. Read the list first, without version." };
  }
  const ceiling = addWork(listings, pageVersionsWork(versions.length, version !== null));
  const sent = Buffer.byteLength(JSON.stringify(answer.found ? answer.value : { error: answer.error }, null, 2) ?? "", "utf8");
  const refused = await settle(settledUnits(atLeast(ceiling, { bytes: COUNT_REPLY_BYTES + read.bytes, sent }), most));
  return refused ?? answer;
}

/**
 * The creator's saved sections, the blocks kept to reuse on any page (631
 * [AA1] (a), unit 14), newest change first, testimonials counted.
 */
export async function savedBlocksTool(store: Store, hold: Hold) {
  // Set aside at its most before anything is read: every section a library may hold. Counted and read afterwards, and
  // settled at the larger of that ceiling for what was read and what was really read and sent, so sections saved
  // between the count and the read are paid for (Codex J on #1821).
  const most = apiReadUnits(savedBlocksWork(SAVED_SECTIONS_MAX));
  const settle = await hold(most);
  if (settle instanceof Response) return settle;
  const unavailable = { sections: null, note: "The saved sections could not be read just now. Try again in a moment." };
  const held = await countSections(store.statsId);
  if (held === null || held > SAVED_SECTIONS_MAX || !store.statsId) {
    // Nothing of the sections was read: only the count is kept.
    const refused = await settle(settledUnits(savedBlocksWork(0), most));
    return refused ?? unavailable;
  }
  const read = await readSectionsExact(store.statsId).catch(() => null);
  // Read but not known, or more than a library holds: how much was read is not known, so all that was set aside is kept.
  if (!read || read.sections.length > SAVED_SECTIONS_MAX) return (await settle(most)) ?? unavailable;
  const value = {
    note: "Sections the creator saved to reuse on any page, newest change first. updated_at is in seconds since 1970 (UTC). Testimonials are counted, not quoted.",
    sections: [...read.sections]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((section) => ({ id: section.id, name: section.name, updated_at: section.updatedAt, blocks: section.blocks.map(blockForAgent) })),
  };
  const sent = Buffer.byteLength(JSON.stringify(value, null, 2) ?? "", "utf8");
  const refused = await settle(settledUnits(atLeast(savedBlocksWork(read.sections.length), { bytes: COUNT_REPLY_BYTES + read.bytes, sent }), most));
  return refused ?? value;
}

/** A work's ceiling, raised to what was really read and sent where that came to more. */
function atLeast(work: ReadWork, measured: { bytes: number; sent: number }): ReadWork {
  return { ...work, bytes: Math.max(work.bytes, measured.bytes), sent: Math.max(work.sent, measured.sent) };
}
