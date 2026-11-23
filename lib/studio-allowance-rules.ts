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
/**
 * A search of the studio's one search box (766 [STN13]; app/api/store/studio-search) is this many of the store's
 * studio requests, taken before it reads: the request itself and one exact read of every product's name, up to
 * MAX_PRODUCTS of them, with its two counters (held in tests/stn13-studio-search.test.ts and
 * tests/plan-cost-registry.ts, line studio).
 */
export const STUDIO_SEARCH_UNITS = 2;
export const ESSENTIAL_NEEDS: readonly Need[] = ["billing", "delete", "export", "member"];
export const ESSENTIAL_PER_DAY = 10;
/**
 * Sales files a store's owner may download in each of its months, or in its trial (lib/sales-files.ts; #5010 row 150),
 * and as many more for its team between them: counted on their own, never from the studio's requests or any other
 * figure, and priced in tests/plan-cost-registry.ts ("sales-files").
 */
export const SALES_FILES_PER_MONTH: number = 3;

/**
 * How many tries a window may fail before anything was read and still give their place back (lib/sales-files.ts;
 * #5267 focal 3634, 4): Stripe not answering its first page, say. Past them, such a try keeps its place, so an account
 * that always fails cannot read Stripe for free; each is priced in tests/plan-cost-registry.ts (SALES_FILE_UNREAD_COST).
 */
export const SALES_FILES_UNREAD_TRIES: number = 3;

/** What the sales files hold, said before the click and on every page that promises them (#5267 audit, ea4f 5, 6, 10). */
export const SALES_FILES_WORDS = `The store's owner can download up to ${SALES_FILES_PER_MONTH} sales files a month (or in a trial), and the team up to ${SALES_FILES_PER_MONTH} more between them. A try counts once your sales are read. They never use up your monthly figures.`;
