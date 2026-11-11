"use client";

import { useId, useState } from "react";
import { campaignView, campaignSort, CAMPAIGN_SORTS, type CampaignSort } from "@/lib/campaign-view";
import type { StatsData } from "@/lib/stats";
import type { AdSpend } from "@/lib/ad-spend-rules";
import { campaignResultsFrom, hasCampaignResults } from "@/lib/campaign-results";
import { campaignResultsReport } from "@/lib/channel-reports";
import { channelName } from "@/lib/channel-names";
import { formatMoney } from "@/lib/money";
import { ReportDownload } from "@/components/report-download";
export function CampaignResultsPanel({ data, range, spends }: { data: StatsData; range: "d7" | "d30" | "d90"; spends: AdSpend[] }) {
  const fieldId=useId();
  const [query,setQuery]=useState("");
  const [sort,setSort]=useState<CampaignSort>("ads");
  const report = campaignResultsFrom(data, range, spends);
  if (!hasCampaignResults(report)) return null;
  const rows=campaignView(report.rows,query,sort);
  const sortLabel=CAMPAIGN_SORTS.find(option=>option.key===sort)?.label ?? "Recorded ads: highest first";
  const money = (amount: number | null) => amount === null ? "—" : formatMoney(amount, data.currency);
  return <section className="mt-6 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" aria-labelledby="numbers-posts">
    <h3 id="numbers-posts" className="text-sm font-bold text-ink">Campaigns, payments and recorded ads</h3>
    <p className="mt-1 text-xs text-ink-soft">{report.from} to {report.to}, UTC. The same campaign tag is combined across channels. Visits are counted for the tag as a whole; payment channels describe paid records, not a split of those visits.</p>
    {!report.salesKnown ? <p className="mt-2 text-sm text-ink-soft" role="status">{report.partial ? "The purchase reading is incomplete. Full campaign amounts and paid-record counts wait for complete figures." : "Complete paid-record figures are not available. Visits and recorded ads can still be read."}</p> : null}
    {report.rows.length ? <div className="mt-3 flex flex-wrap items-end gap-3">
      <label htmlFor={fieldId+"-search"} className="min-w-0 flex-1 text-xs font-semibold text-ink-soft">Search campaign or channel<input id={fieldId+"-search"} type="search" className="field mt-1 w-full" maxLength={100} value={query} onChange={event=>setQuery(event.target.value)} /></label>
      <label htmlFor={fieldId+"-sort"} className="text-xs font-semibold text-ink-soft">Sort campaigns<select id={fieldId+"-sort"} className="field mt-1" value={sort} onChange={event=>setSort(campaignSort(event.target.value))}>{CAMPAIGN_SORTS.map(option=><option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
      {query || sort!=="ads" ? <button type="button" className="btn btn-secondary btn-sm" onClick={()=>{setQuery("");setSort("ads");}}>Reset campaign view</button> : null}
    </div> : null}
    {report.rows.length ? <p className="mt-2 text-xs text-ink-soft" role="status">Showing {rows.length} of {report.rows.length} campaigns. Search matches campaign names and recorded payment or ad channels; unavailable channels are not guessed.</p> : null}
    {report.rows.length > 0 && !rows.length ? <p className="mt-2 text-sm text-ink-soft">No campaigns match this search. Clear the search to see every campaign.</p> : null}
    {rows.length ? <div className="mt-3 max-h-80 overflow-auto" tabIndex={0} role="region" aria-label="Campaign visits, paid records and recorded ad spend">
      <table className="w-full text-left text-sm">
        <thead><tr className="border-b border-line text-xs text-ink-soft">
          <th scope="col" className="py-2 font-semibold">Campaign</th><th scope="col" className="py-2 pl-3 font-semibold">Payment / ad channels</th>
          <th scope="col" className="py-2 pl-3 text-right font-semibold">Visits</th><th scope="col" className="py-2 pl-3 text-right font-semibold">Paid records</th>
          <th scope="col" className="py-2 pl-3 text-right font-semibold">Gross amount</th><th scope="col" className="py-2 pl-3 text-right font-semibold">Recorded ads</th>
          <th scope="col" className="py-2 pl-3 text-right font-semibold">Gross amount less ads</th>
        </tr></thead>
        <tbody>{rows.map(row => <tr key={row.campaign} className="border-b border-line/60">
          <th scope="row" className="py-2 font-medium text-ink">{row.campaign}</th>
          <td className="py-2 pl-3 text-xs text-ink-soft">Payments: {row.paymentChannels === null ? "Channel detail unavailable" : row.paymentChannels.length ? row.paymentChannels.map(channelName).join(", ") : "—"}<span className="block">Ads: {row.adChannels?.length ? row.adChannels.map(channelName).join(", ") : "—"}</span></td>
          <td className="py-2 pl-3 text-right tabular-nums">{row.visits.toLocaleString("en-US")}</td><td className="py-2 pl-3 text-right tabular-nums">{row.paidRecords === null ? "—" : row.paidRecords.toLocaleString("en-US")}</td>
          <td className="py-2 pl-3 text-right tabular-nums">{money(row.gross)}</td><td className="py-2 pl-3 text-right tabular-nums">{money(row.ads)}</td>
          <td className={"py-2 pl-3 text-right font-semibold tabular-nums " + (row.grossLessAds !== null && row.grossLessAds < 0 ? "text-danger" : "text-ink")}>{money(row.grossLessAds)}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
    {report.unassignedAds ? <p className="mt-2 text-sm text-ink-soft">{money(report.unassignedAds)} in recorded ads has no campaign tag and is not assigned to these rows.</p> : null}
    <p className="mt-2 text-xs text-ink-soft">Paid records include purchases and one-click extras, not unique buyers; recurring renewals are excluded. Gross amount less ads is before refunds, fees, tax, commissions and other costs, not profit or proof that advertising caused those payments. A spend-only campaign is included even with no visits or paid records. Match links and recorded spend with the same utm_campaign tag.</p>
    {rows.length ? <ReportDownload csv={campaignResultsReport({...report,rows},data.currency,{query,sort:sortLabel,total:report.rows.length})} filename={"marktmorgen-campaign-view-"+report.from+"-to-"+report.to+".csv"}>Download displayed campaigns</ReportDownload> : null}
    {report.rows.length ? <p className="mt-2 text-xs text-ink-soft">Displayed-campaign downloads use this search and order. The full campaign download below includes every campaign. Untagged ad spend remains a whole-report figure.</p> : null}
    {report.rows.length ? <ReportDownload csv={campaignResultsReport(report, data.currency)} filename={"marktmorgen-campaign-results-" + report.from + "-to-" + report.to + ".csv"}>Download campaign results</ReportDownload> : null}
  </section>;
}
