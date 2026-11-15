/**
 * The returning-buyer link survives the consent box asked for by a digital extra on a shipped product (#4742).
 *
 * A shipped product does not ask for the box at the first check; its digital extra (an order bump) asks for it when
 * the checkout is built (DigitalConsentMissing). The buyer is sent back to the product page with the link still in it,
 * so ticking the box and trying again opens the checkout with the discount. Fixture copied from
 * tests/returning-code.test.ts (that file is untouched); synthetic Stripe, email and Redis, the real route handler,
 * with "next/server" from tests/next-server-after-world.ts (tests/aliases/returning-consent-extra.test.ts.json).
 */
import { NextRequest } from "next/server";
import { afterTasks } from "./next-server-after-world";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setHasDiscounts, setProductExtras, setProductLink, setProductShipping, setReturningCodes, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readProduct } from "@/lib/catalog";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { type ReturningCode } from "@/lib/returning-code-rules";
import { sendReturningLink } from "@/lib/returning-code";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_returning_code_only";
process.env.RESEND_API_KEY = "re_test_returning_code_only";
process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const OWNER = "returning.owner@example.com";
const PAST = "past.buyer@example.com";
let pastProduct = "";

const opened: URLSearchParams[] = [];
const mails: string[] = [];

const charge = () => ({ id: "ch_ReturnPast001", object: "charge", refunded: false, amount_refunded: 0, disputed: false });
const session = () => ({
  id: "cs_test_returningearlier1", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 900, customer: null,
  metadata: { store: "returnshop", product: pastProduct },
  payment_intent: { id: "pi_ReturnPast0001", object: "payment_intent", status: "succeeded", latest_charge: charge() },
});

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") {
    mails.push(String(init?.body ?? ""));
    return answer({ id: `00000000-0000-4000-8000-${String(mails.length).padStart(12, "0")}` });
  }
  if (url.hostname !== "api.stripe.com") throw new Error(`unexpected ${url}`);
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    opened.push(body);
    return answer({ id: `cs_test_${"r".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" });
  }
  if (path === "/checkout/sessions" && method === "GET") {
    const email = url.searchParams.get("customer_details[email]");
    return answer({ object: "list", data: email === PAST ? [session()] : [], has_more: false });
  }
  if (path === "/promotion_codes" && method === "GET") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${method} ${path}` } }, 404);
}) as typeof fetch;

const VIP: ReturningCode = { code: "THANKYOU", coupon: "cpn_ReturnThanks01", off: { kind: "percent", percent: 20 }, endsAt: null, createdAt: 1_790_000_000 };

/** The email the link would go in, captured instead of sent (the provider is not reachable from tests). */
const captured: { to: string; text: string }[] = [];
const capture = (async (message: { to: unknown; text: string }) => {
  captured.push({ to: String(message.to), text: message.text });
  return true;
}) as unknown as Parameters<typeof sendReturningLink>[6];
async function linkFor(email: string, id: string): Promise<string> {
  const store = (await storeForEmail(OWNER))!;
  const product = (await readProduct(store, id))!;
  await sendReturningLink(store, id, product.title, store.returningCodes[0], email, "https://marktmorgen.com", capture);
  return /rtoken=([a-f0-9]{64})/.exec(captured.at(-1)?.text ?? "")?.[1] ?? "";
}

async function runAfter(): Promise<void> {
  while (afterTasks.length) {
    const task = afterTasks.shift();
    if (typeof task === "function") await task();
  }
}


async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "returnshop", "Return Shop", "Synthetic store.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestReturn01", true);
  await setSubscription(OWNER, { customerId: "cus_Return000001", subscriptionId: "sub_Return000001", active: true, tier: "creator", period: paidPeriod() });
  await setHasDiscounts(OWNER, true);
  const made = await addProduct(OWNER, "Starter pack", "", "9", null);
  if (!made.ok) throw new Error("could not make the digital fixture");
  pastProduct = made.product.id;
  await setProductLink(OWNER, pastProduct, `https://example.com/${pastProduct}`);
  await setReturningCodes(OWNER, [VIP]);

  part("A digital extra on a shipped order keeps the returning link through the consent box");
  const shipped = await addProduct(OWNER, "Printed cookbook", "", "39", null);
  if (!shipped.ok) throw new Error("could not make the shipped fixture");
  const shippedId = shipped.product.id;
  is("the shipped product takes its shipping", (await setProductShipping(OWNER, shippedId, { cents: 500, region: "custom", countries: ["US"], note: "" })).ok, true);
  is("the shipped product takes its digital extra", (await setProductExtras(OWNER, shippedId, { bump: { productId: pastProduct, priceCents: 500, pitch: "Digital guide" }, slot: 0 })).ok, true);
  const store = (await storeForEmail(OWNER))!;
  is("the shipped product reads back with its bump", (await readProduct(store, shippedId))?.bumps.map((bump) => bump.productId), [pastProduct]);
  const token = await linkFor(PAST, shippedId);
  is("the shipped product has its own returning link", token.length, 64);

  const noBox = new FormData();
  noBox.set("handle", "returnshop");
  noBox.set("product", shippedId);
  noBox.set("bump", pastProduct);
  noBox.set("rtoken", token);
  const before = opened.length;
  const boxed = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: noBox, headers: { host: "marktmorgen.com", "x-forwarded-for": "198.51.100.53" } }));
  await runAfter();
  is("sent back for the box with the link kept, and no checkout opened",
    [boxed.headers.get("location"), opened.length - before],
    [`https://marktmorgen.com/@returnshop/p/${shippedId}?consent=needed&rtoken=${token}#returning`, 0]);

  const withBox = new FormData();
  withBox.set("handle", "returnshop");
  withBox.set("product", shippedId);
  withBox.set("bump", pastProduct);
  withBox.set("rtoken", token);
  const retried = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(withBox), headers: { host: "marktmorgen.com", "x-forwarded-for": "198.51.100.54" } }));
  await runAfter();
  const session = opened.at(-1)!;
  is("with the box ticked, the same link opens the checkout", [retried.headers.get("location"), opened.length - before], ["https://checkout.stripe.com/c/pay/test", 1]);
  is("with the discount, for that address, and the digital extra", [session.get("discounts[0][coupon]"), session.get("customer_email"), session.get("metadata[bump]")], [VIP.coupon, PAST, pastProduct]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
