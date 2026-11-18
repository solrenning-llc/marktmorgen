import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setHasDiscounts, setProductExtras, setProductLink, setReturningCodes, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing, readProduct } from "@/lib/catalog";
import { HOLDS_PER_ADDRESS, stockLeft } from "@/lib/stock";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { sendReturningLink } from "@/lib/returning-code";
import type { ReturningCode } from "@/lib/returning-code-rules";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_hold_4409_only";
process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";

const OWNER = "hold4409.owner@example.com";
const PAST = "past.buyer@example.com";
let pastProduct = "";
let made = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path === "/checkout/sessions" && method === "POST") {
    const body = new URLSearchParams(String(init?.body));
    // The returning code's coupon is used up on the creator's account: Stripe's 400 names it.
    if (body.has("discounts[0][coupon]")) return answer({ error: { type: "invalid_request_error", message: `Coupon ${body.get("discounts[0][coupon]")} has reached its max redemptions.` } }, 400);
    made += 1;
    const id = `cs_test_${String(made).padStart(24, "r")}`;
    return answer({ id, status: "open", payment_status: "unpaid", url: `https://checkout.stripe.com/c/pay/${id}`, created: Math.floor(Date.now() / 1000) });
  }
  if (path === "/checkout/sessions" && method === "GET") {
    const email = url.searchParams.get("customer_details[email]");
    const rows = email === PAST ? [{ id: "cs_test_returningearlier1", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", amount_total: 900, customer: null, metadata: { store: "hold4409shop", product: pastProduct }, payment_intent: { id: "pi_Hold4409Past01", object: "payment_intent", status: "succeeded", latest_charge: { id: "ch_Hold4409Past1", object: "charge", refunded: false, amount_refunded: 0, disputed: false } } }] : [];
    return answer({ object: "list", data: rows, has_more: false });
  }
  if (path.startsWith("/checkout/sessions/") && method === "GET") return answer({ error: { message: "No such checkout" } }, 404);
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const VIP: ReturningCode = { code: "THANKYOU", coupon: "cpn_Hold4409Thanks", off: { kind: "percent", percent: 20 }, endsAt: null, createdAt: 1_790_000_000 };
const captured: string[] = [];
const capture = (async (message: { text: string }) => {
  captured.push(message.text);
  return true;
}) as unknown as Parameters<typeof sendReturningLink>[6];

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "hold4409shop", "Hold Shop", "Synthetic store.");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestHold44091", true);
  await setSubscription(OWNER, { customerId: "cus_Hold440900001", subscriptionId: "sub_Hold440900001", active: true, tier: "scale", cycle: "month", period: paidPeriod() });
  await setHasDiscounts(OWNER, true);
  const make = async (title: string, price: string, stock: number | null) => {
    const p = await addProduct(OWNER, title, "", price, null);
    if (!p.ok) throw new Error(title);
    if (stock !== null) {
      const limited = await setProductExtras(OWNER, p.product.id, { stock });
      if (!limited.ok) throw new Error(`stock fixture: ${limited.reason}`);
    }
    await setProductLink(OWNER, p.product.id, `https://example.com/${p.product.id}`);
    return p.product.id;
  };
  pastProduct = await make("Starter pack", "9", null);
  const STOCK = 40;
  const dropId = await make("Signed print", "27", STOCK);
  await setReturningCodes(OWNER, [VIP]);
  const store = (await storeForEmail(OWNER))!;
  await sendReturningLink(store, dropId, (await readProduct(store, dropId))!.title, store.returningCodes[0], PAST, "https://marktmorgen.com", capture);
  const token = /rtoken=([a-f0-9]{64})/.exec(captured.at(-1) ?? "")?.[1] ?? "";
  is("a returning link was made for the past buyer", token.length, 64);

  const left = async () => {
    const now = (await storeForEmail(OWNER))!;
    return stockLeft(now, (await readListing(now, dropId))!);
  };
  const press = async (fields: Record<string, string>) => {
    const f = new FormData();
    f.set("handle", "hold4409shop");
    f.set("billing_country", "US");
    f.set("product", dropId);
    for (const [k, v] of Object.entries(fields)) f.set(k, v);
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body: withConsent(f), headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "x-forwarded-for": "198.51.100.77" } }));
    return response.headers.get("location") ?? "";
  };

  part("A refused returning code: the unit and the count must agree");
  const first = await press({ rtoken: token });
  is("the refused code sends the buyer back to the field", first.includes("returning=code"), true);
  const heldAfterOne = STOCK - ((await left()) ?? 0);
  for (let i = 0; i < 4; i += 1) await press({ rtoken: token });
  const heldByRefused = STOCK - ((await left()) ?? 0);
  for (let i = 0; i < 20; i += 1) await press({});
  const heldByOne = STOCK - ((await left()) ?? 0);
  console.log(`held after one refused code: ${heldAfterOne}; after five: ${heldByRefused}; after 20 plain presses more: ${heldByOne}`);
  is(`one connection holds at most HOLDS_PER_ADDRESS (${HOLDS_PER_ADDRESS}) units, refused codes included`, heldByOne <= HOLDS_PER_ADDRESS, true);
  is("a refused code (Stripe's 400, no checkout made) holds no unit", heldByRefused, 0);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
