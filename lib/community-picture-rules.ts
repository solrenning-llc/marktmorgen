/**
 * How many pictures a store's community may keep (added 18 October 2026).
 *
 * A member may post a picture of up to a megabyte (lib/product-image.ts,
 * MAX_IMAGE_BYTES), and until this day nothing bounded how many a community
 * kept: they sit in the file store outside the store's own folder, so its
 * storage figure never saw them. Each costs us to keep for as long as it is
 * kept, so each plan has a number, counted at the most a picture may weigh
 * (lib/community-files.ts, takePicturePlace), and tests/plan-cost-registry.ts
 * prices it in every plan's worst month.
 *
 * Client-safe: the pages that publish the number read this one.
 */
import type { Tier } from "@/lib/plan";
import { type PlanFields, costStandingOf } from "@/lib/plan-standing";
import { MAX_IMAGE_BYTES } from "@/lib/product-image";

export const COMMUNITY_PICTURES: Record<Tier, number> = { creator: 200, pro: 1_000, scale: 3_000 };
/** A free trial's community: a few, to try it with. A store with no plan running adds none. */
export const TRIAL_COMMUNITY_PICTURES = 20;

/** Each picture is counted as the most one may weigh. */
export const PICTURE_BYTES = MAX_IMAGE_BYTES;

/** The pictures this store's community may keep right now. */
export function picturesLimitFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): number {
  // No new pictures while a renewal is unpaid (232 [CA1] unit 4); those kept stay.
  const standing = costStandingOf(store, nowSeconds);
  if (standing === "paid") return COMMUNITY_PICTURES[store.tier ?? "creator"] ?? COMMUNITY_PICTURES.creator;
  return standing === "trial" ? TRIAL_COMMUNITY_PICTURES : 0;
}
