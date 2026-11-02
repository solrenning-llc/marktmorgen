import { serviceRefusedJson, withinServiceWhy } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { clientAddress } from "@/lib/request-guard";
import { affiliatesOn } from "@/lib/affiliates";
import { connectPayPal, disconnectPayPal, payWithPayPal, readPayPal, setAutoPay, settlePayPal } from "@/lib/paypal-payouts";

/**
 * The creator's own PayPal, for paying affiliates (lib/paypal-payouts.ts):
 *
 *   { op: "connect", client, secret }   check the app with PayPal and keep it, the Secret sealed
 *   { op: "disconnect" }                forget it
 *   { op: "auto", on }                  pay by itself on payday, or not
 *   { op: "pay" }                       send everyone owed and cleared, now, from their PayPal
 *   { op: "settle" }                    ask PayPal what has been paid since
 *
 * For the owner and Admins ("settings"): it moves the creator's own money.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings", 4_000);
  if (!guarded.ok) return guarded.response;
  const body = guarded.body;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  const store = await storeForEmail(guarded.ref);
  if (!store || !store.statsId) return fail("none");
  const op = text(body.op, 20);
  try {
    if (op === "connect") {
      const refused = await withinServiceWhy("paypal-connect", `${clientAddress(request)}|${store.handle}`, 10, 3600, store);
      if (refused) return serviceRefusedJson(refused, "slow");
      const result = await connectPayPal(store, text(body.client, 200).trim(), text(body.secret, 200).trim());
      return result.ok ? Response.json({ ok: true, paypal: await readPayPal(store) }) : fail(result.reason);
    }
    if (op === "disconnect") {
      await disconnectPayPal(store);
      return Response.json({ ok: true, paypal: null });
    }
    if (op === "auto") {
      if (!(await setAutoPay(store, body.on === true))) return fail("not-connected");
      return Response.json({ ok: true, paypal: await readPayPal(store) });
    }
    if (op === "pay") {
      if (!affiliatesOn(store)) return fail("off");
      const refused = await withinServiceWhy("paypal-pay", store.handle, 6, 3600, store);
      if (refused) return serviceRefusedJson(refused, "slow");
      const result = await payWithPayPal(store);
      return result.ok ? Response.json(result) : fail(result.reason, result.reason === "error" ? 502 : 409);
    }
    if (op === "settle") {
      return Response.json({ ok: true, ...(await settlePayPal(store)) });
    }
    return fail("op");
  } catch (error) {
    console.error("the PayPal payouts route failed", error);
    return fail("error", 500);
  }
}
