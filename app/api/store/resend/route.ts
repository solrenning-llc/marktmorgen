import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { withinLimit } from "@/lib/request-guard";
import { resendPurchase } from "@/lib/purchase-email";

/** How often one sale's email may be sent again in a day, and one store's in an hour. */
const PER_SALE_PER_DAY = 3;
const PER_STORE_PER_HOUR = 30;

const ANSWERS: Record<string, number> = { unknown: 404, call: 400, refunded: 409, failed: 502 };

/**
 * Sends a buyer their purchase email again: `{ reference: "cs_…" }`, one of
 * the sales listed in the studio. For the owner, an Admin and Support
 * (lib/team-roles.ts, "orders"). The sale is read from the store's own Stripe
 * account and has to be this store's; the email goes only to the address the
 * buyer paid with, never to one typed here.
 */
export async function POST(request: NextRequest) {
  // A locked session (lib/two-step.ts) may rewrite the thank-you note, which this email carries: never sent from it.
  const guarded = await guardStoreWrite(request, "orders", 1_000, () => "resend");
  if (!guarded.ok) return guarded.response;
  const { store, body } = guarded;
  const reference = text(body.reference, 220);
  if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(reference)) {
    return Response.json({ ok: false, error: "unknown" }, { status: 400 });
  }
  if (
    !(await withinLimit("resend-sale", reference, PER_SALE_PER_DAY, 24 * 60 * 60)) ||
    !(await withinLimit("resend-store", store.sid || store.handle, PER_STORE_PER_HOUR, 60 * 60))
  ) {
    return Response.json({ ok: false, error: "limited" }, { status: 429 });
  }
  try {
    const outcome = await resendPurchase(store, reference);
    if (outcome === "sent") return Response.json({ ok: true });
    return Response.json({ ok: false, error: outcome }, { status: ANSWERS[outcome] ?? 400 });
  } catch (error) {
    console.error("sending a purchase email again failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 502 });
  }
}
