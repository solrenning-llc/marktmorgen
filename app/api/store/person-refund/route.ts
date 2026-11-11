import type { NextRequest } from "next/server";
import { guardStoreWrite } from "@/lib/store-request";
import { giveRefund, refundStatus } from "@/lib/creator-refund";

/**
 * A refund the creator gives from a buyer's record in the studio (649 [WG9]):
 *
 *   { charge, token, full: true }              → all that is left of that payment
 *   { charge, token, amount: "12.50" }         → a typed part of it
 *   reason (optional): requested_by_customer | duplicate | fraudulent
 *
 * `token` is the random token of the form drawn for this refund: the same
 * form sent twice gives back once (lib/creator-refund.ts). Only a role with
 * the payments permission passes guardStoreWrite, and a session let in
 * without its second step may not (lib/two-step.ts, LOCKED_NEEDS).
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "payments", 1_000, () => "refund");
  if (!guarded.ok) return guarded.response;
  try {
    const answer = await giveRefund(guarded.store, { email: guarded.email, role: guarded.role }, guarded.body);
    return Response.json(answer, { status: refundStatus(answer), headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Nothing here says the refund was made: an error before the answer is never "done".
    console.error("a studio refund could not be given", error);
    return Response.json({ ok: false, error: "unknown" }, { status: 502 });
  }
}
