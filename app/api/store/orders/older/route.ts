import type { NextRequest } from "next/server";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { askOlder } from "@/lib/purchase-cards";
import type { OlderAnswer } from "@/components/older-purchases";

/** The longest one batch may run: as long as an opening (lib/buyer-orders.ts, ORDERS_OPEN_SECONDS), its reading waited on ORDERS_READ_MS. */
export const maxDuration = 30;

function answer(status: number, body: OlderAnswer): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

/**
 * The next batch of a buyer's older purchases, the ones an opening of the list
 * could not check inside its calls to Stripe, asked for with the button under
 * the list (components/older-purchases.tsx). One way with the page's own
 * batch without JavaScript (lib/purchase-cards.ts, askOlder): the link's own
 * limit and the request's call first; then lib/buyer-orders.ts (olderFor)
 * takes ORDERS_OLDER_UNITS of the store's buyer requests before the grant is
 * read, and every read past them through its meter, with the same ceiling of
 * calls to Stripe as an opening, ORDERS_OLDER_MOST purchases at the most.
 * `older` is where the batch starts (lib/buyer-orders.ts, olderCursor). A
 * store with no room answers "too often" and reads nothing. Each purchase is
 * said exactly as the list says it (lib/purchase-cards.ts).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const handle = normaliseHandle(params.get("handle") ?? "");
  if (!handle) return answer(400, { ok: false, message: "Which store?" });
  const store = await storeForHandle(handle);
  if (!store) return answer(404, { ok: false, message: "We could not find this store." });
  const asked = await askOlder(store, params.get("token") ?? "", params.get("older") ?? "");
  if (!asked.ok) return answer(asked.status, { ok: false, message: asked.message });
  return answer(200, { ok: true, ...asked.value });
}
