import { after, type NextRequest } from "next/server";
import { withinStore } from "@/lib/metered-limits";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited, unknownLimit } from "@/lib/request-guard";
import { noteCheckoutTrouble } from "@/lib/checkout-trouble";
import { openRequestCheckout } from "@/lib/payment-requests";
import { ID_PATTERN } from "@/lib/payment-request-rules";

/**
 * "Pay" on a payment request's page (app/[handle]/pay/[request]): a plain
 * form, so it works without JavaScript. The answer is Stripe's page on the
 * creator's own account, or the request's page saying what was wrong, with
 * nothing charged.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let id = "";
  try {
    const form = await (await limited(request, 1_000)).formData();
    const read = (name: string, max: number) => {
      const value = form.get(name);
      return typeof value === "string" ? value.slice(0, max) : "";
    };
    handle = normaliseHandle(read("handle", 100));
    id = read("request", 40);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!ID_PATTERN.test(id)) return new Response("Bad request", { status: 400 });
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  const back = (problem: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}/pay/${id}${problem ? `?notice=${problem}` : ""}`, "Cache-Control": "no-store" } });

  // Twenty a connection in ten minutes per store: far past any buyer, short of a script trying cards.
  const room = await withinStore("pay-request", `${clientAddress(request)}|${store.handle}`, 20, 600, store, "buyer").catch(unknownLimit);
  if (room === "unknown") return back("error");
  if (!room) return back("limited");
  const opened = await openRequestCheckout(store, id, linkOrigin(request, store));
  if (opened.ok) return new Response(null, { status: 303, headers: { Location: opened.url, "Cache-Control": "no-store" } });
  if (opened.reason === "error") {
    console.error("opening a payment request's checkout failed", opened.error);
    // Stripe refusing on purpose is the creator's to put right, and they are told (lib/checkout-trouble.ts).
    if (opened.error) after(() => noteCheckoutTrouble(store, opened.error).then(() => undefined, () => undefined));
  }
  return back(opened.reason === "gone" ? "" : opened.reason);
}
