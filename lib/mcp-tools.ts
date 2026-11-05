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
import { type Live, type RangeData, type StatsData, type Today, KEPT_DAYS, LIVE_MINUTES, readsSales, productsInStats, readSales, readStats, studioStats } from "@/lib/stats";
import { readListing, readListings, readTitles } from "@/lib/catalog";
import { readAbout } from "@/lib/product-about";
import { type Course, findLesson, readBody, readCourse } from "@/lib/course";
import { readQuizFor } from "@/lib/quiz";
import { readTaskFor } from "@/lib/assignment";
import { readPage, readVersions } from "@/lib/sales-page-store";
import { readSections } from "@/lib/saved-block-store";
import { PICKER_PAGE, bundleChoicesPage, choiceCursor, choiceQuery } from "@/lib/bundle-choices";
import { storeImportsRead } from "@/lib/imports";
import type { PageBlock } from "@/lib/sales-page";
import { type SalesPage, declaredMeasure, runningTest } from "@/lib/sales-page";
import { expectedShareB, readCounts } from "@/lib/headline-test";
import { type Counts, testState } from "@/lib/headline-test-rules";
import { reachShares, readDepth } from "@/lib/page-depth";
import { isFree } from "@/lib/store-field-rules";
import { membershipNumbers } from "@/lib/membership-numbers";
import { listBroadcasts } from "@/lib/broadcasts";
import { broadcastMoney, flowMoney, readMailRevenue } from "@/lib/mail-revenue";
import { flowStats, readFlows } from "@/lib/flows";
import { listCounts } from "@/lib/contacts";
import { affiliatesOn, readBook } from "@/lib/affiliates";
import { insightsFrom } from "@/lib/insights";
import { readPaths } from "@/lib/next-bought";
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
  const stats = await readStats(store, now);
  if (!stats) return null;
  let state: StatsData["sales"] = readsSales(store) ? "ok" : "none";
  const sales = readsSales(store)
    ? await readSales(store, now).catch(() => {
        state = "error";
        return null;
      })
    : null;
  const listings = await readListings(store, productsInStats(store, stats, sales)).catch(() => []);
  return studioStats(store, stats, sales, state, listings);
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

/** Each product for the window, and what its buyers went on to buy (lib/next-bought.ts). */
export async function productsTool(store: Store, data: StatsData, w: Window) {
  const known = paidFiguresComplete(data);
  const paths = await readPaths(store.statsId).catch(() => null);
  const titles = await readTitles(store).catch(() => new Map<string, string>());
  const name = (id: string) => titles.get(id) ?? id;
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
    bought_next: paths
      ? {
          note: "From all sales: what the same buyers bought on a later visit, from three buyers up, with the median days between.",
          bought_first_most: Object.entries(paths.starts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([id, buyers]) => ({ product: name(id), buyers })),
          sequences: Object.entries(paths.next).flatMap(([from, steps]) => steps.map((s) => ({ first: name(from), then: name(s.id), buyers: s.buyers, days_later: s.days }))),
        }
      : null,
  };
}

/** Memberships as the Membership numbers page shows them, without anybody's address or words. */
export async function membershipsTool(store: Store) {
  const n = await membershipNumbers(store);
  if (!n) return { memberships: null, note: "No memberships could be read: the store has no Stripe account connected, or sells none." };
  const titles = await readTitles(store).catch(() => new Map<string, string>());
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
    by_channel: (n.byChannel ?? []).map((c) => ({ channel: c.channel, started: c.started, running: c.running, still_running_at_3_months: c.stayed3, average_months: c.months })),
    why_members_left: n.leaving ? { canceled: n.leaving.canceled, answered: n.leaving.answered, reasons: n.leaving.reasons.map((r) => ({ reason: r.reason, members: r.members, mrr: Math.round(r.mrr) })), payment_failed: n.leaving.paymentFailed } : null,
    mrr_by_month: n.movements?.months ?? [],
    arpu: n.movements?.arpu ?? null,
    net_revenue_retention: n.movements?.nrr ?? null,
    forecast_next_3_months: n.forecast ?? null,
    complete: n.complete,
  };
}

/** The list and what each email sent to it did. */
export async function emailsTool(store: Store) {
  if (!store.listId) return { list: null, note: "This store keeps no list yet." };
  const [counts, broadcasts, flows] = await Promise.all([listCounts(store.listId), listBroadcasts(store.listId, 30), readFlows(store.listId)]);
  const [revenue, flowCounts] = await Promise.all([
    broadcasts.length || flows.length ? readMailRevenue(store).catch(() => null) : Promise.resolve(null),
    flowStats(flows).catch(() => new Map()),
  ]);
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
      const c = flowCounts.get(f.id);
      const money = flowMoney(revenue, f.id);
      return { name: f.name, trigger: f.trigger, started: c?.started ?? 0, emails_sent: c?.sent ?? 0, reached_the_end: c?.reached ?? 0, sales: money?.sales ?? null, revenue: money?.cents ?? null, sales_in_another_currency: money ? money.elsewhere ?? 0 : null };
    }),
  };
}

/** The affiliate program, each affiliate by their link's code, never their address. */
export async function affiliatesTool(store: Store) {
  if (!affiliatesOn(store)) return { program: null, note: "The affiliate program is off." };
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

/**
 * Who is on the store right now and today so far, as the studio's numbers
 * show them every half minute (631 [AA1] (a), unit 8): visitors counted once
 * each, by where they came from. No visitor is identified.
 */
export function liveTool(live: Live, today: Today | null) {
  return {
    note: `Visitors in the last ${LIVE_MINUTES} minutes, each once. Today is the UTC day so far. Today's sales are null when Stripe is not connected or did not answer, never zero.`,
    last_minutes: LIVE_MINUTES,
    visitors_now: live.visitors,
    sources_now: live.sources.map((s) => ({ channel: s.source, visitors: s.visitors })),
    today: today
      ? { day: today.date, visitors: today.visitors, page_views: today.views, checkouts_started: today.checkouts, sales: today.sales?.sales ?? null, revenue: today.sales?.cents ?? null, sources: today.sources.map((s) => ({ channel: s.source, visits: s.visits })) }
      : null,
  };
}

/**
 * Any stretch of days the creator names, as the studio's date picker reads it
 * (lib/stats.ts readRange; 631 [AA1] (a), unit 8). Paid figures are null
 * unless the sales reading was complete: unknown is never zero.
 */
export function rangeTool(range: RangeData, titles: ReadonlyMap<string, string>) {
  const known = range.sales === "ok" && !range.partial;
  const paid = <T>(value: T) => (known ? value : null);
  return {
    from: range.from,
    to: range.to,
    currency: range.currency,
    paid_figures_complete: known,
    coverage_note: `UTC days, up to ${KEPT_DAYS} days back. Paid totals need a complete sales reading; null is unavailable, not zero. Sales in another currency are counted apart and never added to revenue. Money is in the currency smallest unit.`,
    sales_in_another_currency: range.elsewhere,
    totals: { visitors: range.totals.visitors, page_views: range.totals.views, checkouts_started: range.totals.checkouts, sales: paid(range.totals.sales), revenue: paid(range.totals.cents) },
    the_same_days_before: range.before
      ? { visitors: range.before.visitors, page_views: range.before.views, checkouts_started: range.before.checkouts, sales: paid(range.before.sales), revenue: paid(range.before.cents) }
      : null,
    days: range.days.map((d) => ({ day: d.date, visitors: d.visitors, page_views: d.views, checkouts_started: d.checkouts, sales: paid(d.sales), revenue: paid(d.cents) })),
    channels: range.channels.map((c) => ({ channel: c.source, visits: c.visits, sales: paid(c.sales), revenue: paid(c.cents) })),
    channels_truncated: range.channelsTruncated === true,
    products: range.products.map((p) => ({ id: p.id, title: titles.get(p.id) ?? "A product no longer in your store", page_views: p.views, checkouts_started: p.checkouts, sales: paid(p.sales), revenue: paid(p.cents) })),
    products_truncated: range.productsTruncated === true,
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

/** One product's long description, or why there is none to read. */
export async function productTextTool(store: Store, id: string): Promise<{ product: string; title: string; description: string } | null> {
  const listing = await readListing(store, id);
  if (!listing) return null;
  return { product: listing.id, title: listing.title, description: listing.about ? await readAbout(store.statsId, listing.id) : "" };
}

/** A product's sales page, or null when the store has no such product. */
export async function readSalesPageTool(store: Store, id: string) {
  const listing = await readListing(store, id);
  if (!listing) return null;
  return salesPageTool(listing.id, listing.title, await readPage(store.statsId, listing.id));
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

/** The course of one of this store's products, or null. */
export async function readCourseTool(store: Store, id: string) {
  const listing = await readListing(store, id);
  const course = listing?.course ? await readCourse(listing.course.id) : null;
  return listing && course ? courseOutlineTool(listing.id, listing.title, course) : null;
}

/** One lesson's text, its quiz with the right answers and its task, as the studio edits them; null when there is no such lesson. */
export async function readLessonTool(store: Store, id: string, lessonId: string) {
  const listing = await readListing(store, id);
  const course = listing?.course ? await readCourse(listing.course.id) : null;
  const found = course ? findLesson(course, lessonId) : null;
  if (!listing || !course || !found) return null;
  const [text, quiz, task] = await Promise.all([readBody(course.id, lessonId), readQuizFor(course.id, lessonId), readTaskFor(course.id, lessonId)]);
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

/** A product's page test as the studio reads it, or why there is none. */
export async function readPageTestTool(store: Store, id: string): Promise<{ found: false; error: string } | { found: true; value: ReturnType<typeof pageTestTool> }> {
  const listing = await readListing(store, id);
  if (!listing) return { found: false, error: "There is no product with that id in this store. Use list_products for the ids." };
  const page = await readPage(store.statsId, listing.id);
  const test = runningTest(page);
  if (!test) return { found: false, error: "This product's page is not running a test." };
  const counts = await readCounts(store.statsId, listing.id, test);
  if (counts.unavailable) return { found: false, error: "The test's numbers could not be read just now. Try again in a moment." };
  return { found: true, value: pageTestTool(listing.id, page, counts, isFree(listing) ? "checkouts" : "money", expectedShareB(test)) };
}

/** How far down a product's sales page visitors read, block by block, as the studio shows it; null for an unknown product. */
export async function readPageReadingTool(store: Store, id: string) {
  const listing = await readListing(store, id);
  if (!listing) return null;
  const [page, depth] = await Promise.all([readPage(store.statsId, listing.id), readDepth(store.statsId, listing.id)]);
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
export async function readPageVersionsTool(store: Store, id: string, version: number | null) {
  const listing = await readListing(store, id);
  if (!listing) return { found: false as const, error: "There is no product with that id in this store. Use list_products for the ids." };
  const versions = await readVersions(store.statsId, listing.id);
  if (version === null) {
    return {
      found: true as const,
      value: {
        product: listing.id,
        note: "Newest first. at is when that version was saved over, in milliseconds since 1970 (UTC). Read one with version.",
        versions: versions.map((v, index) => ({ version: index, at: v.at, blocks: v.page.blocks.length, headline: v.page.blocks[0]?.kind === "hero" ? v.page.blocks[0].headline : "" })),
      },
    };
  }
  const one = versions[version];
  if (!one) return { found: false as const, error: "There is no such version. Read the list first, without version." };
  return { found: true as const, value: { ...salesPageTool(listing.id, listing.title, one.page), version, at: one.at } };
}

/**
 * The creator's saved sections, the blocks kept to reuse on any page (631
 * [AA1] (a), unit 14), newest change first, testimonials counted.
 */
export async function savedBlocksTool(store: Store) {
  const sections = await readSections(store.statsId);
  return {
    note: "Sections the creator saved to reuse on any page, newest change first. updated_at is in seconds since 1970 (UTC). Testimonials are counted, not quoted.",
    sections: [...sections]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((section) => ({ id: section.id, name: section.name, updated_at: section.updatedAt, blocks: section.blocks.map(blockForAgent) })),
  };
}

/**
 * The products a bundle can be made of (631 [AA1] (a)): the same list, order
 * and reasons as the creator's own picker in /studio/bundles
 * (lib/bundle-choices.ts), so an agent preparing a bundle never offers what
 * the store would refuse. Prices in the smallest unit of the store's currency.
 */
export async function bundleChoicesTool(store: Store, args: Record<string, unknown>) {
  const owner = typeof args.bundle === "string" ? args.bundle.slice(0, 40) : "";
  // A page at a time, each inside the one API request it pays for (Codex A3, #1933): never the whole catalog in one call.
  const listed = await bundleChoicesPage(store, { owner, query: choiceQuery(args.search), after: choiceCursor(args.cursor) });
  return {
    note: `Products that may go in a bundle, in the creator's order, ${PICKER_PAGE} a page, each with can_go_in, and why_not saying why it cannot. To read the next page, call again with cursor set to next_cursor; next_cursor is null on the last page. matches counts the products not ruled out by their kind (null with a search, which looks through the products a stretch at a time, so a page may hold fewer than 20 or none and still have a next_cursor); unsearched counts the products in that stretch whose name is not ready to search yet: list without a search to see them. price is in the smallest unit of the store's currency. hidden products are not listed on the store page.`,
    next_cursor: listed.next === null ? null : String(listed.next),
    matches: listed.matches,
    unsearched: listed.unsearched,
    products: listed.products.map((p) => ({ id: p.id, title: p.title, price: p.priceCents, what: p.what, hidden: p.hidden, can_go_in: p.why === null, why_not: p.why })),
  };
}

/**
 * The store's latest imports from another platform (631 [AA1] (a)): what
 * kind, where from, how far along and what each row came to, as counts. Not
 * the file's name nor who started it, which may name a person; not the rows
 * themselves, and not the report of rows left out, which holds addresses.
 */
export async function importsTool(store: Store) {
  // Only Redis's exact answers: anything else is unknown, said so by the route, never an empty history (Codex A3, #1933).
  const jobs = await storeImportsRead(store);
  if (jobs === null) return null;
  return {
    note: "Newest first, at most ten. started_at and finished_at are in milliseconds since 1970 (UTC); finished_at is 0 while it runs. added were brought in, already were there, skipped were left out on purpose (no consent, unsubscribed, a repeated row), errors could not be brought in: the creator downloads that report in the studio.",
    imports: jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      from: job.options.source ?? "csv",
      state: job.state,
      started_at: job.at,
      finished_at: job.finishedAt,
      rows_expected: job.expected,
      rows_received: job.total,
      rows_looked_at: job.done,
      added: job.counts.added,
      already: job.counts.already,
      skipped: job.counts.skipped,
      errors: job.counts.errors,
      emailed: job.counts.mailed,
      not_emailed: job.counts.unmailed,
      contacts_not_emailable: job.counts.contacts ?? 0,
      stopped: job.counts.stopped ?? 0,
    })),
  };
}
