/**
 * The totals of a poll, read for its creator in the studio (125
 * [F2-EMAIL-POLLS], unit 7c; the mail route's "poll_results"). Only an email
 * of this store's list that keeps a poll and has reached someone. The record is read
 * inside the route's own studio request, as the other actions on one email
 * are; the votes are read only after pollResultsUnits(total) more are taken,
 * by the email's size. Totals only: never who answered what. Anything that
 * does not read is "unknown", never a count (rule 24).
 */
import { BROADCAST_ID, readBroadcast } from "@/lib/broadcasts";
import { pollClosesAt, pollState } from "@/lib/email-poll-rules";
import { pollResults, pollResultsUnits } from "@/lib/email-polls";
import type { Store } from "@/lib/store";

export type StudioPollResults =
  | { state: "ok"; counts: number[]; votes: number; open: boolean; closesAt: number }
  | { state: "none" }
  | { state: "used" }
  | { state: "unknown" };

export async function studioPollResults(store: Pick<Store, "listId">, id: string, take: (units: number) => Promise<boolean>, now: number): Promise<StudioPollResults> {
  if (typeof id !== "string" || !BROADCAST_ID.test(id) || !store.listId) return { state: "none" };
  let broadcast;
  try {
    broadcast = await readBroadcast(id);
  } catch {
    return { state: "unknown" };
  }
  if (!broadcast || broadcast.listId !== store.listId || !broadcast.poll) return { state: "none" };
  // Read once it reached anyone, whatever its status since: it may wait part-way (review, ALTO).
  if (!Number.isSafeInteger(broadcast.sent) || broadcast.sent < 0) return { state: "unknown" };
  if (broadcast.sent === 0) return { state: "none" };
  // In seconds on the broadcast (createBroadcast), in milliseconds for the poll's rules.
  const sentAt = broadcast.sendAt * 1000;
  const closesAt = pollClosesAt(sentAt, broadcast.poll.days);
  const state = pollState(sentAt, broadcast.poll.days, now);
  if (closesAt === null || state === "unknown" || !Number.isSafeInteger(broadcast.total) || broadcast.total < 0) return { state: "unknown" };
  try {
    if (!(await take(pollResultsUnits(broadcast.total)))) return { state: "used" };
  } catch {
    return { state: "unknown" };
  }
  const totals = await pollResults(id, broadcast.poll.options.length);
  if (!totals.known) return { state: "unknown" };
  return { state: "ok", counts: totals.counts, votes: totals.votes, open: state === "open", closesAt };
}
