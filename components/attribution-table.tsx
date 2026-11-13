"use client";

import { attributionSettingsConfirmed } from "@/lib/marketing-settings-response";
import { useState } from "react";
import { attributionReport, type ReportPeriod } from "@/lib/channel-reports";
import { ReportDownload } from "@/components/report-download";
import { toast } from "@/components/toast";
import { ATTRIBUTION_DAYS, type AttributionTable as Table } from "@/lib/attribution-rules";

/**
 * Each channel's money three ways, side by side (lib/attribution-rules.ts):
 * by the last visit before buying, by the first, and by what buyers said.
 * Below it, the sales no link credited, split by what their buyers said; and,
 * for whoever may change settings, how long after a visit a sale is still
 * credited to it.
 */
export function AttributionTable({
  table,
  days: daysGiven,
  canSet,
  span,
  money,
  count,
  period,
}: {
  table: Table;
  days: number;
  canSet: boolean;
  /** "30 days", as the panel says it. */
  span: string;
  money: (cents: number) => string;
  count: (n: number) => string;
  period?: ReportPeriod;
}) {
  const [days, setDays] = useState(daysGiven);
  const [confirmedDays,setConfirmedDays] = useState(daysGiven);
  const [error,setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(next: number) {
    if (busy) return;
    setError("");
    setDays(next);
    setBusy(true);
    try {
      const response = await fetch("/api/store/attribution", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: next }) });
      const body = (await response.json().catch(() => ({}))) as { ok?: unknown; days?: number; error?:unknown };
      if (attributionSettingsConfirmed(response.ok,body,next)) {
        setConfirmedDays(next);
        toast(`Sales are credited to a visit up to ${body.days} days before. This applies to sales from now on.`);
      } else {
        setError("Your selection is still here. The saved attribution window could not be confirmed. Reload to check it before trying again.");
      }
    } catch {
      setError("Your selection is still here. The saved attribution window could not be confirmed. Reload to check it before trying again.");
    } finally {
      setBusy(false);
    }
  }

  const cell = (sales: number, cents: number, unit: [string, string]) =>
    sales > 0 ? (
      <>
        <span className="block font-semibold text-ink">{money(cents)}</span>
        <span className="block text-xs text-ink-soft">{`${count(sales)} ${sales === 1 ? unit[0] : unit[1]}`}</span>
      </>
    ) : (
      <span className="text-ink-mute">—</span>
    );

  const hasAny = table.rows.length > 0 || table.unknown.sales > 0 || (table.unknownFirst?.sales ?? 0) > 0;
  return (
    <div className="mt-6" data-attribution="">
      {hasAny ? (
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-labelledby="numbers-attribution">
          <table className="w-full min-w-[30rem] text-left text-sm">
            <caption id="numbers-attribution" className="text-left text-sm font-bold text-ink">
              {`Where the money came from, three ways, last ${span}`}
            </caption>
            <thead>
              <tr className="border-b border-line text-xs uppercase tracking-wide text-ink-soft">
                <th scope="col" className="py-1 font-semibold">Channel</th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Credited to the last place the buyer came from before buying">
                  Last visit
                </th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold" title="Credited to the first place the buyer came from, in the 90 days before">
                  First visit
                </th>
                <th scope="col" className="py-1 pl-3 text-right font-semibold" title="What buyers answered on the page after paying">
                  Buyers said
                </th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.key} className="border-b border-line/60 align-top">
                  <th scope="row" className="py-1.5 pr-3 font-medium text-ink">
                    {row.name}
                  </th>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{cell(row.last.sales, row.last.cents, ["sale", "sales"])}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{table.unknownFirst ? cell(row.first.sales, row.first.cents, ["sale", "sales"]) : <span className="text-xs text-ink-soft">Unavailable</span>}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{cell(row.said.buyers, row.said.cents, ["buyer", "buyers"])}</td>
                </tr>
              ))}
              {table.unknown.sales > 0 || (table.unknownFirst?.sales ?? 0) > 0 ? (
                <tr className="align-top">
                  <th scope="row" className="py-1.5 pr-3 font-medium text-ink">
                    No channel
                  </th>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{cell(table.unknown.sales, table.unknown.cents, ["sale", "sales"])}</td>
                  <td className="py-1.5 pl-3 text-right tabular-nums">{table.unknownFirst ? cell(table.unknownFirst.sales, table.unknownFirst.cents, ["sale", "sales"]) : <span className="text-xs text-ink-soft">Unavailable</span>}</td>
                  <td className="py-1.5 pl-3 text-right text-ink-mute">—</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <p id="numbers-attribution" className="text-sm font-bold text-ink">{`Where the money came from, three ways, last ${span}`}</p>
      )}
      {!hasAny ? <p className="mt-2 text-sm text-ink-soft">No sales in these days yet.</p> : null}
      {table.unknownSaid.length ? (
        <div className="mt-3 rounded-[12px] bg-paper px-4 py-3 ring-1 ring-line" data-unknown-said="">
          <p className="text-sm font-semibold text-ink">{`Of the sales with no channel, buyers said`}</p>
          <ul className="mt-1 space-y-0.5 text-sm">
            {table.unknownSaid.map((row) => (
              <li key={row.answer} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-ink">{row.name}</span>
                <span className="shrink-0 tabular-nums text-ink-soft">{`${count(row.buyers)} ${row.buyers === 1 ? "buyer" : "buyers"}${row.cents ? ` · ${money(row.cents)}` : ""}`}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-2 text-xs text-ink-soft">
        {`The same sales, from your own Stripe account, read three ways. First, by the last place each buyer came from before buying, within the ${confirmedDays} days before. Second, by the first place, within the 90 days before. Third, by what buyers answered on the page after paying, on the day they answered. Include the no-channel row when summing either visit column. The visit columns are alternative readings of the same purchases and must not be added together. Buyer answers cover only respondents and can fall in different days from their purchases; they must not be added to visit revenue. Where the law asks visitors first, or a browser asks not to be followed, only the tags on the page they bought from count. One-click extras taken after paying are left out.`}
      </p>
      {period && hasAny ? <ReportDownload csv={attributionReport(table, period)} filename={"marktmorgen-attribution-" + period.from + "-to-" + period.to + ".csv"}>Download attribution comparison</ReportDownload> : null}
      {canSet ? <p className="mt-3"><a href="#pixels-title" className="link inline-flex min-h-11 items-center">Review pixel IDs and consent</a></p> : null}
      {canSet ? (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink">
          <span>Credit a sale to a visit up to</span>
          <select
            className="field w-auto min-h-11 py-1.5"
            value={days}
            disabled={busy}
            aria-busy={busy}
            onChange={(e) => void save(Number(e.target.value))}
            aria-describedby="attribution-days-note"
          >
            {ATTRIBUTION_DAYS.map((d) => (
              <option key={d} value={d}>{`${d} days`}</option>
            ))}
          </select>
          <span>before it</span>
          <span id="attribution-days-note" className="w-full text-xs text-ink-soft">
            Shorter credits only the visits that came just before buying; longer gives a channel credit for buyers who took their
            time. It applies to sales from now on; sales already made keep the channel they were given.
          </span>
        </label>
      ) : null}
      {canSet && error ? <div className="mt-3"><p role="alert" className="notice notice-error">{error}</p><button type="button" className="btn btn-secondary mt-3" aria-busy={busy} disabled={busy} onClick={()=>void save(days)}>Retry window change</button></div> : null}
    </div>
  );
}
