import { type NextRequest, after } from "next/server";
import { StoreFullError, chargesBelow, pricedProducts, setCurrency } from "@/lib/store";
import { readProducts } from "@/lib/catalog";
import { currencyRule, isCurrency } from "@/lib/money";
import { chargeableCurrencies, runningSubscriptions } from "@/lib/payment-methods";
import { noticeCreator } from "@/lib/account-notice";
import { runningSeries, seriesUnknownResponse } from "@/lib/call-series-open";
import { UnknownReplyError } from "@/lib/redis-reply";
import { guardStoreWrite, text } from "@/lib/store-request";

/**
 * Changes what the store charges in. `{ currency: "eur", confirm?: true }`.
 *
 * Refused, with the reason, when:
 *   - the creator's Stripe account cannot charge in it ("unsupported"), or
 *     Stripe could not be asked which currencies it charges in
 *     ("unavailable", 503): not known is never "any", nothing changed;
 *   - the store has prices and the move is between the yen and a currency
 *     with cents ("decimals"): 49.99 has no meaning in yen, and nothing is
 *     rounded behind the creator's back (lib/store.ts, setCurrency);
 *   - any price, option, offer, plan payment or pay-what-you-want floor would
 *     be below the new currency's smallest charge ("minimum", with the list
 *     of them, the first 50, and how many in all), to be fixed first;
 *   - a membership or payment plan of the store is still running on Stripe
 *     ("memberships"): each keeps charging in the currency it began in, and
 *     the store's pages would then state its price in the wrong one. That is
 *     the safe choice over letting the two disagree; it is lifted when the
 *     last one ends or is cancelled. Stripe not answering counts as running;
 *   - a series of calls is still running ("series", with how many): each is
 *     charged in the currency it was booked in until its last session
 *     (lib/call-series-open.ts), so the change waits until the last one is
 *     over or canceled; a count Redis answered in an unknown shape is not
 *     "none": the change is refused ("unavailable", 503), nothing changed;
 *   - the store has prices and the creator has not yet agreed that every
 *     saved amount keeps its number ("confirm", with how many products).
 */
export async function POST(request: NextRequest) {
  // The store's currency is a setting: its owner and Admins (lib/team-roles.ts).
  const guarded = await guardStoreWrite(request, "settings", 1_000);
  if (!guarded.ok) return guarded.response;
  const wanted = text(guarded.body.currency, 3).toLowerCase();
  if (!isCurrency(wanted)) return Response.json({ ok: false, error: "currency" }, { status: 400 });

  try {
    const store = guarded.store;
    if (store.currency === wanted) return Response.json({ ok: true, currency: wanted });

    if (store.stripeAccountId) {
      // Null is "Stripe could not be asked", never "any currency": the store
      // is not moved to one its account may not charge in (sweep app1, 7).
      const allowed = await chargeableCurrencies(store);
      if (allowed === null) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
      if (!allowed.includes(wanted)) {
        return Response.json({ ok: false, error: "unsupported" }, { status: 400 });
      }
    }

    const priced = pricedProducts(store);
    if (priced > 0 && currencyRule(store.currency).decimals !== currencyRule(wanted).decimals) {
      return Response.json({ ok: false, error: "decimals", priced }, { status: 409 });
    }

    // Read before asking Stripe anything, and again under the lock (setCurrency).
    const short = priced > 0 ? chargesBelow(await readProducts(store), wanted) : [];
    if (short.length) {
      return Response.json({ ok: false, error: "minimum", items: short.slice(0, 50), count: short.length }, { status: 409 });
    }

    if (store.stripeAccountId) {
      const running = await runningSubscriptions(store);
      if (running === null) return Response.json({ ok: false, error: "stripe" }, { status: 502 });
      if (running > 0) return Response.json({ ok: false, error: "memberships", running }, { status: 409 });
    }

    const series = await runningSeries(store).catch((error: unknown) => {
      if (error instanceof UnknownReplyError) return null;
      throw error;
    });
    if (series === null) return seriesUnknownResponse();
    if (series > 0) return Response.json({ ok: false, error: "series", running: series }, { status: 409 });

    if (priced > 0 && guarded.body.confirm !== true) {
      return Response.json({ ok: false, error: "confirm", priced }, { status: 409 });
    }

    const result = await setCurrency(guarded.ref, wanted);
    if (!result.ok) {
      if (result.reason === "minimum") {
        return Response.json({ ok: false, error: "minimum", items: result.items.slice(0, 50), count: result.items.length }, { status: 409 });
      }
      return Response.json({ ok: false, error: result.reason, priced }, { status: result.reason === "decimals" ? 409 : 400 });
    }
    const from = store.currency;
    after(() => noticeCreator(result.store, { kind: "currency-changed", from, to: wanted }));
    return Response.json({ ok: true, currency: wanted });
  } catch (error) {
    if (error instanceof StoreFullError) return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    console.error("changing the store currency failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
