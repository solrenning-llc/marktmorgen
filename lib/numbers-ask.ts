import { ledgerPaymentsComplete } from "@/lib/payment-ledger-coverage";
import { paidFiguresComplete } from "@/lib/paid-coverage";
/**
 * Asking the store's numbers a question in plain words, and a short summary
 * written at the top of the weekly email (added 12 October 2026).
 *
 * Read before it was built: Fathom, Simple Analytics, ChartMogul, Mixpanel,
 * Amplitude, PostHog and GA4 all answer questions about a site's own
 * numbers; the ones worth copying answer from the numbers and show which.
 * Here the model is handed exactly what the studio's Numbers panel shows —
 * visits, checkouts, sales and money for 7, 30 and 90 days, by channel, by
 * product, by country, by ad, with the stretch before each — as one block of
 * data, and nothing about any buyer. It answers from that block only, names
 * the figures it used, and says which window and which part of the panel to
 * open. A figure it names that is not in the block is dropped before the
 * creator sees it, so a number on the screen is always one the store has.
 *
 * Each question, and each weekly summary, is one of the month's AI jobs
 * (lib/ai.ts, counted), on the smaller model that answers visitors.
 */
import { type AiResult, answerModel, askModel, counted, jsonIn } from "@/lib/ai";
import type { StatsData } from "@/lib/stats";
import type { Store } from "@/lib/store";
import { formatMoney } from "@/lib/money";
import { channelName } from "@/lib/channel-names";
import { DISCOUNT_NAMES } from "@/lib/discount-impact";
import { readSpendLines } from "@/lib/ad-spend";
import { spendBy, type AdSpend } from "@/lib/ad-spend-rules";
import { campaignResultsFrom } from "@/lib/campaign-results";
import { paymentComparisonFrom, paymentChange, paymentShareChange } from "@/lib/payment-comparison";
import { paymentMixFrom, paymentShare } from "@/lib/payment-mix";
import { dailyCashflowRows } from "@/lib/daily-cashflow";
import { refundActivityFrom } from "@/lib/refund-activity";
import { channelCashflows } from "@/lib/channel-cashflow";

export const MAX_QUESTION = 300;
export const WINDOWS = ["d7", "d30", "d90"] as const;
export type AskWindow = (typeof WINDOWS)[number];
/** The parts of the Numbers panel an answer can open, by their ids there (components/stats-panel.tsx). */
export const SECTIONS = ["funnel", "channels", "revenue-source", "attribution", "products", "posts", "ads", "reach", "buyers", "insights", "cashflow", "buyer-channels", "weekly-cohorts", "refund-activity", "daily-cashflow", "payment-mix", "payment-comparison"] as const;
export type AskSection = (typeof SECTIONS)[number];

export type NumbersAnswer = {
  answer: string;
  /** The figures the answer rests on, each found in the store's own numbers. */
  used: { label: string; value: string }[];
  window: AskWindow;
  section: AskSection | "";
};

const NAMES: Record<AskWindow, string> = { d7: "last_7_days", d30: "last_30_days", d90: "last_90_days" };

/**
 * The block of numbers the model is handed: money already written as the
 * creator reads it, so an amount it repeats is the amount on the panel.
 */
export function numbersContext(data: StatsData, spends?: AdSpend[]): Record<string, unknown> {
  const known = paidFiguresComplete(data);
  const money = (cents: number) => formatMoney(cents, data.currency);
  const out: Record<string, unknown> = {
    currency: data.currency.toUpperCase(),
    sales_read: data.sales === "ok" ? data.partial ? "incomplete purchase reading" : "yes" : data.sales === "none" ? "no Stripe account connected" : "Stripe did not answer",
    paid_figures_complete: known,
    partial: data.partial === true,
    coverage_note: "Paid figures require a successful non-partial purchase reading. Omitted or null paid totals, conversion rates and paid-derived insights are unavailable, not zero. Traffic and checkouts can remain available. Previous traffic with traffic_available false is unavailable, not zero; confirmed previous paid figures remain independent.",
  };
  for (const w of WINDOWS) {
    const t = data.totals[w];
    const p = data.previous?.[w];
    const trafficKnown = p != null && data.previousTrafficAvailable?.[w] !== false;
    const days = (data.days ?? []).slice(-(w === "d7" ? 7 : w === "d30" ? 30 : 90));
    const costs = spends !== undefined && days.length ? spendBy(spends, days[0].date, days[days.length - 1].date).channels : new Map<string, number>();
    const cash = known && days.length ? channelCashflows(data, w, data.channels?.[w] ?? [], costs, days[0].date, days[days.length - 1].date) : [];
    const refundActivity = known && days.length ? refundActivityFrom(data, w, days[0].date, days[days.length - 1].date) : null;
    const campaignReport = campaignResultsFrom(data, w, spends);
    const mix = paymentMixFrom(data,w);
    const comparison = paymentComparisonFrom(data,w);
    out[NAMES[w]] = {
      payment_comparison: comparison ? {
        current_from_utc:comparison.current.from,current_to_utc:comparison.current.to,previous_available:comparison.previous!==null,
        previous_period:comparison.previous ? {from_utc:comparison.previous.from,to_utc:comparison.previous.to,payments:money(comparison.previous.total)} : null,
        current_payments:money(comparison.current.total),difference:comparison.delta===null ? null : money(comparison.delta),change:comparison.previous ? paymentChange(comparison.change) : null,
        channels_total:comparison.rows.length,channels:comparison.rows.slice(0,20).map(row=>({channel:channelName(row.source),current_payments:money(row.current),previous_payments:money(row.previous),change:paymentChange(row.change),current_share:paymentShare(row.currentShare),previous_share:paymentShare(row.previousShare),share_change:paymentShareChange(row.shareChange)})),
        note:"Equal consecutive UTC periods, including today as recorded so far. Only 7- and 30-day comparisons fit the complete 90-day payment reading, independently of refund coverage. Previous reading unavailable means null, not zero. Gross payments include renewals, before refunds, fees and ads. Share changes are percentage points; relative growth needs previous payments and share changes need payments in both periods. Includes channels present only in one period. Not new customers, profit or causal marketing lift. At most 20 rows; totals use all channels.",
      } : null,
      payment_mix: mix ? {
        from_utc:mix.from,to_utc:mix.to,total_payments:money(mix.total),
        largest_identified_channel:mix.largest ? {channel:channelName(mix.largest.source),payments:money(mix.largest.cents),share:paymentShare(mix.largest.share)} : null,
        top_three_identified_share:paymentShare(mix.topThreeShare),unidentified_payments:money(mix.unidentified),unidentified_share:paymentShare(mix.unidentifiedShare),
        channels_total:mix.rows.length,channels:mix.rows.slice(0,20).map(row=>({channel:channelName(row.source),identified:row.identified,payments:money(row.cents),share:paymentShare(row.share)})),
        note:"Complete payment reading, independently of refund coverage, including renewals at the recorded subscription channel. Every share divides by all payments, including unidentified origins. Direct, unrecorded and imported origins do not enter largest or top-three identified channels. Gross before refunds, fees and ads; not acquisition, profit or causal ad lift. Empty zero-payment readings have no calculable shares. Summary uses every channel; at most 20 channel rows shown.",
      } : null,
      visitors: t.visitors,
      page_views: t.views,
      checkouts_started: t.checkouts,
      ...(known ? { sales: t.sales, revenue: money(t.cents) } : {}),
      previous_traffic_available: trafficKnown,
      the_same_number_of_days_before: p
        ? { traffic_available: trafficKnown, visitors: trafficKnown ? p.visitors : null, page_views: trafficKnown ? p.views : null, checkouts_started: trafficKnown ? p.checkouts : null, ...(known && p.sales !== null ? { sales: p.sales } : {}), ...(known && p.cents !== null ? { revenue: money(p.cents) } : {}) }
        : null,
      channels: (data.channels?.[w] ?? []).slice(0, 15).map((c) => ({
        channel: channelName(c.source),
        visits: c.visits,
        checkouts_started: c.checkouts,
        free_signups: c.free,
        ...(known ? { sales: c.sales, revenue: money(c.cents) } : {}),
      })),
      products: data.products
        .map((row) => ({ title: row.title, ...row[w] }))
        .filter((row) => row.views || row.checkouts || (known && row.sales))
        .sort((a, b) => (known ? b.cents - a.cents : 0) || b.views - a.views || a.title.localeCompare(b.title))
        .slice(0, 15)
        .map((row) => ({ product: row.title, page_views: row.views, checkouts_started: row.checkouts, ...(known ? { sales: row.sales, revenue: money(row.cents) } : {}) })),
      posts: (data.posts?.[w] ?? []).slice(0, 10).map((r) => ({ post: r.campaign, payment_channels: known ? r.sources?.map(channelName) ?? null : null, visits: r.visits, ...(known && !data.partial ? { paid_records: r.sales, gross_amount: money(r.cents) } : {}) })),
      ad_records_complete: known && data.ads?.[w] != null,
      ad_records_note: "Each variant is grouped by channel, campaign and content tag. Paid records include purchases and one-click extras, not unique buyers. Gross amounts are before refunds and fees; recurring renewals are excluded. When ad_records_complete is false, missing variants mean unavailable totals, not zero payments.",
      ads: known && !data.partial ? (data.ads?.[w] ?? []).slice(0, 10).map((r) => ({ ad: r.content, campaign: r.campaign, channel: channelName(r.source), sales: r.sales, revenue: money(r.cents) })) : [],
      countries_by_views: (data.countries?.[w] ?? []).slice(0, 10).map((r) => ({ country: r.name, page_views: r.visits })),
      devices_by_views: (data.devices?.[w] ?? []).slice(0, 5).map((r) => ({ device: r.name, page_views: r.visits })),
      ...(known && data.renewals && !data.renewals.partial ? { renewals: { payments: data.renewals[w].payments, revenue: money(data.renewals[w].cents) } } : {}),
      ...(campaignReport ? { campaign_recorded_results: {
        from_utc: campaignReport.from, to_utc: campaignReport.to, complete_paid_records: campaignReport.salesKnown,
        campaigns_available: campaignReport.rows.length, campaigns_included: Math.min(20, campaignReport.rows.length),
        untagged_ad_spend: campaignReport.unassignedAds === null ? null : money(campaignReport.unassignedAds),
        note: "Same campaign tag combined across channels. Visits are not split by payment channel. Paid records include purchases and one-click extras, not unique buyers or a conversion rate; recurring renewals are excluded. Gross less recorded ads is before refunds and all other costs, not profit or causal ad lift. Unknown or partial paid figures stay null. Missing ad entries are not invented as zero; untagged spend is not allocated. At most 20 campaigns, with highest recorded spend first.",
        campaigns: campaignReport.rows.slice(0,20).map((row) => ({ campaign: row.campaign, payment_channels: row.paymentChannels?.map(channelName) ?? null, ad_channels: row.adChannels?.map(channelName) ?? null, visits: row.visits,
          paid_records: row.paidRecords, gross_amount: row.gross === null ? null : money(row.gross), recorded_ads: row.ads === null ? null : money(row.ads), gross_amount_less_ads: row.grossLessAds === null ? null : money(row.grossLessAds),
        })),
      } } : {}),
      ...(known && data.buyers ? { buyers: { buyers: data.buyers[w].buyers, orders: data.buyers[w].orders, came_back: data.buyers[w].returning } } : {}),
      ...(known && cash.length ? { cashflow: {
        complete: cash.every(c => c.afterRefunds !== null),
        payments_complete: ledgerPaymentsComplete(data),
        note: "Payments include renewals; refunds include pending refunds and belong to the days recorded. Before fees, tax, commissions and other costs. Not profit or causal ad lift.",
        channels: cash.slice(0, 15).map((c) => ({ channel: channelName(c.source), payments_received: c.receipts === null ? null : money(c.receipts),
          refunds: c.refunds === null ? null : money(c.refunds), after_refunds: c.afterRefunds === null ? null : money(c.afterRefunds),
          ...(spends !== undefined ? { ad_spend_recorded: money(c.adSpend), after_refunds_and_ads: c.afterAds === null ? null : money(c.afterAds) } : {}),
        })),
      } } : {}),
      ...(refundActivity ? { refund_activity: {
        payments_received: money(refundActivity.payments), refunds_recorded: money(refundActivity.refunds), refund_records: refundActivity.records,
        note: "Records include pending refunds and are not unique buyers or orders. Refunds may belong to earlier purchases. Payments include renewals. Same-period amount ratio, not the percentage of purchases refunded. Can exceed 100%; null means no payments. Only complete, matched readings.",
        channels: refundActivity.rows.slice(0, 15).map((row) => ({ channel: channelName(row.source), refund_records: row.records, refunds_recorded: money(row.refunds), payments_received: money(row.payments), recorded_refunds_over_payments: row.share === null ? null : Math.round(row.share * 100) + "%" })),
      } } : {}),
      ...(known && data.buyerChannels ? { buyer_channels: {
        history_partial: data.buyerChannels.historyPartial,
        unidentified_orders: data.buyerChannels[w].unidentifiedOrders,
        note: "First purchase observed in up to 180 days, not lifetime acquisition. Renewals are not repurchases. Only buyers observed for a full 30 days enter the 30-day rate. Gross revenue, not predicted LTV.",
        channels: data.buyerChannels[w].rows.slice(0, 15).map((c) => ({ channel: channelName(c.source), buyers: c.buyers, buyers_who_bought_again: c.repeatBuyers,
          revenue_per_buyer: money(Math.round(c.cents / Math.max(1, c.buyers))), observed_for_30_days: c.eligible30, bought_again_within_30_days: c.repeated30,
        })),
      } } : {}),
      searched_for_and_not_found: (data.searchMisses?.[w] ?? []).slice(0, 10).map((r) => ({ words: r.name, times: r.visits })),
      // The same money three ways (lib/attribution-rules.ts): last visit, first visit, what buyers said.
      ...(known && !data.partial && data.attribution
        ? {
            attribution_note: "Visit models are alternative readings, not additional revenue. Include unattributed amounts in each column total. Buyer answers belong to answer days and cover respondents only. Missing unattributed first visits mean unavailable, not zero. Gross before refunds and fees; extras excluded; no causal lift.",
            sales_with_no_first_visit_channel: data.attribution[w].unknownFirst ? { sales: data.attribution[w].unknownFirst.sales, revenue: money(data.attribution[w].unknownFirst.cents) } : null,
            channels_three_ways: data.attribution[w].rows.slice(0, 15).map((r) => ({
              channel: r.name,
              sales_by_last_visit: r.last.sales,
              revenue_by_last_visit: money(r.last.cents),
              sales_by_first_visit: data.attribution?.[w].unknownFirst ? r.first.sales : null,
              revenue_by_first_visit: data.attribution?.[w].unknownFirst ? money(r.first.cents) : null,
              buyers_who_said_it: r.said.buyers,
              revenue_of_buyers_who_said_it: money(r.said.cents),
            })),
            sales_with_no_channel: { sales: data.attribution[w].unknown.sales, revenue: money(data.attribution[w].unknown.cents) },
            what_buyers_of_sales_with_no_channel_said: data.attribution[w].unknownSaid.map((r) => ({ answer: r.name, buyers: r.buyers, revenue: money(r.cents) })),
          }
        : {}),
    };
  }
  if (known) {
    const daily = dailyCashflowRows(data, "d90", spends);
    if (daily.length) out.daily_recorded_cashflow = {
      payments_complete: ledgerPaymentsComplete(data),
      note: "UTC days from the latest 90-day reading. Payments include renewals. Refunds include pending refunds on the days recorded and may relate to older purchases. Daily ad amounts are allocated from recorded intervals with rounding that conserves smallest currency units. Null is incomplete or unavailable, not zero. Results are before fees, tax, commissions and other costs; not profit, predicted revenue or causal advertising lift.",
      days: daily.map((row) => ({ day: row.date, payments_received: row.payments === null ? null : money(row.payments), refunds_recorded: row.refunds === null ? null : money(row.refunds), after_refunds: row.afterRefunds === null ? null : money(row.afterRefunds),
        ...(spends !== undefined ? { ad_spend_recorded: row.ads === null ? null : money(row.ads), after_refunds_and_ads: row.afterAds === null ? null : money(row.afterAds) } : {}),
      })),
    };
  }
  // Full price beside each discount over the 90 days (lib/discount-impact.ts).
  if (known && data.discounts?.rows) {
    out.discounts_last_90_days = data.discounts.rows.map((r) => ({
      paid: DISCOUNT_NAMES[r.kind],
      sales: r.sales,
      revenue: money(r.cents),
      given_off: money(r.off),
      ...(data.discounts?.refundsRead ? { refunded_sales: r.refunded } : {}),
      buyers: r.buyers,
      buyers_who_bought_again: r.again,
    }));
  }
  if (known && data.buyerChannels?.weekly) {
    out.weekly_repurchase_cohorts = {
      as_of_utc: data.buyerChannels.weekly.asOf,
      history_partial: data.buyerChannels.historyPartial,
      unidentified_orders: data.buyerChannels.weekly.unidentifiedOrders,
      note: "UTC first observed purchase weeks from up to 180 days of history, independent of the selected 7/30/90-day window. Rates are cumulative repurchases, not activity retention. Each denominator contains only buyers observed for the full 7, 30, 60 or 90 days; null rate means no eligible buyers. Renewals and one-click extras do not count. Small groups fluctuate and incomplete history may miss purchases. Not lifetime acquisition or a prediction.",
      weeks: data.buyerChannels.weekly.rows.map((row) => ({
        first_purchase_week_utc: row.week, buyers: row.buyers,
        periods: Object.entries(row.observations).map(([days, cell]) => ({
          days: Number(days), observed_for_full_period: cell.eligible, bought_again_within_period: cell.repeated,
          rate: cell.eligible ? Math.round(cell.repeated / cell.eligible * 100) + "%" : null,
        })),
      })),
    };
  }
  return out;
}

/** Whether a figure appears in the block as given, so nothing invented reaches the screen. */
export function figureIn(context: string, value: string): boolean {
  const v = value.trim();
  if (!v || v.length > 40) return false;
  if (context.includes(JSON.stringify(v))) return true;
  // A bare number appears as a JSON number.
  return /^-?\d+(\.\d+)?$/.test(v) && new RegExp(`[:\\[,]${v.replace(".", "\\.")}[,}\\]]`).test(context);
}

const line = (value: unknown, max: number) => (typeof value === "string" ? value : "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Every spend line only when all of it is known; otherwise undefined, which the context says is unknown, never 0. */
async function knownSpends(statsId: string | null): Promise<AdSpend[] | undefined> {
  const read = await readSpendLines(statsId).catch(() => null);
  return read && !read.metaUnread ? read.spends : undefined;
}

/** One question about the store's numbers, answered from them only. One of the month's jobs. */
export async function askNumbers(store: Store, question: string, data: StatsData, now = Date.now()): Promise<AiResult<NumbersAnswer>> {
  const asked = line(question, MAX_QUESTION);
  if (!asked) return { ok: false, reason: "notes" };
  const spends = await knownSpends(store.statsId);
  const context = JSON.stringify(numbersContext(data, spends));
  return counted(store, now, async () => {
    const system = [
      "You answer a creator's question about their own online store's numbers.",
      "Answer ONLY from the JSON of numbers given. Never estimate, project or invent a number, a cause or a fact that is not in it. If the numbers cannot answer the question, say so plainly in one sentence and say what the numbers do show that comes closest.",
      "Money is already written as the creator reads it: repeat amounts exactly as given. Windows are the last 7, 30 and 90 days; with no window in the question, use the last 30 days.",
      "Campaign tags combine channels. Payment channel lists do not split visit counts. Campaign paid records include one-click extras and are not unique buyers or a visitor conversion rate. Never call gross less ads profit, customer acquisition cost or advertising lift; renewals and refunds are not in that comparison. Never infer a missing channel list from the legacy single-source label. Daily cashflow is recorded UTC activity, not profit or proof of advertising lift. A multi-day spend is allocated with exact total-preserving rounding. Never replace missing daily refunds or ad spend with zero. Refund activity is same-period recorded money, not a refund rate for those purchases or buyers. Do not infer dissatisfaction, causes or the number of buyers from refund records. A missing ratio with no payments is unknown, not zero. Cashflow is before fees, tax, commissions and other costs: never call it profit. Do not recommend increasing ad budgets from attributed sales. A null result is unknown, not zero. Buyer cohorts show first observed purchases, not lifetime acquisition; compare 30-day repurchases only among buyers observed for 30 days. Weekly cohorts are independent of the selected channel window. Always name the period and eligible denominator, do not treat immature cells as zero, infer churn or claim a trend from small groups or incomplete history.",
      "Write in the language of the question. At most 90 words, plain sentences, no markdown, no headings. Be direct: the answer first, then one short line on what it suggests doing, only if the numbers clearly support it.",
      `Return only a JSON object: {"answer": string, "used": [{"label": short name of a figure, "value": the figure exactly as it appears in the JSON}], "window": "d7" | "d30" | "d90", "section": one of ${SECTIONS.map((s) => `"${s}"`).join(", ")} or ""}. "used" lists at most 4 figures, each copied exactly. "section" is the part of the Numbers panel that shows them: funnel (visits to checkout to sale), channels, revenue-source, attribution (each channel by last visit, first visit and what buyers said), products, posts, ads, reach (how far down the store page people get), buyers, insights, payment-mix (recorded payment shares and channel concentration), payment-comparison (equal consecutive UTC payment periods by channel).`,
    ].join("\n\n");
    const reply = await askModel(store, system, `The question: ${asked}\n\nThe numbers:\n${context}`, 600, answerModel());
    const json = reply ? jsonIn(reply) : null;
    const answer = line(json?.answer, 900);
    if (!answer) return null;
    const used = (Array.isArray(json?.used) ? json.used : [])
      .map((u: unknown) => {
        const row = u && typeof u === "object" ? (u as { label?: unknown; value?: unknown }) : {};
        return { label: line(row.label, 60), value: line(typeof row.value === "number" ? String(row.value) : row.value, 40) };
      })
      .filter((u: { label: string; value: string }) => u.label && figureIn(context, u.value))
      .slice(0, 4);
    const window = (WINDOWS as readonly string[]).includes(String(json?.window)) ? (json?.window as AskWindow) : "d30";
    const section = (SECTIONS as readonly string[]).includes(String(json?.section)) ? (json?.section as AskSection) : "";
    return { answer, used, window, section };
  });
}

/**
 * The weekly email's first lines: the week in three or four sentences, from
 * the same block of numbers, by the same rules. One of the month's jobs;
 * null when there is none left or the model does not answer, and the email
 * goes without it.
 */
export async function weeklySummary(store: Store, data: StatsData, now = Date.now()): Promise<string | null> {
  const spends = await knownSpends(store.statsId);
  const context = JSON.stringify(numbersContext(data, spends));
  const done = await counted(store, now, async () => {
    const system = [
      "You write the first lines of a creator's weekly email about their own online store's numbers.",
      "Use ONLY the JSON of numbers given, mostly the last 7 days set beside the 7 days before. Never estimate, project or invent a number or a cause. Repeat amounts exactly as given.",
      "Write in American English, 2 to 4 plain sentences, at most 70 words, no markdown, no greeting, no sign-off: what changed most, where the money came from, and one thing worth a look, only if the numbers clearly show it. If almost nothing happened, say so in one sentence.",
      "Return only the sentences.",
    ].join("\n\n");
    const reply = await askModel(store, system, context, 300, answerModel());
    const text = (reply ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 600);
    return text || null;
  });
  return done.ok ? done.value : null;
}
