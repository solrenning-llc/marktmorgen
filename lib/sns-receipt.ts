/**
 * Amazon SNS notices (app/api/mail/ses) acted on once, and never acknowledged
 * without being acted on (Claude 1 on #2612, the author's recovery proof
 * f14856ee7d).
 *
 * A notice's receipt is one key, the route's seen key for its message id, kept a day, that
 * goes from pending to done:
 *
 *   - pending: a value only this run writes (lib/claim-mark.ts, claimValue: the
 *     time in milliseconds, a point, a random part), taken with SET NX before
 *     anything is done;
 *   - done: written over our own pending value only (one script), after the
 *     notice was acted on.
 *
 * A later delivery that finds "done" is acknowledged without acting. One that
 * finds a pending value younger than the lease is told to come back (503): a
 * run may still be acting on it. One that finds anything else there — a
 * pending value older than the lease, whose run ended without finishing (its
 * SET landed and the answer was lost, or it stopped before writing done), or
 * the bare "1" the route wrote before this protocol — takes it over, only
 * while it still holds what was read (one script), and acts on the notice
 * again. Acting twice is safe: recordSesEvent (lib/mail-report.ts) takes an
 * address off its list only while it is still on it (lib/contacts.ts,
 * stopWriting), counts it once a week (lib/mail-health.ts, its seen key) and
 * counts a report once per provider message (RECORD_MAIL_REPORT); a
 * subscription confirmed again at Amazon's own link stays confirmed.
 *
 * An answer that does not read (CX-123 rule 24) is never ownership: the key is
 * read back, and only our own value there is. When even that does not read,
 * nothing is done, our own value (and only ours) is let go, and the notice is
 * answered with a failure so Amazon tries again; if letting go does not land
 * either, the lease is what lets the retry act.
 */
import { claimValue, releaseMark } from "@/lib/claim-mark";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { SNS_RECEIPT_DONE, SNS_RECEIPT_LEASE_MS, SNS_RECEIPT_SECONDS } from "@/lib/sns-receipt-rules";

export { SNS_RECEIPT_COMMANDS_MOST, SNS_RECEIPT_DONE, SNS_RECEIPT_LEASE_MS, SNS_RECEIPT_SECONDS, SNS_RECEIPT_VALUE_BYTES_MOST } from "@/lib/sns-receipt-rules";

const SWAP =
  '-- marktmorgen:sns-receipt-swap:v1\nif redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2], "EX", ARGV[3]) return 1 else return 0 end';

export type SnsReceipt =
  /** This run holds the notice: act on it, then finishSnsReceipt, or letGoSnsReceipt on a failure. */
  | { state: "ours"; key: string; token: string }
  /** Acted on before: acknowledge without acting. */
  | { state: "done" }
  /** Another run may be acting on it, or nothing could be read: act on nothing and answer with a failure. */
  | { state: "busy" };

const PENDING = /^([0-9]{13})\.[0-9]{9}$/;

async function swap(key: string, from: string, to: string): Promise<boolean> {
  try {
    const replies = repliesFor(await redisPipeline([["EVAL", SWAP, 1, key, from, to, SNS_RECEIPT_SECONDS]]), 1);
    return replies?.[0] === 1;
  } catch {
    return false;
  }
}

/** Takes the receipt of one notice, or says why it may not be acted on now. Never throws. */
export async function takeSnsReceipt(key: string, now = Date.now()): Promise<SnsReceipt> {
  const token = claimValue(now);
  let claim: unknown[] | null = null;
  try {
    claim = repliesFor(await redisPipeline([["SET", key, token, "NX", "EX", SNS_RECEIPT_SECONDS]]), 1);
  } catch {
    claim = null;
  }
  if (claim?.[0] === "OK") return { state: "ours", key, token };
  const answered = claim !== null && claim[0] === null;
  let held: unknown[] | null = null;
  try {
    held = repliesFor(await redisPipeline([["GET", key]]), 1);
  } catch {
    held = null;
  }
  const value = held?.[0];
  if (value === token) return { state: "ours", key, token };
  if (typeof value !== "string") {
    // Unreadable, or gone since: nothing is ours to act on. A claim whose answer did not read may have landed, so our
    // own value, and only ours, is let go, for Amazon's retry to find the key free.
    if (!answered) await releaseMark(key, token);
    return { state: "busy" };
  }
  if (value === SNS_RECEIPT_DONE) return { state: "done" };
  const pending = PENDING.exec(value);
  if (pending && Math.abs(now - Number(pending[1])) < SNS_RECEIPT_LEASE_MS) return { state: "busy" };
  // A pending value past its lease, the route's old "1" or anything else that is not a finished notice: taken over
  // only while it still holds what was read, so two late deliveries never both act on the same take-over.
  return (await swap(key, value, token)) ? { state: "ours", key, token } : { state: "busy" };
}

/** Marks a notice acted on, over this run's own pending value only. False when that could not be confirmed. */
export async function finishSnsReceipt(receipt: Extract<SnsReceipt, { state: "ours" }>): Promise<boolean> {
  return swap(receipt.key, receipt.token, SNS_RECEIPT_DONE);
}

/** Lets go of this run's own pending value after a failure, so Amazon's retry acts at once. Never throws. */
export async function letGoSnsReceipt(receipt: Extract<SnsReceipt, { state: "ours" }>): Promise<void> {
  await releaseMark(receipt.key, receipt.token);
}
