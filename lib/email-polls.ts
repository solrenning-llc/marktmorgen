/**
 * The votes of a poll in a broadcast, kept (125 [F2-EMAIL-POLLS], unit 3;
 * the rules are in lib/email-poll-rules.ts, the links in
 * lib/email-poll-links.ts). Nothing sends a poll or calls this yet.
 *
 *   nl:mail:bc:<broadcast>:poll   hash   recipient's place -> the answer's index
 *
 * One field a recipient, under their place in the broadcast's list, never
 * their address: a new answer replaces theirs, an empty one takes it back.
 * A broadcast goes to at most the plan's monthly emails, so the hash holds at
 * most that many fields of a few bytes each (tests/store-data-registry.ts),
 * and it goes by itself POLL_RESULTS_DAYS after the poll closes, or with the
 * broadcast when its store closes (lib/broadcasts.ts, broadcastKeys).
 *
 * Read exactly (rule 24): a reply that does not read is "unknown", never a
 * vote kept or taken back; results with any kept vote that does not read are
 * unknown, never a count without it.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { BROADCAST_ID } from "@/lib/broadcasts";
import { MAX_LEADS } from "@/lib/contact-rules";
import { MAX_POLL_OPTIONS, tallyPoll } from "@/lib/email-poll-rules";

/** How long the votes, and so the results, are kept after the poll closes. */
export const POLL_RESULTS_DAYS = 30;
/** One vote as kept: a place of up to six digits, its answer's digit and what Redis keeps beside a field. */
export const POLL_VOTE_BYTES = 6 + 1 + 64;

export const pollKey = (broadcastId: string) => `nl:mail:bc:${broadcastId}:poll`;

const isPlace = (place: unknown): place is number => typeof place === "number" && Number.isInteger(place) && place >= 0 && place < MAX_LEADS;

/**
 * One vote, or its taking back, in one step with the poll's end (recordVote). KEYS[1] the poll's votes; ARGV the
 * recipient's place, the answer's index ("" to take it back) and the end in seconds. Answers {fields changed, EXPIREAT's
 * answer}. A vote whose end did not set (EXPIREAT other than 1) is undone in the same step: the key it made is
 * deleted, an answer it replaced is put back, a field it added is taken out, so no vote is kept without its end.
 * Modelled by lib/redis-memory.ts.
 */
export const POLL_VOTE = `-- marktmorgen:email-poll-vote:v1
local key, field = KEYS[1], ARGV[1]
if ARGV[2] == '' then
  local n = redis.call('HDEL', key, field)
  return {n, redis.call('EXPIREAT', key, ARGV[3])}
end
local existed = redis.call('EXISTS', key)
local before = redis.call('HGET', key, field)
local n = redis.call('HSET', key, field, ARGV[2])
local e = redis.call('EXPIREAT', key, ARGV[3])
if e ~= 1 then
  if existed == 0 then redis.call('DEL', key)
  elseif before then redis.call('HSET', key, field, before)
  else redis.call('HDEL', key, field) end
end
return {n, e}`;

export type VoteResult = "recorded" | "withdrawn" | "closed" | "invalid" | "unknown";

/**
 * Keeps one recipient's answer (`option`), or takes it back (`null`), while
 * the poll is open. The caller has already checked the link
 * (checkPollLink) and that the press was a POST (voteStep).
 */
export async function recordVote(broadcastId: string, place: number, option: number | null, closesAt: number, now: number): Promise<VoteResult> {
  if (!BROADCAST_ID.test(broadcastId) || !isPlace(place)) return "invalid";
  if (option !== null && (!Number.isInteger(option) || option < 0 || option >= MAX_POLL_OPTIONS)) return "invalid";
  if (!Number.isFinite(closesAt) || !Number.isFinite(now) || !isRedisConfigured()) return "unknown";
  if (now >= closesAt) return "closed";
  const key = pollKey(broadcastId);
  const until = Math.ceil(closesAt / 1000) + POLL_RESULTS_DAYS * 86_400;
  try {
    // The vote and its end in one step (POLL_VOTE): a vote whose end did not set is taken back in the same step, so no
    // vote is ever kept, or counted, without its end (Codex X4 on #3673).
    const replies = repliesFor(await redisPipeline([["EVAL", POLL_VOTE, 1, key, String(place), option === null ? "" : String(option), until]]), 1);
    const pair = replies && Array.isArray(replies[0]) && replies[0].length === 2 ? (replies[0] as unknown[]) : null;
    const changed = pair ? countOf(pair[0]) : null;
    if (changed === null || changed > 1) return "unknown";
    // A vote kept must go by itself when promised (app/privacy#email-polls): its end not set is not a vote kept.
    // Taking back a vote never cast leaves no key, so its end answers 0 there.
    const ended = pair ? countOf(pair[1]) : null;
    if (ended === null || ended > 1 || (option !== null && ended !== 1)) return "unknown";
    return option === null ? "withdrawn" : "recorded";
  } catch (error) {
    console.error("keeping a poll vote failed", error);
    return "unknown";
  }
}

/** The totals of a poll with `optionCount` answers, never who: unknown when anything does not read. */
export async function pollResults(broadcastId: string, optionCount: number): Promise<ReturnType<typeof tallyPoll>> {
  if (!BROADCAST_ID.test(broadcastId) || !isRedisConfigured()) return { known: false };
  try {
    const values = stringList(repliesFor(await redisPipeline([["HVALS", pollKey(broadcastId)]]), 1)?.[0]);
    return tallyPoll(optionCount, values);
  } catch (error) {
    console.error("reading a poll's votes failed", error);
    return { known: false };
  }
}
