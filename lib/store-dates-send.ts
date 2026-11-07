/**
 * Making the email of each of a store's own dates, once a year
 * (lib/store-dates-rules.ts, 283 [HG2] unit 2).
 *
 * Once a day, inside the daily job (app/api/cron/plans), for every store that
 * turned it on: each date whose day it is (UTC), or was in the last
 * STORE_DATE_WINDOW_DAYS when it was not made yet (dueYear), becomes one of the store's own emails to its whole
 * list, made exactly as the creator's "Send now" in Email makes one
 * (lib/broadcasts.ts, createBroadcast) and sent by the scheduled job that
 * sends every such email (app/api/cron/mail, advanceAll). So it goes, like
 * every one of them, only to people on the list who agreed to hear from the
 * creator and may still be written to (never somebody who left, whose address
 * bounced, who marked an email as spam, or who was deleted from the store),
 * each person once, with the list email's footer: why they get it, a
 * one-click way off the list and the creator's postal address. The store's
 * emails are checked before it is made (too few left this month, it is not
 * made) and taken before each batch goes.
 *
 * Before an email is made:
 *
 *   - the list email must be set up and the plan must include email, or
 *     nothing is taken and the studio is told why;
 *   - the date's mark for that year is claimed exactly (lib/claim-mark.ts):
 *     taken by another run, or an answer not known, makes nothing;
 *   - one studio request is taken from the store's month (lib/store-allowance.ts),
 *     the same the creator's own "Send now" takes: none left, none made.
 *
 * The mark is let go whenever nothing was made, so a later run inside the
 * date's week can try again; it is kept when the email was made, or when its
 * writing could not be confirmed (it may exist: never a second).
 *
 * Fair across stores. At most `limit` emails are tried in one run, for the
 * whole platform (DATE_EMAILS_PER_RUN), so on a day many stores' dates fall
 * on (January 1, December 25) one run cannot make them all. The run then
 * walks on without making anything, noting "waiting" on each date due and
 * not made yet this year, and the next run starts from the first store it
 * did not get to (the cursor), so every store's turn comes, in order. A date
 * stays due for STORE_DATE_WINDOW_DAYS; one still not made by then is not
 * made that year, and its last note says why (the studio: "waiting" past the
 * week reads as not sent because too many were due at once).
 *
 *   nl:hgd:made:<statsId>:<MMDD>:<year>   that date's email for that year, MADE_DAYS
 *   nl:hgd:last:<statsId>                 hash: <MMDD> → what happened that year, for the studio, LAST_DAYS
 *   nl:hgd:cursor                         where the last run stopped
 *
 * Nothing about any person is kept here: who it went to is the email's own
 * record (lib/broadcasts.ts), as for every email of the store.
 */
import { isSenderConfigured } from "@/lib/email";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { claimMark, claimValue, releaseMark } from "@/lib/claim-mark";
import { type Store, setStoreDates, storeForEmail, storesAfter } from "@/lib/store";
import { DataRoomError } from "@/lib/store-data";
import { takeAllowance } from "@/lib/store-allowance";
import { monthlyAllowance } from "@/lib/mail";
import { BroadcastWriteUnconfirmed, createBroadcast } from "@/lib/broadcasts";
import { type DatesRefusal, dateKey, dueYear, readStoreDatesInput, storeDatesOn } from "@/lib/store-dates-rules";

const CURSOR_KEY = "nl:hgd:cursor";
/** A date's mark outlives its window by far: once per date per year. */
const MADE_DAYS = 40;
const LAST_DAYS = 400;
/** At most this many dates' emails tried in one run (a studio request taken for each); the rest the next run, inside each date's window. */
export const DATE_EMAILS_PER_RUN = 50;

const madeKey = (statsId: string, key: string, year: number) => `nl:hgd:made:${statsId}:${key}:${year}`;
const lastKey = (statsId: string) => `nl:hgd:last:${statsId}`;

/**
 * What happened to a date's email in a year, as the studio says it:
 * made (to `total` people), or not made and why.
 */
export type DateOutcome = "made" | "setup" | "plan" | "studio" | "allowance" | "empty" | "room" | "unconfirmed" | "error" | "waiting";
export type DateResult = { year: number; at: number; outcome: DateOutcome; total: number };
const OUTCOMES: readonly DateOutcome[] = ["made", "setup", "plan", "studio", "allowance", "empty", "room", "unconfirmed", "error", "waiting"];

async function note(statsId: string, key: string, result: DateResult): Promise<void> {
  await redisPipeline([
    ["HSET", lastKey(statsId), key, JSON.stringify(result)],
    ["EXPIRE", lastKey(statsId), LAST_DAYS * 86_400],
  ]).catch(() => null);
}

function parseResult(raw: unknown): DateResult | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const { year, at, outcome, total } = value;
    if (!Number.isSafeInteger(year) || !Number.isSafeInteger(at) || !Number.isSafeInteger(total) || (total as number) < 0) return null;
    if (!OUTCOMES.includes(outcome as DateOutcome)) return null;
    return { year: year as number, at: at as number, outcome: outcome as DateOutcome, total: total as number };
  } catch {
    return null;
  }
}

/** What happened to each date's email the last time it was due, by its key; empty when nothing is known. */
export async function readStoreDateResults(store: Pick<Store, "statsId">): Promise<Map<string, DateResult>> {
  const out = new Map<string, DateResult>();
  if (!store.statsId || !isRedisConfigured()) return out;
  const replies = repliesFor(await redisPipeline([["HGETALL", lastKey(store.statsId)]]).catch(() => null), 1);
  const flat = replies && Array.isArray(replies[0]) ? (replies[0] as unknown[]) : [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const result = parseResult(flat[i + 1]);
    if (typeof flat[i] === "string" && result) out.set(flat[i] as string, result);
  }
  return out;
}

export type SaveRefusal = DatesRefusal | "none" | "setup" | "plan";

/**
 * Saves what the studio sent, checked whole. Turning it on needs the list
 * email set up (its sender name and postal address go on every email) and a
 * plan that includes email: otherwise it would be a setting that does nothing.
 */
export async function saveStoreDates(ref: string, raw: unknown, now = Date.now()): Promise<{ ok: true; store: Store } | { ok: false; reason: SaveRefusal; index?: number }> {
  const store = await storeForEmail(ref);
  if (!store) return { ok: false, reason: "none" };
  const read = readStoreDatesInput(raw, store.storeDates, now);
  if (!read.ok) return read;
  if (read.value.on && (!store.mail || !store.listId)) return { ok: false, reason: "setup" };
  if (read.value.on && monthlyAllowance(store) === 0) return { ok: false, reason: "plan" };
  const next = await setStoreDates(ref, read.value);
  return next ? { ok: true, store: next } : { ok: false, reason: "none" };
}

/** One store's dates due now: `budget.left` emails may still be tried this run. `stopped` when it ran out before this store was done. */
async function storeDatesStore(store: Store, deadline: number, now: number, budget: { left: number }): Promise<{ made: number; stopped: boolean }> {
  let made = 0;
  if (!storeDatesOn(store) || !store.statsId) return { made, stopped: false };
  const statsId = store.statsId;
  for (const date of store.storeDates.dates) {
    const year = dueYear(date, now);
    if (year === null) continue;
    if (Date.now() >= deadline || budget.left <= 0) return { made, stopped: true };
    const key = dateKey(date);
    const at = Date.now();
    // Nothing taken, nothing claimed, when it could not be made anyway: the studio is told why.
    if (!store.mail || !store.listId) {
      await note(statsId, key, { year, at, outcome: "setup", total: 0 });
      continue;
    }
    if (monthlyAllowance(store) === 0) {
      await note(statsId, key, { year, at, outcome: "plan", total: 0 });
      continue;
    }
    const mark = madeKey(statsId, key, year);
    const claim = claimValue();
    // Ours only on an exact claim: made already this year, or an unknown answer, makes nothing.
    if ((await claimMark(mark, MADE_DAYS * 86_400, claim)) !== "ours") continue;
    let keep = false;
    try {
      // One studio request, as the creator's own "Send now" takes, before the list is read.
      const taken = await takeAllowance(store, "studio", 1);
      if (!taken.ok) {
        await note(statsId, key, { year, at, outcome: "studio", total: 0 });
        continue;
      }
      budget.left -= 1;
      const created = await createBroadcast(store, { subject: date.subject, body: date.message, productId: "", notProductId: "", sendAt: undefined, who: "all" });
      if (created.ok) {
        keep = true;
        made += 1;
        await note(statsId, key, { year, at, outcome: "made", total: created.broadcast.total });
      } else {
        const outcome: DateOutcome = created.reason === "allowance" || created.reason === "empty" || created.reason === "plan" || created.reason === "setup" ? created.reason : "error";
        await note(statsId, key, { year, at, outcome, total: 0 });
      }
    } catch (error) {
      if (error instanceof BroadcastWriteUnconfirmed) {
        // It may have been written: never a second one this year.
        keep = true;
        await note(statsId, key, { year, at, outcome: "unconfirmed", total: 0 });
      } else {
        await note(statsId, key, { year, at, outcome: error instanceof DataRoomError ? "room" : "error", total: 0 });
        if (!(error instanceof DataRoomError)) console.error("making a store date's email failed", store.handle, error);
      }
    } finally {
      if (!keep) await releaseMark(mark, claim);
    }
  }
  return { made, stopped: false };
}

/**
 * A store this run has no emails left for: each date due and not made yet this year is noted "waiting"
 * for the studio, unless this year's result is already there (made, or why not). Nothing is claimed or taken.
 */
async function noteWaiting(store: Store, now: number): Promise<void> {
  if (!storeDatesOn(store) || !store.statsId) return;
  const statsId = store.statsId;
  for (const date of store.storeDates.dates) {
    const year = dueYear(date, now);
    if (year === null) continue;
    const key = dateKey(date);
    const [raw] = await redisPipeline([["HGET", lastKey(statsId), key]]);
    const prior = parseResult(raw);
    if (prior && prior.year === year) continue;
    await note(statsId, key, { year, at: Date.now(), outcome: "waiting", total: 0 });
  }
}

/**
 * The daily run: every store with its dates on, from where the last run stopped. Once this run's emails
 * are spent, it walks on only to note the dates left waiting, and the next run starts from the first store
 * it did not make for.
 */
export async function sendStoreDates(deadline: number, now = Date.now(), limit = DATE_EMAILS_PER_RUN): Promise<{ stores: number; made: number }> {
  const counts = { stores: 0, made: 0 };
  if (!isRedisConfigured() || !isSenderConfigured()) return counts;
  const budget = { left: limit };
  const [saved] = await redisPipeline([["GET", CURSOR_KEY]]);
  const [savedCursor, savedDone] = typeof saved === "string" ? saved.split("|") : ["0", "0"];
  let cursor = /^\d+$/.test(savedCursor ?? "") ? savedCursor : "0";
  let skip = Number(savedDone) || 0;
  // Where the next run starts: the first store this one ran out of emails for, once it did.
  let resume: string | null = null;
  while (Date.now() < deadline) {
    const { stores, next } = await storesAfter(cursor);
    let done = 0;
    for (const store of stores) {
      if (done < skip) {
        done += 1;
        continue;
      }
      if (Date.now() >= deadline) break;
      if (storeDatesOn(store) && store.statsId) {
        counts.stores += 1;
        try {
          if (resume === null && budget.left > 0) {
            const result = await storeDatesStore(store, deadline, now, budget);
            counts.made += result.made;
            // Out of time or of this run's emails inside this store: the next run starts with it again.
            if (result.stopped) {
              resume = `${cursor}|${done}`;
              if (Date.now() < deadline) await noteWaiting(store, now);
            }
          } else {
            resume ??= `${cursor}|${done}`;
            await noteWaiting(store, now);
          }
        } catch (error) {
          console.error("making a store's date emails failed", store.handle, error);
        }
      }
      done += 1;
    }
    if (done < stores.length) {
      await redisPipeline([["SET", CURSOR_KEY, resume ?? `${cursor}|${done}`]]);
      return counts;
    }
    skip = 0;
    cursor = next;
    if (next === "0") break;
  }
  await redisPipeline([["SET", CURSOR_KEY, resume ?? `${cursor}|0`]]);
  return counts;
}
