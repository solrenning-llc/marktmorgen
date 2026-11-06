import { formatMoney } from "@/lib/money";
import { readAffiliatePromotion } from "@/lib/affiliate-promotion";
import { affiliateCreditGroups, affiliateLineScope, type AffiliateCommissionLine } from "@/lib/affiliate-commission-view";
import type { Credit } from "@/lib/affiliates";
const CREDIT_WORDS: Record<Credit, string> = {
  click: "Their link", code: "Their code", buyer: "A buyer who was already theirs", contact: "A confirmed lead of theirs who bought",
  partner: "Partner share", recurring: "A membership or plan payment",
  bonus: "A monthly goal reached", tier2: "A sale by somebody they brought",
  lead: "A confirmed lead",
};
const money = (cents: number, currency: string) => `${cents < 0 ? "-" : ""}${formatMoney(Math.abs(cents), currency)}`;
const day = (seconds: number) => {
  const date = new Date(seconds * 1000);
  return seconds > 0 && Number.isFinite(date.getTime()) ? date.toLocaleDateString("en-US", {month:"short",day:"numeric",year:"numeric",timeZone:"UTC"}) : "Date unavailable";
};
export function AffiliateCommissionHistory({ lines, total, who, refundsChecked, invoicesChecked }: {
  lines: readonly AffiliateCommissionLine[]; total?: number | null; who: ReadonlyMap<string, {email: string}>;
  refundsChecked: boolean; invoicesChecked: boolean;
}) {
  const scope = affiliateLineScope(lines.length, total);
  const groups = affiliateCreditGroups(lines);
  return <section aria-labelledby="sales-title" className="card p-6 sm:p-8">
    <h2 id="sales-title" className="text-lg font-semibold tracking-[-0.02em] text-ink">Affiliate commission records</h2>
    <p className="mt-2 text-sm text-ink-soft" role="status">{scope.total === null ? (lines.length ? `Showing ${lines.length} loaded commission records. The full recorded count is unavailable.` : "Commission records could not be loaded. The full recorded count is unavailable.") : `Showing ${lines.length} of ${scope.total} loaded commission entries.`}</p>
    {scope.partial ? <p className="mt-2 text-sm text-ink-soft">Only the newest loaded entries are shown. Use Download everything (CSV) for the existing affiliate export.</p> : null}
    <p className="mt-2 text-xs text-ink-soft">The summary covers positive commission records in this displayed list, separately by currency. Bonuses and second-level commissions are records, not additional purchases. Campaign labels do not prove that a promotion caused a sale.</p>
    {!invoicesChecked ? <p className="notice notice-warn mt-3 text-sm" role="status">Some membership and plan payments could not be checked. Entries may be missing; reload to try again.</p> : null}
    {!refundsChecked ? <p className="notice notice-warn mt-3 text-sm" role="status">Refunds and chargebacks could not all be checked. Commission amounts may still include recently refunded or disputed payments; reload to try again.</p> : null}
    {groups.length ? <ul className="mt-3 flex flex-wrap gap-2 text-xs">{groups.map(group => <li key={JSON.stringify([group.how,group.currency])} className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-paper px-3 ring-1 ring-line"><span className="font-semibold text-ink">{CREDIT_WORDS[group.how]}</span><span className="text-ink-soft">{`${group.records} commission ${group.records === 1 ? "record" : "records"} · ${group.commission === null ? "Amount unavailable" : money(group.commission,group.currency)} (${group.currency.toUpperCase()})`}</span></li>)}</ul> : null}
    {!lines.length ? <p className="mt-2 text-sm text-ink-soft">{scope.total === 0 ? "No commission records were loaded." : "No confirmed commission list is loaded. Reload to check the saved records."}</p> : <ul className="mt-4 divide-y divide-line">{lines.map((line,index) => {
      const tags = readAffiliatePromotion(line.promotion);
      return <li key={JSON.stringify([line.ref,line.aff,line.how,index])} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
        <span className="min-w-0">
          <span className="block font-semibold text-ink">{line.title}</span>
          <span className="block text-xs text-ink-soft [overflow-wrap:anywhere]">{line.how === "bonus" ? `${day(line.at)} · ${who.get(line.aff)?.email ?? "A removed affiliate"} · ${CREDIT_WORDS.bonus}` : `${day(line.at)} · ${who.get(line.aff)?.email ?? "A removed affiliate"} · ${money(line.base,line.currency)} before tax · ${line.rate}% · ${CREDIT_WORDS[line.how]}`}{line.refunded ? ` · ${money(line.refunded,line.currency)} refunded` : ""}</span>
          <span className="mt-1 block text-xs text-ink-soft [overflow-wrap:anywhere]">{tags ? `Source: ${tags.source || "Not recorded"} · Campaign: ${tags.campaign || "Not recorded"} · Variant: ${tags.content || "Not recorded"}` : "No campaign labels recorded"}</span>
        </span>
        <span className="text-right"><span className="block font-semibold tabular-nums text-ink">{money(line.commission,line.currency)}</span>{line.status !== "earned" ? <span className="block text-xs font-semibold text-ink-soft">{line.status === "own purchase" ? "Their own purchase" : line.status === "refunded" ? "Refunded" : "Partly refunded"}</span> : null}</span>
      </li>;
    })}</ul>}
  </section>;
}
