/**
 * Private messages inside a community.
 *
 * What the others do, checked on 30 September 2026, because "better" has to
 * mean something you can point at:
 *
 *   Stan     none. No member-to-member, no member-to-creator. Its AutoDM is
 *            Instagram automation and has nothing to do with the community.
 *   Circle   the best controls found: four switches on the community (enable
 *            messaging, member-to-member, group, voice) and two on the
 *            account (prevent members messaging me, disable DMs entirely),
 *            and an admin cannot read a member's messages.
 *   Whop     the best abuse handling found, but on its chat rooms rather than
 *            on DMs: mute with a duration, a cooldown between messages, a
 *            banned-word list, blocking links and uploads.
 *   Kajabi   creator-to-member only on the current product; member-to-member
 *            only survives on its legacy communities.
 *   Skool    DMs to anybody in your communities, from the $9 plan up.
 *
 * So: Circle's switches, Whop's rate limiting, and one thing none of the five
 * has — **the first message from someone you have never spoken to arrives as a
 * request.** It sits in its own list, it cannot be seen from the conversation
 * list, and it becomes a conversation only when the person accepts. Decline
 * and it goes, and that sender cannot open another request.
 *
 * That is the difference between DMs a creator turns on and DMs a creator
 * turns off after the first bad week. Every platform that offers open DMs
 * offers, along with them, the ability for any member to write to any other
 * member unasked. A request queue costs the honest sender one extra step and
 * costs the unwanted one everything.
 *
 * Two rules that are not settings, because they should not be anybody's to
 * change:
 *
 *   - The creator never reads a conversation they are not in. There is no
 *     moderation view of member-to-member messages, and the pages say so.
 *   - A muted or removed member cannot send. Reading what was already said to
 *     them stays possible; a mute is not a way to make evidence disappear.
 *
 * How it is kept, all under the community's own id:
 *
 *   nl:cm:<id>:dm:<pair>        the messages, newest last (list, capped)
 *   nl:cm:<id>:dm:i:<who>       their conversations, by when each last moved
 *   nl:cm:<id>:dm:q:<who>       requests waiting on them, newest first
 *   nl:cm:<id>:dm:x:<who>       who they have declined, and so will not hear from again
 *   nl:cm:<id>:dm:r:<pair>      how much of it each of the two has read
 *
 * A pair names itself: the two member keys, sorted, joined by a dot. Sorting
 * is what makes one conversation rather than two halves of one.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf as replyCount, repliesFor } from "@/lib/redis-reply";
import { countOf, holdsAll } from "@/lib/community-search";
import { CREATOR } from "@/lib/community";
import { stringList } from "@/lib/redis-reply";
import { type DataStore, giveData, needData, noteData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

/**
 * Where messages are counted in the store's data room (lib/store-data.ts):
 * one slot a conversation, its messages as they are kept (the oldest that
 * falls off gives its room back), its places in the two lists and what each
 * has read; and one for the people members have declined.
 */
const PAIR_SLOT = (pair: string) => `cm:dm:${pair}`;
const DECLINED_SLOT = "cm:dmx";
/** A conversation's places in two lists and its two read marks. */
const PAIR_BYTES = 4 * 96;
const DECLINED_BYTES = 96;

const base = (id: string) => `nl:cm:${id}`;
const chatKey = (id: string, pair: string) => `${base(id)}:dm:${pair}`;
const inboxKey = (id: string, who: string) => `${base(id)}:dm:i:${who}`;
const askedKey = (id: string, who: string) => `${base(id)}:dm:q:${who}`;
const shutKey = (id: string, who: string) => `${base(id)}:dm:x:${who}`;
const readKey = (id: string, pair: string) => `${base(id)}:dm:r:${pair}`;

export const MAX_MESSAGE_TEXT = 2_000;
/** How many messages one conversation keeps. Older ones fall off the end. */
export const MAX_MESSAGES = 500;
/** How many conversations and how many requests one person's lists hold. */
export const MAX_CONVERSATIONS = 500;
export const MAX_REQUESTS = 100;
/** How many people one person may have declined. */
export const MAX_DECLINED = 500;
export const INBOX_PAGE = 30;
export const MESSAGE_PAGE = 50;

export type Message = {
  /** Who wrote it: CREATOR or a member key. */
  a: string;
  text: string;
  at: number;
};

export type Conversation = {
  pair: string;
  /** The other person in it, from the point of view of whoever asked. */
  other: string;
  last: Message | null;
  /** When it last moved. */
  at: number;
  /** Something in it this person has not read. */
  unread: boolean;
};

/**
 * What a community allows. Kept on the config beside the spaces, so a creator
 * who wants no messages at all has that, and one who wants only to be written
 * to has that too.
 */
export type DmSetting = {
  /** Messages happen here at all. Off, and none of the rest matters. */
  on: boolean;
  /** Members may write to each other. Off, and only the creator can be written to. */
  between: boolean;
  /** A first message from a stranger waits to be accepted. */
  ask: boolean;
};

export const NO_DM: DmSetting = { on: false, between: false, ask: true };

export function parseDmSetting(raw: unknown): DmSetting {
  if (!raw || typeof raw !== "object") return { ...NO_DM };
  const value = raw as Record<string, unknown>;
  return {
    on: value.on === true,
    between: value.between === true,
    // Defaults to on, and a community written down before there were messages
    // gets it: the safe end of a switch is the one that costs a stranger a
    // step, not the one that costs a member their peace.
    ask: value.ask !== false,
  };
}

/** The name of the conversation between two people. Order never matters. */
export function pairOf(a: string, b: string): string {
  return [a, b].sort().join(".");
}

/** The other person in a pair, or "" when this person is not in it. */
export function otherIn(pair: string, who: string): string {
  const [a, b] = pair.split(".");
  if (a === who) return b ?? "";
  if (b === who) return a ?? "";
  return "";
}

const now = () => Math.floor(Date.now() / 1000);

function parseMessage(raw: unknown): Message | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Message>;
    if (typeof v.a !== "string" || typeof v.text !== "string") return null;
    return { a: v.a, text: v.text, at: typeof v.at === "number" ? v.at : 0 };
  } catch {
    return null;
  }
}

export type SendResult =
  | { ok: true; asked: boolean }
  | { ok: false; reason: "off" | "between" | "self" | "declined" | "empty" | "full" | "slow" };

/**
 * Whether these two may exchange messages at all, before anything is written.
 * Separate from sending so a page can decide whether to draw the box.
 */
export type SendRefusal = Extract<SendResult, { ok: false }>;

export function mayMessage(setting: DmSetting, from: string, to: string): SendRefusal | null {
  if (!setting.on) return { ok: false, reason: "off" };
  if (from === to) return { ok: false, reason: "self" };
  // With member-to-member off, the creator is still reachable, and can still
  // reply: a community where nobody can ask the creator anything privately is
  // not the safer choice, it is just a quieter one.
  if (!setting.between && from !== CREATOR && to !== CREATOR) return { ok: false, reason: "between" };
  return null;
}

/**
 * Writes a message.
 *
 * The first one to somebody who has never written back lands in their request
 * list rather than their conversations, unless the community turned that off,
 * and unless the two have spoken before. The creator is never made to ask:
 * somebody who bought from them can be written to, which is the relationship
 * they are already in.
 */
export async function send(
  id: string,
  setting: DmSetting,
  from: string,
  to: string,
  text: string,
  room: DataStore,
  // false when the sender is past the day's openings (the route's dmNew
  // window): a new request is refused before anything is written. A follow-up
  // to one already waiting, and a message in a conversation, still go.
  options: { mayAsk?: boolean } = {},
): Promise<SendResult> {
  const blocked = mayMessage(setting, from, to);
  if (blocked) return blocked;
  const words = text.trim().slice(0, MAX_MESSAGE_TEXT);
  if (!words) return { ok: false, reason: "empty" };
  const pair = pairOf(from, to);

  // Each reply in its exact shape (CX-123 rule 24): SISMEMBER and EXISTS 0 or 1,
  // ZCARD a whole count, and the pair's place in the recipient's request list
  // and in their inbox a score in text or none. A hole, null, text or a short
  // pipeline is not "not declined", "under the cap" or "already talking":
  // nothing is written and the route answers 503.
  const checks = repliesFor(
    await redisPipeline([
      ["SISMEMBER", shutKey(id, to), from],
      ["EXISTS", chatKey(id, pair)],
      ["ZCARD", inboxKey(id, to)],
      ["ZSCORE", askedKey(id, to), pair],
      ["ZSCORE", inboxKey(id, to), pair],
    ]),
    5,
  );
  const declined = replyCount(checks?.[0]);
  const already = replyCount(checks?.[1]);
  const size = replyCount(checks?.[2]);
  const queued = checks?.[3];
  const listed = checks?.[4];
  if (declined === null || declined > 1 || already === null || already > 1 || size === null || !scoreOrNone(queued) || !scoreOrNone(listed)) {
    throw new UnknownReplyError("a private message's declined, conversation, count or request check");
  }
  // Declined once is declined for good, and the sender is told nothing that
  // would let them work out they were declined rather than ignored.
  if (declined === 1) return { ok: false, reason: "declined" };
  // "Already talking" is the pair in the recipient's own inbox, never a
  // conversation that merely exists: one left behind with no line of theirs
  // (a request trimmed while its sender wrote again, Claude 6 on #3266) must
  // not let the next message past the request.
  const talking = listed !== null;
  // A new conversation, or a new request, needs room in the recipient's list.
  if (size >= MAX_CONVERSATIONS && !talking && queued === null) return { ok: false, reason: "full" };

  const message: Message = { a: from, text: words, at: now() };
  // A request whenever the community asks for one and the two are not talking
  // yet. The creator writing to a member never is; a member writing to the
  // creator never is either. A request the recipient has not answered stays
  // one: another message from the sender joins it where it waits, in its first
  // place (ZADD NX), and never reaches their inbox before they accept.
  const asking = setting.ask && !talking && from !== CREATOR && to !== CREATOR;
  // Only a request that is not in the list yet takes a place in it.
  const fresh = asking && queued === null;
  if (fresh && options.mayAsk === false) return { ok: false, reason: "slow" };

  // Its room first (DataRoomError when it does not fit). A conversation at
  // MAX_MESSAGES lets its oldest go, and that one's room comes back.
  const [length, oldest] = await redisPipeline([["LLEN", chatKey(id, pair)], ["LINDEX", chatKey(id, pair), 0]]);
  const dropped = Number(length) >= MAX_MESSAGES && typeof oldest === "string" ? dataBytes([oldest], 1) : 0;
  const taken = dataBytes([JSON.stringify(message)], 1) + (already ? 0 : PAIR_BYTES) - dropped;
  await needData(room, [{ slot: PAIR_SLOT(pair), bytes: taken }]);

  // A full request list makes room before the new request goes in, and the
  // requests that leave it go whole (rule 30). Unknown: nothing new is written
  // and the room just taken comes back.
  if (fresh) {
    try {
      await dropOldestRequests(id, to, room);
    } catch (error) {
      await giveData(room, [{ slot: PAIR_SLOT(pair), bytes: taken }]);
      throw error;
    }
  }

  await redisPipeline([
    ["RPUSH", chatKey(id, pair), JSON.stringify(message)],
    ["LTRIM", chatKey(id, pair), -MAX_MESSAGES, -1],
    ["ZADD", inboxKey(id, from), message.at, pair],
    // NX: a request already in the list keeps its first place, and one a trim
    // took out while this was on its way is put back, so what is stored stays
    // in the recipient's list for their copy and their erasure (rule 30).
    ...(asking ? [["ZADD", askedKey(id, to), "NX", message.at, pair]] : [["ZADD", inboxKey(id, to), message.at, pair]]),
    // The sender has read what they just wrote.
    ["HSET", readKey(id, pair), from, message.at],
  ]);
  if (asking && (await acceptedMeanwhile(id, to, pair))) return { ok: true, asked: false };
  return { ok: true, asked: asking };
}

/**
 * After a request's write: whether the recipient said yes while it was on its way (accept wrote the inbox line before
 * taking the request line out). Then the request line this write put back with ZADD NX is a stray beside the accepted
 * conversation, so it goes, and the message is in the conversation, not a request (Claude 6's note on #3266). Read
 * exactly: anything but a score or none, or Redis failing, leaves the line where it is and says nothing was accepted;
 * the message itself is written either way, and the trim and the thread already read a pair in the inbox as accepted.
 */
async function acceptedMeanwhile(id: string, to: string, pair: string): Promise<boolean> {
  try {
    const listed = repliesFor(await redisPipeline([["ZSCORE", inboxKey(id, to), pair]]), 1);
    if (!listed || listed[0] === null || !scoreOrNone(listed[0])) return false;
    await redisPipeline([["ZREM", askedKey(id, to), pair]]);
    return true;
  } catch (error) {
    console.error("reading whether a request was accepted on its way failed", error);
    return false;
  }
}

/** A sorted-set score as Redis gives it (a number in text), or none (null). */
function scoreOrNone(reply: unknown): boolean {
  return reply === null || (typeof reply === "string" && reply.trim() !== "" && Number.isFinite(Number(reply)));
}

/**
 * Makes room in a member's request list for one more: every request past the
 * newest MAX_REQUESTS - 1 goes, and goes whole. Its conversation, its read
 * marks and its place in the sender's inbox are deleted, not just its line in
 * the request list. A request trimmed off the list alone would leave a message
 * addressed to this member that nothing of theirs points at, so their data copy
 * would miss it and erasing them would leave it stored (rule 30).
 *
 * Everything past the cap is read, not just one, so a list a concurrent send
 * pushed over the cap is brought back under it by the next request.
 *
 * Each reply in its exact shape (rule 24): a lost or off-shape reply throws
 * UnknownReplyError and the send writes nothing new. The conversation is
 * deleted first and the request list line last, so whatever is still stored
 * stays in this member's request list for a retry, their copy and their
 * erasure to find.
 *
 * Read, then deleted, in separate requests: a race is possible. If the
 * recipient accepts one of these requests between the read and the deletion,
 * the accepted conversation loses the messages it had, and their inbox keeps
 * its name (still theirs to copy and erase). If the same sender writes again
 * in that moment, their write puts the request's line back (send's ZADD NX):
 * whatever it stores stays in the recipient's request list, and the list may
 * hold one past the cap until the next request trims it.
 */
async function dropOldestRequests(id: string, to: string, room: DataStore): Promise<void> {
  const what = "a member's oldest private-message requests removed";
  const past = stringList(repliesFor(await redisPipeline([["ZREVRANGE", askedKey(id, to), MAX_REQUESTS - 1, -1]]), 1)?.[0]);
  if (!past) throw new UnknownReplyError(what);
  if (!past.length) return;
  // A pair also in their inbox was accepted (inside a follow-up's window, which
  // put its line back): only that stray line goes, never the conversation they
  // accepted. Each place read exactly, a score in text or none.
  const where = repliesFor(await redisPipeline(past.map((pair) => ["ZSCORE", inboxKey(id, to), pair])), past.length);
  if (!where || where.some((reply) => !scoreOrNone(reply))) throw new UnknownReplyError(what);
  const pairs = past.filter((pair, i) => where[i] === null && otherIn(pair, to) !== "");
  const commands: (string | number)[][] = pairs.flatMap((pair) => [
    ["DEL", chatKey(id, pair), readKey(id, pair)],
    ["ZREM", inboxKey(id, otherIn(pair, to)), pair],
  ]);
  if (commands.length) {
    const deleted = repliesFor(await redisPipeline(commands), commands.length);
    if (!deleted || deleted.some((reply) => replyCount(reply) === null)) throw new UnknownReplyError(what);
  }
  const unlisted = repliesFor(await redisPipeline(past.map((pair) => ["ZREM", askedKey(id, to), pair])), past.length);
  if (!unlisted || unlisted.some((reply) => (replyCount(reply) ?? 2) > 1)) throw new UnknownReplyError(what);
  // Each conversation's room comes back, as when a request is declined.
  if (pairs.length) await giveData(room, pairs.map((pair) => ({ slot: PAIR_SLOT(pair), bytes: 0, set: true })));
}

/** Accepts a request: it becomes an ordinary conversation. */
export async function accept(id: string, who: string, pair: string): Promise<boolean> {
  if (!otherIn(pair, who)) return false;
  const [held] = await redisPipeline([["ZSCORE", askedKey(id, who), pair]]);
  if (held === null || held === undefined) return false;
  // The inbox line goes in before the request line comes out. A follow-up request racing this yes writes its line back
  // with ZADD NX and then reads the inbox (send): in either order of the two writers' commands, it either sees the
  // pair in the inbox and takes its own stray line out, or its line is taken out here.
  await redisPipeline([
    ["ZADD", inboxKey(id, who), Number(held) || now(), pair],
    ["ZREM", askedKey(id, who), pair],
  ]);
  return true;
}

/**
 * Declines a request: it goes, and that person cannot open another.
 *
 * The messages themselves go with it. Keeping an unwanted message that its
 * reader said no to, in case somebody later wants to read it, is not a
 * kindness to anybody in this exchange.
 */
export async function decline(id: string, who: string, pair: string, room: DataStore): Promise<boolean> {
  const other = otherIn(pair, who);
  if (!other) return false;
  const [held] = await redisPipeline([["ZSCORE", askedKey(id, who), pair]]);
  if (held === null || held === undefined) return false;
  await redisPipeline([
    ["ZREM", askedKey(id, who), pair],
    ["ZREM", inboxKey(id, other), pair],
    ["DEL", chatKey(id, pair), readKey(id, pair)],
    ["SADD", shutKey(id, who), other],
  ]);
  // The conversation's room comes back; the person declined takes a little,
  // never refused: saying no must always work.
  await giveData(room, [{ slot: PAIR_SLOT(pair), bytes: 0, set: true }]);
  await noteData(room, [{ slot: DECLINED_SLOT, bytes: DECLINED_BYTES }]);
  // Bounded, so one person's refusals cannot grow without end. Dropping the
  // oldest is the right way round: somebody who declined five hundred people
  // is far likelier to meet a new stranger than the first one again.
  const [count] = await redisPipeline([["SCARD", shutKey(id, who)]]);
  if (Number(count) > MAX_DECLINED) {
    await redisPipeline([["SPOP", shutKey(id, who)]]);
    await giveData(room, [{ slot: DECLINED_SLOT, bytes: DECLINED_BYTES }]);
  }
  return true;
}

/** Lets somebody previously declined write again. */
export async function unblock(id: string, who: string, other: string, room: DataStore): Promise<void> {
  const [removed] = await redisPipeline([["SREM", shutKey(id, who), other]]);
  if (Number(removed) === 1) await giveData(room, [{ slot: DECLINED_SLOT, bytes: DECLINED_BYTES }]);
}

/** Everyone this person has declined. */
export async function declinedBy(id: string, who: string): Promise<string[]> {
  const [raw] = await redisPipeline([["SMEMBERS", shutKey(id, who)]]);
  return Array.isArray(raw) ? raw.map(String) : [];
}

/** One page of a person's conversations, the ones that moved last on top. */
export async function inbox(id: string, who: string, requests = false): Promise<Conversation[]> {
  const key = requests ? askedKey(id, who) : inboxKey(id, who);
  const [raw] = await redisPipeline([["ZREVRANGE", key, 0, INBOX_PAGE - 1, "WITHSCORES"]]);
  const flat = Array.isArray(raw) ? raw.map(String) : [];
  const pairs: { pair: string; at: number }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) pairs.push({ pair: flat[i], at: Number(flat[i + 1]) || 0 });
  if (!pairs.length) return [];
  const rows = await redisPipeline(
    pairs.flatMap(({ pair }) => [
      ["LRANGE", chatKey(id, pair), -1, -1],
      ["HGET", readKey(id, pair), who],
    ]),
  );
  return pairs.map(({ pair, at }, i) => {
    const tail = rows[i * 2];
    const last = parseMessage(Array.isArray(tail) ? tail[0] : null);
    const seen = Number(rows[i * 2 + 1]) || 0;
    return {
      pair,
      other: otherIn(pair, who),
      last,
      at,
      unread: Boolean(last && last.a !== who && last.at > seen),
    };
  });
}

/** How many requests are waiting, for the badge. */
export async function requestCount(id: string, who: string): Promise<number> {
  const [n] = await redisPipeline([["ZCARD", askedKey(id, who)]]);
  return Number(n) || 0;
}

export type Thread = {
  messages: Message[];
  /** Waiting to be accepted by the person reading it. */
  pending: boolean;
};

/**
 * One conversation, oldest message first, and whether this person still has
 * to accept it. Reading it marks it read.
 */
export async function thread(id: string, who: string, pair: string): Promise<Thread | null> {
  if (!otherIn(pair, who)) return null;
  const [raw, asked, listed] = await redisPipeline([
    ["LRANGE", chatKey(id, pair), -MESSAGE_PAGE, -1],
    ["ZSCORE", askedKey(id, who), pair],
    ["ZSCORE", inboxKey(id, who), pair],
  ]);
  const messages = (Array.isArray(raw) ? raw : []).map(parseMessage).filter((m): m is Message => m !== null);
  if (!messages.length) return null;
  const last = messages[messages.length - 1];
  await redisPipeline([["HSET", readKey(id, pair), who, last.at]]).catch(() => {});
  // Pending only while it waits and is not in their inbox: one accepted while a
  // follow-up was on its way can sit in both lists, and it was accepted.
  return { messages, pending: asked !== null && asked !== undefined && (listed === null || listed === undefined) };
}

/** Everything a conversation leaves behind, for when a member is removed. */
export function dmKeys(id: string, who: string): string[] {
  return [inboxKey(id, who), askedKey(id, who), shutKey(id, who)];
}

/** How many of a person's conversations one search reads, the most recent first. */
export const SEARCH_CONVERSATIONS = 30;

/** How many conversations a search of this person's messages reads (SEARCH_CONVERSATIONS at the most): one command, before it reads them (lib/page-read-rules.ts). Null when it cannot be counted. */
export async function searchedConversations(id: string, who: string): Promise<number | null> {
  try {
    const [n] = await redisPipeline([["ZCARD", inboxKey(id, who)]]);
    // An absent or odd reply is unknown, never none (Codex I, #2316).
    const count = countOf(n);
    return count === null ? null : Math.min(count, SEARCH_CONVERSATIONS);
  } catch {
    return null;
  }
}
/** How many of the latest messages of each it reads. */
export const SEARCH_MESSAGES = 200;
/** How many conversations are read in one request, so no reply is ever large. */
const SEARCH_BATCH = 10;

export type MessageHit = { pair: string; other: string; message: Message };

/**
 * The messages in this person's own conversations that hold every word
 * searched for, newest first.
 *
 * Only ever their own. The conversations read are the ones in their inbox,
 * which holds nothing but the pairs they are one half of; nothing here takes a
 * pair from outside, so there is no id to change to read somebody else's.
 *
 * Read rather than indexed, and bounded where the page can say so: the
 * SEARCH_CONVERSATIONS most recent conversations, the last SEARCH_MESSAGES
 * messages of each. A private message is the last thing that should sit in a
 * second copy, word by word, in an index that has to be kept in step with a
 * list that trims itself — and a person looking for something said to them is
 * nearly always looking for something recent.
 *
 * Each request carries at most SEARCH_BATCH conversations, so a person with
 * long conversations never asks Redis for one enormous reply.
 */
export async function searchMessages(id: string, who: string, used: string[]): Promise<MessageHit[]> {
  if (!used.length) return [];
  // Each list in its exact shape (CX-123 rule 24): a lost or off-shape reply is
  // not "no match", so the search page says it could not search the messages.
  // Only an exact empty list has nothing to find.
  const what = "a member's conversations for a search";
  const inbox = stringList(repliesFor(await redisPipeline([["ZREVRANGE", inboxKey(id, who), 0, SEARCH_CONVERSATIONS - 1]]), 1)?.[0]);
  if (!inbox) throw new UnknownReplyError(what);
  const pairs = inbox.filter((pair) => otherIn(pair, who) !== "");
  const hits: MessageHit[] = [];
  for (let at = 0; at < pairs.length; at += SEARCH_BATCH) {
    const batch = pairs.slice(at, at + SEARCH_BATCH);
    const rows = repliesFor(await redisPipeline(batch.map((pair) => ["LRANGE", chatKey(id, pair), -SEARCH_MESSAGES, -1])), batch.length);
    if (!rows) throw new UnknownReplyError(what);
    batch.forEach((pair, i) => {
      const list = stringList(rows[i]);
      if (!list) throw new UnknownReplyError(what);
      for (const entry of list) {
        const message = parseMessage(entry);
        if (message && holdsAll(message.text, used)) hits.push({ pair, other: otherIn(pair, who), message });
      }
    });
  }
  return hits.sort((a, b) => b.message.at - a.message.at);
}

/**
 * Deletes one member's private messages (lib/community-erasure.ts): every
 * conversation and request they are in, for both people in it, since a
 * conversation is the two of them; and their lists of conversations,
 * requests and people they declined. Somebody else's choice to decline them
 * stays with that person.
 */
export async function forgetDmPerson(id: string, who: string): Promise<number> {
  // Both lists in their exact shape (CX-123 rule 24): a lost or off-shape reply
  // is not "no conversations", so nothing is deleted, their own lists included,
  // and the erasure stays pending to be retried. Only exact empty lists have
  // nothing to go through.
  const what = "a member's private conversations forgotten";
  const lists = repliesFor(await redisPipeline([["ZRANGEBYSCORE", inboxKey(id, who), "-inf", "+inf"], ["ZRANGEBYSCORE", askedKey(id, who), "-inf", "+inf"]]), 2);
  const mine = stringList(lists?.[0]);
  const asked = stringList(lists?.[1]);
  if (!mine || !asked) throw new UnknownReplyError(what);
  const pairs = [...new Set([...mine, ...asked])].filter((p) => p.split(".").includes(who));
  const commands: (string | number)[][] = [];
  for (const pair of pairs) {
    const other = pair.split(".").find((k) => k !== who) ?? "";
    commands.push(["DEL", chatKey(id, pair), readKey(id, pair)]);
    if (other) commands.push(["ZREM", inboxKey(id, other), pair], ["ZREM", askedKey(id, other), pair]);
  }
  // The conversations first, each deletion answered with its count; their own
  // lists only after that, so a retry can still find every conversation.
  if (commands.length) {
    const replies = repliesFor(await redisPipeline(commands), commands.length);
    if (!replies || replies.some((reply) => replyCount(reply) === null)) throw new UnknownReplyError(what);
  }
  const gone = repliesFor(await redisPipeline([["DEL", ...dmKeys(id, who)]]), 1);
  if (replyCount(gone?.[0]) === null) throw new UnknownReplyError(what);
  return pairs.length;
}

/**
 * Every private conversation and request one member is in, whole, for the
 * copy of their data (619 [SZ3], lib/person-copy.ts): the conversations the
 * erasure deletes. Each message says whether they wrote it; the other
 * person is not named (their key, handle and address are theirs). Only
 * reads: no read mark is set.
 */
export async function conversationsOf(id: string, who: string): Promise<{ request: boolean; messages: { mine: boolean; fromCreator: boolean; text: string; at: number }[] }[]> {
  // Every list and line in its exact shape (CX-123 rule 24): a lost or
  // off-shape reply, or a line that cannot be read as a message, is not "no
  // conversations" or "no messages". It throws, so lib/person-copy.ts fails the
  // whole copy rather than hand over one with a part silently missing. Only
  // exact empty lists mean none.
  const what = "a member's private conversations for their data copy";
  const heads = repliesFor(await redisPipeline([["ZRANGEBYSCORE", inboxKey(id, who), "-inf", "+inf"], ["ZRANGEBYSCORE", askedKey(id, who), "-inf", "+inf"]]), 2);
  const mine = stringList(heads?.[0]);
  const asked = stringList(heads?.[1]);
  if (!mine || !asked) throw new UnknownReplyError(what);
  const requests = new Set(asked);
  const pairs = [...new Set([...mine, ...asked])].filter((p) => p.split(".").includes(who));
  if (!pairs.length) return [];
  const lists = repliesFor(await redisPipeline(pairs.map((pair) => ["LRANGE", chatKey(id, pair), 0, -1])), pairs.length);
  if (!lists) throw new UnknownReplyError(what);
  return pairs.map((pair, i) => {
    const lines = stringList(lists[i]);
    if (!lines) throw new UnknownReplyError(what);
    return {
      request: requests.has(pair),
      messages: lines.map((line) => {
        const m = parseMessage(line);
        if (!m) throw new UnknownReplyError(what);
        return { mine: m.a === who, fromCreator: m.a === CREATOR, text: m.text, at: m.at };
      }),
    };
  });
}

/** How many conversations and requests one member is in: what deleting them goes through (lib/community-erasure.ts). */
export async function dmCount(id: string, who: string): Promise<number> {
  const [mine, asked] = await redisPipeline([["ZCARD", inboxKey(id, who)], ["ZCARD", askedKey(id, who)]]);
  return (Number(mine) || 0) + (Number(asked) || 0);
}
