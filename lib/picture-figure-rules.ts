/**
 * A store's pictures figure (507 [SG3]; security finding MM-SA-08): how many
 * bytes of pictures a store may keep at once, outside its storage figure.
 *
 * Pictures (a product's, a link's, a page's, the AI writer's, an email's, a
 * review's photo) are kept outside the storage figure, and until this figure
 * nothing bounded them. The figure is what the store's own month of requests
 * could add: each studio request a picture of at most MAX_IMAGE_BYTES and each
 * buyer action a review photo of at most MAX_REVIEW_PHOTO_BYTES, paying or not
 * (allowanceFor), so no store loses room it can use in a month. Its cost is in
 * docs/pictures-figure-proposal.md.
 *
 * Off: PICTURE_FIGURE_ON is false and no picture door takes a place yet. The
 * doors, the sweep of pictures attached to nothing and the cost line come in
 * their own units. Client-safe.
 */
import type { Tier } from "@/lib/plan";
import type { PlanFields } from "@/lib/plan-standing";
import { MAX_IMAGE_BYTES } from "@/lib/product-image";
import { MAX_REVIEW_PHOTO_BYTES } from "@/lib/review-summary";
import { allowanceFor } from "@/lib/store-allowance-rules";

/** Off until the owner confirms the figure: nothing takes a place yet. */
export const PICTURE_FIGURE_ON = false;

/** The bytes of pictures this store may keep at once. */
export function picturesFigureFor(store: PlanFields & { tier?: Tier }, nowSeconds = Date.now() / 1000): number {
  return allowanceFor(store, "studio", nowSeconds) * MAX_IMAGE_BYTES + allowanceFor(store, "buyer", nowSeconds) * MAX_REVIEW_PHOTO_BYTES;
}
