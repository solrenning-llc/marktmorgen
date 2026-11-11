/**
 * A recipient's confirmed answer to a poll in a broadcast (125
 * [F2-EMAIL-POLLS], unit 4; the rules are in lib/email-poll-rules.ts, the
 * links in lib/email-poll-links.ts, the votes in lib/email-polls.ts). Only a
 * press of Confirm on the page reaches it (a POST): opening the link, which
 * mail scanners do on their own, never does.
 *
 * In this order, so that a link that is not someone's costs nothing:
 *   1. the link is checked against the broadcast's id, with no read at all;
 *   2. the broadcast is read: it must keep a poll, have gone out ("sending"
 *      or "sent"), and its list must reach the link's place;
 *   3. the poll must be open (from sendAt for its days);
 *   4. the store is read and POLL_VOTE_REQUEST_UNITS of its month's public
 *      requests are taken (lib/buyer-actions.ts takeBuyerRead): past its
 *      figure the store is resting and nothing is kept;
 *   5. the answer is kept, or taken back, under the place (recordVote).
 *
 * Anything that does not read is "unknown", never kept and never refused
 * (rule 24).
 */
import { BROADCAST_ID, readBroadcast } from "@/lib/broadcasts";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { checkPollLink } from "@/lib/email-poll-links";
import { type EmailPoll, POLL_VOTE_REQUEST_UNITS, pollClosesAt, pollState, voteStep } from "@/lib/email-poll-rules";
import { recordVote } from "@/lib/email-polls";
import { type Store, storeForHandle } from "@/lib/store";

export type PollVoteAnswer = "recorded" | "withdrawn" | "closed" | "invalid" | "resting" | "unknown";

export type PollVoteDeps = {
  loadStore: (handle: string) => Promise<Store | null>;
  take: (store: Store) => Promise<boolean>;
};

const DEPS: PollVoteDeps = { loadStore: storeForHandle, take: (store) => takeBuyerRead(store, POLL_VOTE_REQUEST_UNITS) };

const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Keeps a recipient's confirmed answer (`option`), or takes it back (`null`). */
export async function votePoll(
  input: { broadcastId: string; link: unknown; option: number | null; now: number },
  deps: PollVoteDeps = DEPS,
): Promise<PollVoteAnswer> {
  const { broadcastId, option, now } = input;
  if (typeof broadcastId !== "string" || !BROADCAST_ID.test(broadcastId)) return "invalid";
  const checked = checkPollLink(broadcastId, input.link);
  if (!checked.ok) return checked.unknown ? "unknown" : "invalid";
  let broadcast;
  try {
    broadcast = await readBroadcast(broadcastId);
  } catch {
    return "unknown";
  }
  if (!broadcast || !broadcast.poll) return "invalid";
  if (broadcast.status !== "sending" && broadcast.status !== "sent") return "invalid";
  if (!nonnegative(broadcast.total) || !nonnegative(broadcast.sendAt)) return "unknown";
  if (checked.recipient >= broadcast.total) return "invalid";
  const step = voteStep({ method: "POST", option, poll: broadcast.poll, sentAt: broadcast.sendAt, now, recipient: "valid" });
  if (step.step === "confirm") return "invalid";
  if (step.step !== "record" && step.step !== "withdraw") return step.step;
  const closesAt = pollClosesAt(broadcast.sendAt, broadcast.poll.days);
  if (closesAt === null) return "unknown";
  try {
    const store = await deps.loadStore(broadcast.handle);
    if (!store) return "unknown";
    if (!(await deps.take(store))) return "resting";
  } catch {
    return "unknown";
  }
  return recordVote(broadcastId, checked.recipient, step.step === "record" ? step.option : null, closesAt, now);
}

export type PollPage =
  | { state: "open" | "closed"; poll: EmailPoll; sender: string; language: string; closesAt: number }
  | { state: "resting"; language: string }
  | { state: "invalid" }
  | { state: "unknown" };

/**
 * What the page a recipient's link opens shows (unit 5): the poll, open or
 * closed, with who sent it and in the store's language. It keeps, changes
 * and takes back nothing: mail scanners open every link, and only the press
 * of Confirm (votePoll) counts. The same checks in the same order as a vote,
 * so a link that is not someone's costs nothing, and the same
 * POLL_VOTE_REQUEST_UNITS taken before the store is shown.
 */
export async function pollPage(input: { broadcastId: string; link: unknown; now: number }, deps: PollVoteDeps = DEPS): Promise<PollPage> {
  const { broadcastId, now } = input;
  if (typeof broadcastId !== "string" || !BROADCAST_ID.test(broadcastId)) return { state: "invalid" };
  const checked = checkPollLink(broadcastId, input.link);
  if (!checked.ok) return checked.unknown ? { state: "unknown" } : { state: "invalid" };
  let broadcast;
  try {
    broadcast = await readBroadcast(broadcastId);
  } catch {
    return { state: "unknown" };
  }
  if (!broadcast || !broadcast.poll) return { state: "invalid" };
  if (broadcast.status !== "sending" && broadcast.status !== "sent") return { state: "invalid" };
  if (!nonnegative(broadcast.total) || !nonnegative(broadcast.sendAt)) return { state: "unknown" };
  if (checked.recipient >= broadcast.total) return { state: "invalid" };
  const state = pollState(broadcast.sendAt, broadcast.poll.days, now);
  const closesAt = pollClosesAt(broadcast.sendAt, broadcast.poll.days);
  if (state === "unknown" || closesAt === null) return { state: "unknown" };
  let store: Store | null;
  try {
    store = await deps.loadStore(broadcast.handle);
    if (!store) return { state: "unknown" };
    if (!(await deps.take(store))) return { state: "resting", language: store.language };
  } catch {
    return { state: "unknown" };
  }
  const sender = store.mail?.fromName || store.name;
  return { state, poll: broadcast.poll, sender, language: store.language, closesAt };
}
