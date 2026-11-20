import { withinStore } from "@/lib/metered-limits";
import { channelOfRequest } from "@/lib/visit-channel";
import type { NextRequest } from "next/server";
import { linkOrigin, originFrom } from "@/lib/request-origin";
import { normaliseHandle, storeForHandle } from "@/lib/store";
import { clientAddress, fromAnotherSite, limited } from "@/lib/request-guard";
import { createTipCheckout, tipsOpen } from "@/lib/store-tip-checkout";
import { readTipAmount, tipAmounts } from "@/lib/store-tips";
import { consumerGate } from "@/lib/eu-vat-gate";
import type { EuSupplyFields } from "@/lib/eu-vat-supply";

/**
 * A gift, for the EU VAT gate: no product, so its kind never reads (a paid supply of unknown kind,
 * lib/eu-vat-supply.ts euSupplyOf). Under the reading of docs/eu-vat-article-9a.md a tip is consideration paid through
 * the platform to a creator whose content the payer receives, so the gate always asks where the buyer is.
 */
const TIP_SUPPLY: EuSupplyFields = { priceCents: 1, file: null, link: null, keys: null, course: null, recurring: null, call: null, bundle: null, pwyw: null };

/**
 * "Support my work" on a store page (lib/store-tips.ts): a plain form, so it
 * works without JavaScript. The supporter chooses one of the creator's amounts
 * (`amount`, in the currency's smallest unit, and only one the box offers) or
 * "another amount" (`amount=other`, with `other` as typed; a typed amount with
 * nothing chosen, as Enter in the box sends it, is read the same way), and the
 * country they are sending from. The answer is Stripe's page, or the store
 * page saying what was wrong.
 */
export async function POST(request: NextRequest) {
  const origin = originFrom(request);
  if (fromAnotherSite(request)) return new Response("forbidden", { status: 403 });
  let handle = "";
  let picked = "";
  let other = "";
  // The form as sent, for the billing country the EU VAT gate reads (lib/eu-vat-gate.ts consumerGate).
  let sent = new FormData();
  try {
    const form = await (await limited(request, 2_000)).formData();
    sent = form;
    const read = (name: string, max: number) => {
      const value = form.get(name);
      return typeof value === "string" ? value.slice(0, max) : "";
    };
    handle = normaliseHandle(read("handle", 100));
    picked = read("amount", 12);
    other = read("other", 20);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const store = handle ? await storeForHandle(handle) : null;
  if (!store) return new Response("No such store.", { status: 404 });
  const away = (problem: string) =>
    new Response(null, { status: 303, headers: { Location: `${origin}/@${store.handle}?tip=${problem}#support`, "Cache-Control": "no-store" } });
  if (!tipsOpen(store)) return away("closed");

  // A chosen amount is taken only when the box offers it; "another amount", or nothing chosen, reads what was typed,
  // held to the range. One of the creator's amounts chosen while another was typed is never settled silently either
  // way (WCAG 3.3.6): the supporter is asked to choose one.
  const offered = tipAmounts(store.tips, store.currency);
  const amount =
    picked === "other" || !picked ? readTipAmount(other, store.currency)
    : other.trim() ? null
    : /^\d{1,9}$/.test(picked) && offered.includes(Number(picked)) ? Number(picked)
    : null;
  if (amount === null) return away("amount");
  // EU VAT art. 9a (owner's decision IV, 789 [IV1] unit 1): before anything is sent to Stripe, a supporter in the EU
  // or the UK is refused and one without a billing country is asked for it, as the card checkout and the cart do. Kept
  // until the tax is collected on top of the price at checkout (AGENTS.md, section IV).
  const gate = consumerGate({ product: TIP_SUPPLY, headers: request.headers, form: sent });
  if (!gate.ok) return away(gate.reason === "refused" ? "abroad" : "country");

  // Twenty a connection in ten minutes per store: far past any fan, short of a script trying cards.
  if (!(await withinStore("tip", `${clientAddress(request)}|${store.handle}`, 20, 600, store))) return away("limited");
  try {
    const opened = await createTipCheckout(
      store,
      linkOrigin(request, store),
      amount,
      channelOfRequest(request, store.handle, new URL(origin).hostname, Date.now() / 1000, store.attributionDays),
    );
    return new Response(null, { status: 303, headers: { Location: opened.url, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("opening a support checkout failed", error);
    return away("error");
  }
}
