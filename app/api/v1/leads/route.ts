import { apiAdder, apiError, apiOk, apiStore } from "@/lib/api-guard";
import { apiOkFields } from "@/lib/api-fields";
import { leads } from "@/lib/api-read";
import { WRITE_ERRORS, addLead, roomFor } from "@/lib/api-write";

/**
 * GET /api/v1/leads?cursor=&agreed=true — the creator's list: the same rows as
 * the studio's CSV export. `agreed=true` keeps only those who agreed to hear
 * from the creator and have not unsubscribed — the ones it is fair to email.
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  const params = new URL(request.url).searchParams;
  try {
    return apiOkFields(request, await leads(store, params.get("cursor"), params.get("agreed") === "true"));
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
