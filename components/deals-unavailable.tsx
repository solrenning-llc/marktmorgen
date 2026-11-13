import { Abbr } from "@/components/abbr";
import type { CrmField } from "@/lib/crm-rules";
import type { DealActionFilter } from "@/lib/crm-deal-filter";

/** A failed opportunity read is not a confirmed empty board. No stored records are changed. */
export function DealsUnavailable({ storeId, buyersHref, fields, followup }: { storeId: string; buyersHref: string; fields: readonly CrmField[]; followup: DealActionFilter }) {
  return (
    <section className="notice notice-warn" role="status" aria-labelledby="deals-unavailable-title">
      <h2 id="deals-unavailable-title" className="font-semibold">Your deals could not be loaded</h2>
      <p className="mt-2 text-sm">The saved <Abbr of="CRM" /> information needed for this page could not be checked. This is not an empty board. Totals, worklist downloads and CRM editing on this page are paused until the saved list can be checked. No saved deal or contact field has been changed.</p>
      {fields.length ? <div className="mt-3"><p className="text-sm font-semibold">Loaded contact fields</p><ul className="mt-2 flex flex-wrap gap-2">{fields.map(field => <li className="tag" key={field.id}>{field.name}</li>)}</ul></div> : null}
      <p className="mt-3 text-sm">Individual contact information and the existing list export remain on <a className="underline underline-offset-4" href={buyersHref}>Buyers</a>. Reload to check the saved CRM list before editing it here.</p>
      <form action="/studio/deals" method="get" className="mt-3">
        <input type="hidden" name="store" value={storeId} />
        <input type="hidden" name="followup" value={followup} />
        <button type="submit" className="btn btn-secondary">Reload deals</button>
      </form>
    </section>
  );
}
