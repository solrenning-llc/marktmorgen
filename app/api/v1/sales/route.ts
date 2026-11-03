import { apiError, apiOk, apiStore } from "@/lib/api-guard";
import { sales } from "@/lib/api-sales";
import { canSell } from "@/lib/store-checkout";

/** GET /api/v1/sales?cursor= — the store's paid checkouts, newest first, as the studio's list of sales reads them (lib/api-sales.ts). */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  // As the studio: no sales are read while the store cannot take payments.
  if (!store.stripeAccountId || !canSell(store)) return apiError(409, "not_selling", "This store is not taking payments, so there are no sales to read.");
  try {
    const page = await sales(store, new URL(request.url).searchParams.get("cursor"));
    if (!page) return apiError(502, "unavailable", "Sales could not be read just now. Try again in a moment.");
    return apiOk(page);
  } catch (error) {
    console.error("api: sales failed", error);
    return apiError(502, "unavailable", "Sales could not be read just now. Try again in a moment.");
  }
}
