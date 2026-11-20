import { after, type NextRequest } from "next/server";
import { withinStore } from "@/lib/metered-limits";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { noteCheckoutTrouble } from "@/lib/checkout-trouble";
import { chargesOffAfterRefusal } from "@/lib/stripe-charges";
import { openRequestCheckout } from "@/lib/payment-requests";
import { ID_PATTERN } from "@/lib/payment-request-rules";
import { consumerGate } from "@/lib/eu-vat-gate";
import type { EuSupplyFields } from "@/lib/eu-vat-supply";

/**
 * What a payment request bills, for the EU VAT gate: free text the creator typed, so its kind never reads (a paid
 * supply of unknown kind, lib/eu-vat-supply.ts euSupplyOf). Never a live service and never free, so the gate always
 * asks where the buyer is.
 */
const REQUEST_SUPPLY: EuSupplyFields = { priceCents: 1, file: null, link: null, keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null };

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
  // The form as sent, for the billing country the EU VAT gate reads (lib/eu-vat-gate.ts consumerGate).
  let sent = new FormData();
  try {
    const form = await (await limited(request, 1_000)).formData();
    sent = form;
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
  // EU VAT art. 9a (owner's decision IV, 789 [IV1] unit 1): before anything is held or sent to Stripe, a buyer in the
  // EU or the UK is refused and a buyer without a billing country is asked for one, as the card checkout and the cart
  // do. Kept until the tax is collected on top of the price at checkout (AGENTS.md, section IV).
  const gate = consumerGate({ product: REQUEST_SUPPLY, headers: request.headers, form: sent });
  if (!gate.ok) return back(gate.reason === "refused" ? "abroad" : "country");

  // Twenty a connection in ten minutes per store: far past any buyer, short of a script trying cards.
  if (!(await withinStore("pay-request", `${clientAddress(request)}|${store.handle}`, 20, 600, store, "buyer"))) return back("limited");
  const opened = await openRequestCheckout(store, id, linkOrigin(request, store));
  if (opened.ok) return new Response(null, { status: 303, headers: { Location: opened.url, "Cache-Control": "no-store" } });
  if (opened.reason === "error") {
    console.error("opening a payment request's checkout failed", opened.error);
    // Stripe refusing on purpose is the creator's to put right, and they are told (lib/checkout-trouble.ts).
    if (opened.error) after(() => noteCheckoutTrouble(store, opened.error).then(() => undefined, () => undefined));
    // Stripe says the account cannot take card payments: written down, and said with the page's own notice (lib/stripe-charges.ts).
    if (await chargesOffAfterRefusal(store, opened.error)) return back("closed");
  }
  return back(opened.reason === "gone" ? "" : opened.reason);
}
