/**
 * How many sales files a store may download (app/api/store/export, what=sales; #5010 row 150, coordinator de89; held
 * for the owner's decision). A sales file reads every sale again: up to EXPORT_PAGES pages of each of the creator's two
 * Stripe lists, waited on, and every PayPal sale's record, each up to MAX_PAID_BYTES. At the ten essential requests a
 * day it could take before, that cost more than a Store plan can carry. It is now counted on its own,
 * SALES_FILES_PER_MONTH in each of the store's months (or its trial: the same window its figures use,
 * lib/allowance-window.ts), never taken from the studio's requests or any other figure, so downloading one's sales
 * still never depends on what the rest of the month used.
 *
 * The store's owner has SALES_FILES_PER_MONTH of their own, and the team (an Admin with "export") as many more between
 * them, so a teammate never uses up the owner's (#5267 audit, coordinator ea4f 8). A count taken and refused is given
 * back at once (ea4f 7). Stripe's pages are read before the PayPal records, the dearer part; once Stripe's first page
 * has answered, the place is spent even if the file fails, since reading was done (ea4f 9, 729c 11). A failure before
 * that gives it back, up to SALES_FILES_UNREAD_TRIES a window (focal 3634, 4).
 * A count that does not read, a billing month not known after asking Stripe, or a store with no statsId refuses with
 * nothing read (729c 12, 13).
 */
import { allowanceWindow, resetWords, windowKeySeconds } from "@/lib/allowance-window";
import { refreshPeriod } from "@/lib/billing-sync";
import { standingOf } from "@/lib/plan-standing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { SALES_FILES_PER_MONTH, SALES_FILES_UNREAD_TRIES } from "@/lib/studio-allowance-rules";
import { windowCount, windowCountOf } from "@/lib/window-count";
import type { Store } from "@/lib/store";

/** Said when the count cannot be read: nothing was read. */
export const SALES_FILES_UNCOUNTED = "Your sales file could not be counted just now. Nothing was read. Try again in a minute.";

/** How long one store's sales file holds its turn: a second click waits for the first (focal 3634, 5). */
export const SALES_FILE_BUSY_SECONDS = 120;

/** Said to a second click while the first is being made: nothing was counted. */
export const SALES_FILE_BUSY_WORDS = "Your sales file is already being made. It downloads in a moment. Nothing more was counted.";

/** Said when the store has no count of its own yet, after trying to make one: a lasting problem, not a passing one. */
export const SALES_FILES_NO_STORE_ID = "Your sales files can't be counted for this store yet, so nothing was read. Write to us and we will fix it.";

/** "this month", or "in this trial" when the store's window is its trial (729c 14). */
export function salesFilesSpan(store: Store, now = Date.now()): string {
  return standingOf(store, now / 1000) === "trial" ? "in this trial" : "this month";
}

/** The words for a window whose sales files are used: how many, whose, and when they open again. */
export function salesFilesUsedWords(store: Store, owner: boolean, now = Date.now()): string {
  const files = SALES_FILES_PER_MONTH === 1 ? "the 1 sales file" : `all ${SALES_FILES_PER_MONTH} sales files`;
  const whose = owner ? "You have used" : "Your team has used";
  return `${whose} ${files} ${salesFilesSpan(store, now)}. A try counts once your sales were read, even if the file could not be made. They never use up your monthly figures. ${resetWords(store, now)}`;
}

/** Said when a file failed: whether it counted, and how many are left. */
export function salesFileFailedWords(store: Store, counted: boolean, left: number, now = Date.now()): string {
  const span = salesFilesSpan(store, now);
  const leftWords = left === 1 ? "1 sales file is left" : `${left} sales files are left`;
  return counted
    ? `Stripe or our records did not answer while your sales were read. This try counted, because your sales were read. ${leftWords} ${span}. Try again in a moment.`
    : `Stripe or our records did not answer before your sales were read. Nothing was counted: ${leftWords} ${span}. Try again in a moment.`;
}

/**
 * Takes one of the window's sales files before anything is read, from the owner's own or the team's. "ok" with the
 * store as read again for its billing month, how many are left after it, and `unread`, which gives the place back
 * when nothing was read (up to SALES_FILES_UNREAD_TRIES a window); otherwise the answer to send (503 when the count or
 * the month is not known, 429 when the files are used).
 */
export async function takeSalesFile(
  store: Store,
  owner: boolean,
  now = Date.now(),
): Promise<{ ok: true; store: Store; left: number; unread: () => Promise<boolean> } | { ok: false; status: 429 | 503; message: string }> {
  if (!isRedisConfigured()) return { ok: true, store, left: SALES_FILES_PER_MONTH, unread: async () => true };
  if (!store.statsId) return { ok: false, status: 503, message: SALES_FILES_NO_STORE_ID };
  // The billing month as Stripe has it now, as holdStudio reads it, so a month not yet known is asked for first.
  const current = await refreshPeriod(store, now);
  const window = allowanceWindow(current, now);
  if (!window) return { ok: false, status: 503, message: resetWords(current, now) };
  const key = `nl:rl:export:${store.statsId}:${owner ? "sales" : "sales-team"}:${window.id}`;
  let count: number | null = null;
  try {
    count = windowCountOf(await redisPipeline(windowCount(key, windowKeySeconds(current, 86_400, now))));
  } catch (error) {
    console.error("counting a sales file failed", error);
  }
  if (count === null) return { ok: false, status: 503, message: SALES_FILES_UNCOUNTED };
  const giveBack = async () => {
    await redisPipeline([["DECR", key]]).catch((error) => console.error("giving back a sales file failed", error));
  };
  if (count > SALES_FILES_PER_MONTH) {
    await giveBack();
    return { ok: false, status: 429, message: salesFilesUsedWords(current, owner, now) };
  }
  // A try that failed before anything was read gives its place back, up to SALES_FILES_UNREAD_TRIES a window.
  const unreadKey = `nl:rl:export:${store.statsId}:sales-unread:${window.id}`;
  const unread = async (): Promise<boolean> => {
    try {
      const tries = windowCountOf(await redisPipeline(windowCount(unreadKey, windowKeySeconds(current, 86_400, now))));
      if (tries === null || tries > SALES_FILES_UNREAD_TRIES) return false;
    } catch (error) {
      console.error("counting a sales file that read nothing failed", error);
      return false;
    }
    await giveBack();
    return true;
  };
  return { ok: true, store: current, left: SALES_FILES_PER_MONTH - count, unread };
}
