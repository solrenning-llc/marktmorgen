import type { NextRequest } from "next/server";
import { setTax, storeForEmail } from "@/lib/store";
import { taxStatus } from "@/lib/tax";
import { guardStoreWrite } from "@/lib/store-request";
import { runningSeries } from "@/lib/call-series-open";

/**
 * Switches Stripe Tax on or off for the store's checkouts. On only once
 * Stripe says the creator's tax setup is complete, and never while a series
 * of calls is running ("series", with how many; C2-94): its later sessions
 * are charged without a checkout, so Stripe Tax would not add the tax to
 * them while the rest of the store charges it on top
 * (lib/call-series-billing.ts, seriesBillingProblem). Switching it off, or
 * the tax number box and invoices, stays free.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "settings");
  if (!guarded.ok) return guarded.response;
  const enabled = guarded.body.enabled === true;
  const included = guarded.body.included === true;
  // The tax number box and the invoice stand on their own: a creator not
  // registered anywhere may still have business buyers who need a document to
  // file, and Stripe draws both up without any tax being charged.
  const ids = guarded.body.ids === true;
  const invoices = guarded.body.invoices === true;

  try {
    if (enabled) {
      const store = await storeForEmail(guarded.ref);
      if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
      if (!store.tax.enabled) {
        const running = await runningSeries(store);
        if (running > 0) return Response.json({ ok: false, error: "series", running }, { status: 409 });
      }
      if (!store.stripeAccountId) return Response.json({ ok: false, error: "stripe" }, { status: 400 });
      const status = await taxStatus(store);
      if (status.state !== "active") {
        return Response.json(
          { ok: false, error: status.state === "pending" ? "setup" : "server_error", missing: status.state === "pending" ? status.missing : [] },
          { status: status.state === "pending" ? 400 : 502 },
        );
      }
    }
    const result = await setTax(guarded.ref, { enabled, included, ids, invoices });
    if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
    return Response.json({ ok: true, tax: result.store.tax });
  } catch (error) {
    console.error("saving the tax setting failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
