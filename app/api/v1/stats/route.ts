import { apiError, apiOk, apiStore, takeMoreApi } from "@/lib/api-guard";
import { chargeNumbers } from "@/lib/api-read";
import { readNumbers, summaryOf } from "@/lib/stats-report";

/**
 * GET /api/v1/stats — the store's numbers for the last 7, 30 and 90 days:
 * visitors, checkouts, sales and revenue, each channel from visit to sale,
 * and page views by country and by device. The same figures the studio
 * shows; money in the smallest unit of the store's currency, and null where
 * paid figures are unavailable or incomplete, with explicit coverage flags.
 * Reading them takes what ninety days of counts and every page of sales cost
 * at their most, before anything is read (lib/api-read-rules.ts, numbersWork).
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  try {
    const refused = await chargeNumbers(store, (more) => takeMoreApi(store, more));
    if (refused) return refused;
    const data = await readNumbers(store);
    if (!data) return apiError(503, "unavailable", "Your numbers could not be read just now. Try again in a moment.");
    return apiOk({ data: summaryOf(data, { fullDetails: new URL(request.url).searchParams.get("details") === "all" }) });
  } catch (error) {
    console.error("api: stats failed", error);
    return apiError(502, "unavailable", "Your numbers could not be read just now. Try again in a moment.");
  }
}
