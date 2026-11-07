import type { NextRequest } from "next/server";
import { storeForEmail } from "@/lib/store";
import { setDiscountBox } from "@/lib/discount-box";
import { canSell } from "@/lib/store-checkout";
import { createCode, listCodes, stopCode } from "@/lib/discount";
import { readCodeAsked } from "@/lib/discount-input";
import { guardStoreWrite, text } from "@/lib/store-request";

const ACTIONS = new Set(["list", "add", "stop"]);

/** A code live on Stripe while the checkout's code box could not be switched on (lib/discount-box.ts). */
/** The box not confirmed on; after a stop, also that the code asked for is off (stopped), as /api/v1/codes says. */
const boxNotOn = (stopped = false) => Response.json(stopped ? { ok: false, error: "checkout_box", stopped: true } : { ok: false, error: "checkout_box" }, { status: 503 });

/**
 * The creator's discount codes, which live on their own Stripe account.
 *
 * Every answer here is read from Stripe rather than from anything we keep, so
 * the redemption counts are the real ones and a code the creator switched off
 * in their own dashboard shows as off here too. The only thing written on our
 * side is the one bit the buyer's checkout needs: whether to show a box at all.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;

  const { ref, body } = guarded;
  const action = text(body.action, 10);
  if (!ACTIONS.has(action)) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  try {
    const store = await storeForEmail(ref);
    if (!store) {
      return Response.json({ ok: false, error: "none" }, { status: 400 });
    }
    // A code discounts a charge, and a store that cannot charge has nothing to
    // discount. Said here rather than letting Stripe refuse it later.
    if (!store.stripeAccountId || !canSell(store)) {
      return Response.json({ ok: false, error: "not_selling" }, { status: 400 });
    }
    const account = store.stripeAccountId;

    if (action === "add") {
      // Read the same way as the API's (lib/discount-input.ts).
      const read = readCodeAsked(body, store.currency);
      if (!read.ok) {
        return Response.json(
          { ok: false, error: "code", reason: read.reason },
          { status: 400 },
        );
      }
      const { code, off, maxRedemptions, minimum } = read.asked;

      const made = await createCode(account, code, off, maxRedemptions, minimum);
      if (!made.ok) {
        return Response.json(
          { ok: false, error: made.reason },
          { status: made.reason === "taken" ? 409 : 502 },
        );
      }
      // No buyer can enter the code until the checkout's box is on, read back
      // on: not confirmed, it is not said as done (not even as "done, listed
      // false" below), and the studio says why. The code stays as Stripe has it.
      if (!(await setDiscountBox(ref, true))) return boxNotOn();
    } else if (action === "stop") {
      const id = text(body.id, 80);
      if (!id) {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      if (!(await stopCode(account, id))) {
        return Response.json({ ok: false, error: "stripe" }, { status: 502 });
      }
    }

    // Listed last on every path, so the answer the creator gets back is what
    // Stripe says now rather than what we believe we just did.
    const list = await listCodes(account);
    if (list.state !== "ok") {
      // A make or a stop Stripe already did is said as done, so it is not
      // pressed again; only the list after it is unconfirmed, and nothing is
      // written from it. The studio shows its "could not confirm" words.
      if (action !== "list") return Response.json({ ok: true, done: action, listed: false });
      return Response.json({ ok: false, error: "stripe" }, { status: 502 });
    }
    // The box follows the list. A live code with the box not confirmed on is
    // never shown as fine; with no live code, a box left on only shows a field
    // Stripe answers for, so the list is said as Stripe has it.
    const live = list.codes.some((entry) => entry.active);
    if (!(await setDiscountBox(ref, live)) && live) return boxNotOn(action === "stop");

    return Response.json({ ok: true, codes: list.codes });
  } catch (error) {
    console.error("changing a discount code failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
