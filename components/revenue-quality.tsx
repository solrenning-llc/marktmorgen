import type { StatsData } from "@/lib/stats";
import type { BuyerChannelWindow } from "@/lib/buyer-channel-rules";
import { channelCashflows } from "@/lib/channel-cashflow";
import { channelName } from "@/lib/channel-names";
import { formatMoney } from "@/lib/money";
import { spendBy, type AdSpend } from "@/lib/ad-spend-rules";

import { cashflowReport, buyerChannelReport, type ReportPeriod } from "@/lib/channel-reports";
import { ReportDownload } from "@/components/report-download";

const count = (n: number) => n.toLocaleString("en-US");

/** spends undefined: the ad spend could not be read; every figure that needs it reads "—", never as no spend. */
export function RevenueQuality({ data, range, spends }: { data: StatsData; range: "d7" | "d30" | "d90"; spends: AdSpend[] | undefined }) {
  const days = range === "d7" ? data.days.slice(-7) : range === "d30" ? data.days.slice(-30) : data.days;
  if (data.sales !== "ok" || !days.length) return null;
  const spent = spends === undefined ? null : spendBy(spends, days[0].date, days[days.length - 1].date);
  const rows = channelCashflows(data, range, data.channels?.[range] ?? [], spent?.channels ?? new Map<string, number>(), days[0].date, days[days.length - 1].date)
    .map((r) => (spent ? { ...r, adSpend: r.adSpend as number | null } : { ...r, adSpend: null, afterAds: null, backPerOne: null }))
    .filter((r) => r.receipts === null || r.refunds === null || r.receipts || r.refunds || r.adSpend);
  if (!rows.length) return null;
  const money = (amount: number | null) => amount === null ? "—" : formatMoney(amount, data.currency);
  const received = rows.every(r => r.receipts !== null) ? rows.reduce((sum, r) => sum + (r.receipts ?? 0), 0) : null;
  const returned = rows.every(r => r.refunds !== null) ? rows.reduce((sum, r) => sum + (r.refunds ?? 0), 0) : null;
  const left = returned === null || received === null || spent === null ? null : received - returned - spent.total;
  const tiles = [
    { name: "Payments received", value: money(received) },
    { name: "Refunds recorded", value: money(returned) },
    { name: "Ad spend recorded", value: money(spent?.total ?? null) },
    { name: "After refunds and ads", value: money(left) },
  ];
  return (
    <section className="mt-6 rounded-[12px] bg-paper px-4 py-4 ring-1 ring-line" aria-labelledby="numbers-cashflow">
      <h3 id="numbers-cashflow" className="text-sm font-bold text-ink">What remains after refunds and ads</h3>
      <p className="mt-1 text-xs text-ink-soft">Payments received in these days, including renewals and later installments. This is before payment fees, tax, affiliate commissions and your other costs; it is not profit.</p>
      {spent === null ? <p className="mt-2 text-sm text-ink-soft" role="status">Ad spend could not be read just now, so the ad spend and the result after ads show &ldquo;&mdash;&rdquo;. Payments and refunds are as read.</p> : null}
      {left === null && spent !== null ? <p className="mt-2 text-sm text-ink-soft" role="status">Some payments or refunds could not be read in full, or a refund could not be matched to this store. The result after refunds waits for complete figures; payment totals also wait when their reading is incomplete. Recorded ad spend remains available.</p> : null}
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => <div key={t.name}><dt className="text-xs text-ink-soft">{t.name}</dt><dd className="mt-1 text-lg font-bold tabular-nums text-ink">{t.value}</dd></div>)}
      </dl>
      <div className="mt-4 overflow-x-auto" tabIndex={0} role="region" aria-label="Payments, refunds and ad spend by channel">
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b border-line text-xs text-ink-soft">
            <th scope="col" className="py-2 font-semibold">Channel</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">Payments</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">Refunds</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">Ads</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">After refunds and ads</th>
          </tr></thead>
          <tbody>{rows.map((r) => <tr key={r.source} className="border-b border-line/60">
            <th scope="row" className="py-2 font-medium text-ink">{channelName(r.source)}</th>
            <td className="py-2 pl-3 text-right tabular-nums">{money(r.receipts)}</td>
            <td className="py-2 pl-3 text-right tabular-nums">{money(r.refunds)}</td>
            <td className="py-2 pl-3 text-right tabular-nums">{money(r.adSpend)}</td>
            <td className={`py-2 pl-3 text-right font-semibold tabular-nums ${r.afterAds !== null && r.afterAds < 0 ? "text-danger" : "text-ink"}`}>{money(r.afterAds)}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <ReportDownload csv={cashflowReport(rows, { from: days[0].date, to: days[days.length - 1].date, currency: data.currency })} filename={`marktmorgen-channel-cashflow-${days[0].date}-to-${days[days.length - 1].date}.csv`}>Download channel results</ReportDownload>
      <p className="mt-2 text-xs text-ink-soft">Refunds belong to the days they were recorded, even when the purchase was earlier; pending refunds are included. A channel&apos;s organic sales count too. This does not prove that advertising caused those sales or that increasing its budget would help.</p>
    </section>
  );
}

export function BuyerChannelsPanel({ window, currency, historyPartial, period }: { window: BuyerChannelWindow; currency: string; historyPartial: boolean; period: Omit<ReportPeriod, "currency"> }) {
  if (!window.rows.length && !window.unidentifiedOrders) return null;
  const share = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : "—";
  return (
    <section className="mt-6" aria-labelledby="numbers-buyer-channels">
      <h3 id="numbers-buyer-channels" className="text-sm font-bold text-ink">Which channels bring buyers who buy again</h3>
      <p className="mt-1 text-xs text-ink-soft">Buyers whose first observed purchase was in the selected days, grouped by its first recorded channel. Money includes their later purchases and one-click extras; recurring renewals are not repeat purchases.</p>
      {historyPartial ? <p className="mt-2 text-sm text-ink-soft" role="status">The purchase history was not read in full. These are the buyers observed; older purchases may be missing.</p> : null}
      {window.rows.length ? <div className="mt-3 overflow-x-auto" tabIndex={0} role="region" aria-label="Buyer repurchase by first recorded channel">
        <table className="w-full text-left text-sm">
          <thead><tr className="border-b border-line text-xs text-ink-soft">
            <th scope="col" className="py-2 font-semibold">First recorded channel</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">Buyers</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">Bought again</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">Revenue per buyer</th>
            <th scope="col" className="py-2 pl-3 text-right font-semibold">Bought again within 30 days</th>
          </tr></thead>
          <tbody>{window.rows.map((r) => <tr key={r.source} className="border-b border-line/60">
            <th scope="row" className="py-2 font-medium text-ink">{channelName(r.source)}</th>
            <td className="py-2 pl-3 text-right tabular-nums">{count(r.buyers)}</td>
            <td className="py-2 pl-3 text-right tabular-nums">{count(r.repeatBuyers)} · {share(r.repeatBuyers, r.buyers)}</td>
            <td className="py-2 pl-3 text-right tabular-nums">{r.buyers ? formatMoney(Math.round(r.cents / r.buyers), currency) : "—"}</td>
            <td className="py-2 pl-3 text-right tabular-nums">{share(r.repeated30, r.eligible30)}{r.eligible30 ? <span className="block text-xs text-ink-soft">{count(r.repeated30)} of {count(r.eligible30)} observed for 30 days</span> : <span className="block text-xs text-ink-soft">Not enough time observed</span>}</td>
          </tr>)}</tbody>
        </table>
      </div> : null}
      <ReportDownload csv={buyerChannelReport(window, historyPartial, { ...period, currency })} filename={`marktmorgen-buyer-channels-${period.from}-to-${period.to}.csv`}>Download buyer channels</ReportDownload>
      <p className="mt-2 text-xs text-ink-soft">The history covers up to 180 days, so a first observed purchase may not be somebody&apos;s first ever. Only buyers with a full 30 days of observation enter the 30-day rate. Revenue is before refunds and fees, not predicted lifetime value. No buyer&apos;s identity is included in this table.</p>
      {window.unidentifiedOrders > 0 ? <p className="mt-1 text-xs text-ink-soft">{count(window.unidentifiedOrders)} {window.unidentifiedOrders === 1 ? "order could" : "orders could"} not be linked to a buyer and {window.unidentifiedOrders === 1 ? "is" : "are"} left out.</p> : null}
    </section>
  );
}
