import { apiError, apiOk, apiStore, holdMoreApi, takeMoreApi } from "@/lib/api-guard";
import { apiNumbers } from "@/lib/api-numbers";
import { summaryOf } from "@/lib/stats-report";

/**
 * GET /api/v1/stats — the store's numbers for the last 7, 30 and 90 days:
 * visitors, checkouts, sales and revenue, each channel from visit to sale,
 * and page views by country and by device. The same figures the studio
 * shows; money in the smallest unit of the store's currency, and null where
 * paid figures are unavailable or incomplete, with explicit coverage flags.
 * `asOf` says when they were read: a copy is kept an hour (lib/api-numbers.ts).
 * Read anew, they take what ninety days of counts and every page of sales
 * cost at their most, before anything is read (lib/api-read-rules.ts,
 * numbersWork); from the copy, only what reading it and the answer take.
 */
export async function GET(request: Request) {
  const store = await apiStore(request);
  if (store instanceof Response) return store;
  try {
    const read = await apiNumbers(store, "plain", (more, taken) => takeMoreApi(store, more, taken), (most) => holdMoreApi(store, most));
    if (read instanceof Response) return read;
    if (!read) return apiError(503, "unavailable", "Your numbers could not be read just now. Try again in a moment.");
    const body = { data: summaryOf(read.data, { fullDetails: new URL(request.url).searchParams.get("details") === "all" }), asOf: read.asOf };
    // What the answer sends is settled before it is sent.
    const refused = await read.settle(Buffer.byteLength(JSON.stringify(body)));
    return refused ?? apiOk(body);
  } catch (error) {
    console.error("api: stats failed", error);
    return apiError(502, "unavailable", "Your numbers could not be read just now. Try again in a moment.");
  }
}
