/**
 * The room where a community talks at the speed people talk.
 *
 * A feed is for things worth coming back to. A room is for the hour everybody
 * is there at once, and it is the difference between a forum that empties and
 * a place people stay in. Stan has neither a room nor anything like one: posts
 * and comments, with posts that can be scheduled, which is the behaviour of a
 * blog. Circle made its chat spaces work independently of its direct-message
 * switch, which is a company treating chat as infrastructure. Whop built its
 * whole positioning on the room.
 *
 * What Whop documents and nobody else does is the moderation: a mute with a
 * duration, a cooldown between messages, a banned-word list, blocking links
 * and uploads, restricting posting to admins. That is the part worth matching,
 * because an unmoderated room is a room the creator closes after a fortnight.
 *
 * Here: a cooldown the creator sets, links off or on, creator-only when they
 * want the room quiet, and the community's own mute — which already means
 * "reads, does not write" — applying here with nothing extra to learn.
 *
 * Kept under the community's own id:
 *
 *   nl:cm:<id>:ch     the messages, scored by their number (sorted set)
 *   nl:cm:<id>:chn    the counter that numbers them
 *   nl:cm:<id>:chs:<who>  when this person last said something, for the cooldown
 *
 * A sorted set rather than a list, because the room is read by asking "what
 * has happened since number N". A list would mean sending the whole room on
 * every look, a few times a minute, to everybody in it.
 *
 * On what "live" means here, said plainly because the word is usually a lie:
 * the page asks whether anything is new every few seconds while people are
 * talking, twice a minute while the room is quiet (lib/chat-pace.ts), and
 * stops asking while the tab is in the background or nobody has touched the
 * page for a while. There is no socket held open. For a room of people
 * typing, the difference is not something a person can perceive; what it is
 * not is a claim that a message arrives the instant it is sent.
 */
import { MAX_CHAT_TEXT, MAX_CHAT_KEPT, CHAT_PAGE, MAX_SLOW, type ChatRefusal } from "@/lib/community-chat-rules";
export { MAX_CHAT_TEXT, MAX_CHAT_KEPT, CHAT_PAGE, MAX_SLOW, type ChatRefusal } from "@/lib/community-chat-rules";
import { redisPipeline } from "@/lib/redis";
import { cleanText, linkCount } from "@/lib/community-text";
import { holdsAll } from "@/lib/community-search";

const base = (id: string) => `nl:cm:${id}`;
const roomKey = (id: string) => `${base(id)}:ch`;
const countKey = (id: string) => `${base(id)}:chn`;
const spokeKey = (id: string, who: string) => `${base(id)}:chs:${who}`;

export type ChatMessage = {
  /** Its number: what a reader asks for "everything after". */
  i: number;
  /** CREATOR or a member key. */
  a: string;
  text: string;
  at: number;
  /**
   * The name it was said under, kept with the message so that reading what
   * is new needs nothing looked up (lib/chat-pace.ts). Absent on messages
   * from before October 7, 2026, whose names are read from the members.
   */
  n?: string;
};

export type ChatSetting = {
  /** The room exists at all. */
  on: boolean;
  /** Seconds a member waits between messages. 0 for none. */
  slow: number;
  /** Web addresses may be written here. */
  links: boolean;
  /** Only the creator writes; everybody else reads. */
  creatorOnly: boolean;
};

export const NO_CHAT: ChatSetting = { on: false, slow: 0, links: true, creatorOnly: false };

export function parseChatSetting(raw: unknown): ChatSetting {
  if (!raw || typeof raw !== "object") return { ...NO_CHAT };
  const value = raw as Record<string, unknown>;
  const slow = typeof value.slow === "number" && Number.isInteger(value.slow) ? value.slow : 0;
  return {
    on: value.on === true,
    slow: Math.min(Math.max(0, slow), MAX_SLOW),
    // Links allowed unless said otherwise: a room where nobody can share
    // anything is a room with a strange hole in it.
    links: value.links !== false,
    creatorOnly: value.creatorOnly === true,
  };
}

const now = () => Math.floor(Date.now() / 1000);

function parse(raw: unknown): ChatMessage | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ChatMessage>;
    if (typeof v.a !== "string" || typeof v.text !== "string" || typeof v.i !== "number") return null;
    return { i: v.i, a: v.a, text: v.text, at: typeof v.at === "number" ? v.at : 0, ...(typeof v.n === "string" && v.n ? { n: v.n.slice(0, 80) } : {}) };
  } catch {
    return null;
  }
}

export type SaidResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; reason: "off" | "empty" | "links" | "slow" | "creatorOnly"; wait?: number };

/**
 * Says something in the room.
 *
 * `owner` skips the cooldown and the creator-only gate, and nothing else: the
 * creator of a community is not a person their own room needs protecting from.
 */
export async function say(
  id: string,
  setting: ChatSetting,
  who: string,
  owner: boolean,
  raw: unknown,
  /** The name it is said under: the store's for the creator, the member's own otherwise. */
  name = "",
): Promise<SaidResult> {
  if (!setting.on) return { ok: false, reason: "off" };
  if (setting.creatorOnly && !owner) return { ok: false, reason: "creatorOnly" };
  const text = cleanText(raw, MAX_CHAT_TEXT);
  if (!text) return { ok: false, reason: "empty" };
  if (!setting.links && !owner && linkCount(text) > 0) return { ok: false, reason: "links" };

  if (setting.slow > 0 && !owner) {
    // SET NX with an expiry is the cooldown itself: it either takes, or it
    // tells how long is left. No clock is read and no row is written to be
    // cleaned up later.
    const [got] = await redisPipeline([["SET", spokeKey(id, who), "1", "NX", "EX", setting.slow]]);
    if (got === null) {
      const [left] = await redisPipeline([["TTL", spokeKey(id, who)]]);
      return { ok: false, reason: "slow", wait: Math.max(1, Number(left) || setting.slow) };
    }
  }

  const [n] = await redisPipeline([["INCR", countKey(id)]]);
  const said = cleanText(name, 80);
  const message: ChatMessage = { i: Number(n), a: who, text, at: now(), ...(said ? { n: said } : {}) };
  await redisPipeline([
    ["ZADD", roomKey(id), message.i, JSON.stringify(message)],
    // The room keeps its last MAX_CHAT_KEPT and forgets the rest.
    ["ZREMRANGEBYRANK", roomKey(id), 0, -(MAX_CHAT_KEPT + 1)],
  ]);
  return { ok: true, message };
}

export type ChatPage = {
  messages: ChatMessage[];
  /** The number to ask "everything after" with, next time. */
  cursor: number;
};

/**
 * What has been said, or what has been said since a number.
 *
 * `since` of 0 brings the last page of the room, which is what opening it
 * needs; anything else brings only what is new, which is what looking again
 * needs, and is why this is cheap enough to ask for every few seconds.
 */
export async function room(id: string, since = 0): Promise<ChatPage> {
  const [raw] = await redisPipeline(
    since > 0
      ? [["ZRANGEBYSCORE", roomKey(id), `(${since}`, "+inf", "LIMIT", 0, CHAT_PAGE]]
      : [["ZREVRANGE", roomKey(id), 0, CHAT_PAGE - 1]],
  );
  const rows = (Array.isArray(raw) ? raw : []).map(parse).filter((m): m is ChatMessage => m !== null);
  const messages = since > 0 ? rows : rows.reverse();
  return { messages, cursor: messages.length ? messages[messages.length - 1].i : since };
}

/** Seconds since a moment the room was spoken in (a message's `at`); -1 for a room nobody has spoken in. */
export function quietFor(at: number): number {
  return at > 0 ? Math.max(0, now() - at) : -1;
}

/**
 * When the room was last spoken in, in seconds; 0 for an empty room. One
 * read: what handing out a leave to ask needs to know (lib/chat-grant.ts).
 */
export async function lastSaid(id: string): Promise<number> {
  const [raw] = await redisPipeline([["ZREVRANGE", roomKey(id), 0, 0]]);
  return parse(Array.isArray(raw) ? raw[0] : null)?.at ?? 0;
}

/** Takes one message out of the room: the creator's, on anything in it. */
export async function unsay(id: string, number: number): Promise<boolean> {
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", roomKey(id), number, number]]);
  const rows = Array.isArray(raw) ? raw : [];
  if (!rows.length) return false;
  await redisPipeline([["ZREM", roomKey(id), ...rows.map(String)]]);
  return true;
}

/** Empties the room. What a creator does after a bad night. */
export async function clearRoom(id: string): Promise<void> {
  await redisPipeline([["DEL", roomKey(id)]]);
}

/**
 * Every way a message can be refused, and what the person is told.
 *
 * Kept here, beside the refusals themselves, and exhaustive on purpose: a
 * reason without its own sentence falls back to "try again in a moment",
 * which is wrong for most of these and actively false for two — somebody
 * whose access has ended will never succeed by trying again, and somebody who
 * hit the hourly ceiling is not waiting on the per-message cooldown.
 *
 * `slow` and `hourly` are deliberately separate. The route used to answer
 * `slow` for both, and the room told a member who had written thirty times in
 * an hour that they were waiting thirty seconds.
 */


export function refusalWords(reason: ChatRefusal, slow: number, wait?: number): string {
  switch (reason) {
    case "slow":
      return `One message every ${slow} seconds here. ${wait ?? slow} to go.`;
    case "hourly":
      return "That is as much as anybody may write in an hour. It opens again shortly.";
    case "links":
      return "Web addresses are not written in this room.";
    case "creatorOnly":
      return "Only the creator writes in this room.";
    case "muted":
      return "You can read here, but not write.";
    case "name":
      return "Choose a name on your own page first.";
    case "full":
      return "This community is full, so nothing can be written right now.";
    case "off":
      return "The room has been closed.";
    case "out":
      return "Your place here has ended, so this no longer takes messages.";
    case "empty":
      return "There was nothing to send.";
    case "resting":
      return "This store is resting for now, so nothing can be written here until it opens again.";
    case "unknown":
      return "That did not send. Try again in a moment.";
  }
}

/** How many messages the room holds right now. */
export async function roomSize(id: string): Promise<number> {
  const [n] = await redisPipeline([["ZCARD", roomKey(id)]]);
  return Number(n) || 0;
}

/**
 * The messages still in the room that hold every word searched for, newest
 * first.
 *
 * Read straight from the room rather than from an index, on purpose. The room
 * keeps its last MAX_CHAT_KEPT messages and forgets the rest; an index would
 * have to be told about every message that falls off the end, and the day it
 * missed one it would find messages the room no longer has. Reading the room
 * itself is one request for at most MAX_CHAT_KEPT short messages, and cannot
 * disagree with what is there.
 *
 * Matched exactly as every other search here is — whole words, accents folded,
 * the common ones dropped (lib/community-search.ts) — so a word finds the same
 * things in the room as it does in the feed.
 */
export async function searchRoom(id: string, used: string[]): Promise<ChatMessage[]> {
  if (!used.length) return [];
  const [raw] = await redisPipeline([["ZREVRANGE", roomKey(id), 0, MAX_CHAT_KEPT - 1]]);
  const rows = (Array.isArray(raw) ? raw : []).map(parse).filter((m): m is ChatMessage => m !== null);
  return rows.filter((message) => holdsAll(message.text, used));
}

/** Deletes what one member said in the room, and their cooldown (lib/community-erasure.ts). */
export async function forgetChatPerson(id: string, who: string): Promise<number> {
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", roomKey(id), "-inf", "+inf"]]);
  const theirs = (Array.isArray(raw) ? raw : []).map(String).filter((row) => {
    try {
      return (JSON.parse(row) as Partial<ChatMessage>).a === who;
    } catch {
      return false;
    }
  });
  await redisPipeline([["DEL", spokeKey(id, who)], ...(theirs.length ? [["ZREM", roomKey(id), ...theirs]] : [])]);
  return theirs.length;
}

/** What one member said in the community's room, for the copy of their data (619 [SZ3]): the messages the erasure deletes. Only reads. */
export async function chatMessagesOf(id: string, who: string): Promise<{ text: string; at: number }[]> {
  const [raw] = await redisPipeline([["ZRANGEBYSCORE", roomKey(id), "-inf", "+inf"]]);
  return (Array.isArray(raw) ? raw : []).map(String).flatMap((row) => {
    try {
      const message = JSON.parse(row) as Partial<ChatMessage>;
      return message.a === who && typeof message.text === "string" ? [{ text: message.text, at: Number(message.at) || 0 }] : [];
    } catch {
      return [];
    }
  });
}
