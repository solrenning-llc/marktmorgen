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
 *   nl:cm:<id>:dm:xo:<who>      who they have declined, and so will not hear from again,
 *                               each by when (a sorted set, so the oldest can go first)
 *   nl:cm:<id>:dm:x:<who>       refusals kept before 7 November 2026, as a plain set:
 *                               still read everywhere, moved into the one above on the
 *                               person's next refusal, never written to again
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
/** Refusals as they were kept before 7 November 2026: a plain set, read and moved, never added to. */
const shutKey = (id: string, who: string) => `${base(id)}:dm:x:${who}`;
/** Refusals as they are kept: a sorted set, each scored by the second it was made. */
const declinedKey = (id: string, who: string) => `${base(id)}:dm:xo:${who}`;
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

/**
 * KEYS[1] the plain set of refusals kept before 7 November 2026, KEYS[2] the
 * sorted set they are kept in now: every member of the first put in the
 * second as the oldest (score 0; one already there keeps its own), and the
 * first deleted, in one step; answers how many it held. lib/redis-memory.ts
 * runs the same for the tests.
 */
export const DECLINED_MOVE = `-- marktmorgen:dm-declined-move:v1
local held = redis.call("SMEMBERS", KEYS[1])
for i = 1, #held, 500 do
  local batch = {}
  for j = i, math.min(i + 499, #held) do
    batch[#batch + 1] = 0
    batch[#batch + 1] = held[j]
  end
  redis.call("ZADD", KEYS[2], "NX", unpack(batch))
end
if #held > 0 then redis.call("DEL", KEYS[1]) end
return #held`;

/**
 * A ZSCORE reply read exactly: 1 when the member is there (Redis answers its
 * score, as a number or its text), 0 when it answered none, and null for
 * anything else, which is unknown and never "not there".
 */
function scored(reply: unknown): 0 | 1 | null {
  if (reply === null) return 0;
  if (typeof reply === "number") return Number.isFinite(reply) ? 1 : null;
  return typeof reply === "string" && reply.trim() !== "" && Number.isFinite(Number(reply)) ? 1 : null;
}

/** An exact 0 or 1 (SISMEMBER, SREM or ZREM of one member, ZADD of one), or null. */
function bit(reply: unknown): 0 | 1 | null {
  const n = replyCount(reply);
  return n === 0 || n === 1 ? n : null;
}

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
  | { ok: false; reason: "off" | "between" | "self" | "declined" | "empty" | "full" };

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
): Promise<SendResult> {
  const blocked = mayMessage(setting, from, to);
  if (blocked) return blocked;
  const words = text.trim().slice(0, MAX_MESSAGE_TEXT);
  if (!words) return { ok: false, reason: "empty" };
  const pair = pairOf(from, to);

  // Each reply in its exact shape (CX-123 rule 24): ZSCORE a score or none,
  // SISMEMBER and EXISTS 0 or 1, ZCARD a whole count. A hole, null, text or a
  // short pipeline is not "not declined", "under the cap" or "already
  // talking": nothing is written and the route answers 503.
  const checks = repliesFor(
    await redisPipeline([
      ["ZSCORE", declinedKey(id, to), from],
      // A refusal kept before 7 November 2026 refuses just the same.
      ["SISMEMBER", shutKey(id, to), from],
      ["EXISTS", chatKey(id, pair)],
      ["ZCARD", inboxKey(id, to)],
    ]),
    4,
  );
  const declined = checks ? scored(checks[0]) : null;
  const declinedBefore = bit(checks?.[1]);
  const already = bit(checks?.[2]);
  const size = replyCount(checks?.[3]);
  if (declined === null || declinedBefore === null || already === null || size === null) {
    throw new UnknownReplyError("a private message's declined, conversation or count check");
  }
  // Declined once is declined for good, and the sender is told nothing that
  // would let them work out they were declined rather than ignored.
  if (declined === 1 || declinedBefore === 1) return { ok: false, reason: "declined" };
  if (size >= MAX_CONVERSATIONS && !already) return { ok: false, reason: "full" };

  const message: Message = { a: from, text: words, at: now() };
  // A request when this is the first thing said and the community asks for
  // one. The creator writing to a member never is; a member writing to the
  // creator never is either.
  const asking = setting.ask && !already && from !== CREATOR && to !== CREATOR;

  // Its room first (DataRoomError when it does not fit). A conversation at
  // MAX_MESSAGES lets its oldest go, and that one's room comes back.
  const [length, oldest] = await redisPipeline([["LLEN", chatKey(id, pair)], ["LINDEX", chatKey(id, pair), 0]]);
  const dropped = Number(length) >= MAX_MESSAGES && typeof oldest === "string" ? dataBytes([oldest], 1) : 0;
  await needData(room, [{ slot: PAIR_SLOT(pair), bytes: dataBytes([JSON.stringify(message)], 1) + (already ? 0 : PAIR_BYTES) - dropped }]);

  await redisPipeline([
    ["RPUSH", chatKey(id, pair), JSON.stringify(message)],
    ["LTRIM", chatKey(id, pair), -MAX_MESSAGES, -1],
    ["ZADD", inboxKey(id, from), message.at, pair],
    ...(asking
      ? [
          ["ZADD", askedKey(id, to), message.at, pair],
          ["ZREMRANGEBYRANK", askedKey(id, to), 0, -(MAX_REQUESTS + 1)],
        ]
      : [["ZADD", inboxKey(id, to), message.at, pair]]),
    // The sender has read what they just wrote.
    ["HSET", readKey(id, pair), from, message.at],
  ]);
  return { ok: true, asked: asking };
}

/** Accepts a request: it becomes an ordinary conversation. */
export async function accept(id: string, who: string, pair: string): Promise<boolean> {
  if (!otherIn(pair, who)) return false;
  const [held] = await redisPipeline([["ZSCORE", askedKey(id, who), pair]]);
  if (held === null || held === undefined) return false;
  await redisPipeline([
    ["ZREM", askedKey(id, who), pair],
    ["ZADD", inboxKey(id, who), Number(held) || now(), pair],
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
  // The refusal first, before the request is taken away, and every reply read
  // exactly (CX-123 rule 24): anything unknown throws, so the page says it
  // could not confirm, the request still waits, and a second try finishes it
  // (each step below is safe to run twice).
  //
  // Refusals kept before 7 November 2026, in a plain set, are moved into the
  // sorted set as the oldest there (score 0) and the plain set deleted, in one
  // step inside Redis (DECLINED_MOVE): nothing is read out and sent back, and
  // no refusal can be written to the plain set between the two and lost.
  // Bounded, so one person's refusals cannot grow without end: the oldest go
  // first (somebody who declined five hundred people is far likelier to meet
  // a new stranger than the first one again), cut before the new one is
  // written, so the one just declined is never the one let go, and with no
  // size to read first.
  const written = repliesFor(
    await redisPipeline([
      ["EVAL", DECLINED_MOVE, 2, shutKey(id, who), declinedKey(id, who)],
      ["ZREMRANGEBYRANK", declinedKey(id, who), 0, -MAX_DECLINED],
      ["ZADD", declinedKey(id, who), now(), other],
    ]),
    3,
  );
  const moved = replyCount(written?.[0]);
  const trimmed = replyCount(written?.[1]);
  const shut = bit(written?.[2]);
  if (moved === null || trimmed === null || shut === null) {
    throw new UnknownReplyError("whether a private message request was declined");
  }
  // Then the request and its messages go; each reply is a count, or what was
  // said gone is not known to be.
  const removed = repliesFor(
    await redisPipeline([
      ["ZREM", askedKey(id, who), pair],
      ["ZREM", inboxKey(id, other), pair],
      ["DEL", chatKey(id, pair), readKey(id, pair)],
    ]),
    3,
  );
  if (!removed || removed.some((reply) => replyCount(reply) === null)) {
    throw new UnknownReplyError("whether a declined request was taken away");
  }
  // The conversation's room comes back; the person declined takes a little,
  // never refused: saying no must always work. Those cut by the bound give
  // theirs back.
  await giveData(room, [{ slot: PAIR_SLOT(pair), bytes: 0, set: true }]);
  await noteData(room, [{ slot: DECLINED_SLOT, bytes: DECLINED_BYTES }]);
  if (trimmed > 0) await giveData(room, [{ slot: DECLINED_SLOT, bytes: trimmed * DECLINED_BYTES }]);
  return true;
}

/** Lets somebody previously declined write again. */
export async function unblock(id: string, who: string, other: string, room: DataStore): Promise<void> {
  // Read exactly (CX-123 rule 24): 0 or 1 from each place a refusal is kept
  // (the sorted set and the plain set of before 7 November 2026), and anything
  // else is unknown, never "they can write to you again". Removing twice
  // changes nothing, so a second try is safe.
  const replies = repliesFor(await redisPipeline([["ZREM", declinedKey(id, who), other], ["SREM", shutKey(id, who), other]]), 2);
  const removed = bit(replies?.[0]);
  const removedBefore = bit(replies?.[1]);
  if (removed === null || removedBefore === null) throw new UnknownReplyError("whether a declined person may write again");
  if (removed === 1 || removedBefore === 1) await giveData(room, [{ slot: DECLINED_SLOT, bytes: DECLINED_BYTES }]);
}

/** Everyone this person has declined, wherever the refusal is kept; an unknown reply throws, never "nobody". */
export async function declinedBy(id: string, who: string): Promise<string[]> {
  const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", declinedKey(id, who), "-inf", "+inf"], ["SMEMBERS", shutKey(id, who)]]), 2);
  const ordered = stringList(replies?.[0]);
  const before = stringList(replies?.[1]);
  if (!ordered || !before) throw new UnknownReplyError("who a person has declined");
  return [...new Set([...ordered, ...before])];
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
  const [raw, asked] = await redisPipeline([
    ["LRANGE", chatKey(id, pair), -MESSAGE_PAGE, -1],
    ["ZSCORE", askedKey(id, who), pair],
  ]);
  const messages = (Array.isArray(raw) ? raw : []).map(parseMessage).filter((m): m is Message => m !== null);
  if (!messages.length) return null;
  const last = messages[messages.length - 1];
  await redisPipeline([["HSET", readKey(id, pair), who, last.at]]).catch(() => {});
  return { messages, pending: asked !== null && asked !== undefined };
}

/** Everything a conversation leaves behind, for when a member is removed. */
export function dmKeys(id: string, who: string): string[] {
  return [inboxKey(id, who), askedKey(id, who), declinedKey(id, who), shutKey(id, who)];
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
  // dmKeys names both places a refusal is kept (the sorted set ":dm:xo:" and the
  // plain set ":dm:x:" of before 7 November 2026): whatever deletes or counts a
  // person's refusals here deletes and counts both, never only the plain set.
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
