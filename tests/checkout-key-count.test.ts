/**
 * SG2, finding 11 (CX-123, rule 24): the checkout of one product that hands
 * out license keys from a pool reads how many keys are left before it opens.
 * When that count cannot be read (Redis failed, or answered in a shape that
 * is not one whole number), the order is unknown, never "some left": the
 * buyer is sent back with the plain error, and Stripe is never reached. A
 * read count still decides as before: none left is sold out, some left opens.
 * The creator's Stripe account is played by a stand-in for `fetch`; nothing
 * real is reached.
 */
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureStatsId, setProductKeys, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { DEFAULT_KEYS } from "@/lib/key-setup";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

process.env.STRIPE_SECRET_KEY = "sk_test_checkout_key_count_only";

const sessions: URLSearchParams[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const method = init?.method ?? "GET";
  if (path === "/checkout/sessions" && method === "POST") {
    sessions.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify({ id: `cs_test_${"k".repeat(24)}`, url: "https://checkout.stripe.com/c/pay/test" }));
  }
  return new Response(JSON.stringify({ error: { message: `no stand-in for ${method} ${path}` } }), { status: 404 });
}) as typeof fetch;

// The pool's count is read with LLEN on the pool's own key; every other
// command reaches the stand-in Redis unchanged.
type Answer = "real" | "throws" | "text" | "null" | "negative" | "fraction" | "empty" | "sparse" | "extra";
let answer: Answer = "real";
const realPipeline = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const asksPool = commands.some((command) => command[0] === "LLEN" && String(command[1]).endsWith(":pool"));
  if (!asksPool || answer === "real") return realPipeline(commands);
  if (answer === "throws") throw new Error("Synthetic Redis failure reading the key pool");
  const replies = await realPipeline(commands);
  if (answer === "empty") return [];
  if (answer === "sparse") return Array(replies.length);
  if (answer === "extra") return [...replies, 0];
  return replies.map((reply, i) =>
    commands[i][0] === "LLEN" && String(commands[i][1]).endsWith(":pool")
      ? answer === "text" ? "many" : answer === "null" ? null : answer === "negative" ? -1 : 0.5
      : reply,
  );
}) as typeof redis.pipeline;

const post = (body: FormData) => new NextRequest("https://marktmorgen.com/api/store/checkout", { method: "POST", body, headers: { host: "marktmorgen.com" } });

async function main(): Promise<void> {
  redis.clear();
  const owner = "keycount@example.com";
  await claimHandle(owner, "keycountshop", "Key Count Shop", "");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_1TestKeyCount01", true);
  await setSubscription(owner, { customerId: "cus_KeyCount0001", subscriptionId: "sub_KeyCount0001", active: true, period: paidPeriod() });
  const app = await addProduct(owner, "Desktop app", "", "29", null);
  if (!app.ok) throw new Error("no product");
  await setProductLink(owner, app.product.id, "https://example.com/app");
  const keyed = await setProductKeys(owner, app.product.id, { ...DEFAULT_KEYS, source: "pool" });
  is("the product hands out keys from a pool", keyed.ok, true);
  const buy = () => {
    const f = new FormData();
    f.set("handle", "keycountshop");
    f.set("product", app.product.id);
    return withConsent(f);
  };
  const open = async (as: Answer) => {
    answer = as;
    const before = sessions.length;
    const response = await checkoutRoute(post(buy()));
    answer = "real";
    return [response.headers.get("location"), sessions.length - before];
  };

  part("A count that was read decides as before");
  is("an empty pool: sold out, Stripe never reached", await open("real"), ["https://marktmorgen.com/@keycountshop?status=soldout", 0]);
  // One key in the pool, written where lib/licence-keys.ts keeps it.
  await redis.pipeline([["RPUSH", `nl:keys:${(await storeForEmail(owner))!.statsId}:${app.product.id}:pool`, "KEY-ONE"]]);
  is("a key left: on to Stripe", await open("real"), ["https://checkout.stripe.com/c/pay/test", 1]);

  part("A count that could not be read never sells (SG2, finding 11)");
  for (const as of ["throws", "text", "null", "negative", "fraction", "empty", "sparse", "extra"] as const) {
    is(`the pool's count ${as === "throws" ? "fails to load" : `answers ${as}`}: the plain error, Stripe never reached`, await open(as), ["https://marktmorgen.com/@keycountshop?status=error", 0]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
