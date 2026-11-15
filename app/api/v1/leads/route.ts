import { apiAdder, apiError, apiOk, apiStore, holdMoreApi } from "@/lib/api-guard";
import { apiOkFields, badFields } from "@/lib/api-fields";
import { LEAD_FIELDS, chargedLead, chargedLeads, leadAddress } from "@/lib/api-read";
import { WRITE_ERRORS, addLead, roomFor } from "@/lib/api-write";

/**
 * GET /api/v1/leads?cursor=&agreed=true — the creator's list: the same rows as
 * the studio's CSV export. `agreed=true` keeps only those who agreed to hear
 * from the creator and have not unsubscribed — the ones it is fair to email.
 *
 * GET /api/v1/leads?email= — the one contact kept under that address, or none
 * (lib/api-read.ts, chargedLead): a page of at most one row, never a guess.
 * An address that cannot be one is refused before anything is taken or read;
 * a cursor does not go with it.
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  // A ?fields= that cannot be answered is refused before any further request is taken or anything read.
  const bad = badFields(request, LEAD_FIELDS);
  if (bad) return bad;
  const params = new URL(request.url).searchParams;
  const lookup = params.has("email");
  const email = lookup ? leadAddress(params.get("email")) : null;
  if (lookup && !email) return apiError(400, "invalid_email", "This is not an email address. Send the address to look up as email, such as email=dana@example.com.");
  if (lookup && params.has("cursor")) return apiError(400, "invalid_cursor", "A lookup by email is one row with no next page, so it takes no cursor. Leave cursor out.");
  try {
    if (email) {
      const one = await chargedLead(store, email, params.get("agreed") === "true", (most) => holdMoreApi(store, most));
      if (one instanceof Response) return one;
      return apiOkFields(request, one);
    }
    // A page at its most is set aside before the scan, and settled at what it read and sends before it is sent (lib/api-read-rules.ts, listPageMost, scannedPageWork).
    const found = await chargedLeads(store, params.get("cursor"), params.get("agreed") === "true", (most) => holdMoreApi(store, most));
    if (found instanceof Response) return found;
    return apiOkFields(request, found);
  } catch (error) {
    console.error("api: leads failed", error);
    return apiError(502, "unavailable", "The list could not be read just now. Try again in a moment.");
  }
}

/**
 * POST /api/v1/leads — puts somebody who agreed to hear from the creator on
 * the list (lib/api-write.ts): `{ "email", "name", "tags", "agreed": true }`.
 * A key that may write only.
 */
export async function POST(request: Request) {
  // 232 [CA1] unit 4c: waits while the plan's renewal is unpaid or a payment for it is disputed.
  const writer = await apiAdder(request);
  if (writer instanceof Response) return writer;
  const body = writer.body;
  try {
    const done = await roomFor(() => addLead(writer.store, body));
    if (!done.ok) return apiError(WRITE_ERRORS[done.error][0], done.error, done.message ?? WRITE_ERRORS[done.error][1]);
    return apiOk({ data: done.value });
  } catch (error) {
    console.error("api: adding a lead failed", error);
    return apiError(502, "unavailable", "The list could not be changed just now. Nothing was changed; try again in a moment.");
  }
}
