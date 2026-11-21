import type { StatsData } from "@/lib/stats";
import type { AdSpend } from "@/lib/ad-spend-rules";
import { dailyCashflowRows } from "@/lib/daily-cashflow";
import { dailyCashflowReport } from "@/lib/channel-reports";
import { formatMoney } from "@/lib/money";
import { ReportDownload } from "@/components/report-download";
export function DailyCashflowPanel({ data, range, spends }: { data: StatsData; range: "d7" | "d30" | "d90"; spends: AdSpend[] | undefined }) {
  const rows = dailyCashflowRows(data, range, spends);
  if (!rows.length) return null;
  const money = (amount: number | null) => amount === null ? "—" : formatMoney(amount, data.currency);
  const known = rows.every(row => row.afterAds !== null);
  const total = known ? rows.reduce((sum, row) => sum + (row.afterAds ?? 0), 0) : null;
  return <section className="mt-6 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" aria-labelledby="numbers-daily-cashflow">
    <h3 id="numbers-daily-cashflow" className="text-sm font-bold text-ink">Daily result after refunds and ads</h3>
    <p className="mt-1 text-xs text-ink-soft">{rows[0].date} to {rows[rows.length - 1].date}, UTC. Payments include renewals; refunds belong to the day recorded, including pending refunds. The recorded result for these days is {money(total)}, before fees, tax, commissions and other costs; it is not profit.</p>
    {!known ? <p className="mt-2 text-sm text-ink-soft" role="status">Complete payment and refund figures are not available for this daily reading. Results after refunds wait for the complete ledger.</p> : null}
    <div className="mt-3 max-h-80 overflow-auto" tabIndex={0} role="region" aria-label="Daily payments, refunds, recorded ad spend and result">
      <table className="w-full text-left text-sm">
        <thead><tr className="border-b border-line text-xs text-ink-soft">
          <th scope="col" className="py-2 font-semibold">Day (UTC)</th>
          <th scope="col" className="py-2 pl-3 text-right font-semibold">Payments</th>
          <th scope="col" className="py-2 pl-3 text-right font-semibold">Refunds</th>
          <th scope="col" className="py-2 pl-3 text-right font-semibold">Recorded ads</th>
          <th scope="col" className="py-2 pl-3 text-right font-semibold">After refunds and ads</th>
        </tr></thead>
        <tbody>{[...rows].reverse().map((row) => <tr key={row.date} className="border-b border-line/60">
          <th scope="row" className="py-2 font-medium text-ink"><time dateTime={row.date}>{row.date}</time></th>
          <td className="py-2 pl-3 text-right tabular-nums">{money(row.payments)}</td>
          <td className="py-2 pl-3 text-right tabular-nums">{money(row.refunds)}</td>
          <td className="py-2 pl-3 text-right tabular-nums">{money(row.ads)}</td>
          <td className={"py-2 pl-3 text-right font-semibold tabular-nums " + (row.afterAds !== null && row.afterAds < 0 ? "text-danger" : "text-ink")}>{money(row.afterAds)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <p className="mt-2 text-xs text-ink-soft">Most recent day first. A multi-day ad entry is allocated evenly across its recorded days with rounding that preserves every smallest currency unit. This is recorded activity, including organic payments, not proof of advertising lift. A refund may relate to a purchase on an earlier day.</p>
    <ReportDownload csv={dailyCashflowReport(rows, data.currency)} filename={"marktmorgen-daily-cashflow-" + rows[0].date + "-to-" + rows[rows.length - 1].date + ".csv"}>Download daily result</ReportDownload>
  </section>;
}
