import { apiError, apiStore, takeMoreApi } from "@/lib/api-guard";
import { apiOkFields, fieldsAsked } from "@/lib/api-fields";
import { SALE_FIELDS, cursorOf, sales } from "@/lib/api-sales";
import { canSell } from "@/lib/store-checkout";
import { API_SALES_UNITS } from "@/lib/store-allowance-rules";
import { StripeError } from "@/lib/stripe-account";

const unavailable = () => apiError(502, "unavailable", "Sales could not be read just now. Try again in a moment.");
const badCursor = () => apiError(400, "invalid_cursor", "This cursor is not one this list gave. Send the next value of the page before, once, or leave cursor out to start from the newest sale.");

/** GET /api/v1/sales?cursor=&fields= — the store's paid checkouts, newest first, as the studio's list of sales reads them (lib/api-sales.ts). */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  // As the studio: no sales are read while the store cannot take payments.
  if (!store.stripeAccountId || !canSell(store)) return apiError(409, "not_selling", "This store is not taking payments, so there are no sales to read.");
  // What the request asks is checked before Stripe is read or more of the month is taken.
  const cursor = cursorOf(request.url);
  if (!cursor.ok) return badCursor();
  // A field name that cannot be one is refused with apiOkFields's own 400, and one no sale has with its
  // unknown_field, before the answer is read or the rest of the call is taken from the month.
  const fields = fieldsAsked(request.url);
  if (!fields.ok) return apiOkFields(request, null);
  const unknown = fields.fields?.find((f) => !(SALE_FIELDS as readonly string[]).includes(f));
  if (unknown) return apiError(400, "unknown_field", `No item in this answer has a field named “${unknown}”.`);
  // A page of sales is API_SALES_UNITS of the month's API requests, the request itself one of them.
  const refused = await takeMoreApi(store, API_SALES_UNITS - 1);
  if (refused) return refused;
  try {
    // The listings read for titles are taken before they are read (lib/api-sales.ts).
    const page = await sales(store, cursor.cursor, (more, taken) => takeMoreApi(store, more, taken));
    if (page instanceof Response) return page;
    if (!page) return unavailable();
    return apiOkFields(request, page);
  } catch (error) {
    // A cursor of another account, or of a checkout Stripe no longer has (Stripe says resource_missing, as a 400
    // on starting_after or a 404): the request's own, so trying again never helps.
    if (cursor.cursor && error instanceof StripeError && error.code === "resource_missing" && (error.status === 400 || error.status === 404)) return badCursor();
    // Stripe's limit on the creator's account: said with when to try again.
    if (error instanceof StripeError && error.status === 429) {
      return apiError(503, "unavailable", "Stripe is busy with your account just now. Try again in a few seconds.", { "Retry-After": "10" });
    }
    console.error("api: sales failed", error);
    return unavailable();
  }
}
