/**
 * A person's reviews in their copy are read as the erasure reads them (CX-123
 * rules 24 and 30; Claude 3 cloud I, erasure audit 14/11/2026).
 *
 * The copy read each review with readReview, which answers null for a kept
 * review that does not read, so it was left out and the copy given as
 * complete; the erasure throws on the same record (storedReview). Nor was a
 * kept review checked to be the one asked for. Now both throw. Synthetic data only.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { erasureScope } from "@/lib/person-erasure";
import { COPIERS } from "@/lib/person-copy";
import { reviewId } from "@/lib/reviews";
import { store as redis } from "./redis-stub";

const OWNER = "owner.rc@example.test";
const BUYER = "buyer.rc@example.test";
const PRODUCT = "prod000001";

async function setup() {
  redis.clear();
  await claimHandle(OWNER, "rcreviews", "RC Reviews", "");
  await ensureStatsId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const scope = { ...(await erasureScope(store, BUYER))!, productIds: [PRODUCT] };
  const statsId = store.statsId!;
  const id = reviewId(statsId, PRODUCT, BUYER);
  const review = (over: object = {}) => JSON.stringify({ id, productId: PRODUCT, rating: 5, text: "Great course.", name: "Rae", createdAt: 1_800_000_000, ...over });
  const keep = (value: string) => redis.pipeline([["HSET", `nl:rev:${statsId}:${PRODUCT}`, id, value]]);
  return { copy: () => COPIERS["lib/reviews.ts"](scope), review, keep };
}

test("the copy: the person's review is copied", async () => {
  const { copy, review, keep } = await setup();
  await keep(review());
  assert.deepEqual(((await copy()) as { text: string }[]).map((r) => r.text), ["Great course."]);
});

test("the copy: a kept review that does not read is not left out", async () => {
  const { copy, keep } = await setup();
  await keep(JSON.stringify({ id: "x" }));
  await assert.rejects(copy(), (error: Error) => error.name === "UnknownReplyError");
});

test("the copy: a kept review of another id is not given as theirs (rule 30)", async () => {
  const { copy, review, keep } = await setup();
  await keep(review({ id: "f".repeat(24) }));
  await assert.rejects(copy(), (error: Error) => error.name === "UnknownReplyError");
});
