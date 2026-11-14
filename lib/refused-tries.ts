/**
 * How many times one email may be refused for certain before it is no
 * longer tried (rule 30, as 283 [HG2]; Claude 2's MEDIUM 3 on #3377).
 *
 * sendEmailOutcome (lib/email.ts) answers "refused" also when the guarded
 * transport stopped before any request (`posted: false`), and a stop can come
 * after the store's figure was taken for the email (the dispatch's deadline
 * passed before the fetch), as a 4xx after the request does. A caller that
 * asks again on a refusal (a job that lets its mark go, a button pressed
 * again) would take the figure again each time, without end. Each such
 * caller counts its refusals here, under a name of its own for the one
 * email, and stops at REFUSED_TRIES, the number #3377 gave its checkout
 * reminders (lib/checkout-recovery.ts): N certain refusals take the figure
 * at most REFUSED_TRIES times.
 *
 * Keys (one family):
 *
 *   nl:refused:<hash>   certain refusals of one email, kept `seconds` (a day
 *                       unless the caller asks longer, never past
 *                       REFUSED_MAX_SECONDS); named by a hash of the
 *                       caller's name, so no address is ever in a key
 *
 * A count that cannot be read or written is the limit (CX-123 rule 24):
 * nothing more is taken on an unknown answer.
 */
import { createHash } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { countOf, repliesFor } from "@/lib/redis-reply";

/** Certain refusals of one email, at the most, before it is no longer tried (#3377's checkout reminders, the same). */
export const REFUSED_TRIES = 3;
/** How long a count is kept unless its caller asks otherwise: a day, past a five-minute job's window and a day of presses. */
export const REFUSED_SECONDS = 24 * 60 * 60;
/** The longest a count is kept: a payment request's open time (lib/payment-request-rules.ts, OPEN_DAYS), whose daily reminders it bounds. */
export const REFUSED_MAX_SECONDS = 45 * 24 * 60 * 60;
/** Commands one try may add: the read before a send by hand, and the count and its expiry after a refusal. */
export const REFUSED_TRY_COMMANDS = 3;

const keyOf = (name: string) => `nl:refused:${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;
const COUNT = /^(0|[1-9][0-9]{0,8})$/;

/**
 * Whether the email called `name` was already refused for certain
 * REFUSED_TRIES times, read before it is sent so a try past the limit takes
 * nothing. An unreadable count answers true: not tried on an unknown answer.
 */
export async function refusedTooOften(name: string): Promise<boolean> {
  try {
    const replies = repliesFor(await redisPipeline([["GET", keyOf(name)]]), 1);
    if (!replies) return true;
    const [raw] = replies;
    if (raw === null) return false;
    const count = typeof raw === "number" ? countOf(raw) : typeof raw === "string" && COUNT.test(raw) ? Number(raw) : null;
    return count === null || count >= REFUSED_TRIES;
  } catch {
    return true;
  }
}

/**
 * Counts one certain refusal of the email called `name`, kept `seconds`
 * (within REFUSED_MAX_SECONDS). True while it may be tried again (fewer than
 * REFUSED_TRIES refusals); false at the limit, or when the count does not read.
 */
export async function countRefusal(name: string, seconds = REFUSED_SECONDS): Promise<boolean> {
  const key = keyOf(name);
  const kept = Number.isFinite(seconds) ? Math.max(1, Math.min(REFUSED_MAX_SECONDS, Math.floor(seconds))) : REFUSED_SECONDS;
  try {
    const counted = repliesFor(await redisPipeline([["INCR", key], ["EXPIRE", key, kept]]), 2);
    const tries = counted ? countOf(counted[0]) : null;
    return tries !== null && tries > 0 && tries < REFUSED_TRIES;
  } catch {
    return false;
  }
}
