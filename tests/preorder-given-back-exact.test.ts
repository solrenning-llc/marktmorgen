/**
 * A pre-order confirmed after its payment was given back is marked revoked, and only a known answer lets it be taken
 * as handled (Codex X6's LOW on #4408). confirmPreorder writes the entry down, finds the payment refunded in full,
 * reads the entry back and writes it revoked. Before, an entry that read back as gone, or a revoked write whose
 * keep (EXPIRE) reply was not the expected 1, still answered "skip", so the confirmation was never tried again and
 * nothing said the pre-order had been taken back. Now both are unknown and throw, so the confirmation runs again.
 *
 * Synthetic store, Stripe stand-in and the Redis stub.
 */
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmPreorder, readPreorder } from "@/lib/preorders";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
/** Set when the payment is read: the next entry read or keep reply after it is the one under test. */
let afterPayment = false;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") return new Response(JSON.stringify({ id: "email_1" }));
  const path = url.pathname.replace(/^\/v1/, "");
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (path.startsWith("/payment_intents/")) {
    afterPayment = true;
    return answer({ id: path.split("/")[2], object: "payment_intent", latest_charge: { object: "charge", refunded: true, amount: 2500, amount_refunded: 2500 } });
  }
  if (path === "/refunds" || path === "/events") return answer({ object: "list", data: [], has_more: false });
  return answer({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_given_back_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_given_back_only";

  await claimHandle("owner@givenback.example", "givenback", "Given Back", "");
  await ensureStatsId("owner@givenback.example");
  await setStripeAccount("owner@givenback.example", "acct_1TestGivenBack1", true);
  await setSubscription("owner@givenback.example", { customerId: "cus_GivenBack001", subscriptionId: "sub_GivenBack001", active: true, period: paidPeriod() });
  const made = await addProduct("owner@givenback.example", "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink("owner@givenback.example", made.product.id, "https://example.com/course");
  const store = (await storeForEmail("owner@givenback.example"))!;
  const product = (await readListing(store, made.product.id))!;
  const deps = { base: "https://marktmorgen.com/@givenback", from: '"Given Back" <hello@marktmorgen.com>', ordersLink: async () => null, recordStart: async () => {} };
  const session = (n: number) => ({
    id: `cs_test_givenback0000000${n}`,
    created: NOW - 600,
    status: "complete",
    payment_status: "paid",
    amount_total: 2500,
    currency: "usd",
    payment_intent: `pi_givenback0000000${n}`,
    metadata: { store: "givenback", product: product.id, preorder: "yes" },
    customer_details: { email: `buyer${n}@givenback.example` },
  });

  const real = redis.pipeline.bind(redis);
  let mode: "gone" | "keep-zero" | null = null;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const replies = await real(commands);
    if (!afterPayment || !mode) return replies;
    if (mode === "gone" && commands.length === 1 && commands[0][0] === "HGET") {
      mode = null;
      return [null];
    }
    const expire = commands.findIndex((c) => c[0] === "EXPIRE");
    if (mode === "keep-zero" && commands.some((c) => c[0] === "HSET") && expire >= 0) {
      mode = null;
      return replies.map((r: unknown, i: number) => (i === expire ? 0 : r));
    }
    return replies;
  }) as typeof redis.pipeline;
  const confirm = async (n: number) => {
    afterPayment = false;
    return confirmPreorder(store, session(n) as never, product, deps).catch(() => "threw" as const);
  };

  part("The entry reads back as gone after the payment was found given back");
  mode = "gone";
  is("unknown, not handled: the confirmation throws, to be tried again", await confirm(1), "threw");
  is("tried again with a known read: skipped and marked revoked", [await confirm(1), Boolean((await readPreorder(store, product.id, session(1).id))?.revoked)], ["skip", true]);

  part("The revoked write's keep reply is not the expected 1");
  mode = "keep-zero";
  is("unknown, not handled: the confirmation throws, to be tried again", await confirm(2), "threw");
  is("tried again with known replies: skipped and marked revoked", [await confirm(2), Boolean((await readPreorder(store, product.id, session(2).id))?.revoked)], ["skip", true]);

  part("Known replies throughout");
  is("a pre-order given back is skipped and marked revoked at once", [await confirm(3), Boolean((await readPreorder(store, product.id, session(3).id))?.revoked)], ["skip", true]);

  redis.pipeline = real;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
