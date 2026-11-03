import type { NextRequest } from "next/server";
import { guardStoreWrite, text } from "@/lib/store-request";
import { normaliseEmail } from "@/lib/auth";
import { listCodes } from "@/lib/discount";
import { applyMemberDiscount, memberSubs } from "@/lib/member-discount";

/**
 * A creator's discount code put on one member's running membership
 * (616 [WP15](8), lib/member-discount.ts), for a role that may change the
 * store's settings, as discount codes are:
 *
 *   { action: "find", email }                          the member's running memberships here, and the active codes
 *   { action: "apply", email, subscription, code }     the code (Stripe's promotion code id) on that membership
 *
 * Everything is read again from the creator's Stripe on "apply"; nothing the
 * page sends is trusted but the choice.
 */
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;
  const { body, store } = guarded;
  const refuse = (error: string, message: string, status = 400) => Response.json({ ok: false, error, message }, { status });
  if (!store.stripeAccountId) return refuse("no_stripe", "Connect your Stripe account first: memberships and codes are kept there.");
  const raw = text(body.email, 320).trim();
  if (!EMAIL.test(raw)) return refuse("email", "Type the address the member pays with.");
  const email = normaliseEmail(raw);
  const action = text(body.action, 10);

  if (action === "find") {
    const [subs, codes] = await Promise.all([memberSubs(store, email), listCodes(store.stripeAccountId)]);
    if (subs === null || codes.state !== "ok") return refuse("stripe", "Your Stripe account could not be read just now. Try again in a minute.", 502);
    return Response.json({
      ok: true,
      memberships: subs,
      codes: codes.codes.filter((c) => c.active).map((c) => ({ id: c.id, code: c.code })),
    });
  }
  if (action === "apply") {
    const done = await applyMemberDiscount(store, email, text(body.subscription, 80), text(body.code, 80));
    if (done.ok) return Response.json({ ok: true });
    const words: Record<typeof done.reason, [string, number]> = {
      not_member: ["That membership is not a running one of this member at your store. Find the member again.", 409],
      discounted: ["A discount already comes off that membership, so nothing was changed. Stripe keeps one at a time here.", 409],
      code: ["That code is not active any more. Find the member again to see your active codes.", 409],
      refused: ["Stripe did not accept that code for this membership, by the code's own rules (for example a first order only, or a minimum). Nothing was changed.", 409],
      stripe: ["Your Stripe account could not be reached just now, so nothing was changed. Try again in a minute.", 502],
    };
    return refuse(done.reason, words[done.reason][0], words[done.reason][1]);
  }
  return refuse("invalid", "That is not something this page can do.");
}
