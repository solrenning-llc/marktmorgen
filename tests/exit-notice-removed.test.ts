/**
 * Claude 1's review of #3730 (cloud C4), the moved notice of a closed store (97 [D2-OPEN-EXIT]):
 *   - MEDIUM 1: once the closing day's walk removed the store's files (state `removed`), closingOf answered null, so
 *     the old address showed the store "as always" until its record was deleted, up to ERASE_WITHIN_DAYS. The page now
 *     reads closingDayBegun (lib/plan-closing.ts): the closing day has begun for as long as the store is in the final
 *     line, its files removed or not.
 *   - MEDIUM 2: the released address (closeStoreRecord) carried the closedAt kept when the notice was chosen, not the
 *     day the store really closed, so a day moved later ended the notice weeks early. The closing day, once it begins,
 *     writes the real day into the notice (setExitNoticeDay), so the released copy counts its 90 days from it.
 *   - LOW: the page read the closing twice a render and for every store with a notice; it now reads it once, and only
 *     for a store whose plan has ended (a store that pays never closes, so its front page reads nothing more).
 * Synthetic only: the in-memory store, the real readers and writers.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claimHandle, closeStoreRecord, storeForEmail, storeHandleKey, storeRef } from "@/lib/store";
import { KEEP_NOTHING_FROM } from "@/lib/plan-closing-rules";
import * as closing from "@/lib/plan-closing";
import * as store from "@/lib/store";
import { FINAL_INDEX } from "@/lib/closing-holds";
import { EXIT_NOTICE_DAYS, exitAnswerForStore, exitAnswerForValue, type ExitNotice } from "@/lib/exit-redirect-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400_000;
const OWNER = "exitremoved@example.com";
const stateKey = (key: string) => `nl:plan:closing:${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "exitremoved", "Exit Removed", "");
  const shop = (await storeForEmail(OWNER))!;
  const ref = storeRef(shop);
  const endedAt = Math.max(KEEP_NOTHING_FROM, Date.now()) + DAY;
  const chosenDay = endedAt + 30 * DAY;
  const realDay = chosenDay + 30 * DAY;
  const notice: ExitNotice = { to: "https://example.com/", host: "example.com", closedAt: chosenDay, setAt: chosenDay - 2 * DAY };
  const begun = (closing as unknown as { closingDayBegun?: (ref: string, now?: number) => Promise<{ day: number; today: true } | null> }).closingDayBegun;
  const setDay = (store as unknown as { setExitNoticeDay?: (ref: string, day: number) => Promise<boolean> }).setExitNoticeDay;

  part("MEDIUM 1: the notice stays once the walk removed the store's files");
  await redis.pipeline([
    ["ZADD", FINAL_INDEX, String(endedAt), ref],
    ["SET", stateKey(ref), JSON.stringify({ day: realDay, removed: realDay + 1, due: realDay + 1 })],
  ]);
  const read = begun ? await begun(ref, realDay + 2 * DAY) : null;
  is("the closing day has begun, files removed or not", read, { day: realDay, today: true });
  is("so the old address shows the notice, counted from the real day", exitAnswerForStore({ exitNotice: notice }, read, realDay + 2 * DAY), { kind: "moved", to: notice.to, host: notice.host, until: realDay + EXIT_NOTICE_DAYS * DAY });
  await redis.pipeline([["ZREM", FINAL_INDEX, ref]]);
  is("a store not in the final line: not begun", begun ? await begun(ref, realDay) : "missing", null);

  part("MEDIUM 2: the released address counts from the day the store really closed");
  await store.chooseExitNotice(ref, "https://example.com/", { endedAt, day: chosenDay }, endedAt + DAY);
  is("the notice was chosen with the day known then", (await storeForEmail(OWNER))?.exitNotice?.closedAt, chosenDay);
  is("the closing day writes the real day into it", setDay ? await setDay(ref, realDay) : "missing", true);
  const after = (await storeForEmail(OWNER))!;
  is("which the record now carries", after.exitNotice?.closedAt, realDay);
  await closeStoreRecord(after);
  const [released] = await redis.pipeline([["GET", storeHandleKey("exitremoved")]]);
  is("the released address still shows the notice weeks after the day first chosen", exitAnswerForValue(released, chosenDay + 100 * DAY).kind, "moved");

  part("LOW: read once a render, and only for a store whose plan has ended");
  const page = readFileSync(join(process.cwd(), "app/[handle]/page.tsx"), "utf8");
  is("the page reads closingDayBegun, never closingOf", [/closingDayBegun/.test(page), /closingOf\(/.test(page)], [true, false]);
  is("once a render (React cache)", /cache\(/.test(page), true);
  is("and only for a store whose plan has ended", /standingOf\([^)]*\) !== "ended"/.test(page), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
