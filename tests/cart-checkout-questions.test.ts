/**
 * A product with checkout questions is bought from its own page, which asks
 * them; the cart checkout (POST /api/store/cart) refuses it. The cart as it is
 * opened (GET) read only the product's listing, which has no questions, so it
 * showed such a line as payable and counted it in the total, and every press
 * of "Checkout" came back as cart=changed: nothing in the cart could be paid
 * for until the buyer found and removed that line (#4350, Codex X5).
 *
 * The GET now reads whether each line asks questions (readAsking), says that
 * line is not payable here, keeps it out of the total, and the other lines
 * stay payable and open at Stripe. A reading that cannot be had is never
 * "asks nothing" (rule 24): no line is payable right now.
 */
import { NextRequest } from "next/server";
import { GET as readCart, POST as payCart } from "@/app/api/store/cart/route";
import { readAsking } from "@/lib/catalog";
import { addProduct, claimHandle, ensureStatsId, setProductFields, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Command = (string | number)[];
const real = redis.pipeline.bind(redis);
let breakExtras = false;
redis.pipeline = (async (batch: Command[]) => {
  if (breakExtras && batch.some((c) => c[0] === "GET" && typeof c[1] === "string" && c[1].includes(":x:"))) throw new Error("connection lost");
  return real(batch);
}) as typeof redis.pipeline;

const stripeSessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    stripeSessions.push(new URLSearchParams(String(init.body)));
    return Response.json({ id: "cs_test_cartQuestions0001", url: "https://checkout.stripe.com/c/pay/cs_test_cartQuestions0001" });
  }
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", data: [], has_more: false });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

const OWNER = "cart-questions@example.test";
const HANDLE = "cartquestions";

async function made(title: string, price: string): Promise<string> {
  const added = await addProduct(OWNER, title, "A synthetic product.", price, null);
  if (!added.ok) throw new Error(`fixture could not add ${title}`);
  await setProductLink(OWNER, added.product.id, `https://example.test/${added.product.id}`);
  return added.product.id;
}

type Cart = { items: { id: string; ok: boolean }[]; total?: string };
async function open(ids: string[]): Promise<Cart> {
  const url = `https://marktmorgen.test/api/store/cart?handle=${HANDLE}&ids=${ids.join(",")}`;
  const response = await readCart(new NextRequest(url, { headers: { host: "marktmorgen.test" } }));
  return (await response.json()) as Cart;
}

async function pay(ids: string[]): Promise<{ location: string; opened: number }> {
  const before = stripeSessions.length;
  const form = withConsent(new URLSearchParams([["handle", HANDLE], ...ids.map((id) => ["id", id] as [string, string])]));
  const response = await payCart(new NextRequest("https://marktmorgen.test/api/store/cart", {
    method: "POST",
    headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  }));
  return { location: response.headers.get("location") ?? "", opened: stripeSessions.length - before };
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_cart_questions_stand_in";
  redis.clear();
  await claimHandle(OWNER, HANDLE, "Cart Questions", "");
  await ensureStatsId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_CartQuest01", subscriptionId: "sub_CartQuest01", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setStripeAccount(OWNER, "acct_1CartQuestions1", true);
  const custom = await made("Custom guide", "30");
  const plain = await made("Plain guide", "20");

  part("Control: no questions, both lines payable");
  const before = await open([custom, plain]);
  is("both lines can be paid for", before.items.map(({ id, ok }) => [id, ok]), [[custom, true], [plain, true]]);

  part("A required checkout question saved on one product");
  const field = { label: "Name for the guide", type: "text" as const, optional: false, options: [] };
  is("the question is saved", (await setProductFields(OWNER, custom, [field])).ok, true);
  const store = (await storeForEmail(OWNER))!;
  is("readAsking names the product that asks, not the other", [...(await readAsking(store, [custom, plain]))], [custom]);
  const cart = await open([custom, plain]);
  is("the cart says the product with a question is not payable here, the other is", cart.items.map(({ id, ok }) => [id, ok]), [[custom, false], [plain, true]]);
  is("the total is the payable line's price only", cart.total, (await open([plain])).total);
  const payment = await pay(cart.items.filter(({ ok }) => ok).map(({ id }) => id));
  is("paying for the payable lines opens at Stripe", [payment.opened, payment.location.includes("cart=")], [1, false]);

  part("Unknown is never \"asks nothing\" (rule 24)");
  breakExtras = true;
  let threw = false;
  try {
    await readAsking(store, [plain]);
  } catch {
    threw = true;
  }
  is("readAsking throws when the questions cannot be read", threw, true);
  const unknown = await open([plain]);
  is("the cart offers no line as payable while the questions cannot be read", unknown.items.map(({ id, ok }) => [id, ok]), [[plain, false]]);
  breakExtras = false;

  part("Control: the question taken off again");
  is("the question is removed", (await setProductFields(OWNER, custom, [])).ok, true);
  const again = await open([custom, plain]);
  is("both lines can be paid for again", again.items.map(({ id, ok }) => [id, ok]), [[custom, true], [plain, true]]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
