/**
 * A stand-in for Stripe's GET /v1/payment_intents/<id>?expand[]=latest_charge on a payment that went through and was
 * neither refunded nor disputed: the read a gift (lib/gifts.ts deliverGift) and a pre-order of a product on sale
 * (lib/preorders.ts confirmPreorder) make before handing anything over (MM-E2E-RG-1, RG-2). Fixtures whose payments
 * are plain paid ones answer it with this; null for any other request.
 */
export function paidIntentReply(input: string | URL | Request, method = "GET"): Response | null {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const id = /^\/v1\/payment_intents\/([^/]+)$/.exec(url.pathname)?.[1];
  if (url.hostname !== "api.stripe.com" || method !== "GET" || !id) return null;
  const pi = decodeURIComponent(id);
  return new Response(
    JSON.stringify({ id: pi, object: "payment_intent", status: "succeeded", latest_charge: { id: "ch_standinPaid0001", object: "charge", payment_intent: pi, refunded: false, amount_refunded: 0, disputed: false } }),
  );
}
