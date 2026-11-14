/**
 * A poll on a post: a question with answers people pick from.
 *
 * What the others do, checked on 30 September 2026, because "better" has to
 * mean something measurable:
 *
 *   Circle    5 options, one answer only, an end date, results the creator
 *             can keep to themselves, and who voted for what is visible.
 *   Kajabi    10 options, multiple answers allowed, an end date, and results
 *             a member sees only once they have voted.
 *   Discord   10 answers, a fixed duration from a list, multiple choice, and
 *             results always public.
 *   Stan      none. Its own help centre tells creators to write a post and
 *             agree that one emoji reaction means A and another means B.
 *
 * So: 12 options, multiple answers when the creator wants them, an end date
 * or none, and results the creator can hold back until it closes. Two things
 * here that none of the four do — a voter can take their vote back entirely,
 * not only change it, and a poll says plainly whether the creator can see who
 * voted for what, instead of leaving people to assume.
 *
 * On privacy, the decision worth stating: a vote is never anonymous to the
 * software, because a poll that let one person vote a thousand times is not a
 * poll — the count has to be tied to the voter to be worth reading. What the
 * creator is shown is the tally only, never the list of who chose what. The
 * page says so, in those words, so nobody votes believing something untrue
 * about who can see it.
 *
 * How it is kept, under the community's own id:
 *
 *   nl:cm:<id>:pv:<post>   who voted what: member key -> option ids, comma separated
 *   nl:cm:<id>:pc:<post>   the tally: option id -> how many
 *
 * The tally is kept as its own small hash rather than counted from the votes,
 * because counting 50,000 votes to draw one bar is work nobody should pay for
 * on every page view. The two are written together, and a vote that changes
 * moves the count off the old option and on to the new one in the same call.
 */
import { redisPipeline } from "@/lib/redis";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { cleanLine } from "@/lib/community-text";
import { TRACE_ENTRY, traceKey } from "@/lib/community-trace";

const base = (id: string) => `nl:cm:${id}`;
const votesKey = (id: string, post: string) => `${base(id)}:pv:${post}`;
const tallyKey = (id: string, post: string) => `${base(id)}:pc:${post}`;

/** More than Circle's 5 and more than Kajabi's and Discord's 10. */
export const MAX_POLL_OPTIONS = 12;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTION_TEXT = 80;
/** The furthest ahead a poll may be set to close: a year. */
export const MAX_POLL_DAYS = 365;

export type PollOption = {
  /** "1" to "12": its place, which never changes once anybody has voted. */
  id: string;
  text: string;
};

export type Poll = {
  options: PollOption[];
  /** More than one answer may be chosen. */
  multi: boolean;
  /** When it closes, in seconds, or 0 for never. */
  ends: number;
  /** Nobody but the creator sees the tally until it closes. */
  quiet: boolean;
};

/** A poll as a reader sees it: the counts, and what this person chose. */
export type PollView = {
  poll: Poll;
  counts: Record<string, number>;
  total: number;
  /** The option ids this viewer picked. Empty when they have not voted. */
  mine: string[];
  closed: boolean;
  /** Whether this viewer may see the counts at all. */
  showing: boolean;
};

export function pollClosed(poll: Poll, at = Math.floor(Date.now() / 1000)): boolean {
  return poll.ends > 0 && at >= poll.ends;
}

/**
 * Whatever came back from storage or from the composer, made safe to use, or
 * null when it is not a poll at all. Options keep the order they were written
 * in, and their ids are their places, so a tally can never drift on to a
 * different answer than the one that was voted for.
 */
export function parsePoll(raw: unknown): Poll | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const listed = Array.isArray(value.options) ? value.options : [];
  const options: PollOption[] = [];
  for (const entry of listed.slice(0, MAX_POLL_OPTIONS)) {
    const text = cleanLine(
      typeof entry === "string" ? entry : typeof (entry as { text?: unknown })?.text === "string" ? String((entry as { text: string }).text) : "",
      MAX_POLL_OPTION_TEXT,
    );
    if (text) options.push({ id: String(options.length + 1), text });
  }
  if (options.length < MIN_POLL_OPTIONS) return null;
  const ends = typeof value.ends === "number" && Number.isFinite(value.ends) && value.ends > 0 ? Math.floor(value.ends) : 0;
  return { options, multi: value.multi === true, ends, quiet: value.quiet === true };
}

/** The option ids a vote may carry, given the poll. Empty means take it back. */
export function cleanChoice(poll: Poll, asked: string[]): string[] {
  const allowed = new Set(poll.options.map((o) => o.id));
  const picked = [...new Set(asked.filter((one) => allowed.has(one)))];
  if (!poll.multi) return picked.slice(0, 1);
  return picked.slice(0, MAX_POLL_OPTIONS);
}

/**
 * Casts, changes or takes back one person's vote, and moves the tally with
 * it in the same call. An empty `choice` takes the vote back, which is a
 * thing none of the four platforms checked allow.
 *
 * Returns false when the poll has closed, so a vote cannot land after the
 * count people have already read.
 */
export async function vote(
  id: string,
  post: string,
  poll: Poll,
  who: string,
  choice: string[],
  room: DataStore,
): Promise<boolean> {
  if (pollClosed(poll)) return false;
  const picked = cleanChoice(poll, choice);
  const [raw] = await redisPipeline([["HGET", votesKey(id, post), who]]);
  const before = typeof raw === "string" && raw ? raw.split(",").filter(Boolean) : [];
  const gone = before.filter((one) => !picked.includes(one));
  const added = picked.filter((one) => !before.includes(one));
  if (!gone.length && !added.length) return true;
  // A vote is counted in its post's slot of the store's data room (lib/community.ts):
  // a new one takes room first (DataRoomError when it does not fit), one taken back gives it.
  const weight = (list: string[]) => (list.length ? dataBytes([list.join(",")], 1) : 0);
  const grown = weight(picked) - weight(before);
  // A first vote also writes its entry in the member's trace (lib/community.ts, traceKey); taking every pick back removes it.
  const traceIn = picked.length > 0 && before.length === 0;
  const traceOut = picked.length === 0 && before.length > 0;
  if (grown > 0 || traceIn) await needData(room, [...(grown > 0 ? [{ slot: `cm:p:${post}`, bytes: grown }] : []), ...(traceIn ? [TRACE_ENTRY] : [])]);
  const replies = await redisPipeline([
    ...gone.map((one) => ["HINCRBY", tallyKey(id, post), one, -1]),
    ...added.map((one) => ["HINCRBY", tallyKey(id, post), one, 1]),
    picked.length
      ? ["HSET", votesKey(id, post), who, picked.join(",")]
      : ["HDEL", votesKey(id, post), who],
    ...(traceIn ? [["SADD", traceKey(id, who), `v:${post}`]] : []),
    ...(traceOut ? [["SREM", traceKey(id, who), `v:${post}`]] : []),
  ]);
  // The trace's entry comes back only when this took it out (a deletion of the member takes the whole trace).
  const untraced = traceOut && Number(replies[replies.length - 1]) === 1;
  if (grown < 0 || untraced) await giveData(room, [...(grown < 0 ? [{ slot: `cm:p:${post}`, bytes: -grown }] : []), ...(untraced ? [TRACE_ENTRY] : [])]);
  return true;
}

/** The poll as this person should see it right now. */
export async function pollView(
  id: string,
  post: string,
  poll: Poll,
  who: string,
  owner: boolean,
): Promise<PollView> {
  const [tally, mine] = await redisPipeline([
    ["HGETALL", tallyKey(id, post)],
    ["HGET", votesKey(id, post), who],
  ]);
  return readView(poll, tally, mine, owner);
}

/**
 * The polls on a page of posts, in one round trip rather than one each.
 * Posts without a poll are simply absent from the map.
 */
export async function pollViews(
  id: string,
  posts: { id: string; poll: Poll | null }[],
  who: string,
  owner: boolean,
): Promise<Map<string, PollView>> {
  const withPolls = posts.filter((p): p is { id: string; poll: Poll } => p.poll !== null);
  const seen = new Map<string, PollView>();
  if (!withPolls.length) return seen;
  const rows = await redisPipeline(
    withPolls.flatMap((p) => [
      ["HGETALL", tallyKey(id, p.id)],
      ["HGET", votesKey(id, p.id), who],
    ]),
  );
  withPolls.forEach((p, i) => {
    seen.set(p.id, readView(p.poll, rows[i * 2], rows[i * 2 + 1], owner));
  });
  return seen;
}

/** One poll's replies, read into the shape a page renders. */
function readView(poll: Poll, tally: unknown, mineRaw: unknown, owner: boolean): PollView {
  const counts: Record<string, number> = {};
  const flat = Array.isArray(tally) ? tally.map(String) : [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const n = Math.max(0, Number(flat[i + 1]) || 0);
    if (n > 0) counts[flat[i]] = n;
  }
  const mine = typeof mineRaw === "string" && mineRaw ? mineRaw.split(",").filter(Boolean) : [];
  const closed = pollClosed(poll);
  return {
    poll,
    counts,
    total: Object.values(counts).reduce((sum, n) => sum + n, 0),
    mine,
    closed,
    showing: owner || closed || !poll.quiet,
  };
}

/** Everything a deleted post's poll leaves behind. */
export function pollKeys(id: string, post: string): string[] {
  return [votesKey(id, post), tallyKey(id, post)];
}

/** How a poll's closing time reads: "Closes in 3 days", "Closed". */
export function pollWhen(poll: Poll, at = Math.floor(Date.now() / 1000)): string {
  if (!poll.ends) return "";
  if (at >= poll.ends) return "Closed";
  const left = poll.ends - at;
  if (left < 3600) return `Closes in ${Math.max(1, Math.round(left / 60))} minutes`;
  if (left < 86_400) return `Closes in ${Math.round(left / 3600)} hours`;
  const days = Math.round(left / 86_400);
  return `Closes in ${days} ${days === 1 ? "day" : "days"}`;
}

/** One member's votes in the polls on these posts, for the copy of their data (619 [SZ3]): the options they picked, by post. Only reads. */
export async function votesOf(id: string, who: string, postIds: string[]): Promise<{ post: string; picked: string[] }[]> {
  if (!postIds.length) return [];
  const out: { post: string; picked: string[] }[] = [];
  for (let i = 0; i < postIds.length; i += 500) {
    const batch = postIds.slice(i, i + 500);
    const replies = await redisPipeline(batch.map((post) => ["HGET", votesKey(id, post), who]));
    batch.forEach((post, k) => {
      const raw = replies[k];
      if (typeof raw === "string" && raw) out.push({ post, picked: raw.split(",").filter(Boolean) });
    });
  }
  return out;
}
