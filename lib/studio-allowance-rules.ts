/**
 * How the studio's requests are counted against a store's window
 * (lib/store-allowance-rules.ts, kind "studio"; lib/studio-route.ts).
 *
 * A request from the studio's own code is one; a page of the studio drawn
 * reads far more (the store, its plan, its products, its numbers) and is
 * STUDIO_PAGE_UNITS. What the owner needs to pay, leave or take their data
 * away is never refused by the window's figure: moving to a larger plan,
 * cancelling, deleting the store, downloading its data, and leaving a team
 * or choosing a store in the switcher. Those have ESSENTIAL_PER_DAY a store
 * a day instead, which tests/plan-cost-registry.ts prices with the rest.
 */
import type { Need } from "@/lib/studio-route";

export const STUDIO_PAGE_UNITS = 4;
/** RED stub: 766 [STN13] unit 1. */
export const STUDIO_SEARCH_UNITS = 0;
export const ESSENTIAL_NEEDS: readonly Need[] = ["billing", "delete", "export", "member"];
export const ESSENTIAL_PER_DAY = 10;
