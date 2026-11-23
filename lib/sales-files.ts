/**
 * How many sales files a store may download in a month (app/api/store/export, what=sales; #5010 row 150, coordinator
 * de89; held for the owner's decision). A sales file reads every sale again: up to EXPORT_PAGES pages of each
 * of the creator's two Stripe lists, waited on, and every PayPal sale's record, each up to MAX_PAID_BYTES. At the ten
 * essential requests a day it could take before, that cost more than a Store plan can carry. It is now counted on its
 * own, SALES_FILES_PER_MONTH in each of the store's months (the same month its figures use, lib/allowance-window.ts),
 * never taken from the studio's requests or any other figure, so downloading one's sales still never depends on what
 * the rest of the month used. A count that does not read refuses, with nothing read; a file that could not be made
 * gives its place back.
 */
import { allowanceWindow, resetWords, windowKeySeconds } from "@/lib/allowance-window";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { SALES_FILES_PER_MONTH } from "@/lib/studio-allowance-rules";
import { windowCount, windowCountOf } from "@/lib/window-count";
import type { Store } from "@/lib/store";

/** Said when the count cannot be read: nothing was read. */
export const SALES_FILES_UNCOUNTED = "Your sales file could not be counted just now. Nothing was read. Try again in a minute.";

/** The words for a month whose sales files are used: how many, and when they open again. */
export function salesFilesUsedWords(store: Store, now = Date.now()): string {
  const files = SALES_FILES_PER_MONTH === 1 ? "1 sales file" : `${SALES_FILES_PER_MONTH} sales files`;
  return `You have downloaded ${files} this month, which is what each month has. It never counts against your studio's requests. ${resetWords(store, now)}`;
}

/**
 * Takes one of the month's sales files before anything is read. "ok" with `giveBack`, which returns the place when
 * the file could not be made; otherwise the answer to send (503 when the count or the month is not known, 429 when
 * the month's files are used).
 */
export async function takeSalesFile(store: Store, now = Date.now()): Promise<{ ok: true; giveBack: () => Promise<void> } | { ok: false; status: 429 | 503; message: string }> {
  if (!isRedisConfigured() || !store.statsId) return { ok: true, giveBack: async () => {} };
  const window = allowanceWindow(store, now);
  if (!window) return { ok: false, status: 503, message: resetWords(store, now) };
  const key = `nl:rl:export:${store.statsId}:sales:${window.id}`;
  let count: number | null = null;
  try {
    count = windowCountOf(await redisPipeline(windowCount(key, windowKeySeconds(store, 86_400, now))));
  } catch (error) {
    console.error("counting a sales file failed", error);
  }
  if (count === null) return { ok: false, status: 503, message: SALES_FILES_UNCOUNTED };
  if (count > SALES_FILES_PER_MONTH) return { ok: false, status: 429, message: salesFilesUsedWords(store, now) };
  return {
    ok: true,
    giveBack: async () => {
      await redisPipeline([["DECR", key]]).catch((error) => console.error("giving back a sales file failed", error));
    },
  };
}
