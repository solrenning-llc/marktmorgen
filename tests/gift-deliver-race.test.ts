/**
 * A gift confirmation that waited for another run's giving mark reads the gift again once it holds the mark
 * (Claude 7's race hunt): it never gives again from the copy it read before waiting.
 *
 * deliverGift read the gift, returned "already" when it was given, and then took the giving mark; it never read the
 * gift again. Two confirmations of the same gift (the thanks page and the checkout sweep) could both read it as not
 * given. The first gave it and let its mark go; a full refund then took the gift back (revoked, purchase removed,
 * refund marked read); the second took the free mark and gave it again from its old copy: the purchase was granted
 * again and {...gift, given} was written over the revoked mark. The refund, already read, was never looked at again,
 * so the buyer kept the money and the recipient kept the product.
 *
 * The second run is held at its own claim of the mark while the first run and the refund pass run in full, so the
 * order is the interleaving under test, every time. Real MemoryRedis; Stripe and the email provider are stand-ins.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { addProduct, claimHandle, ensureStatsId, setProductLink, setStripeAccount, setSubscription, storeForEmail, type Listing, type Store } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { deliverGift, revokeRefundedGifts, startGift } from "@/lib/gifts";
import { importedFor } from "@/lib/imported-purchases";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

const NOW = Math.floor(Date.now() / 1000);
const OWNER = "owner@giftrace.example";
const TO = "friend@giftrace.example";
const PI = "pi_giftrace00000001";
let refunded = false;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  const path = url.pathname.replace(/^\/v1/, "");
  const charge = { object: "charge", refunded, amount: 2500, amount_refunded: refunded ? 2500 : 0 };
  if (path === "/refunds") {
    const data = refunded ? [{ id: "re_giftrace0001", object: "refund", created: NOW, status: "succeeded", payment_intent: PI, charge }] : [];
    return answer({ object: "list", data, has_more: false });
  }
  if (path === "/events") return answer({ object: "list", data: [], has_more: false });
  if (path.startsWith("/payment_intents/")) return answer({ id: PI, object: "payment_intent", status: "succeeded", latest_charge: charge });
  return answer({ error: { message: `no stand-in for ${path}` } }, 404);
}) as typeof fetch;

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const errors = console.error;
  console.error = () => {};
  try { return await run(); } finally { console.error = errors; }
};

async function setUp(): Promise<{ store: Store; product: Listing; giftId: string }> {
  redis.clear();
  refunded = false;
  process.env.STRIPE_SECRET_KEY = "sk_test_gift_race_only_a_stand_in";
  process.env.RESEND_API_KEY = "re_test_gift_race_only";
  await claimHandle(OWNER, "giftrace", "Gift Race", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestGiftRace01", true);
  await setSubscription(OWNER, { customerId: "cus_GiftRace0001", subscriptionId: "sub_GiftRace0001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Bread Course", "", "25", null);
  if (!made.ok) throw new Error("no product");
  await setProductLink(OWNER, made.product.id, "https://example.com/course");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))! as Listing;
  const started = await startGift(store, product, { to: TO, from: "Ana", message: "" });
  if (!started.ok) throw new Error("no gift");
  return { store, product, giftId: started.gift.id };
}

function deliver(store: Store, product: Listing, giftId: string) {
  return deliverGift({
    store,
    session: { id: "cs_test_giftrace00000001", created: NOW - 600, amount_total: 2500, currency: "usd", payment_intent: PI, metadata: { store: "giftrace", product: product.id, gift: giftId }, customer_details: { email: "buyer@giftrace.example" } } as never,
    product,
    base: "https://marktmorgen.com/@giftrace",
    from: '"Gift Race" <hello@marktmorgen.com>',
    recordStart: async () => {},
    ordersLink: async () => null,
  });
}
const holds = async () => (await importedFor((await storeForEmail(OWNER)) as Store, TO)).length > 0;
const keptGift = (giftId: string) => JSON.parse(String(redis.run(["GET", `nl:gift:${giftId}`]))) as { given?: number; revoked?: number };

test("a confirmation that waited for the giving mark does not give a gift refunded in the meantime again", async () => {
  const { store, product, giftId } = await setUp();
  const real = redis.pipeline.bind(redis);
  let held = false;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const claim = commands.some((c) => c[0] === "SET" && String(c[1]).endsWith(":giving") && c.includes("NX"));
    if (claim && !held) {
      // The second confirmation read the gift (not given) and is about to take the mark: the first runs in full and
      // lets its mark go, then the refund pass takes the gift back.
      held = true;
      redis.pipeline = real;
      assert.equal(await quiet(() => deliver(store, product, giftId)), "given");
      refunded = true;
      assert.equal(await quiet(() => revokeRefundedGifts(store, Date.now() + 60_000, async () => {})), 1);
      assert.equal(await holds(), false, "the refund pass took the purchase back");
    }
    return real(commands);
  }) as typeof redis.pipeline;
  try {
    assert.equal(await quiet(() => deliver(store, product, giftId)), "already");
  } finally {
    redis.pipeline = real;
  }
  assert.ok(held, "the second confirmation was held at its claim");
  assert.equal(await holds(), false, "the refunded gift is not given again");
  assert.ok(keptGift(giftId).revoked, "the gift stays revoked");
});

test("control: one confirmation gives the gift, and a second one says it is already given", async () => {
  const { store, product, giftId } = await setUp();
  assert.equal(await quiet(() => deliver(store, product, giftId)), "given");
  assert.equal(await quiet(() => deliver(store, product, giftId)), "already");
  assert.equal(await holds(), true);
});
