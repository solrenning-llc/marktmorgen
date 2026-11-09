import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { OrdersBusy, OrdersLate, findPurchase } from "@/lib/buyer-orders";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { readStatement } from "@/lib/withdrawal-rules";
import { withConfirmations, withdraw } from "@/lib/withdrawal";

const MAX_BODY_BYTES = 2_000;

// The longest one request may run: findPurchase is bounded by DOWNLOAD_LOOKUP_MS, then one write, one email and one inbox message.
export const maxDuration = 30;

/**
 * A buyer's online withdrawal statement (Directive 2011/83/EU art. 11a;
 * lib/withdrawal.ts, 588 [KB9]): sent by the "Confirm withdrawal" button of
 * /@store/orders/withdraw.
 *
 * A plain HTML form, so it works with JavaScript turned off. The order must
 * be one the link's address paid for (findPurchase reads it again from
 * Stripe, as a download does); the statement's name and email are checked;
 * the period is read at the moment it is submitted. The answer is always a
 * redirect back to the statement's page with what happened, and never puts
 * the name or the email in the URL.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return new Response("Too large", { status: 413 });

  let handle = "";
  let token = "";
  let reference = "";
  let name = "";
  let email = "";
  try {
    const form = await (await limited(request, MAX_BODY_BYTES)).formData();
    const read = (key: string) => {
      const value = form.get(key);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    token = read("token").slice(0, 200);
    reference = read("ref").slice(0, 200);
    name = read("name").slice(0, 400);
    email = read("email").slice(0, 400);
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
        Location: `${origin}/@${store.handle}/orders/withdraw?${new URLSearchParams({ token, ref: reference, w: state })}`,
        "Cache-Control": "no-store",
      },
    });

  let found: Awaited<ReturnType<typeof findPurchase>>;
  try {
    found = await findPurchase(store, token, reference);
    // Whether its confirmation is known sent, where the yes would end the right (art. 16(m)(iii)), read through the lookup's meter.
    if (found) found = { ...found, purchase: (await withConfirmations([found.purchase], found.meter))[0] };
  } catch (error) {
    if (error instanceof OrdersBusy || error instanceof OrdersLate) return back("busy");
    console.error("reading an order to withdraw from failed", error);
    return back("error");
  }
  if (!found) return back("closed");
  const statement = readStatement({ name, reference, email });
  if (!statement) return back("form");
  try {
    const outcome = await withdraw(store, found.purchase, statement);
    return back(outcome === "full" ? "busy" : outcome);
  } catch (error) {
    console.error("recording a withdrawal failed", error);
    return back("error");
  }
}
