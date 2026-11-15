import { revenuePerTraffic, selectedRevenueShare } from "@/lib/custom-range-efficiency";
import { customRangeComparison } from "@/lib/custom-range-comparison";
import { CUSTOM_RANGE_METRICS, CUSTOM_RANGE_GROUPINGS, customRangeChartRows, customRangeChartSummary, customRangeWeekdays, effectiveCustomRangeMetric, effectiveCustomRangeGrouping, type CustomRangeMetric, type CustomRangeGrouping } from "@/lib/custom-range-chart";
import { customRangeOrderLabel, customRangeFilterLabel, customRangeMinimumTraffic, effectiveCustomRangeMinimumPaidRecords, customRangeSelectionTotals, type CustomRangeFilter, type CustomRangeSort } from "@/lib/custom-range-view";
import type { RangeData } from "@/lib/stats";
import { paidFiguresComplete } from "@/lib/paid-coverage";
import type { PaymentComparison } from "@/lib/payment-comparison";
import type { PaymentMix } from "@/lib/payment-mix";
import type { AttributionTable } from "@/lib/attribution-rules";
import type { CreativeRow } from "@/lib/creative-results";
import type { CampaignResults } from "@/lib/campaign-results";
import type { DailyCashflowRow } from "@/lib/daily-cashflow";
import type { RefundActivity } from "@/lib/refund-activity";
import type { ChannelCashflow } from "@/lib/channel-cashflow";
import { COHORT_AGES, type WeeklyBuyerCohorts, type BuyerChannelWindow } from "@/lib/buyer-channel-rules";
import { csvCell } from "@/lib/csv";
import { channelName } from "@/lib/channel-names";
import { toMajor } from "@/lib/money";

type Cell = string | number | null;
export type CustomRangeReportSelection = {query?:string;sort?:CustomRangeSort;filter?:CustomRangeFilter;minimumTraffic?:number;minimumPaidRecords?:number};
export type ReportPeriod = { from: string; to: string; currency: string };
/** Text is formula-safe; finite numbers remain numbers, including negative results. */
const line = (cells: Cell[]) => cells.map((value) => typeof value === "number"
  ? Number.isFinite(value) ? String(value) : ""
  : csvCell(value ?? "")).join(",");
const csv = (rows: Cell[][]) => "\uFEFF" + rows.map(line).join("\r\n") + "\r\n";
const amount = (value: number | null, currency: string) => value === null ? null : toMajor(value, currency);

/** Rows whose ad spend was not read carry adSpend null (components/revenue-quality.tsx): blank in the file, never 0. */
export function cashflowReport(rows: (Omit<ChannelCashflow, "adSpend"> & { adSpend: number | null })[], period: ReportPeriod): string {
  const note = "Recorded payments include renewals; refunds include pending refunds in the days recorded. Before fees, tax, commissions and other costs; not profit or causal advertising lift. Blank payments or result mean incomplete or unavailable payment coverage; refunds and results also wait for complete refund coverage.";
  return csv([
    ["From (UTC)", "To (UTC)", "Currency", "Channel", "Payments received", "Refunds recorded", "Ad spend recorded", "After refunds", "After refunds and ads", "Payment and refund coverage", "Definition"],
    ...rows.map((r): Cell[] => [period.from, period.to, period.currency.toUpperCase(), channelName(r.source), amount(r.receipts, period.currency), amount(r.refunds, period.currency), amount(r.adSpend, period.currency), amount(r.afterRefunds, period.currency), amount(r.afterAds, period.currency), r.afterRefunds === null ? "Incomplete" : "Complete", note]),
  ]);
}

export function buyerChannelReport(window: BuyerChannelWindow, historyPartial: boolean, period: ReportPeriod): string {
  const note = "First observed purchase in selected UTC days, from up to 180 days of history; not lifetime acquisition. Revenue includes later purchases and one-click extras, before refunds and fees. Renewals are not repeat purchases. The 30-day rate uses only buyers observed for a full 30 days; blank means no eligible buyers. Counts exclude orders without a buyer identity.";
  return csv([
    ["From (UTC)", "To (UTC)", "Currency", "First recorded channel", "Buyers", "Repeat buyers", "Orders", "Gross revenue", "Gross revenue per buyer", "Buyers observed for 30 days", "Bought again within 30 days", "30-day repurchase rate (%)", "History coverage", "Unidentified orders in selected days (whole report)", "Definition"],
    ...window.rows.map((r): Cell[] => [period.from, period.to, period.currency.toUpperCase(), channelName(r.source), r.buyers, r.repeatBuyers, r.orders, amount(r.cents, period.currency), r.buyers ? amount(Math.round(r.cents / r.buyers), period.currency) : null, r.eligible30, r.repeated30, r.eligible30 ? Math.round(r.repeated30 / r.eligible30 * 100) : null, historyPartial ? "Partial" : "Up to 180 days", window.unidentifiedOrders, note]),
    ...(!window.rows.length && window.unidentifiedOrders ? [[period.from, period.to, period.currency.toUpperCase(), "No identified buyers", 0, 0, 0, null, null, 0, 0, null, historyPartial ? "Partial" : "Up to 180 days", window.unidentifiedOrders, note] as Cell[]] : []),
  ]);
}

/** One row per cohort and age, with the exact mature denominator beside every rate. */
export function weeklyCohortReport(cohorts: WeeklyBuyerCohorts, historyPartial: boolean): string {
  const note = "UTC Monday of first observed purchase in up to 180 days of history, independent of the selected channel window. Only buyers observed for the full age enter its denominator. Cumulative repeat purchases within that many days; not recurring renewals, retention activity or lifetime acquisition. Blank rate means nobody has enough observation time; counts exclude unidentified orders.";
  return csv([
    ["First purchase week (UTC Monday)", "As of (UTC)", "Cohort buyers", "Days after first purchase", "Buyers observed for full period", "Buyers who bought again within period", "Repurchase rate (%)", "History coverage", "Unidentified orders (whole report)", "Definition"],
    ...cohorts.rows.flatMap((row) => COHORT_AGES.map((age): Cell[] => {
      const { eligible, repeated } = row.observations[age];
      return [row.week, cohorts.asOf, row.buyers, age, eligible, repeated, eligible ? Math.round(repeated / eligible * 100) : null, historyPartial ? "Partial" : "Up to 180 days", cohorts.unidentifiedOrders, note];
    })),
    ...(!cohorts.rows.length && cohorts.unidentifiedOrders ? [["No identified buyers", cohorts.asOf, 0, null, 0, 0, null, historyPartial ? "Partial" : "Up to 180 days", cohorts.unidentifiedOrders, note] as Cell[]] : []),
  ]);
}

export function refundActivityReport(activity: RefundActivity, period: ReportPeriod): string {
  const note = "Refund records include pending refunds and are not unique buyers or orders. Refunds are recorded in these UTC days and matched to the purchase channel; purchases may have been earlier. Payments include renewals. Refunds / payments compares same-period amounts, not the percentage of purchases refunded; it may exceed 100%. Blank ratio means no payments in the period. Only complete, matched readings.";
  return csv([
    ["From (UTC)", "To (UTC)", "Currency", "Channel", "Refund records", "Refund amount", "Payments received", "Recorded refunds / payments (%)", "Definition"],
    ...activity.rows.map((row): Cell[] => [period.from, period.to, period.currency.toUpperCase(), channelName(row.source), row.records, amount(row.refunds, period.currency), amount(row.payments, period.currency), row.share === null ? null : Math.round(row.share * 100), note]),
  ]);
}

export function dailyCashflowReport(rows: DailyCashflowRow[], currency: string): string {
  const note = "Recorded payments include renewals. Refunds include pending refunds and belong to the day recorded; purchases may be earlier. Multi-day ad entries are allocated evenly with cumulative rounding that preserves smallest currency units. Before fees, tax, commissions and other costs; not profit or advertising lift. Blank means incomplete or unavailable figures.";
  return csv([
    ["Day (UTC)", "Currency", "Payments received", "Refunds recorded", "Ad spend recorded", "After refunds", "After refunds and ads", "Definition"],
    ...rows.map((row): Cell[] => [row.date, currency.toUpperCase(), amount(row.payments, currency), amount(row.refunds, currency), amount(row.ads, currency), amount(row.afterRefunds, currency), amount(row.afterAds, currency), note]),
  ]);
}

export function campaignResultsReport(report: CampaignResults, currency: string, view?: {query:string;sort:string;total:number}): string {
  const note = "Campaign tag totals across channels; visits are not split by payment channel. Paid records include purchases and one-click extras, not unique buyers; recurring renewals excluded. Gross less ads is before refunds, fees, tax, commissions and other costs, not profit or causal ad lift. Blank means unavailable or incomplete. Untagged ad spend is not allocated to campaign rows.";
  return csv([
    ["From (UTC)", "To (UTC)", "Currency", "Campaign", "Recorded payment channels", "Recorded ad channels", "Visits", "Paid records", "Gross amount", "Recorded ads", "Gross amount less ads", "Untagged ad spend (whole report)", "Definition", ...(view ? ["Search filter", "Sort order", "Unfiltered campaigns (whole report)"] : [])],
    ...report.rows.map((row): Cell[] => [report.from, report.to, currency.toUpperCase(), row.campaign, row.paymentChannels === null ? "Unavailable" : row.paymentChannels.join("; "), row.adChannels === null ? "Unavailable" : row.adChannels.join("; "), row.visits, row.paidRecords, amount(row.gross, currency), amount(row.ads, currency), amount(row.grossLessAds, currency), amount(report.unassignedAds, currency), note, ...(view ? [view.query,view.sort,view.total] : [])]),
  ]);
}

export function creativeResultsReport(rows: CreativeRow[], period: ReportPeriod): string {
  const note = "Each row groups channel, campaign and content tag. Paid records include purchases and one-click extras, not unique buyers; renewals excluded. Gross before refunds, fees and other costs, not profit or causal ad lift. All variants in the selected period are exported, including those outside the first 15 displayed. Only complete purchase readings.";
  return csv([
    ["From (UTC)", "To (UTC)", "Currency", "Channel", "Campaign", "Variant (utm_content)", "Paid records", "Gross amount", "Definition"],
    ...rows.map((row): Cell[] => [period.from, period.to, period.currency.toUpperCase(), row.source, row.campaign, row.content, row.sales, amount(row.cents, period.currency), note]),
  ]);
}

export function attributionReport(table: AttributionTable, period: ReportPeriod): string {
  const note = "First and last visits are alternative readings of the same purchases; never add the columns. One-click extras excluded. Gross before refunds and fees. Buyer answers belong to the UTC day answered and cover only respondents; their amounts are not an extra revenue source. Answer subset rows describe buyers of last-visit unattributed sales and overlap channel rows. A blank first-visit unattributed figure means unavailable in an older reading, not zero. No causal marketing lift.";
  const entry = (kind: string, name: string, last: number | null, lastCents: number | null, first: number | null, firstCents: number | null, buyers: number | null, saidCents: number | null): Cell[] => [period.from, period.to, period.currency.toUpperCase(), kind, name, last, amount(lastCents, period.currency), first, amount(firstCents, period.currency), buyers, amount(saidCents, period.currency), note];
  return csv([
    ["From (UTC)", "To (UTC)", "Currency", "Row type", "Channel or answer", "Last-visit sales", "Last-visit gross", "First-visit sales", "First-visit gross", "Buyer answers", "Gross of answered sales", "Definition"],
    ...table.rows.map(row => entry("Channel", row.name, row.last.sales, row.last.cents, table.unknownFirst ? row.first.sales : null, table.unknownFirst ? row.first.cents : null, row.said.buyers, row.said.cents)),
    entry("No channel", "No channel", table.unknown.sales, table.unknown.cents, table.unknownFirst?.sales ?? null, table.unknownFirst?.cents ?? null, null, null),
    ...table.unknownSaid.map(row => entry("Answer subset: last-visit no channel", row.name, null, null, null, null, row.buyers, row.cents)),
  ]);
}

export function paymentMixReport(mix: PaymentMix,currency: string): string {
  const note="Gross recorded payments include renewals at the recorded subscription channel; before refunds, fees and ads. Shares use all recorded payments, including unidentified origins. Direct, unrecorded and imported origins are excluded from largest and top-three identified channels. Not profit, customer acquisition or causal ad lift. Only complete payment coverage, independently of refund coverage; no buyers exported.";
  return csv([
    ["From (UTC)","To (UTC)","Currency","Channel","Identified marketing channel","Payments","Share of all payments (%)","Total payments (whole report)","Unidentified payments (whole report)","Top 3 identified channels (%)","Definition"],
    ...mix.rows.map((row):Cell[] => [mix.from,mix.to,currency.toUpperCase(),row.source,row.identified ? "Yes" : "No",amount(row.cents,currency),row.share*100,amount(mix.total,currency),amount(mix.unidentified,currency),mix.topThreeShare === null ? null : mix.topThreeShare*100,note]),
  ]);
}

export function paymentComparisonReport(report:PaymentComparison,currency:string):string {
  const previous=report.previous;
  const note="Equal adjacent UTC periods, including current day as recorded so far. Gross recorded payments include renewals, before refunds, fees and ads. No previous payments means blank relative change; share change is percentage points and requires payments in both periods. A missing complete previous reading exports no rows. Requires complete payment coverage, independently of refund coverage. Not new customers, profit or causal marketing lift.";
  return csv([
    ["Current from (UTC)","Current to (UTC)","Previous from (UTC)","Previous to (UTC)","Currency","Channel","Current payments","Previous payments","Payment difference","Payment change (%)","Current share (%)","Previous share (%)","Share change (percentage points)","Definition"],
    ...(previous ? report.rows.map((row):Cell[]=>[report.current.from,report.current.to,previous.from,previous.to,currency.toUpperCase(),row.source,amount(row.current,currency),amount(row.previous,currency),amount(row.current-row.previous,currency),row.change===null ? null : row.change*100,row.currentShare===null ? null : row.currentShare*100,row.previousShare===null ? null : row.previousShare*100,row.shareChange===null ? null : row.shareChange*100,note]) : []),
  ]);
}

const rangeCoverage = (data: RangeData) => data.sales !== "ok" ? "Unavailable" : data.partial ? "Incomplete" : "Complete";
const listCoverage = (limited: boolean | undefined) => limited === undefined ? "Unknown" : limited ? "Yes" : "No";
/** Exports the displayed rows, including explicit list and financial coverage. */
export function customRangeChannelsReport(data: RangeData, selection: CustomRangeReportSelection = {}): string {
  const known = paidFiguresComplete(data);
  const selectedRevenue=customRangeSelectionTotals(data).channels.cents;
  const query = selection.query?.trim() ?? "";
  const note = "Recorded rows for selected UTC dates; not unique buyers or causal marketing lift. Channel visits count recorded views. Revenue per visit divides gross revenue by recorded visits, not unique people; no visits means unavailable. The analytical ratio keeps calculated precision in the currency major unit. The effective paid-count filter is disabled for incomplete payment readings. Paid records and gross revenue exclude renewals and one-click extras, before refunds, fees and other costs. Blank paid values mean unavailable or incomplete readings, not zero. Recorded row totals describe the reading, not proof of complete payments. This file contains the displayed search selection. Expand the list and clear the search and sales filter and remove the traffic and paid-record minimums for all recorded rows. List truncation is independent of search filtering. Revenue share uses this selected loaded list’s total gross revenue, not the whole period or the other list. A zero total has no defined share; percentages describe only loaded rows even when truncated.";
  return csv([
    ["From (UTC)","To (UTC)","Currency","Channel","Visits","Paid records","Gross revenue","Paid coverage","Displayed rows","Recorded rows","List truncated","Order","Definition","Search","Sales filter","Minimum traffic","Revenue per visit","Minimum paid records","Share of selected revenue (%)"],
    ...data.channels.map((r): Cell[] => [data.from,data.to,data.currency.toUpperCase(),channelName(r.source),r.visits,known?r.sales:null,known?amount(r.cents,data.currency):null,rangeCoverage(data),data.channels.length,data.channelsTotal??null,listCoverage(data.channelsTruncated),customRangeOrderLabel(data, selection.sort ?? "recorded", "channels"),note,query,customRangeFilterLabel(data,selection.filter??"all"),customRangeMinimumTraffic(selection.minimumTraffic),amount(revenuePerTraffic(r.cents,r.visits,known),data.currency),effectiveCustomRangeMinimumPaidRecords(data,selection.minimumPaidRecords),selectedRevenueShare(r.cents,selectedRevenue,known)]),
  ]);
}
export function customRangeProductsReport(data: Omit<RangeData,"products"> & {products:(RangeData["products"][number]&{title?:string})[]}, selection: CustomRangeReportSelection = {}): string {
  const known = paidFiguresComplete(data);
  const selectedRevenue=customRangeSelectionTotals(data).products.cents;
  const query = selection.query?.trim() ?? "";
  const note = "Revenue per page view divides gross revenue by recorded page views, not unique people; no views means unavailable. The analytical ratio keeps calculated precision in the currency major unit. The effective paid-count filter is disabled for incomplete payment readings. Recorded product rows for selected UTC dates; not unique buyers or causal marketing lift. Paid records and gross revenue include purchases and one-click extras, exclude renewals, and are before refunds, fees and other costs. Blank paid values mean unavailable or incomplete readings, not zero. Recorded row totals describe the reading, not proof of complete payments. This file contains the displayed search selection. Expand the list and clear the search and sales filter and remove the traffic and paid-record minimums for all recorded rows. List truncation is independent of search filtering. Revenue share uses this selected loaded list’s total gross revenue, not the whole period or the other list. A zero total has no defined share; percentages describe only loaded rows even when truncated.";
  return csv([
    ["From (UTC)","To (UTC)","Currency","Product ID","Product","Page views","Checkouts","Paid records","Gross revenue","Paid coverage","Displayed rows","Recorded rows","List truncated","Order","Definition","Search","Sales filter","Minimum traffic","Revenue per page view","Minimum paid records","Share of selected revenue (%)"],
    ...data.products.map((r): Cell[] => [data.from,data.to,data.currency.toUpperCase(),r.id,r.title??r.id,r.views,r.checkouts,known?r.sales:null,known?amount(r.cents,data.currency):null,rangeCoverage(data),data.products.length,data.productsTotal??null,listCoverage(data.productsTruncated),customRangeOrderLabel(data, selection.sort ?? "recorded", "products"),note,query,customRangeFilterLabel(data,selection.filter??"all"),customRangeMinimumTraffic(selection.minimumTraffic),amount(revenuePerTraffic(r.cents,r.views,known),data.currency),effectiveCustomRangeMinimumPaidRecords(data,selection.minimumPaidRecords),selectedRevenueShare(r.cents,selectedRevenue,known)]),
  ]);
}

/** Every daily row returned for the selected dates, independently of channel/product list caps. */
export function customRangeDailyReport(data: RangeData): string {
  const known = paidFiguresComplete(data);
  const note = "Recorded UTC daily activity for selected dates. Visitors are measured per day, not unique buyers or a lifetime audience. Paid records and gross revenue include purchases and one-click extras, exclude renewals, and are before refunds, fees, ads and other costs; not profit or causal marketing lift. Blank paid values mean incomplete or unavailable readings, not zero. All returned daily rows are included, independently of channel and product list limits.";
  return csv([
    ["From (UTC)","To (UTC)","Day (UTC)","Currency","Visitors","Page views","Checkouts","Paid records","Gross revenue","Paid coverage","Definition"],
    ...data.days.map((r): Cell[] => [data.from,data.to,r.date,data.currency.toUpperCase(),r.visitors,r.views,r.checkouts,known?r.sales:null,known?amount(r.cents,data.currency):null,rangeCoverage(data),note]),
  ]);
}

/** Independent traffic and purchase availability for equal consecutive custom periods. */
export function customRangeComparisonReport(data: RangeData): string {
  const {previousFrom,previousTo,rows:metrics} = customRangeComparison(data);
  const note = "Equal consecutive UTC periods, including the selected end day as recorded so far. Blank figures and changes mean unavailable or incomplete readings; a zero previous value has no relative growth rate. Differences are current minus previous; change is a percentage, not percentage points. Traffic availability is independent of paid coverage. Paid records include purchases and one-click extras, exclude renewals; gross revenue is before refunds, fees, ads and other costs, not profit. ";
  return csv([
    ["From (UTC)","To (UTC)","Previous from (UTC)","Previous to (UTC)","Currency","Metric","Unit","Current","Previous","Difference","Change (%)","Current available","Previous available","Paid coverage","Definition"],
    ...metrics.map((m):Cell[]=>[data.from,data.to,previousFrom,previousTo,data.currency.toUpperCase(),m.name,m.unit,m.money?amount(m.current,data.currency):m.current,m.money?amount(m.previous,data.currency):m.previous,m.money?amount(m.difference,data.currency):m.difference,m.change,m.current!==null?"Yes":"No",m.previous!==null?"Yes":"No",rangeCoverage(data),note+m.definition]),
  ]);
}

/** Export exactly the chart's effective metric and UTC grouping, including explicit fallback metadata. */
export function customRangeChartReport(data:RangeData,metric:CustomRangeMetric,grouping:CustomRangeGrouping,cumulative=false):string {
 const selected=effectiveCustomRangeMetric(data,metric);
 const unit=effectiveCustomRangeGrouping(grouping);
 const label=CUSTOM_RANGE_METRICS.find(item=>item.value===selected)!.label;
 const requested=CUSTOM_RANGE_METRICS.find(item=>item.value===metric)?.label??String(metric);
 const groupLabel=CUSTOM_RANGE_GROUPINGS.find(item=>item.value===unit)!.label;
 const note="Recorded UTC chart values. Weeks start on Monday; boundary groups may be partial and contain only recorded days within the selected period. Visitors are summed daily counts, not distinct people across the group. Paid records include purchases and one-click extras, exclude renewals; revenue is before refunds, fees, ads and other costs, not profit. An unavailable requested paid metric falls back to Visitors, matching the chart; Metric and Unit describe Value. All chart groups are exported independently of channel/product search and list limits. Accumulation identifies per-group or cumulative values. Cumulative values sum only recorded days from the selected start through Group to; missing days are not invented and cumulative visitors are not distinct people across the period. Daily summary statistics remain independent of accumulation.";
 return csv([
  ["From (UTC)","To (UTC)","Group from (UTC)","Group to (UTC)","Currency","Grouping","Requested metric","Metric","Unit","Value","Paid coverage","Definition","Accumulation","Value from (UTC)"],
  ...customRangeChartRows(data,selected,unit,cumulative).map((row):Cell[]=>[data.from,data.to,row.from,row.to,data.currency.toUpperCase(),groupLabel,requested,label,selected==="cents"?data.currency.toUpperCase():"Count",selected==="cents"?amount(row.value,data.currency):row.value,rangeCoverage(data),note,cumulative?"Cumulative":"Per group",cumulative?data.from:row.from]),
 ]);
}

/** Independent totals of the displayed loaded lists, with the exact selection and source limits. */
export function customRangeSelectionReport(data:RangeData,selection:CustomRangeReportSelection={}):string {
 const totals=customRangeSelectionTotals(data);
 const rows=[
  {kind:"channels" as const,name:"Channels",unit:"Visits",...totals.channels,sourceTotal:data.channelsTotal,truncated:data.channelsTruncated,scope:"Channel purchases exclude renewals and one-click extras."},
  {kind:"products" as const,name:"Products",unit:"Page views",...totals.products,sourceTotal:data.productsTotal,truncated:data.productsTruncated,scope:"Product purchases include one-click extras and exclude renewals."},
 ];
 const note="Matching loaded rows only, not whole-period totals. Lists overlap and must not be added together. Source row counts and truncation describe the original reading independently of filters. Blank paid values mean incomplete or unavailable purchase readings, not zero. The effective paid-count filter is disabled for incomplete payment readings. Gross revenue is before refunds, fees, ads and other costs. Revenue per traffic event divides the selected list’s total gross revenue by its total recorded traffic, not the average of row ratios or per unique person. No traffic or unknown revenue means unavailable. Traffic unit identifies visits or page views; the ratio retains calculated precision in the currency major unit. ";
 return csv([
  ["From (UTC)","To (UTC)","Currency","List","Matching loaded rows","Traffic unit","Traffic","Paid records","Gross revenue","Paid coverage","Recorded source rows","Source list truncated","Search","Sales filter","Minimum traffic","Order","Definition","Revenue per traffic event","Minimum paid records"],
  ...rows.map((row):Cell[]=>[data.from,data.to,data.currency.toUpperCase(),row.name,row.rows,row.unit,row.traffic,row.paidRecords,amount(row.cents,data.currency),rangeCoverage(data),row.sourceTotal??null,listCoverage(row.truncated),selection.query?.trim()??"",customRangeFilterLabel(data,selection.filter??"all"),customRangeMinimumTraffic(selection.minimumTraffic),customRangeOrderLabel(data,selection.sort??"recorded",row.kind),note+row.scope,amount(revenuePerTraffic(row.cents,row.traffic,row.cents!==null),data.currency),effectiveCustomRangeMinimumPaidRecords(data,selection.minimumPaidRecords)]),
 ]);
}

/** Export daily summary statistics with exact analytical averages before UI rounding. */
export function customRangeChartSummaryReport(data:RangeData,metric:CustomRangeMetric,grouping:CustomRangeGrouping="day"):string {
 const summary=customRangeChartSummary(data,metric);
 const group=effectiveCustomRangeGrouping(grouping);
 const requested=CUSTOM_RANGE_METRICS.find(item=>item.value===metric)?.label??String(metric);
 const label=summary?CUSTOM_RANGE_METRICS.find(item=>item.value===summary.metric)!.label:null;
 const groupLabel=CUSTOM_RANGE_GROUPINGS.find(item=>item.value===group)!.label;
 const note="Summary uses recorded UTC daily rows regardless of chart grouping or list filters. Recorded zero days enter the average; missing days are not invented. Average equals total / recorded days before display rounding and is an analytical value, not an individual payment amount. Visitors are summed daily counts, not distinct people across the period. Peak ties show the earliest recorded UTC day and their count. Unavailable requested paid metrics fall back to Visitors, matching the chart. Paid records include one-click extras and exclude renewals; revenue is before refunds, fees and ads. Recorded day count does not certify full calendar coverage. Days with activity count recorded daily values above zero for the effective metric; zero-activity days count exact recorded zeros. Missing days are excluded, regardless of chart grouping or accumulation. Active-day share equals days with activity / recorded days * 100 for the effective metric, not a conversion rate or full-calendar coverage. Median is the middle sorted recorded daily value, or the midpoint of the two middle values for an even day count; zero days count, missing days are excluded, and the CSV retains calculated precision. Longest activity sequence counts consecutive recorded UTC days with positive values for the effective metric; zero days and missing dates break it, and ties show the earliest sequence. No active days means zero length and blank sequence dates.";
 const value=(n:number)=>summary?.metric==="cents"?amount(n,data.currency):n;
 return csv([
  ["From (UTC)","To (UTC)","Currency","Chart grouping","Requested metric","Metric","Unit","Recorded days","Recorded total","Average per recorded day (unrounded)","First highest day (UTC)","Highest daily value","Days tied for highest value","Paid coverage","Definition","Days with activity","Recorded days with zero activity","Active-day share (%)","Median per recorded day (unrounded)","Longest activity sequence (days)","Sequence from (UTC)","Sequence to (UTC)"],
  ...(summary?[[data.from,data.to,data.currency.toUpperCase(),groupLabel,requested,label,summary.metric==="cents"?data.currency.toUpperCase():"Count",summary.days,value(summary.total),value(summary.average),summary.peak.date,value(summary.peak.value),summary.peak.ties,rangeCoverage(data),note,summary.activeDays,summary.zeroDays,summary.activeDayShare,value(summary.median),summary.longestStreak?.days??0,summary.longestStreak?.from??null,summary.longestStreak?.to??null] as Cell[]]:[]),
 ]);
}

/** Export weekday totals and analytical means with observed-day denominators and explicit missing values. */
export function customRangeWeekdayReport(data:RangeData,metric:CustomRangeMetric):string {
 const report=customRangeWeekdays(data,metric);
 const label=CUSTOM_RANGE_METRICS.find(item=>item.value===report.metric)!.label;
 const requested=CUSTOM_RANGE_METRICS.find(item=>item.value===metric)?.label??String(metric);
 const money=report.metric==="cents";
 const value=(n:number|null)=>money?amount(n,data.currency):n;
 const note="Observed UTC weekdays, Monday to Sunday, independent of chart grouping, accumulation and list filters. Each average is that weekday total / its recorded days; confirmed zero days count and missing dates do not. A weekday with no observations has blank total and average, not zero. Unequal observed-day counts and a current day still in progress can affect comparisons. Visitors sum daily counts, not distinct people across weekdays. Paid records include one-click extras and exclude renewals; revenue is before refunds, fees and ads. Unavailable paid metrics fall back to Visitors; Metric and Unit identify the exported values. Analytical averages retain calculated precision. Not a forecast or proof that a weekday causes better results. Weekday median is the middle sorted recorded daily value or midpoint of the two central values; confirmed zero days count. Days with activity count positive values for that weekday and effective metric; no observations means blank median and activity count.";
 return csv([
  ["From (UTC)","To (UTC)","Currency","Requested metric","Metric","Unit","Weekday (UTC)","Recorded days","Recorded total","Average per recorded day (unrounded)","Paid coverage","Definition","Median per recorded day (unrounded)","Days with activity"],
  ...(report.rows.some(row=>row.days>0)?report.rows.map((row):Cell[]=>[data.from,data.to,data.currency.toUpperCase(),requested,label,money?data.currency.toUpperCase():"Count",row.name,row.days,value(row.total),value(row.average),rangeCoverage(data),note,value(row.median),row.activeDays]):[]),
 ]);
}
