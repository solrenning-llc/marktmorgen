import { readDealExact, readStages } from "@/lib/crm";
import { DEAL_ID } from "@/lib/crm-rules";
import { can, type Role } from "@/lib/team-roles";

/**
 * What a deal's "Request payment" fills the payment requests page in with (components/deals-board.tsx), read here on
 * the server from the deal's opaque id, never from the URL (#4407): an address, a deal's text or an amount in a URL
 * stays in the browser's history and in request logs (as app/api/store/free/route.ts says of an address).
 *
 * Only for a role that may send payment requests ("send": the owner and Admins, who see every pipeline, so no deal is
 * shown to someone a pipeline is hidden from); only a deal that names a person. Anything that cannot be read fills
 * nothing in: the form opens empty, as it does from the studio's own link.
 */
export async function dealRequestPrefill(statsId: string | null, role: Role, id: string): Promise<{ email: string; text: string; cents: number } | null> {
  if (!statsId || !can(role, "send") || !DEAL_ID.test(id)) return null;
  try {
    const { deal } = await readDealExact(statsId, id, await readStages(statsId));
    if (!deal || !deal.email) return null;
    return { email: deal.email, text: deal.title, cents: deal.cents };
  } catch (error) {
    console.error("reading a deal to fill a payment request in failed", error);
    return null;
  }
}
