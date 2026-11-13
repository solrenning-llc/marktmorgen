import { withinService } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { affiliateCookieName, affiliateForSession, setPayAddress } from "@/lib/affiliates";
import { fromAnotherSite, limited } from "@/lib/request-guard";
import { UnknownReplyError } from "@/lib/redis-reply";

/**
 * A signed-in affiliate choosing the PayPal address they are paid at, from
 * their own page (lib/affiliates.ts setPayAddress). Empty goes back to the
 * address they joined with. The address they joined with is told of every
 * change.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let paypal = "";
  try {
    const form = await (await limited(request, 4_000)).formData();
    const read = (name: string) => {
      const value = form.get(name);
      return typeof value === "string" ? value : "";
    };
    handle = normaliseHandle(read("handle"));
    paypal = read("paypal").slice(0, 300);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  const back = (status: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/affiliates?status=${status}#payto`, "Cache-Control": "no-store" } });
  const affiliate = await affiliateForSession(store, request.cookies.get(affiliateCookieName(store.handle))?.value);
  if (!affiliate) return back("signedout");
  if (!(await withinService("aff-payto", `${store.handle}|${affiliate.id}`, 5, 3600, store))) return back("payto-slow");
  // The record kept changing, or its lock was held (LockBusyError, lib/affiliates.ts changeAffiliate): nothing was
  // saved, and the page is not told it was. A reply that could not be read (UnknownReplyError): the address may or
  // may not have been saved, so the answer never says "nothing was changed" (review of #1924). Never a 500 either way.
  const result = await setPayAddress(store, affiliate, paypal).catch((error: unknown) => {
    console.error("saving an affiliate's PayPal address failed", error);
    return error instanceof UnknownReplyError ? ("unsure" as const) : null;
  });
  const plain = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "5" };
  if (result === "unsure") {
    return new Response("We could not confirm whether your PayPal address was saved. Go back and reload your page: it shows the address you are paid at now.", { status: 503, headers: plain });
  }
  if (!result) {
    return new Response("Your PayPal address could not be saved just now. Nothing was changed. Go back and try again in a moment.", { status: 503, headers: plain });
  }
  return back(result.ok ? "payto" : "payto-email");
}
