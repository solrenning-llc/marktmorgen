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
 * back at once (ea4f 7). Once the file has started reading (the PayPal records first, then Stripe's pages), its place
 * is spent even if it fails, since that reading was done (ea4f 9, 729c 11); only a failure before it gives it back.
 * A count that does not read, a billing month not known after asking Stripe, or a store with no statsId refuses with
 * nothing read (729c 12, 13).
 */
import { allowanceWindow, resetWords, windowKeySeconds } from "@/lib/allowance-window";
import { refreshPeriod } from "@/lib/billing-sync";
import { standingOf } from "@/lib/plan-standing";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { SALES_FILES_PER_MONTH } from "@/lib/studio-allowance-rules";
import { windowCount, windowCountOf } from "@/lib/window-count";
import type { Store } from "@/lib/store";

/** Said when the count cannot be read: nothing was read. */
export const SALES_FILES_UNCOUNTED = "Your sales file could not be counted just now. Nothing was read. Try again in a minute.";

/** "this month", or "in this trial" when the store's window is its trial (729c 14). */
export function salesFilesSpan(store: Store, now = Date.now()): string {
  return standingOf(store, now / 1000) === "trial" ? "in this trial" : "this month";
}

/** The words for a window whose sales files are used: how many, whose, and when they open again. */
export function salesFilesUsedWords(store: Store, owner: boolean, now = Date.now()): string {
  const files = SALES_FILES_PER_MONTH === 1 ? "1 sales file" : `${SALES_FILES_PER_MONTH} sales files`;
  const who = owner ? "You have downloaded" : "Your team has downloaded";
  return `${who} ${files} ${salesFilesSpan(store, now)}, which is all there is. They never use up your monthly figures. ${resetWords(store, now)}`;
}

/**
 * Takes one of the window's sales files before anything is read, from the owner's own or the team's. "ok" with the
 * store as read again for its billing month, and `giveBack`, which returns the place only when nothing was read yet;
 * otherwise the answer to send (503 when the count or the month is not known, 429 when the files are used).
 */
export async function takeSalesFile(
  store: Store,
  owner: boolean,
  now = Date.now(),
): Promise<{ ok: true; store: Store; giveBack: () => Promise<void> } | { ok: false; status: 429 | 503; message: string }> {
  if (!isRedisConfigured()) return { ok: true, store, giveBack: async () => {} };
  if (!store.statsId) return { ok: false, status: 503, message: SALES_FILES_UNCOUNTED };
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
  return { ok: true, store: current, giveBack };
}
