/**
 * The words of the preview line (moved unchanged from lib/opening.ts, which re-exports them). Words only:
 * whether they are shown is PLANS_ON_SALE, decided in lib/opening.ts on the server. Kept apart so the site
 * menu, a browser component, can fall back to them without carrying that decision's review.
 */

/** What every public page says at its top while plans are not on sale. */
export const PREVIEW_LINE =
  "Marktmorgen is still being built. You can open a store and set it up today; its paid plans are not on sale yet.";

/** Where that line sends somebody who wants the detail: both lists, in full. */
export const PREVIEW_LINK = { href: "/mission", label: "See what is built" };
