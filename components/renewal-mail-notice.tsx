import { renewalMailSummary } from "@/lib/renewal-mail-notice";
import { SUPPORT_EMAIL } from "@/lib/creator-research";
import type { ShipmentMailRuntime } from "@/lib/shipment-mail-outbox";
import type { Store } from "@/lib/store";

export async function RenewalMailNotice({store,runtime}: {store:Store;runtime?:ShipmentMailRuntime}) {
  const summary = await renewalMailSummary(store,runtime);
  if (!summary || !("unavailable" in summary) && !summary.unconfirmed && !summary.held) return null;
  return <section aria-labelledby="renewal-mail-notice-title" className="card mt-8 p-6 sm:p-8">
    <h2 id="renewal-mail-notice-title" className="text-lg font-semibold text-ink">Download-link requests need attention</h2>
    <p className="mt-2">{"unavailable" in summary
      ? "The status of pending download-link requests could not be checked."
      : `${summary.unconfirmed} request(s) have unconfirmed email acceptance; ${summary.held} request(s) are retained without another attempt scheduled.`}</p>
    <p className="mt-2">These requests remain retained. Ask support to reconcile provider acceptance and the pending capacity before another email is sent. Do not resend or delete an uncertain request to make room.</p>
    <a href={`mailto:${SUPPORT_EMAIL}?subject=Download-link%20request%20reconciliation`} className="mt-3 inline-block font-semibold underline underline-offset-4">Contact support to reconcile these requests</a>
  </section>;
}
