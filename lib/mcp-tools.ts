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
import { listingsToRead, productIds, readListings, readTitles } from "@/lib/catalog";
import { membershipNumbersPaid } from "@/lib/membership-numbers";
import { broadcastSizes, listBroadcasts } from "@/lib/broadcasts";
import { broadcastMoney, flowMoney, readMailRevenuePaid } from "@/lib/mail-revenue";
import { flowStats, flowsBytes, readFlows } from "@/lib/flows";
import { listCounts } from "@/lib/contacts";
import { affiliatesOn, readBook } from "@/lib/affiliates";
import { type Charge, chargeBook } from "@/lib/api-read";
import { EMAILS_BROADCASTS, MEMBERSHIPS_COLD_WORK, apiReadUnits, emailsWork, listingsWork, mailRevenueColdWork, membershipsWork } from "@/lib/api-read-rules";
import { paypalCounts } from "@/lib/paypal-sales";
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
  const read = await readFullNumbersPaid(store, null, now);
  return read instanceof Response ? null : read;
}

/**
 * readFullNumbers, taking what reading the listings of the products the
 * numbers name costs (lib/api-read-rules.ts, listingsWork) once they are
 * known and before they are read; the refusal, as it is, when it is not left.
 * The numbers themselves are taken before this, by the caller (lib/api-read.ts, chargeNumbers).
 */
export async function readFullNumbersPaid(store: Store, charge: Charge | null, now = Date.now()): Promise<StatsData | null | Response> {
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
  const refused = charge ? await charge(apiReadUnits(listingsWork(listingsToRead(store, named)))) : null;
  if (refused) return refused;
  const listings = await readListings(store, named).catch(() => []);
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

/**
 * Memberships as the Membership numbers page shows them, without anybody's
 * address or words. What reading them costs is taken first: the kept numbers,
 * the titles and the answer; and, when they are not kept, every page of the
 * creator's Stripe account they read, just before it (lib/api-read-rules.ts).
 */
export async function membershipsTool(store: Store, charge: Charge) {
  if (!store.stripeAccountId || !store.statsId) return { memberships: null, note: "No memberships could be read: the store has no Stripe account connected, or sells none." };
  const first = await charge(apiReadUnits(membershipsWork(productIds(store).length)));
  if (first) return first;
  const said: { refused: Response | null } = { refused: null };
  const read = await membershipNumbersPaid(store, async () => {
    said.refused = await charge(apiReadUnits(MEMBERSHIPS_COLD_WORK));
    return said.refused === null;
  });
  if (said.refused) return said.refused;
  const n = read === "refused" ? null : read;
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

/**
 * The list and what each email sent to it did. Its broadcasts and sequences
 * are measured by their bytes and what reading them costs is taken first
 * (lib/api-read-rules.ts, emailsWork); what they sold, when it is not kept,
 * just before its sales are read (mailRevenueColdWork).
 */
export async function emailsTool(store: Store, charge: Charge) {
  if (!store.listId) return { list: null, note: "This store keeps no list yet." };
  const [sizes, flowBytes] = await Promise.all([broadcastSizes(store.listId, EMAILS_BROADCASTS), flowsBytes(store.listId)]);
  if (!sizes || flowBytes === null) throw new Error("the emails could not be measured");
  const first = await charge(apiReadUnits(emailsWork({ broadcasts: sizes.count, broadcastBytes: sizes.bytes, flowBytes })));
  if (first) return first;
  const [counts, broadcasts, flows] = await Promise.all([listCounts(store.listId), listBroadcasts(store.listId, EMAILS_BROADCASTS), readFlows(store.listId)]);
  const said: { refused: Response | null } = { refused: null };
  const [revenueRead, flowCounts] = await Promise.all([
    broadcasts.length || flows.length
      ? readMailRevenuePaid(store, async () => {
          const paypal = await paypalCounts(store.statsId);
          said.refused = paypal ? await charge(apiReadUnits(mailRevenueColdWork(paypal.sales))) : await charge(Number.POSITIVE_INFINITY);
          return said.refused === null;
        }).catch(() => null)
      : Promise.resolve(null),
    flowStats(flows).catch(() => new Map()),
  ]);
  if (said.refused) return said.refused;
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
      const c = flowCounts.get(f.id);
      const money = flowMoney(revenue, f.id);
      return { name: f.name, trigger: f.trigger, started: c?.started ?? 0, emails_sent: c?.sent ?? 0, reached_the_end: c?.reached ?? 0, sales: money?.sales ?? null, revenue: money?.cents ?? null, sales_in_another_currency: money ? money.elsewhere ?? 0 : null };
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
