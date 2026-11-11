import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { OrdersBusy, OrdersLate, findPurchase } from "@/lib/buyer-orders";
import { fromAnotherSite, limited, withinLimit } from "@/lib/request-guard";
import { readOrderProblem } from "@/lib/order-problem-rules";
import { reportOrderProblem } from "@/lib/order-problem";

// A note of 1,000 characters, each up to 12 bytes once form-encoded (a 4-byte character as %XX%XX%XX%XX), and the
// other fields: a full note in any language fits, so it is never refused as too large before it is read.
const MAX_BODY_BYTES = 13_000;
/** Reports one address may send to one store in a day, whatever the orders. */
export const ORDER_PROBLEM_PER_DAY = 5;

// findPurchase is bounded by DOWNLOAD_LOOKUP_MS, then one mark, one inbox message and one email to the creator.
export const maxDuration = 30;

/**
 * "Report a problem with this order" (567 [GD1] (a), unit 2), sent from the
 * buyer's page for it (/@store/orders/problem, the next unit). A plain HTML
 * form, so it works with JavaScript turned off. The order must be one the
 * link's address paid for (findPurchase reads it again, as a download
 * does). The answer is always a redirect back to that page with what
 * happened (`problem=`), and never puts the buyer's words or address in
 * the URL.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

  let handle = "";
  let token = "";
  let reference = "";
  let reason = "";
  let note = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    token = read("token").slice(0, 200);
    reference = read("ref").slice(0, 300);
    reason = read("reason").slice(0, 40);
    // Not cut here: a note over the most is refused by the rules, never shortened.
    note = read("note");
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!handle) return new Response("Bad request", { status: 400 });
  const store = await storeForHandle(handle);
  if (!store) return new Response("No such store.", { status: 404 });

  const back = (state: string) =>
    new Response(null, {
      status: 303,
      headers: {
        Location: `${origin}/@${store.handle}/orders/problem?${new URLSearchParams({ token, ref: reference, problem: state })}`,
        "Cache-Control": "no-store",
      },
    });

  const problem = readOrderProblem({ reason, note, order: reference });
  if (!problem.ok) return back(problem.field);

  let found: Awaited<ReturnType<typeof findPurchase>>;
  try {
    found = await findPurchase(store, token, reference);
  } catch (error) {
    if (error instanceof OrdersBusy || error instanceof OrdersLate) return back("busy");
    console.error("reading an order to report a problem with failed", error);
    return back("error");
  }
  if (!found) return back("order");
  if (!(await withinLimit("order-problem", `${store.statsId}:${found.email}`, ORDER_PROBLEM_PER_DAY, 86_400))) return back("limited");
  try {
    return back(await reportOrderProblem(store, found.purchase, found.email, problem.problem));
  } catch (error) {
    console.error("reporting a problem with an order failed", error);
    return back("error");
  }
}
