/**
 * The count kept for a batch of emails whose answer was not known.
 *
 * sendBatchOutcome (lib/email.ts) answers "uncertain" when Resend may have
 * taken a batch (a post whose answer never came, a 5xx or 408), and its
 * caller keeps the count it reserved for it, never given back. The same batch
 * tried again (the same batch key, to the same people) is the same request
 * under the same idempotency key: Resend drops it if it took the first, so
 * the people in it are written to once. Amazon's lost acknowledgement is
 * "unconfirmed" and never marked: Amazon keeps no such key and writes to them
 * again on the retry, which is counted again (#4073 MEDIUM 1). Reserving its count again took the creator's monthly emails twice,
 * or once per unknown answer, for emails that went once (reviews of #4073).
 *
 * So the caller marks the batch when it keeps the count, and a retry that
 * finds the mark sends under the count already kept instead of reserving
 * again. The mark is never a reason to give anything back: a later answer
 * that nothing went cannot prove the first did not go, so the count stays.
 *
 * The mark lasts less than the service's idempotency window (Resend keeps a
 * key 24 hours; SES's own record, lib/ses.ts, two days): a retry after it,
 * which the service could send anew, is counted anew. A mark that cannot be
 * read is no mark, so the retry is counted again: more counted, never less.
 */
import { createHash } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";

export const BATCH_KEPT_SECONDS = 23 * 3_600;

/** The mark's key: the batch key and its people, sorted, hashed (no address is written in a key). */
export function batchKeptKey(batchKey: string, to: readonly string[]): string {
  const people = [...to].map((t) => t.trim().toLowerCase()).sort().join(",");
  return `nl:mail:kept:${createHash("sha256").update(`${batchKey}\n${people}`).digest("hex").slice(0, 40)}`;
}

/** Whether this batch, to exactly these people, already holds its count. Unknown is no. */
export async function batchCountKept(batchKey: string, to: readonly string[]): Promise<boolean> {
  if (!to.length) return false;
  try {
    const reply = repliesFor(await redisPipeline([["GET", batchKeptKey(batchKey, to)]]), 1);
    return reply?.[0] === "1";
  } catch {
    return false;
  }
}

/** Marks that this batch's count is kept, after an answer not known. A mark not written only costs a second count. */
export async function keepBatchCount(batchKey: string, to: readonly string[]): Promise<void> {
  if (!to.length) return;
  await redisPipeline([["SET", batchKeptKey(batchKey, to), "1", "EX", BATCH_KEPT_SECONDS]]).catch((error: unknown) => {
    console.error("the count kept for a batch could not be marked; a retry counts it again", error);
  });
}

/** The batch went: its mark goes, so nothing is left to excuse another batch from its count. */
export async function batchCountSettled(batchKey: string, to: readonly string[]): Promise<void> {
  if (!to.length) return;
  await redisPipeline([["DEL", batchKeptKey(batchKey, to)]]).catch(() => {});
}
