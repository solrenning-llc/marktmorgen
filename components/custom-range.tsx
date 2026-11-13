"use client";

import { customRangeChannelsReport, customRangeProductsReport, customRangeDailyReport, customRangeComparisonReport, customRangeChartReport, customRangeSelectionReport, customRangeChartSummaryReport, customRangeWeekdayReport, type CustomRangeReportSelection } from "@/lib/channel-reports";
import { ReportDownload } from "@/components/report-download";

import { paidFiguresComplete } from "@/lib/paid-coverage";
import { customRangeView, customRangeOrderLabel, effectiveCustomRangeSort, CUSTOM_RANGE_FILTERS, effectiveCustomRangeFilter, customRangeMinimumTraffic, effectiveCustomRangeMinimumPaidRecords, customRangeSelectionTotals, type CustomRangeFilter, type CustomRangeSort } from "@/lib/custom-range-view";
import { adjacentCustomRange, presetCustomRange, CUSTOM_RANGE_PRESETS, type CustomDatePeriod } from "@/lib/custom-range-dates";
import { CUSTOM_RANGE_METRICS, customRangeChartSummary, customRangeWeekdays, effectiveCustomRangeMetric, CUSTOM_RANGE_GROUPINGS, effectiveCustomRangeGrouping, customRangeChartRows, type CustomRangeGrouping, type CustomRangeMetric } from "@/lib/custom-range-chart";
import { revenuePerTraffic, formatRevenuePerTraffic, selectedRevenueShare, formatSelectedRevenueShare } from "@/lib/custom-range-efficiency";
import { customRangeComparison } from "@/lib/custom-range-comparison";
import { useState } from "react";
import { formatMoney } from "@/lib/money";
import { channelName } from "@/lib/channel-names";
import type { RangeData } from "@/lib/stats";
import type { AutoMark } from "@/lib/auto-marks";

const MESSAGES: Record<string, string> = {
  dates: "Pick a start and an end date.",
  order: "The start date comes after the end date. Swap them.",
  future: "The end date is in the future. Pick today or a day before it.",
  kept: "Visits are kept for 400 days. Pick a start date inside them.",
  signed_out: "Your session ended. Log in again.",
  server_error: "Your numbers could not be read just now. Try again in a moment.",
};

const count = (n: number) => n.toLocaleString("en-US");
const day = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const comparisonPercent=(n:number|null)=>{
  if(n===null)return "—";
  if(n!==0&&Math.abs(n)<0.1)return (n>0?"+":"")+n.toLocaleString("en-US",{maximumSignificantDigits:4})+"%";
  const rounded=Math.round(n*10)/10;
  return (rounded>0?"+":"")+(rounded===0?0:rounded).toLocaleString("en-US",{maximumFractionDigits:1})+"%";
 };
const change = (now: number, before: number | null) => {
  if (before === null) return "";
  if (before === 0) return now === 0 ? "same as the days before" : "none the days before";
  if (now === before) return "same as the days before";
  return `${comparisonPercent(((now - before) / before) * 100)} on the days before`;
};

type Products = (RangeData["products"][number] & { title: string })[];

/**
 * Any dates the creator picks (lib/stats.ts, readRange): a launch read from
 * its first day to its last, set beside the same number of days before it,
 * with what the store marked on those days.
 */
export function CustomRange({ today, currency }: { today: string; currency: string }) {
  const earliest = new Date(Date.parse(`${today}T00:00:00Z`) - 399 * 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ range: Omit<RangeData, "products"> & { products: Products }; marks: AutoMark[] | null; titlesUnavailable: boolean; fullDetails: boolean; receivedAt: string } | null>(null);

  async function show(fullDetails = false, period?: CustomDatePeriod, keepDraftDates = false) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/store/stats/range?${new URLSearchParams({ from: period?.from ?? (fullDetails && result ? result.range.from : from), to: period?.to ?? (fullDetails && result ? result.range.to : to), ...(fullDetails ? { details: "all" } : {}) })}`, { cache: "no-store" });
      const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; range?: RangeData & { products: Products }; marks?: AutoMark[] | null; titlesUnavailable?: boolean };
      if (data.ok && data.range) {
        // Marks that were not read are unknown (null), never an empty list (VR2 audit, rule 24).
        setResult({ range: data.range, marks: Array.isArray(data.marks) ? data.marks : null, titlesUnavailable: data.titlesUnavailable === true, fullDetails, receivedAt: new Date().toISOString() });
        if (period && !keepDraftDates) { setFrom(data.range.from); setTo(data.range.to); }
      }
      else setError(MESSAGES[data.error ?? ""] ?? MESSAGES.server_error);
    } catch {
      setError(MESSAGES.server_error);
    } finally {
      setBusy(false);
    }
  }

  const r = result?.range;
  const previousPeriod = r ? adjacentCustomRange(r,-1,today) : null;
  const nextPeriod = r ? adjacentCustomRange(r,1,today) : null;

  return (
    <div className="mt-5 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" role="region" aria-labelledby="custom-range" data-custom-range>
      <p id="custom-range" className="text-sm font-bold text-ink">
        Any dates
      </p>
      <CustomRangePresets today={today} busy={busy} onSelect={period => { void show(false, period); }} />
      <form
        className="mt-2 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void show();
        }}
      >
        <label className="block" htmlFor="range-from">
          <span className="field-label">From</span>
          <input id="range-from" type="date" className="field mt-1" min={earliest} max={today} value={from} onChange={(event) => setFrom(event.target.value)} required />
        </label>
        <label className="block" htmlFor="range-to">
          <span className="field-label">To</span>
          <input id="range-to" type="date" className="field mt-1" min={earliest} max={today} value={to} onChange={(event) => setTo(event.target.value)} required />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? "Reading…" : "Show these days"}
        </button>
      </form>
      <p className="mt-2 text-xs text-ink-soft">Any days from the last 400, in UTC like every day here, set beside the same number of days just before.</p>
      <p className="mt-2 text-xs text-ink-soft" role="status" aria-live="polite" aria-atomic="true">
        {busy ? (result ? "Reading selected dates. The previous report remains visible until the new reading succeeds. " : "Reading selected dates. ") : null}
        {result ? <>Last report received: <time dateTime={result.receivedAt}>{new Date(result.receivedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" })} UTC</time>. This is the reading time; data availability is shown below.</> : null}
      </p>
      {error ? (
        <p className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      ) : null}
      {r ? <CustomRangeResults range={r} marks={result.marks} titlesUnavailable={result.titlesUnavailable} currency={currency} onShowAll={() => { void show(true); }} onRefresh={() => { void show(result.fullDetails, {from:r.from,to:r.to}, true); }} busy={busy} onNavigate={direction=>{const period=direction===-1?previousPeriod:nextPeriod;if(period)void show(false,period);}} canPrevious={previousPeriod!==null} canNext={nextPeriod!==null} /> : null}
    </div>
  );
}

/** Direct shortcuts use the same confirmed request flow as period navigation. */
export function CustomRangePresets({today,busy=false,onSelect}:{today:string;busy?:boolean;onSelect:(period:CustomDatePeriod)=>void}) {
 return <div className="mt-2" role="group" aria-label="Quick date ranges">
  <div className="flex flex-wrap gap-2">{CUSTOM_RANGE_PRESETS.map(preset=>{
   const period=presetCustomRange(preset.value,today);
   return <button key={preset.value} type="button" className="btn btn-secondary" disabled={busy || !period} onClick={()=>{if(period)onSelect(period);}}>{preset.label}</button>;
  })}</div>
  <p className="mt-1 text-xs text-ink-soft">Last 7/30/90 days and This month include today in UTC. Today’s numbers may still grow. Yesterday, Last month and completed-day shortcuts exclude today and use completed UTC dates.</p>
 </div>;
}

/** The confirmed results of the requested dates, with paid coverage checked separately. */
export function CustomRangeResults({ range, marks, titlesUnavailable = false, currency, onShowAll, onRefresh, busy = false, onNavigate, canPrevious = false, canNext = false }: { range: Omit<RangeData, "products"> & { products: Products }; marks: AutoMark[] | null; titlesUnavailable?: boolean; currency: string; onShowAll?: () => void; onRefresh?: () => void; busy?: boolean; onNavigate?: (direction:-1|1)=>void; canPrevious?:boolean; canNext?:boolean }) {
  const money = (cents: number) => formatMoney(cents, currency);
  const r = range;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CustomRangeSort>("recorded");
  const [filter,setFilter] = useState<CustomRangeFilter>("all");
  const [minimumTraffic,setMinimumTraffic]=useState("0");
  const [minimumPaidRecords,setMinimumPaidRecords]=useState("0");
  const actualMinimumPaidRecords=effectiveCustomRangeMinimumPaidRecords(r,minimumPaidRecords);
  const minimumPaidInvalid=paidFiguresComplete(r)&&minimumPaidRecords.trim()!==""&&actualMinimumPaidRecords===0&&Number(minimumPaidRecords)!==0;
  const hasListSelection=query!==""||sort!=="recorded"||filter!=="all"||minimumTraffic!=="0"||minimumPaidRecords!=="0";
  const actualMinimum=customRangeMinimumTraffic(minimumTraffic);
  const minimumInvalid=minimumTraffic.trim()!==""&&actualMinimum===0&&Number(minimumTraffic)!==0;
  const actualFilter=effectiveCustomRangeFilter(r,filter);
  const actualSort = effectiveCustomRangeSort(r, sort);
  const view = customRangeView(r, query, actualSort, actualFilter, actualMinimum, actualMinimumPaidRecords);
  const sold = paidFiguresComplete(r);
  const listTotals=customRangeSelectionTotals(view);
  const [chartMetric, setChartMetric] = useState<CustomRangeMetric>("visitors");
  const [chartGrouping, setChartGrouping] = useState<CustomRangeGrouping>("day");
  const [chartCumulative,setChartCumulative]=useState(false);
  const tiles = [
        { label: "Visitors", value: count(r.totals.visitors), note: r.before ? change(r.totals.visitors, r.before.visitors) : "" },
        { label: "Page views", value: count(r.totals.views), note: r.before ? change(r.totals.views, r.before.views) : "" },
        { label: "Checkouts started", value: count(r.totals.checkouts), note: r.before ? change(r.totals.checkouts, r.before.checkouts) : "" },
        ...(sold
          ? [
              { label: "Sales", value: count(r.totals.sales), note: r.before ? change(r.totals.sales, r.before.sales) : "" },
              { label: "Revenue", value: money(r.totals.cents), note: r.before ? change(r.totals.cents, r.before.cents) : "" },
            ]
          : []),
      ];

  return (
    <div className="mt-4" data-range-result>
      {onRefresh ? <div className="mb-3">
        <button type="button" className="btn btn-secondary" onClick={onRefresh} disabled={busy} aria-busy={busy}>{busy ? "Reading…" : "Refresh results"}</button>
        <p className="mt-1 text-xs text-ink-soft">Refresh the displayed dates, keeping the list view. Dates being edited above stay unchanged.</p>
      </div> : null}
      {onNavigate ? <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Move between periods">
        <button type="button" className="btn btn-secondary" disabled={busy || !canPrevious} onClick={()=>onNavigate(-1)}>Previous period</button>
        <button type="button" className="btn btn-secondary" disabled={busy || !canNext} onClick={()=>onNavigate(1)}>Next period</button>
        <p className="w-full text-xs text-ink-soft">Move by the same number of days, within the available history.</p>
      </div> : null}
      {onShowAll && (r.channelsTruncated === true || r.productsTruncated === true) ? <button type="button" className="btn btn-secondary mb-3" onClick={onShowAll} disabled={busy} aria-busy={busy}>{busy ? "Reading…" : "Show all channels and products"}</button> : null}
      <p className="text-sm font-semibold text-ink">{r.from === r.to ? day(r.from) : `${day(r.from)} to ${day(r.to)}, ${r.days.length} days`}</p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-[12px] bg-white px-4 py-3 ring-1 ring-line">
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-soft">{t.label}</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{t.value}</dd>
            {t.note ? <dd className="text-xs text-ink-soft">{t.note}</dd> : null}
          </div>
        ))}
      </dl>
      <CustomRangeComparison range={r} currency={currency} />
      <ReportDownload csv={()=>customRangeComparisonReport(r)} filename={"marktmorgen-custom-comparison-"+r.from+"-to-"+r.to+".csv"}>Download period comparison</ReportDownload>
      {r.days.length ? <ReportDownload csv={()=>customRangeDailyReport(r)} filename={"marktmorgen-custom-daily-"+r.from+"-to-"+r.to+".csv"}>Download daily results</ReportDownload> : null}
      {r.sales === "error" ? <p className="mt-2 text-sm text-ink-soft">Stripe did not answer, so sales are not shown. Try again in a moment.</p> : null}
      {r.partial ? <p className="mt-2 text-sm text-ink-soft">The purchase reading is incomplete. Sales and revenue are unavailable; traffic and checkouts remain visible.</p> : null}
      <CustomRangeChart range={r} currency={currency} metric={chartMetric} onMetricChange={setChartMetric} grouping={chartGrouping} onGroupingChange={setChartGrouping} cumulative={chartCumulative} onCumulativeChange={setChartCumulative} />
      {marks === null ? <p className="mt-3 text-sm text-ink-soft" role="status">Marks for these days could not be loaded. Try again in a moment.</p> : null}
      {marks?.length ? (
        <ul className="mt-3 space-y-1 text-sm" aria-label="Marked on these days">
          {marks.map((m, i) => (
            <li key={`${m.day}-${i}`} className="flex gap-2">
              <span className="shrink-0 tabular-nums text-ink-soft">{day(m.day)}</span>
              <span className="min-w-0 text-ink [overflow-wrap:anywhere]">{m.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {titlesUnavailable && r.products.length ? <p className="mt-3 text-sm text-ink-soft" role="status">Some product names could not be loaded. Those products show “Title could not be loaded”. Try again in a moment.</p> : null}
      {r.channels.length || r.products.length ? <div className="mt-4">
        <label className="field-label" htmlFor="range-search">Search channels or products</label>
        <input id="range-search" type="search" className="field mt-1" value={query} maxLength={100} onChange={event=>setQuery(event.target.value)} placeholder="Channel, product name or product ID" />
        <label className="field-label mt-3" htmlFor="range-sort">Order channels and products</label>
        <select id="range-sort" className="field mt-1" value={actualSort} onChange={event=>setSort(event.target.value as CustomRangeSort)}>
          <option value="recorded">Recorded order</option><option value="traffic_desc">Traffic, highest first</option><option value="traffic_asc">Traffic, lowest first</option>
          <option value="revenue_desc" disabled={!sold}>Revenue, highest first</option><option value="revenue_asc" disabled={!sold}>Revenue, lowest first</option>
          <option value="sales_desc" disabled={!sold}>Sales, highest first</option><option value="sales_asc" disabled={!sold}>Sales, lowest first</option><option value="efficiency_desc" disabled={!sold}>Revenue / visit or view, highest first</option><option value="efficiency_asc" disabled={!sold}>Revenue / visit or view, lowest first</option><option value="name">Name, A–Z</option>
        </select>
        <label className="field-label mt-3" htmlFor="range-sales-filter">Filter channels and products</label>
        <select id="range-sales-filter" className="field mt-1" value={actualFilter} onChange={event=>setFilter(event.target.value as CustomRangeFilter)}>
          {CUSTOM_RANGE_FILTERS.map(item=><option key={item.value} value={item.value} disabled={item.value!=="all"&&!sold}>{item.label}</option>)}
        </select>
        <p className="mt-1 text-xs text-ink-soft">Traffic without sales means recorded visits or views with zero recorded purchases in this reading. Sales without recorded traffic means recorded purchases with zero visits or views in the selected dates; this does not establish why traffic is absent. Sales filters require a complete purchase reading.</p>
        <label className="field-label mt-3" htmlFor="range-minimum-traffic">Minimum visits / views</label>
        <input id="range-minimum-traffic" type="number" min={0} step={1} max={Number.MAX_SAFE_INTEGER} className="field mt-1" value={minimumTraffic} onChange={event=>setMinimumTraffic(event.target.value)} aria-describedby="range-minimum-help" aria-invalid={minimumInvalid} />
        <p id="range-minimum-help" className="mt-1 text-xs text-ink-soft">Channels use visits; products use page views. Zero or an empty field applies no minimum.</p>
        {minimumInvalid?<p className="mt-1 text-xs text-danger" role="alert">Enter a whole number of zero or more. No minimum is applied until the value is valid.</p>:null}
        <label className="field-label mt-3" htmlFor="range-minimum-paid">Minimum paid records</label>
        <input id="range-minimum-paid" type="number" min={0} step={1} max={Number.MAX_SAFE_INTEGER} className="field mt-1" value={sold?minimumPaidRecords:"0"} onChange={event=>setMinimumPaidRecords(event.target.value)} disabled={!sold} aria-describedby="range-minimum-paid-help" aria-invalid={minimumPaidInvalid} />
        <p id="range-minimum-paid-help" className="mt-1 text-xs text-ink-soft">Payment records, not distinct buyers. Channels exclude one-click extras; products include them. Zero or an empty field applies no minimum. Requires a complete purchase reading.</p>
        {minimumPaidInvalid?<p className="mt-1 text-xs text-danger" role="alert">Enter a whole number of zero or more. No paid-record minimum is applied until the value is valid.</p>:null}
        <p className="mt-1 text-xs text-ink-soft">Search applies to the loaded lists. Period totals and daily results stay the same.{r.channelsTruncated || r.productsTruncated ? " Open all results above to search or filter every recorded row." : ""}</p>
        {query.trim() || actualFilter!=="all" || actualMinimum>0 || actualMinimumPaidRecords>0 ? <p className="mt-1 text-xs text-ink-soft" role="status">{view.channels.length} of {r.channels.length} loaded channels and {view.products.length} of {r.products.length} loaded products match.</p> : null}
      </div> : null}
      {hasListSelection?<CustomRangeSelectionSummary range={view} currency={currency} selection={{query,sort:actualSort,filter:actualFilter,minimumTraffic:actualMinimum,minimumPaidRecords:actualMinimumPaidRecords}} />:null}
      {hasListSelection?<button type="button" className="btn btn-secondary mt-3" onClick={()=>{setQuery("");setSort("recorded");setFilter("all");setMinimumTraffic("0");setMinimumPaidRecords("0");}}>Reset list view</button>:null}
      {sold ? <p className="mt-3 text-xs text-ink-soft">Revenue / visit and Revenue / view divide each row’s gross revenue by recorded visits or page views, not unique people. Channels exclude one-click extras; products include them. Both exclude renewals and are before refunds, fees and costs. No traffic means unavailable; rows without a defined ratio sort last in either direction. Analytical money uses up to four significant digits; CSV values keep calculated precision. Revenue share uses each selected loaded list’s total revenue, separately for channels and products, not whole-period revenue. A zero total has no defined share; limited lists describe only the loaded selection.</p> : null}
      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        {view.channels.length ? (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-labelledby="range-channels">
          <ReportDownload csv={()=>customRangeChannelsReport(view,{query,sort:actualSort,filter:actualFilter,minimumTraffic:actualMinimum,minimumPaidRecords:actualMinimumPaidRecords})} filename={"marktmorgen-custom-channels-"+r.from+"-to-"+r.to+".csv"}>Download displayed channels</ReportDownload>
            <table className="w-full text-left text-sm">
              <caption id="range-channels" className="text-left text-sm font-bold text-ink">Where they came from{r.channelsTruncated === true && r.channelsTotal != null ? <span className="mt-1 block text-xs font-normal text-ink-soft">Showing {view.channels.length} of {r.channelsTotal} recorded channels, ordered by {customRangeOrderLabel(r,actualSort,"channels").toLowerCase()}.</span> : null}</caption>
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                  <th scope="col" className="py-1 font-semibold">Channel</th>
                  <th scope="col" className="py-1 pl-3 text-right font-semibold">Visits</th>
                  {sold ? <th scope="col" className="py-1 pl-3 text-right font-semibold">Sales</th> : null}
                  {sold ? <th scope="col" className="py-1 pl-3 text-right font-semibold">Revenue</th> : null}
                  {sold ? <th scope="col" className="py-1 pl-3 text-right font-semibold">Revenue / visit</th> : null}
                  {sold ? <th scope="col" className="py-1 pl-3 text-right font-semibold">Share of selected revenue</th> : null}
                </tr>
              </thead>
              <tbody>
                {view.channels.map((c) => (
                  <tr key={c.source} className="border-b border-line/60">
                    <th scope="row" className="py-1.5 pr-3 font-medium text-ink">{channelName(c.source)}</th>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{count(c.visits)}</td>
                    {sold ? <td className="py-1.5 pl-3 text-right tabular-nums">{count(c.sales)}</td> : null}
                    {sold ? <td className="py-1.5 pl-3 text-right tabular-nums">{money(c.cents)}</td> : null}
                    {sold ? <td className="py-1.5 pl-3 text-right tabular-nums">{formatRevenuePerTraffic(revenuePerTraffic(c.cents,c.visits,sold),currency)}</td> : null}
                    {sold ? <td className="py-1.5 pl-3 text-right tabular-nums">{formatSelectedRevenueShare(selectedRevenueShare(c.cents,listTotals.channels.cents,sold))}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : r.channels.length ? <p className="text-sm text-ink-soft">No loaded channels match the current search and filters. Reset the list view or adjust the filters.{r.channelsTruncated===true?" The loaded channel list is limited.":""}</p> : null}
        {view.products.length ? (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-labelledby="range-products">
          <ReportDownload csv={()=>customRangeProductsReport(view,{query,sort:actualSort,filter:actualFilter,minimumTraffic:actualMinimum,minimumPaidRecords:actualMinimumPaidRecords})} filename={"marktmorgen-custom-products-"+r.from+"-to-"+r.to+".csv"}>Download displayed products</ReportDownload>
            <table className="w-full text-left text-sm">
              <caption id="range-products" className="text-left text-sm font-bold text-ink">Products{r.productsTruncated === true && r.productsTotal != null ? <span className="mt-1 block text-xs font-normal text-ink-soft">Showing {view.products.length} of {r.productsTotal} recorded products, ordered by {customRangeOrderLabel(r,actualSort,"products").toLowerCase()}.</span> : null}</caption>
              <thead>
                <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                  <th scope="col" className="py-1 font-semibold">Product</th>
                  <th scope="col" className="py-1 pl-3 text-right font-semibold">Views</th>
                  <th scope="col" className="py-1 pl-3 text-right font-semibold">Checkouts</th>
                  {sold ? <th scope="col" className="py-1 pl-3 text-right font-semibold">Sales</th> : null}
                  {sold ? <th scope="col" className="py-1 pl-3 text-right font-semibold">Revenue</th> : null}
                  {sold ? <th scope="col" className="py-1 pl-3 text-right font-semibold">Revenue / view</th> : null}
                  {sold ? <th scope="col" className="py-1 pl-3 text-right font-semibold">Share of selected revenue</th> : null}
                </tr>
              </thead>
              <tbody>
                {view.products.map((p) => (
                  <tr key={p.id} className="border-b border-line/60">
                    <th scope="row" className="py-1.5 pr-3 font-medium text-ink [overflow-wrap:anywhere]">{p.title}</th>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{count(p.views)}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{count(p.checkouts)}</td>
                    {sold ? <td className="py-1.5 pl-3 text-right tabular-nums">{count(p.sales)}</td> : null}
                    {sold ? <td className="py-1.5 pl-3 text-right tabular-nums">{money(p.cents)}</td> : null}
                    {sold ? <td className="py-1.5 pl-3 text-right tabular-nums">{formatRevenuePerTraffic(revenuePerTraffic(p.cents,p.views,sold),currency)}</td> : null}
                    {sold ? <td className="py-1.5 pl-3 text-right tabular-nums">{formatSelectedRevenueShare(selectedRevenueShare(p.cents,listTotals.products.cents,sold))}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : r.products.length ? <p className="text-sm text-ink-soft">No loaded products match the current search and filters. Reset the list view or adjust the filters.{r.productsTruncated===true?" The loaded product list is limited.":""}</p> : null}
      </div>
    </div>
  );
}


/** Every displayed group uses the current reading's coverage and exact recorded dates. */
export function CustomRangeChart({range,currency,metric="visitors",grouping="day",onMetricChange,onGroupingChange,cumulative=false,onCumulativeChange}:{range:RangeData;currency:string;metric?:CustomRangeMetric;grouping?:CustomRangeGrouping;onMetricChange?:(metric:CustomRangeMetric)=>void;onGroupingChange?:(grouping:CustomRangeGrouping)=>void;cumulative?:boolean;onCumulativeChange?:(value:boolean)=>void}) {
 const selected=effectiveCustomRangeMetric(range,metric);
 const unit=effectiveCustomRangeGrouping(grouping);
 const label=CUSTOM_RANGE_METRICS.find(item=>item.value===selected)!.label;
 const sold=paidFiguresComplete(range);
 const rows=customRangeChartRows(range,selected,unit,cumulative);
 const peak=Math.max(1,...rows.map(row=>row.value));
 const value=(n:number)=>selected==="cents"?formatMoney(n,currency):count(n);
 const dates=(row:typeof rows[number])=>cumulative?"Through "+day(row.to):row.from===row.to?day(row.from):day(row.from)+" to "+day(row.to);
 const chartLabel=(cumulative?"Cumulative recorded ":"")+label+(unit==="day"?" each day":unit==="week"?" by week":" by month");
 return <div className="mt-4">
  <label className="field-label" htmlFor="range-chart-metric">Daily chart</label>
  <select id="range-chart-metric" className="field mt-1" value={selected} onChange={event=>onMetricChange?.(event.target.value as CustomRangeMetric)}>
   {CUSTOM_RANGE_METRICS.map(item=><option key={item.value} value={item.value} disabled={item.paid&&!sold}>{item.label}</option>)}
  </select>
  <label className="field-label mt-2" htmlFor="range-chart-grouping">Group chart by</label>
  <select id="range-chart-grouping" className="field mt-1" value={unit} onChange={event=>onGroupingChange?.(event.target.value as CustomRangeGrouping)}>
   {CUSTOM_RANGE_GROUPINGS.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}
  </select>
  <label className="mt-2 flex items-center gap-2 text-sm text-ink" htmlFor="range-chart-cumulative"><input id="range-chart-cumulative" type="checkbox" checked={cumulative} onChange={event=>onCumulativeChange?.(event.target.checked)} />Cumulative recorded total</label>
  {cumulative?<p className="mt-1 text-xs text-ink-soft">Each value accumulates recorded days from the selected start through that group’s last date. Missing days are not invented. Cumulative visitors sum daily counts, not distinct people across the period. The summary below still uses daily values.</p>:null}
  <p className="mt-1 text-xs text-ink-soft">Daily totals in UTC.{unit!=="day"?" Weeks start on Monday. First and last groups may cover only part of a week or month. Visitors are summed daily counts, not distinct people across the group.":""}{selected==="cents"||selected==="sales"?" Purchases include one-click extras and exclude renewals. Revenue is before fees, refunds and ad spend.":""}</p>
  <CustomRangeChartSummary range={range} currency={currency} metric={metric} grouping={unit} />
  <div className={"mt-3 flex h-24 items-end "+(rows.length>60?"gap-0":"gap-[2px]")} role="img" aria-label={chartLabel}>
   {rows.map(row=><div key={row.from} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={dates(row)+": "+value(row.value)+" "+label.toLowerCase()+(selected==="visitors"&&row.sales!==null?", "+row.sales+" sales":"")}>
    <div className="w-full rounded-t-[2px] bg-violet-brand/80" style={{height:Math.max(row.value?4:1,(row.value/peak)*100)+"%",opacity:row.value?1:0.25}} />
   </div>)}
  </div>
  {rows.length?<ReportDownload csv={()=>customRangeChartReport(range,metric,grouping,cumulative)} filename={"marktmorgen-custom-chart-"+selected+"-"+unit+(cumulative?"-cumulative":"")+"-"+range.from+"-to-"+range.to+".csv"}>Download chart values</ReportDownload>:null}
  {rows.length?<details className="mt-2">
   <summary className="cursor-pointer text-sm font-semibold text-ink">View chart values</summary>
   <div className="mt-2 max-h-64 overflow-auto" tabIndex={0} role="region" aria-label="Chart values">
    <table className="w-full text-left text-sm"><caption className="text-left text-xs text-ink-soft">{chartLabel} (UTC)</caption>
     <thead><tr><th scope="col" className="py-1">{cumulative?"Through (UTC)":"Dates"}</th><th scope="col" className="py-1 text-right">{label}</th></tr></thead>
     <tbody>{rows.map(row=><tr key={row.from}><th scope="row" className="py-1 font-normal">{dates(row)}</th><td className="py-1 text-right tabular-nums">{value(row.value)}</td></tr>)}</tbody>
    </table>
   </div>
  </details>:null}
 </div>;
}

/** Exact values behind the headline changes, independently of table search or chart grouping. */
export function CustomRangeComparison({range,currency}:{range:RangeData;currency:string}) {
 const comparison=customRangeComparison(range);
 const dates=(from:string,to:string)=>from===to?day(from):day(from)+" to "+day(to);
 const value=(n:number|null,metric:typeof comparison.rows[number],signed=false)=>n===null?"Unavailable":(signed&&n>0?"+":"")+(metric.money?(n!==0&&Math.abs(n)<1?formatRevenuePerTraffic(n,currency):formatMoney(n,currency)):metric.ratio?n.toLocaleString("en-US",{maximumSignificantDigits:4}):count(n));

 return <details className="mt-3">
  <summary className="cursor-pointer text-sm font-semibold text-ink">Compare with previous period</summary>
  <p className="mt-2 text-xs text-ink-soft">Selected: {dates(range.from,range.to)} (UTC).{comparison.previousFrom&&comparison.previousTo?" Previous: "+dates(comparison.previousFrom,comparison.previousTo)+" (UTC).":""}</p>
  <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Period comparison">
   <table className="w-full text-left text-sm">
    <caption className="text-left text-xs text-ink-soft">Equal consecutive UTC periods</caption>
    <thead><tr><th scope="col" className="py-1">Metric</th><th scope="col" className="py-1 pl-3 text-right">Selected days</th><th scope="col" className="py-1 pl-3 text-right">Previous days</th><th scope="col" className="py-1 pl-3 text-right">Difference</th><th scope="col" className="py-1 pl-3 text-right">Change</th></tr></thead>
    <tbody>{comparison.rows.map(row=><tr key={row.name} className="border-b border-line/60">
     <th scope="row" className="py-1.5 pr-3 font-medium">{row.name}</th>
     <td className="py-1.5 pl-3 text-right tabular-nums">{value(row.current,row)}</td>
     <td className="py-1.5 pl-3 text-right tabular-nums">{value(row.previous,row)}</td>
     <td className="py-1.5 pl-3 text-right tabular-nums">{value(row.difference,row,true)}</td>
     <td className="py-1.5 pl-3 text-right tabular-nums">{comparisonPercent(row.change)}</td>
    </tr>)}</tbody>
   </table>
  </div>
  <p className="mt-2 text-xs text-ink-soft">Difference is selected minus previous. A dash means no percentage is available because a reading is missing or the previous value is zero. Traffic availability is independent of paid coverage. Paid records include one-click extras and exclude renewals; revenue is before refunds, fees and ad spend. Money is rounded for display; very small nonzero monetary values remain visible with up to four significant digits. Count ratios use up to four significant digits, so small nonzero values remain visible. Nonzero percentage changes below 0.1% use up to four significant digits. The CSV keeps the calculated precision. The selected end day may still be in progress.</p>
  <details className="mt-2 text-xs text-ink-soft">
   <summary className="cursor-pointer font-semibold">How metrics are calculated</summary>
   <dl className="mt-2 space-y-2">{comparison.rows.map(row=><div key={row.name}><dt className="font-semibold text-ink">{row.name}</dt><dd>{row.definition}</dd></div>)}</dl>
  </details>
 </details>;
}

/** Describe the loaded search/filter selection without presenting it as a whole-period total. */
export function CustomRangeSelectionSummary({range,currency,selection}:{range:RangeData;currency:string;selection?:CustomRangeReportSelection}) {
 const totals=customRangeSelectionTotals(range);
 const rows=[{name:"Channels (visits)",...totals.channels},{name:"Products (page views)",...totals.products}];
 return <div className="mt-3 rounded-[12px] bg-white px-3 py-3 ring-1 ring-line" role="region" aria-label="Selection totals">
  <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Matching loaded row totals">
   <table className="w-full text-left text-sm">
    <caption className="mb-1 text-left text-sm font-semibold text-ink">Matching loaded rows</caption>
    <thead><tr><th scope="col" className="py-1">List</th><th scope="col" className="py-1 pl-3 text-right">Rows</th><th scope="col" className="py-1 pl-3 text-right">Traffic</th><th scope="col" className="py-1 pl-3 text-right">Paid records</th><th scope="col" className="py-1 pl-3 text-right">Gross revenue</th><th scope="col" className="py-1 pl-3 text-right">Revenue / visit or view</th></tr></thead>
    <tbody>{rows.map(row=><tr key={row.name} className="border-b border-line/60">
     <th scope="row" className="py-1.5 font-medium">{row.name}</th>
     <td className="py-1.5 pl-3 text-right tabular-nums">{count(row.rows)}</td>
     <td className="py-1.5 pl-3 text-right tabular-nums">{count(row.traffic)}</td>
     <td className="py-1.5 pl-3 text-right tabular-nums">{row.paidRecords===null?"Unavailable":count(row.paidRecords)}</td>
     <td className="py-1.5 pl-3 text-right tabular-nums">{row.cents===null?"Unavailable":formatMoney(row.cents,currency)}</td>
     <td className="py-1.5 pl-3 text-right tabular-nums">{formatRevenuePerTraffic(revenuePerTraffic(row.cents,row.traffic,row.cents!==null),currency)}</td>
    </tr>)}</tbody>
   </table>
  </div>
  <p className="mt-2 text-xs text-ink-soft">Totals cover matching loaded rows, not the whole period. Channels and products overlap; do not add them together.{range.channelsTruncated||range.productsTruncated?" Some loaded lists are limited.":""}</p>
  <p className="mt-1 text-xs text-ink-soft">Channel purchases exclude one-click extras; product purchases include them. Both exclude renewals. Gross revenue is before refunds, fees and ad spend. Revenue / visit or view divides each selected list’s total gross revenue by its total recorded traffic, not the average of row ratios. No traffic or unknown revenue means unavailable. Channels use visits; products use page views. Analytical money uses up to four significant digits; CSV values keep calculated precision.</p>
  {selection?<ReportDownload csv={()=>customRangeSelectionReport(range,selection)} filename={"marktmorgen-custom-selection-"+range.from+"-to-"+range.to+".csv"}>Download selection totals</ReportDownload>:null}
 </div>;
}

/** The summary uses daily rows even when bars are grouped by week or month. */
export function CustomRangeChartSummary({range,currency,metric,grouping="day"}:{range:RangeData;currency:string;metric:CustomRangeMetric;grouping?:CustomRangeGrouping}) {
 const summary=customRangeChartSummary(range,metric);
 if(!summary)return null;
 const label=CUSTOM_RANGE_METRICS.find(item=>item.value===summary.metric)!.label;
 const weekdays=customRangeWeekdays(range,metric);
 const value=(n:number,average=false)=>summary.metric==="cents"?(n!==0&&Math.abs(n)<1?formatRevenuePerTraffic(n,currency):formatMoney(Math.round(n),currency)):n.toLocaleString("en-US",average&&n!==0&&Math.abs(n)<0.01?{maximumSignificantDigits:4}:{maximumFractionDigits:average?2:0});
 return <div className="mt-3" role="region" aria-label="Chart metric summary">
  <p className="text-xs font-semibold text-ink">{label} over {count(summary.days)} recorded UTC days</p>
  <dl className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
   <div><dt className="text-xs text-ink-soft">Recorded total</dt><dd className="text-lg font-semibold tabular-nums">{value(summary.total)}</dd></div>
   <div><dt className="text-xs text-ink-soft">Average per recorded day</dt><dd className="text-lg font-semibold tabular-nums">{value(summary.average,true)}</dd><dt className="mt-1 text-xs text-ink-soft">Median per recorded day</dt><dd className="text-sm font-semibold tabular-nums">{value(summary.median,true)}</dd></div>
   <div><dt className="text-xs text-ink-soft">Days with activity</dt><dd className="text-lg font-semibold tabular-nums">{count(summary.activeDays)}</dd><dd className="text-xs text-ink-soft">{summary.activeDayShare.toLocaleString("en-US",{maximumFractionDigits:2})}% of recorded days. This is daily activity frequency, not a conversion rate.</dd><dd className="text-xs text-ink-soft">{count(summary.zeroDays)} recorded days with zero activity. Counts follow the selected metric; missing days are excluded.</dd></div>
   <div><dt className="text-xs text-ink-soft">Highest recorded day</dt><dd className="text-lg font-semibold tabular-nums">{value(summary.peak.value)}</dd><dd className="text-xs text-ink-soft">{day(summary.peak.date)}{summary.peak.ties>1?" · "+count(summary.peak.ties)+" days tied; earliest shown.":""}</dd></div>
  </dl>
  <details className="mt-2 text-sm">
   <summary className="cursor-pointer font-semibold text-ink">Longest activity sequence: {count(summary.longestStreak?.days??0)} days</summary>
   <p className="mt-1 text-xs text-ink-soft">{summary.longestStreak?day(summary.longestStreak.from)+" to "+day(summary.longestStreak.to)+" (UTC).":"No recorded days with positive activity."} Counts consecutive recorded UTC days with positive values for the selected metric. Zero days and missing dates break the sequence; the earliest longest sequence is shown. Grouping and accumulation do not change it.</p>
  </details>
  <p className="mt-1 text-xs text-ink-soft">Summary uses daily rows even when the chart is grouped. The median is the middle recorded daily value, or the midpoint of the two middle values; zero days count and missing days are excluded. Averages are rounded for display; small nonzero averages remain visible with up to four significant digits.{summary.metric==="visitors"?" Visitors are summed daily counts, not distinct people across the period.":""} Values for today can still grow.</p>
  <details className="mt-2 text-sm">
   <summary className="cursor-pointer font-semibold text-ink">Compare weekdays (UTC)</summary>
   <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Weekday activity">
    <table className="w-full text-left text-sm">
     <caption className="text-left text-xs text-ink-soft">{label} by recorded UTC weekday</caption>
     <thead><tr><th scope="col" className="py-1">Weekday</th><th scope="col" className="py-1 pl-3 text-right">Recorded days</th><th scope="col" className="py-1 pl-3 text-right">Recorded total</th><th scope="col" className="py-1 pl-3 text-right">Average per recorded day</th><th scope="col" className="py-1 pl-3 text-right">Median per recorded day</th><th scope="col" className="py-1 pl-3 text-right">Days with activity</th></tr></thead>
     <tbody>{weekdays.rows.map(row=><tr key={row.name} className="border-b border-line/60"><th scope="row" className="py-1.5 font-medium">{row.name}</th><td className="py-1.5 pl-3 text-right tabular-nums">{count(row.days)}</td><td className="py-1.5 pl-3 text-right tabular-nums">{row.total===null?"Unavailable":value(row.total)}</td><td className="py-1.5 pl-3 text-right tabular-nums">{row.average===null?"Unavailable":value(row.average,true)}</td><td className="py-1.5 pl-3 text-right tabular-nums">{row.median===null?"Unavailable":value(row.median,true)}</td><td className="py-1.5 pl-3 text-right tabular-nums">{row.activeDays===null?"Unavailable":count(row.activeDays)}</td></tr>)}</tbody>
    </table>
   </div>
   <p className="mt-1 text-xs text-ink-soft">Each average divides that weekday’s total by its recorded days, including confirmed zero days. Missing dates are excluded; a weekday without observations is unavailable. Compare the day counts too: the samples may differ and today can still grow. The median is the central recorded daily value or midpoint of the two central values; zero days count. Days with activity count positive daily values. These patterns do not establish that a weekday causes better results.</p>
   <ReportDownload csv={()=>customRangeWeekdayReport(range,metric)} filename={"marktmorgen-custom-weekdays-"+summary.metric+"-"+range.from+"-to-"+range.to+".csv"}>Download weekday results</ReportDownload>
  </details>
  <ReportDownload csv={()=>customRangeChartSummaryReport(range,metric,grouping)} filename={"marktmorgen-custom-chart-summary-"+summary.metric+"-"+range.from+"-to-"+range.to+".csv"}>Download chart summary</ReportDownload>
 </div>;
}
