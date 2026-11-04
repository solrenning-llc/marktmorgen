import { apiError, apiStore } from "@/lib/api-guard";
import { apiOkFields, fieldsAsked } from "@/lib/api-fields";
import { cursorOf, sales } from "@/lib/api-sales";
import { canSell } from "@/lib/store-checkout";
import { takeAllowance } from "@/lib/store-allowance";
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
  // A field name that cannot be one is refused with apiOkFields's own 400, before the answer is read.
  if (!fieldsAsked(request.url).ok) return apiOkFields(request, null);
  // A page of sales is API_SALES_UNITS of the month's API requests, the request itself one of them.
  const taken = await takeAllowance(store, "api", API_SALES_UNITS - 1);
  if (!taken.ok) return apiError(429, taken.reason === "used" ? "monthly_limit" : taken.reason === "pool" ? "no_place" : "unavailable", taken.message);
  try {
    const page = await sales(store, cursor.cursor);
    if (!page) return unavailable();
    return apiOkFields(request, page);
  } catch (error) {
    // A cursor of another account, or of a checkout Stripe no longer has: the request's own, so trying again never helps.
    if (cursor.cursor && error instanceof StripeError && error.status === 404) return badCursor();
    // Stripe's limit on the creator's account: said with when to try again.
    if (error instanceof StripeError && error.status === 429) {
      return apiError(503, "unavailable", "Stripe is busy with your account just now. Try again in a few seconds.", { "Retry-After": "10" });
    }
    console.error("api: sales failed", error);
    return unavailable();
  }
}
