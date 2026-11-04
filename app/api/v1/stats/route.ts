import { apiError, apiOk, apiStore, takeMoreApi } from "@/lib/api-guard";
import { API_NUMBERS_UNITS } from "@/lib/store-allowance-rules";
import { readNumbers, summaryOf } from "@/lib/stats-report";

/**
 * GET /api/v1/stats — the store's numbers for the last 7, 30 and 90 days:
 * visitors, checkouts, sales and revenue, each channel from visit to sale,
 * and page views by country and by device. The same figures the studio
 * shows; money in the smallest unit of the store's currency, and null where
 * paid figures are unavailable or incomplete, with explicit coverage flags.
 * Its sales are read again from Stripe, so it counts as API_NUMBERS_UNITS of
 * the store's API requests, taken before they are read.
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  const refused = await takeMoreApi(store, API_NUMBERS_UNITS - 1);
  if (refused) return refused;
  try {
    const data = await readNumbers(store);
    if (!data) return apiError(503, "unavailable", "Your numbers could not be read just now. Try again in a moment.");
    return apiOk({ data: summaryOf(data, { fullDetails: new URL(request.url).searchParams.get("details") === "all" }) });
  } catch (error) {
    console.error("api: stats failed", error);
    return apiError(502, "unavailable", "Your numbers could not be read just now. Try again in a moment.");
  }
}
