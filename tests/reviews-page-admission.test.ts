/**
 * A product's public reviews page reads the store's review summary and a page of its reviews (lib/reviews.ts) for
 * anybody who asks, so, as the product page it belongs to, it is one of the store's counted public requests and rests
 * once the window's requests are used (lib/traffic.ts, isResting): never a Redis read with no ceiling (MR, rule 30).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ReviewsPage from "@/app/[handle]/p/[product]/reviews/page";
import { addProduct, claimHandle, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { requestLimitFor } from "@/lib/traffic-rules";
import { takePublicRequest } from "@/lib/traffic";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = async () => { throw new Error("No external service in this test"); };
const owner = "reviews-admission@example.test", handle = "reviewsadmit";

async function fixture() {
  redis.clear();
  assert.equal((await claimHandle(owner, handle, "Synthetic reviews shop", "")).ok, true);
  await ensureStatsId(owner);
  assert.ok(await setSubscription(owner, { customerId: "cus_ReviewsAdmission", subscriptionId: "sub_ReviewsAdmission", active: true, tier: "creator", period: paidPeriod() }));
  const made = await addProduct(owner, "Synthetic guide", "", "19", null);
  assert.ok(made.ok);
  return { store: (await storeForEmail(owner))!, product: made.product.id };
}

async function render(product: string) {
  const original = redis.pipeline.bind(redis);
  const commands: (string | number)[][] = [];
  redis.pipeline = async (batch) => { commands.push(...batch); return original(batch); };
  let tree: unknown = null;
  try {
    tree = await ReviewsPage({ params: Promise.resolve({ handle: "@" + handle, product }), searchParams: Promise.resolve({}) });
  } finally {
    redis.pipeline = original;
  }
  const reviewReads = commands.filter((c) => String(c[1] ?? "").startsWith("nl:rev:")).length;
  const counted = commands.findIndex((c) => c[0] === "INCRBY" && String(c[1]).startsWith("nl:traffic:r:"));
  const firstReview = commands.findIndex((c) => String(c[1] ?? "").startsWith("nl:rev:"));
  return { tree, reviewReads, counted, firstReview };
}

test("control: an open store's reviews page counts one public request before it reads the reviews", async () => {
  const { product } = await fixture();
  const seen = await render(product);
  assert.ok(seen.tree);
  assert.ok(seen.counted >= 0, "the page is counted as one of the store's public requests");
  assert.ok(seen.firstReview > seen.counted, JSON.stringify({ reviewReads: seen.reviewReads, counted: seen.counted, firstReview: seen.firstReview }));
});

test("a store whose public requests are used rests: the reviews are never read", async () => {
  const { store, product } = await fixture();
  assert.equal(await takePublicRequest(store, "buyer", undefined, requestLimitFor(store)), true);
  const seen = await render(product);
  assert.equal(seen.reviewReads, 0, `the reviews were read for a resting store: ${JSON.stringify({ reviewReads: seen.reviewReads, counted: seen.counted, firstReview: seen.firstReview })}`);
});
