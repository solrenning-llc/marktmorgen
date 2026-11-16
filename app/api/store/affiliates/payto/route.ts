import { withinService } from "@/lib/metered-limits";
import type { NextRequest } from "next/server";
import { originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { affiliateCookieName, affiliateForSession, setPayAddress } from "@/lib/affiliates";
import { fromAnotherSite, limited } from "@/lib/request-guard";

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
  // The record could not be read or written exactly, or kept changing (lib/affiliates.ts changeAffiliate): nothing
  // was saved, and the page is not told it was.
  const result = await setPayAddress(store, affiliate, paypal).catch((error: unknown) => {
    console.error("saving an affiliate's PayPal address failed", error);
    return null;
  });
  if (!result) {
    return new Response("Your PayPal address could not be saved just now. Nothing was changed. Go back and try again in a moment.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "5" },
    });
  }
  return back(result.ok ? "payto" : "payto-email");
}
