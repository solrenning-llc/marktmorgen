/**
 * A discount code that arrives in a link (lib/code-link.ts), applied at the
 * checkout without being typed.
 *
 * Measured before it was built (7 October 2026): Gumroad, Kajabi and Shopify
 * take a code in the address; on Stan a buyer types it. The creator's Stripe
 * account is played by a stand-in for `fetch`. What is checked:
 *
 *   - only something shaped like a code is kept, upper case, one cookie per
 *     store, and the shape is the same one the studio's codes are held to;
 *   - a live code of the creator's goes on by itself, and the box does not;
 *   - an unknown code leaves the box, as if no code had come;
 *   - a code Stripe refuses for this sale opens the checkout with the box
 *     rather than turning the buyer away;
 *   - a store-wide sale still wins.
 */
import { TEST_CONSENT } from "./digital-consent-fixture";
import { addProduct, claimHandle, ensureStatsId, setHasDiscounts, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { CODE_PATTERN } from "@/lib/discount";
import { LINK_CODE_PATTERN, codeCookieName, readLinkCode } from "@/lib/code-link";
import { createCheckout } from "@/lib/store-checkout";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const sessions: URLSearchParams[] = [];
let live: Record<string, string> = {};
let refuse = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/promotion_codes" && method === "GET") {
    const id = live[url.searchParams.get("code") ?? ""];
    return new Response(JSON.stringify({ object: "list", data: id ? [{ id, object: "promotion_code", active: true, code: url.searchParams.get("code") }] : [] }));
  }
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    sessions.push(body);
    if (refuse && body.has("discounts[0][promotion_code]")) {
      return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "This promotion code cannot be redeemed because the order does not meet the minimum amount." } }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: `cs_test_${"c".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_codes_only_a_stand_in";

  part("What is kept from the address");
  is("upper case", readLinkCode(" spring-26 "), "SPRING-26");
  is("not something that is not a code", [readLinkCode("<script>"), readLinkCode("ab"), readLinkCode(null)], ["", "", ""]);
  is("one cookie per store", codeCookieName("Harbor"), "nl_code_harbor");
  is("the same shape the studio's codes have", LINK_CODE_PATTERN.source, CODE_PATTERN.source);

  const owner = "codes@example.com";
  await claimHandle(owner, "codeshop", "Code Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestCodes00001", true);
  await setSubscription(owner, { customerId: "cus_Codes00001", subscriptionId: "sub_Codes00001", active: true, period: paidPeriod() });
  await setHasDiscounts(owner, true);
  const made = await addProduct(owner, "Recipe pack", "", "27", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(owner, made.product.id, "https://example.com/pack");
  const store = (await storeForEmail(owner))!;
  const product = (await readProduct(store, made.product.id))!;

  part("A live code of the creator's");
  live = { SPRING: "promo_1Spring" };
  await createCheckout(store, product, "https://marktmorgen.com", undefined, { code: "SPRING", digitalConsent: TEST_CONSENT });
  let sent = sessions.at(-1)!;
  is("goes on by itself", sent.get("discounts[0][promotion_code]"), "promo_1Spring");
  is("and the box is not offered beside it", sent.get("allow_promotion_codes"), null);
  is("kept with the sale", sent.get("metadata[code]"), "SPRING");

  part("A code nobody made");
  await createCheckout(store, product, "https://marktmorgen.com", undefined, { code: "NOPE", digitalConsent: TEST_CONSENT });
  sent = sessions.at(-1)!;
  is("leaves the box, as without a code", [sent.get("discounts[0][promotion_code]"), sent.get("allow_promotion_codes")], [null, "true"]);

  part("A code that does not fit this sale");
  refuse = true;
  const opened = await createCheckout(store, product, "https://marktmorgen.com", undefined, { code: "SPRING", digitalConsent: TEST_CONSENT });
  sent = sessions.at(-1)!;
  is("the checkout still opens", opened.url, "https://checkout.stripe.com/c/pay/test");
  is("with the box instead", [sent.get("discounts[0][promotion_code]"), sent.get("allow_promotion_codes"), sent.get("metadata[code]")], [null, "true", null]);
  refuse = false;

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
