/**
 * An alarm when a store's window of requests is used up much faster than the
 * window passes (TODOS-51 D): it tells the person who runs the site, and it
 * never changes a count, a store or what any page shows.
 *
 * It costs nothing on an ordinary request. lib/traffic.ts (countRequest)
 * already holds the window's count after each INCRBY; this looks at it only
 * when that INCRBY carried the count across one of SPIKE_MARKS (half, three
 * quarters, nine tenths of the window's requests), so at most three times a
 * window per store. Only then, when that mark came before its share of the window's time
 * (spikeMark), does it spend one claim per store, window and mark, one count
 * toward the day's ceiling on all such emails (SPIKE_ALERTS_PER_DAY) and one
 * email paid by the company. A reply in another shape, a missing operator or a
 * spent ceiling sends nothing (CX-123 rule 24); a failure here never reaches
 * the request being counted.
 */
import type { AllowanceWindow } from "@/lib/allowance-window";
import { NIMBUS_FROM, sendEmail } from "@/lib/email";
import { configuredDemoStudioAdmin } from "@/lib/house-store";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { SITE_URL } from "@/lib/site-url";
import type { Store } from "@/lib/store";

/** Each mark: the share of the window's requests, and the share of its time before which reaching it is abnormal. */
export const SPIKE_MARKS = [
  { requests: 0.5, before: 0.25 },
  { requests: 0.75, before: 0.4 },
  { requests: 0.9, before: 0.6 },
] as const;

/** The most of these emails the company sends in a UTC day, whatever the number of stores. */
export const SPIKE_ALERTS_PER_DAY = 30;

const DAY_SECONDS = 86_400;

/** The count at which a mark is reached: the first whole request at or past its share. */
export const markCount = (limit: number, share: number) => Math.ceil(limit * share);

/**
 * Which mark the INCRBY of `units` that left the window at `count` carried it
 * across, when it did so early: the index in SPIKE_MARKS, or null. Pure, so
 * every other request costs nothing.
 */
export function spikeMark(count: number, units: number, limit: number, window: Pick<AllowanceWindow, "start" | "end">, now: number): number | null {
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(units) || units < 1 || !Number.isSafeInteger(limit) || limit < 4) return null;
  const span = window.end - window.start;
  if (!(span > 0) || now < window.start || now >= window.end) return null;
  const elapsed = (now - window.start) / span;
  const before = count - units;
  // The highest mark crossed by this one INCRBY: a large one may cross two at once.
  let index = -1;
  SPIKE_MARKS.forEach((mark, i) => {
    const at = markCount(limit, mark.requests);
    if (before < at && count >= at) index = i;
  });
  if (index < 0) return null;
  return elapsed < SPIKE_MARKS[index].before ? index : null;
}

const claimKey = (folder: string, window: string, mark: number) => `nl:traffic:spike:${folder}:${window}:${mark}`;
const dayKey = (now: number) => `nl:traffic:spike-day:${new Date(now).toISOString().slice(0, 10)}`;

type Send = typeof sendEmail;

/**
 * Tells the operator once that this store reached a mark early. True only when
 * the email was handed over. Never throws.
 */
export async function alertSpike(
  store: Pick<Store, "handle">,
  folder: string,
  window: AllowanceWindow,
  count: number,
  units: number,
  limit: number,
  now = Date.now(),
  send: Send = sendEmail,
): Promise<boolean> {
  const mark = spikeMark(count, units, limit, window, now);
  if (mark === null) return false;
  const operator = configuredDemoStudioAdmin();
  if (!operator || !isRedisConfigured()) return false;
  try {
    // Once per store, window and mark: kept until a day after the window ends.
    const keep = Math.max(DAY_SECONDS, Math.ceil((window.end - now) / 1000) + DAY_SECONDS);
    const claim = repliesFor(await redisPipeline([["SET", claimKey(folder, window.id, mark), "1", "NX", "EX", keep]]), 1);
    if (!claim || claim[0] !== "OK") return false;
    // The day's ceiling on all of them, counted before the email.
    const day = repliesFor(await redisPipeline([["INCR", dayKey(now)], ["EXPIRE", dayKey(now), 2 * DAY_SECONDS]]), 2);
    const sent = day ? countOf(day[0]) : null;
    if (sent === null || sent < 1 || sent > SPIKE_ALERTS_PER_DAY) return false;
    const share = Math.round(SPIKE_MARKS[mark].requests * 100);
    const elapsed = Math.max(0, Math.round(((now - window.start) / (window.end - window.start)) * 100));
    const lines = [
      `@${store.handle} has used ${share}% of the requests of its window ${window.id} (${count.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")}) after ${elapsed}% of the window's time.`,
      "",
      "Nothing was changed: the store, its counts and its pages are as they were. This is a note to look at it.",
      "",
      `The store: ${SITE_URL}/@${store.handle}`,
      "",
      `At most one such email per store, window and mark, and at most ${SPIKE_ALERTS_PER_DAY} a day in all.`,
    ];
    return await send({
      meter: { by: "company" },
      from: NIMBUS_FROM,
      to: operator,
      subject: `@${store.handle}: ${share}% of its requests after ${elapsed}% of its window`.slice(0, 180),
      text: lines.join("\n"),
    }).catch(() => false);
  } catch {
    return false;
  }
}
