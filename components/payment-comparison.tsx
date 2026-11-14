import { Abbr } from "@/components/abbr";
import type { StatsData } from "@/lib/stats";
import { paymentComparisonFrom, paymentChange, paymentShareChange } from "@/lib/payment-comparison";
import { paymentShare } from "@/lib/payment-mix";
import { paymentComparisonReport } from "@/lib/channel-reports";
import { channelName } from "@/lib/channel-names";
import { formatMoney } from "@/lib/money";
import { ReportDownload } from "@/components/report-download";
export function PaymentComparisonPanel({data,range}:{data:StatsData;range:"d7"|"d30"|"d90"}){
  const report=paymentComparisonFrom(data,range);
  if(!report)return null;
  const previous=report.previous;
  const money=(value:number)=>formatMoney(value,data.currency);
  return <section className="mt-6 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" aria-labelledby="numbers-payment-comparison">
    <h3 id="numbers-payment-comparison" className="text-sm font-bold text-ink">Payments compared with the previous period</h3>
    {previous && data.cashflowComplete !== true ? <p className="mt-2 text-sm text-ink-soft" role="status">The payment reading is complete. Results after refunds remain unavailable; these figures are before refunds.</p> : null}
    {!previous ? <p className="mt-2 text-sm text-ink-soft" role="status">A complete previous period is not available in this reading. Comparisons need two consecutive periods inside the 90-day ledger; use 7 or 30 days when both periods are available.</p> : <>
      <p className="mt-1 text-xs text-ink-soft">{report.current.from} to {report.current.to} compared with {previous.from} to {previous.to}, UTC. {money(report.current.total)} received now versus {money(previous.total)} before: {money(report.delta ?? 0)} difference · {paymentChange(report.change)}.</p>
      {report.rows.length ? <div className="mt-3 max-h-80 overflow-auto" tabIndex={0} role="region" aria-label="Channel payments compared with the previous period">
        <table className="w-full text-left text-sm"><thead><tr className="border-b border-line text-xs text-ink-soft"><th scope="col" className="py-2 font-semibold">Channel</th><th scope="col" className="py-2 pl-3 text-right font-semibold">Current payments</th><th scope="col" className="py-2 pl-3 text-right font-semibold">Previous payments</th><th scope="col" className="py-2 pl-3 text-right font-semibold">Payment change</th><th scope="col" className="py-2 pl-3 text-right font-semibold">Current / previous share</th><th scope="col" className="py-2 pl-3 text-right font-semibold">Share change</th></tr></thead>
        <tbody>{report.rows.map(row=><tr key={row.source} className="border-b border-line/60"><th scope="row" className="py-2 font-medium text-ink">{channelName(row.source)}</th><td className="py-2 pl-3 text-right tabular-nums">{money(row.current)}</td><td className="py-2 pl-3 text-right tabular-nums">{money(row.previous)}</td><td className="py-2 pl-3 text-right tabular-nums">{paymentChange(row.change)}</td><td className="py-2 pl-3 text-right tabular-nums">{paymentShare(row.currentShare)} / {paymentShare(row.previousShare)}</td><td className="py-2 pl-3 text-right tabular-nums">{paymentShareChange(row.shareChange)}</td></tr>)}</tbody></table>
      </div> : <p className="mt-2 text-sm text-ink-soft">No payments in either period; no percentage change or share can be calculated.</p>}
      {report.rows.length ? <ReportDownload csv={paymentComparisonReport(report,data.currency)} filename={"marktmorgen-payment-comparison-"+report.current.from+"-to-"+report.current.to+".csv"}>Download payment comparison</ReportDownload> : null}
      <p className="mt-2 text-xs text-ink-soft">Same number of <Abbr of="UTC" /> days, including today as recorded so far. Payments include renewals at their recorded subscription channel, before refunds, fees and ads. A channel absent from a complete period has zero payments in that period; a missing previous reading stays unavailable. Percentage changes need previous payments, and share changes need payments in both periods. Share changes are percentage points, not relative growth. These are recorded payments, not new customers, profit or proof of marketing lift.</p>
    </>}
  </section>;
}
