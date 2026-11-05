import { formatMoney } from "@/lib/money";
import { validCrmDate, type Deal, type Stage } from "@/lib/crm-rules";
import { dealWorklistRows } from "@/lib/crm-deal-worklist";

/**
 * Already authorized, selected and ordered records; editing uses the board's existing editor. Without onEdit (a pipeline this person may only see, 639 [GL7](7)) there is no Edit column.
 * While the board is busy, each Edit stays focusable (aria-disabled, its press ignored) and points to `whyId`, the board's words saying why (2.4.3, AX274).
 */
export function DealAgenda({ deals, stages, currency, today, disabled, whyId, onEdit }: { deals: readonly Deal[]; stages: readonly Stage[]; currency: string; today: string; disabled: boolean; /** The id of the words saying why Edit cannot be used now. */ whyId?: string; onEdit?: (deal: Deal) => void }) {
  const rows = dealWorklistRows(deals, stages, "agenda");
  if (!rows.length) return <p className="mt-6 rounded-xl bg-paper p-4 text-sm text-ink-soft">No loaded deals match this selection.</p>;
  return (
    <div className="mt-6 overflow-x-auto">
      <table className="w-full min-w-[54rem] text-left text-sm">
        <caption className="sr-only">Selected deals ordered across all stages</caption>
        <thead><tr className="text-ink-soft">{["Action date (UTC)", "Next action", "Deal and contact", "Stage", "Responsible", "Recorded value", ...(onEdit ? ["Edit"] : [])].map(label => <th key={label} scope="col" className="py-3 pr-4 font-semibold">{label}</th>)}</tr></thead>
        <tbody>{rows.map(({ deal, stage }) => {
          const overdue = stage.kind === "open" && !!deal.nextAction && validCrmDate(deal.dueDate) && deal.dueDate < today;
          return <tr key={deal.id} className="border-t border-line align-top">
            <td className="py-3 pr-4 whitespace-nowrap">{validCrmDate(deal.dueDate) ? deal.dueDate : "Not dated"}{overdue ? <span className="mt-1 block text-xs font-semibold text-danger">Overdue</span> : null}</td>
            <td className="max-w-[18rem] py-3 pr-4 break-words">{deal.nextAction || "No next action"}</td>
            <td className="max-w-[20rem] py-3 pr-4 break-words"><p className="font-semibold">{deal.title}</p>{deal.email ? <p className="mt-1 text-ink-soft">{deal.email}</p> : null}{deal.note ? <details className="mt-2"><summary className="cursor-pointer text-ink-soft">Note</summary><p className="mt-1 whitespace-pre-line">{deal.note}</p></details> : null}</td>
            <td className="py-3 pr-4">{stage.name}<span className="mt-1 block text-xs capitalize text-ink-soft">{stage.kind}</span></td>
            <td className="max-w-[16rem] py-3 pr-4 break-words">{deal.assignee || "Unassigned"}</td>
            <td className="py-3 pr-4 whitespace-nowrap tabular-nums">{deal.cents ? formatMoney(deal.cents, currency) : "No amount yet"}</td>
            {onEdit ? <td className="py-3"><button type="button" id={`deal-agenda-edit-${deal.id}`} className="btn btn-secondary btn-sm" aria-disabled={disabled || undefined} aria-describedby={disabled ? whyId : undefined} onClick={() => { if (!disabled) onEdit(deal); }} aria-label={`Edit ${deal.title}`}>Edit</button></td> : null}
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}
