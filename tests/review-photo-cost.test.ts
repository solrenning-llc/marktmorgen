/**
 * A buyer's review photo is a file kept in the file store (lib/review-photo.ts, keepReviewPhoto: one put of up to
 * MAX_REVIEW_PHOTO_BYTES), with no figure of its own (CI audit of the cost registry, 13 November 2026). Until then no
 * line of tests/plan-cost-registry.ts priced it: the photos a store keeps were outside every plan's worst month.
 *
 * What bounds them in code today: a photo belongs to one review (setReviewPhoto puts it on the review and takes off
 * the one before), and every review takes room in the store's data room before it is written (lib/reviews.ts,
 * saveReview, takeData), refused past the plan's DATA_ROOM_BYTES. So a store keeps at most
 * DATA_ROOM_BYTES / (the room the smallest review takes) photos at once, each at most MAX_REVIEW_PHOTO_BYTES.
 *
 * Measured here with the real saveReview against the in-memory Redis double (synthetic store only): the room the
 * smallest review takes, then the registry's "review-photos" line held to at least that many photos at their
 * heaviest, at the dearest store a file may be in, for every plan.
 */
import { claimHandle, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { saveReview } from "@/lib/reviews";
import { dataUsed } from "@/lib/store-data";
import { DATA_ROOM_BYTES } from "@/lib/store-data-rules";
import { MAX_REVIEW_PHOTO_BYTES } from "@/lib/review-summary";
import { COST_LINES, GB, STORAGE_PER_GB } from "./plan-cost-registry";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

async function main(): Promise<void> {
  redis.clear();
  const owner = "lens@example.com";
  await claimHandle(owner, "lensshop", "Lens store", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await setSubscription(owner, { customerId: "cus_lens", subscriptionId: "sub_lens", active: true, tier: "scale", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  const statsId = store.statsId as string;

  part("1. The room the smallest review takes, measured");
  const before = (await dataUsed(store))!.used;
  // No words, no name, the shortest order reference and no payment id: the least a review can weigh.
  const saved = await saveReview(statsId, { productId: "p00001", email: "a@b.co", reference: "r", pi: "", rating: 5, text: "", name: "" }, store);
  is("written", saved.state, "created");
  const smallest = (await dataUsed(store))!.used - before;
  console.log(`  the smallest review takes ${smallest} bytes of the data room`);
  is("it takes room before it is written", smallest > 0, true);

  part("2. The registry prices every photo the data room lets a store keep, at its heaviest");
  const line = COST_LINES.find((each) => each.id === "review-photos");
  is("a line for review photos", Boolean(line), true);
  if (line) {
    for (const tier of ["creator", "pro", "scale"] as const) {
      const photos = Math.floor(DATA_ROOM_BYTES[tier] / smallest);
      const worst = ((photos * MAX_REVIEW_PHOTO_BYTES) / GB) * STORAGE_PER_GB;
      console.log(`  ${tier}: at most ${photos} photos, $${worst.toFixed(4)} a month; line $${line.monthlyUsd(tier).toFixed(4)}`);
      is(`${tier}: the line holds every photo at its heaviest`, line.monthlyUsd(tier) >= worst - 1e-12, true);
    }
    const cited = line.sources.flatMap((source) => source.names.map((name) => `${source.file}:${name}`));
    is("it cites the put and the photo's size", ["lib/review-photo.ts:keepReviewPhoto", "lib/review-summary.ts:MAX_REVIEW_PHOTO_BYTES"].every((name) => cited.includes(name)), true);
  }
  done();
}

main();
