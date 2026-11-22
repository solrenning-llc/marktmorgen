/**
 * A recipient's confirmed answer to a poll in a broadcast (125
 * [F2-EMAIL-POLLS], unit 4; the rules are in lib/email-poll-rules.ts, the
 * links in lib/email-poll-links.ts, the votes in lib/email-polls.ts). Only a
 * press of Confirm on the page reaches it (a POST): opening the link, which
 * mail scanners do on their own, never does.
 *
 * In this order, so that a link that is not someone's costs nothing:
 *   1. the link is checked against the broadcast's id, with no read at all;
 *   2. the client short-window counter is taken before the broadcast read;
 *      past it, nothing from the database is read;
 *   3. the broadcast is read: it must keep a poll and have already been
 *      sent to the link's place (its first `sent` places, whatever its
 *      status since);
 *   4. the poll's answer is checked; an open answer or a closed-poll response
 *      takes POLL_VOTE_REQUEST_UNITS before any store or vote write;
 *   5. the answer is kept, or taken back, under the place (recordVote).
 *
 * Anything that does not read is "unknown", never kept and never refused
 * (rule 24).
 */
import { BROADCAST_ID, readBroadcast } from "@/lib/broadcasts";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { withinEssentialLimit } from "@/lib/request-guard";
import { checkPollLink } from "@/lib/email-poll-links";
import { POLL_VOTE_REQUEST_UNITS, pollClosesAt, voteStep } from "@/lib/email-poll-rules";
import { recordVote } from "@/lib/email-polls";
import { type Store, storeForHandle } from "@/lib/store";

export type PollVoteAnswer = "recorded" | "withdrawn" | "closed" | "invalid" | "resting" | "unknown";

export type PollVoteDeps = {
  loadStore: (handle: string) => Promise<Store | null>;
  take: (store: Store) => Promise<boolean>;
  admit: (who: string) => Promise<boolean>;
};

const DEPS: PollVoteDeps = {
  loadStore: storeForHandle,
  take: (store) => takeBuyerRead(store, POLL_VOTE_REQUEST_UNITS),
  admit: (who) => withinEssentialLimit("email-poll-vote", who, 60, 60),
};

const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Keeps a recipient's confirmed answer (`option`), or takes it back (`null`). */
export async function votePoll(
  input: { broadcastId: string; link: unknown; option: number | null; now: number; who?: string },
  deps: PollVoteDeps = DEPS,
): Promise<PollVoteAnswer> {
  const { broadcastId, option, now } = input;
  if (typeof broadcastId !== "string" || !BROADCAST_ID.test(broadcastId)) return "invalid";
  const checked = checkPollLink(broadcastId, input.link);
  if (!checked.ok) return checked.unknown ? "unknown" : "invalid";
  // Signed-link replays are throttled before any database read, including after close or when the store month is spent.
  if (input.who) {
    try { if (!(await deps.admit(input.who))) return "unknown"; }
    catch { return "unknown"; }
  }
  let broadcast;
  try {
    broadcast = await readBroadcast(broadcastId);
  } catch {
    return "unknown";
  }
  if (!broadcast || !broadcast.poll) return "invalid";
  if (!nonnegative(broadcast.sent) || !nonnegative(broadcast.sendAt)) return "unknown";
  // Whoever it reached, whatever it does since: it waits in daily portions, for a month's emails or a subject
  // test, fails or is canceled part-way, with the first `sent` places of its list reached (review, ALTO).
  if (checked.recipient >= broadcast.sent) return "invalid";
  // A broadcast keeps its times in seconds (createBroadcast); the poll's rules count in milliseconds.
  const sentAt = broadcast.sendAt * 1000;
  const step = voteStep({ method: "POST", option, poll: broadcast.poll, sentAt, now, recipient: "valid" });
  if (step.step === "confirm" || step.step === "invalid" || step.step === "unknown") return step.step === "confirm" ? "invalid" : step.step;
  const closesAt = pollClosesAt(sentAt, broadcast.poll.days);
  if (closesAt === null) return "unknown";
  try {
    const store = await deps.loadStore(broadcast.handle);
    if (!store) return "unknown";
    if (!(await deps.take(store))) return "resting";
  } catch {
    return "unknown";
  }
  if (step.step === "closed") return "closed";
  return recordVote(broadcastId, checked.recipient, step.step === "record" ? step.option : null, closesAt, now);
}

/** What the poll route answers when no page asked (app/api/mail/poll/route.ts). */
export const POLL_ROUTE_WORDS: Record<PollVoteAnswer, { status: number; text: string }> = {
  recorded: { status: 200, text: "Your answer is counted. You can change it or take it back from the same link while the poll is open." },
  withdrawn: { status: 200, text: "Your answer is taken back. Nothing of yours is counted in this poll." },
  closed: { status: 410, text: "This poll has closed, so answers can no longer be changed." },
  invalid: { status: 404, text: "This poll link is not one we know. Nothing was counted." },
  // takePublicRequest says no both past the figure and when it could not count: "just now", never "this month".
  resting: { status: 503, text: "This store cannot take answers just now. Nothing was counted." },
  unknown: { status: 503, text: "We could not save that just now. Nothing was counted. Please try again in a minute." },
};
