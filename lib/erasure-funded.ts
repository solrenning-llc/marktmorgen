/**
 * A person's erasure in a closed store is never refused for its cost
 * (owner's decision DONO-20261113-DEC-1, 13 November 2026, option (a)).
 *
 * A store whose plan ended keeps a small studio window (100 units a month,
 * lib/store-allowance-rules.ts NON_PAYING_ALLOWANCES.ended), and an erasure
 * is taken from it (lib/person-erasure.ts). Past about 58 products with no
 * course an erasure needs more than the whole window, and until this change
 * it answered "limit": a deletion the law requires could not be made.
 *
 * The owner chose: the part of the erasure past what is left of the store's
 * window is paid by the company, from its own funded exposure for it
 * (`erasure_overflow`, lib/funded-exposure-rules.ts), never from the store's
 * window, and the erasure is never refused for it. Its automatic ceiling is
 * per request: an erasure can cost no more than ERASE_WORST_UNITS studio
 * units, the erasure of the largest store there can be (every product a
 * course of MAX_LESSONS lessons, every count at its own cap), at the per-thing
 * rates of lib/erasure-rules.ts. A size past it is beyond what the caps allow,
 * so it is unknown and the erasure answers "unavailable", never charged above
 * the ceiling. tests/plan-cost-registry.ts prices one case (ERASURE_OVERFLOW)
 * and docs/funded-exposure-review.md carries it as a company exposure in the
 * minimum paid base.
 *
 *   nl:erase:funded:<YYYY-MM>   hash  cases, units: the company's month, no store or person, 400 days
 *
 * Every case is counted before the erasure runs; a count Redis does not
 * confirm leaves the erasure undone ("unavailable"), to be pressed again,
 * and the store's share taken for it is given back. A count over the reviewed
 * monthly case cap is still counted and the erasure still made: it makes the
 * company's funded total unknown for the review (as held stores do), never a
 * refusal of a person's deletion.
 *
 * Only a store whose plan ended takes this path; any other store's erasure is
 * taken from its own window as before.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";
import { giveAllowance, takeAllowance, type AllowanceStore } from "@/lib/store-allowance";
import { standingOf } from "@/lib/plan-standing";
import { type ErasureSize, erasureUnits } from "@/lib/erasure-rules";
import { MAX_PRODUCTS } from "@/lib/catalog-rules";
import { MAX_LESSONS } from "@/lib/course";
import { MAX_DEALS } from "@/lib/crm-rules";
import { MAX_CONVERSATIONS as MAX_INBOX_CONVERSATIONS } from "@/lib/inbox-rules";
import { MAX_CONVERSATIONS as MAX_DM_CONVERSATIONS, MAX_REQUESTS as MAX_DM_REQUESTS } from "@/lib/community-dm";
import { MAX_CHAT_KEPT } from "@/lib/community-chat-rules";
import { MAX_KEPT_EVENTS } from "@/lib/community-text";
import { LEGACY_SCAN as CERTIFICATES_COUNTED_PER_COURSE } from "@/lib/certificate";

/** The exposure scope that pays it (lib/funded-exposure-rules.ts). */
export const ERASE_FUNDED_SCOPE = "erasure_overflow";

/**
 * The largest erasure there can be, each count at the cap its own module holds: every product of the catalog
 * (MAX_PRODUCTS) a course, each of MAX_LESSONS lessons and with as many certificates as an erasure counts for a
 * course; every deal (MAX_DEALS) and inbox conversation; a community member's conversations and requests, the room's
 * kept messages and the kept events.
 */
export const ERASE_WORST_SIZE: ErasureSize = {
  products: MAX_PRODUCTS,
  courses: MAX_PRODUCTS,
  lessons: MAX_PRODUCTS * MAX_LESSONS,
  deals: MAX_DEALS,
  conversations: MAX_INBOX_CONVERSATIONS,
  dmConversations: MAX_DM_CONVERSATIONS + MAX_DM_REQUESTS,
  roomMessages: MAX_CHAT_KEPT,
  events: MAX_KEPT_EVENTS,
  certificates: MAX_PRODUCTS * CERTIFICATES_COUNTED_PER_COURSE,
};

/** The automatic ceiling of one erasure, in studio units: the company never pays for more of one. */
export const ERASE_WORST_UNITS = erasureUnits(ERASE_WORST_SIZE);

/** How long a month's counts are kept: past the next yearly look at them. */
export const ERASE_FUNDED_KEEP_SECONDS = 400 * 86_400;
/** Commands one case's count sends: the case, its units and the key's life. */
export const ERASE_FUNDED_COMMANDS = 3;

const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);
const monthKey = (month: string) => `nl:erase:funded:${month}`;

/** What taking an erasure's units answered: how many came from the store's window and how many from the company. */
export type ErasureTake =
  | { ok: true; fromStore: number; fromCompany: number }
  | { ok: false; reason: "limit" | "unavailable"; message?: string };

/**
 * Counts `units` for the company in this month, and one case when `newCase`. True only when Redis confirms both
 * counts; a lost or odd reply is unknown (and stays counted if it was made: never taken back on a guess).
 */
async function countCompany(units: number, newCase: boolean, now: number): Promise<boolean> {
  if (!isRedisConfigured()) return false;
  const key = monthKey(monthOf(now));
  try {
    const replies = repliesFor(
      await redisPipeline([
        ["HINCRBY", key, "cases", newCase ? 1 : 0],
        ["HINCRBY", key, "units", units],
        ["EXPIRE", key, ERASE_FUNDED_KEEP_SECONDS],
      ]),
      ERASE_FUNDED_COMMANDS,
    );
    if (!replies) return false;
    const cases = countOf(replies[0]);
    const counted = countOf(replies[1]);
    return cases !== null && cases >= (newCase ? 1 : 0) && counted !== null && counted >= units && (replies[2] === 0 || replies[2] === 1);
  } catch {
    return false;
  }
}

/**
 * Takes `units` of an erasure from the store's studio window, and for a store whose plan ended, what the window does
 * not hold from the company (DONO-20261113-DEC-1). `total` is the whole erasure's units so far, held to the ceiling;
 * `newCase` says whether this erasure has not yet been counted as one of the company's cases.
 */
export async function takeErasureUnits(store: AllowanceStore & Parameters<typeof standingOf>[0], units: number, total: number, newCase: boolean, now = Date.now()): Promise<ErasureTake> {
  const taken = await takeAllowance(store, "studio", units, now);
  if (taken.ok) return { ok: true, fromStore: units, fromCompany: 0 };
  // Not counted just now: pressed again, never charged to anyone on a guess.
  if (taken.reason === "unknown") return { ok: false, reason: "unavailable", message: taken.message };
  // Any other store pays its own erasure, from its own window, as before.
  if (standingOf(store, now / 1000) !== "ended") return { ok: false, reason: taken.reason === "used" ? "limit" : "unavailable", message: taken.message };
  // Past the ceiling is past what any cap allows: unknown, never charged above it.
  if (!Number.isSafeInteger(units) || units < 1 || !Number.isSafeInteger(total) || total < units || total > ERASE_WORST_UNITS) {
    console.error(`deleting a person: ${total} studio units is beyond the largest erasure there can be (${ERASE_WORST_UNITS})`);
    return { ok: false, reason: "unavailable" };
  }
  // The store's window first, whatever is left of it: the whole window when the count was not read, then what the
  // count says is left. A store without a place this month has nothing to take (reason "pool").
  let fromStore = 0;
  if (taken.reason === "used") {
    const left = typeof taken.left === "number" ? taken.left : taken.limit;
    if (Number.isSafeInteger(left) && left > 0 && left < units) {
      const part = await takeAllowance(store, "studio", left, now);
      if (part.ok) fromStore = left;
      else if (part.reason === "used" && typeof part.left === "number" && part.left > 0 && part.left < left) {
        const rest = await takeAllowance(store, "studio", part.left, now);
        if (rest.ok) fromStore = part.left;
      }
    }
  }
  const fromCompany = units - fromStore;
  if (!(await countCompany(fromCompany, newCase, now))) {
    if (fromStore) await giveAllowance(store, "studio", fromStore, now);
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, fromStore, fromCompany };
}

/** For the owner's report: a month's cases and units, numbers only; null when it cannot be read. */
export async function erasureFundedMonth(month: string): Promise<{ month: string; cases: number; units: number } | null> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !isRedisConfigured()) return null;
  try {
    const replies = repliesFor(await redisPipeline([["HMGET", monthKey(month), "cases", "units"]]), 1);
    const pair = replies && Array.isArray(replies[0]) && replies[0].length === 2 ? (replies[0] as unknown[]) : null;
    if (!pair) return null;
    const read = (raw: unknown): number | null => (raw === null ? 0 : typeof raw === "string" && /^(0|[1-9][0-9]{0,15})$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null);
    const cases = read(pair[0]);
    const units = read(pair[1]);
    return cases === null || units === null ? null : { month, cases, units };
  } catch {
    return null;
  }
}
