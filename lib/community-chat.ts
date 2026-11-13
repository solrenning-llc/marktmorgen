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
import { isProxy } from "node:util/types";
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { cleanText, linkCount } from "@/lib/community-text";
import { holdsAll } from "@/lib/community-search";
import { stringList } from "@/lib/redis-reply";

const base = (id: string) => `nl:cm:${id}`;
const roomKey = (id: string) => `${base(id)}:ch`;
const countKey = (id: string) => `${base(id)}:chn`;
const spokeKey = (id: string, who: string) => `${base(id)}:chs:${who}`;
const CHAT_AUTHOR = /^(?:creator|[0-9a-f]{32})$/;

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

/** JSON.parse keeps only the last repeated key; a personal copy must not lose that ambiguity. */
function hasRepeatedTopLevelKey(raw: string): boolean {
  const keys = new Set<string>();
  let depth = 0;
  let stringStart = -1;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (stringStart >= 0) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        const token = raw.slice(stringStart, index + 1);
        stringStart = -1;
        if (depth === 1) {
          let next = index + 1;
          while (/\s/.test(raw[next] ?? "")) next += 1;
          if (raw[next] === ":") {
            let key: unknown;
            try {
              key = JSON.parse(token);
            } catch {
              return true;
            }
            if (typeof key !== "string" || keys.has(key)) return true;
            keys.add(key);
          }
        }
      }
      continue;
    }
    if (character === '"') stringStart = index;
    else if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
  }
  return false;
}

function copyMessage(raw: unknown): ChatMessage {
  if (typeof raw !== "string" || !raw) throw new Error("Incomplete community chat record");
  if (hasRepeatedTopLevelKey(raw)) throw new Error("Incomplete community chat record");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Incomplete community chat record");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Incomplete community chat record");
  const message = value as Partial<ChatMessage>;
  if (!Number.isSafeInteger(message.i) || (message.i as number) <= 0
    || typeof message.a !== "string" || !CHAT_AUTHOR.test(message.a)
    || typeof message.text !== "string"
    || !Number.isSafeInteger(message.at) || (message.at as number) < 0
    || (message.n !== undefined && (typeof message.n !== "string" || !message.n || message.n.length > 80))) {
    throw new Error("Incomplete community chat record");
  }
  return message as ChatMessage;
}

/** A JSON response array: ordinary, dense and made only of own inert positions. */
function copyArray(raw: unknown): unknown[] {
  // Node can recognize a Proxy without invoking any of its traps. Do this
  // before Array.isArray, prototype or descriptor reflection.
  if (isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    throw new Error("Incomplete community chat record");
  }
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== raw.length + 1 || keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= raw.length))) {
    throw new Error("Incomplete community chat record");
  }
  const values: unknown[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error("Incomplete community chat record");
    values.push(descriptor.value);
  }
  return values;
}

export type SaidResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; reason: "off" | "empty" | "links" | "slow" | "creatorOnly" | "unknown"; wait?: number };

function singleReply(reply: unknown): unknown {
  return Array.isArray(reply) && reply.length === 1 ? reply[0] : undefined;
}

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

  try {
    if (setting.slow > 0 && !owner) {
      // SET NX with an expiry is the cooldown itself: it either takes, or it
      // tells how long is left. No clock is read and no row is written to be
      // cleaned up later.
      const got = singleReply(await redisPipeline([["SET", spokeKey(id, who), "1", "NX", "EX", setting.slow]]));
      if (got === null) {
        const left = singleReply(await redisPipeline([["TTL", spokeKey(id, who)]]));
        if (typeof left !== "number" || !Number.isInteger(left) || left < 0 || left > MAX_SLOW) return { ok: false, reason: "unknown" };
        return { ok: false, reason: "slow", wait: Math.max(1, left) };
      }
      if (got !== "OK") return { ok: false, reason: "unknown" };
    }

    const n = singleReply(await redisPipeline([["INCR", countKey(id)]]));
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) return { ok: false, reason: "unknown" };
    const said = cleanText(name, 80);
    const message: ChatMessage = { i: n, a: who, text, at: now(), ...(said ? { n: said } : {}) };
    const written = await redisPipeline([
      ["ZADD", roomKey(id), message.i, JSON.stringify(message)],
      // The room keeps its last MAX_CHAT_KEPT and forgets the rest.
      ["ZREMRANGEBYRANK", roomKey(id), 0, -(MAX_CHAT_KEPT + 1)],
    ]);
    if (!Array.isArray(written) || written.length !== 2 || written[0] !== 1
      || typeof written[1] !== "number" || !Number.isSafeInteger(written[1]) || written[1] < 0) return { ok: false, reason: "unknown" };
    return { ok: true, message };
  } catch {
    // A transport failure can happen after Redis applies the write. The
    // caller must keep that uncertainty instead of claiming it did not send.
    return { ok: false, reason: "unknown" };
  }
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
      return "We could not confirm this message. Check the room before sending it again.";
  }
}

/** How many messages the room holds right now. */
export async function roomSize(id: string): Promise<number> {
  // ZCARD's own count only (CX-123 rule 24): what a person's erasure is sized by is never 0 on an unknown answer.
  const n = countOf(repliesFor(await redisPipeline([["ZCARD", roomKey(id)]]), 1)?.[0]);
  if (n === null) throw new UnknownReplyError("the room's size");
  return n;
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
  // The room in its exact shape (CX-123 rule 24): a lost or off-shape reply is
  // not "no match", so the search page says it could not search the room.
  // Only an exact empty room has nothing to find.
  const raw = stringList(repliesFor(await redisPipeline([["ZREVRANGE", roomKey(id), 0, MAX_CHAT_KEPT - 1]]), 1)?.[0]);
  if (!raw) throw new UnknownReplyError("the room for a search");
  const rows = raw.map(parse).filter((m): m is ChatMessage => m !== null);
  return rows.filter((message) => holdsAll(message.text, used));
}

/** Deletes what one member said in the room, and their cooldown (lib/community-erasure.ts). */
export async function forgetChatPerson(id: string, who: string): Promise<number> {
  // The room in its exact shape (CX-123 rule 24): a lost or off-shape reply is
  // not "they said nothing", so nothing is deleted and the erasure stays
  // pending to be retried. Only an exact empty room has nothing of theirs.
  const what = "a member's room messages forgotten";
  const rows = stringList(repliesFor(await redisPipeline([["ZRANGEBYSCORE", roomKey(id), "-inf", "+inf"]]), 1)?.[0]);
  if (!rows) throw new UnknownReplyError(what);
  const theirs = rows.filter((row) => {
    try {
      return (JSON.parse(row) as Partial<ChatMessage>).a === who;
    } catch {
      return false;
    }
  });
  const commands: (string | number)[][] = [["DEL", spokeKey(id, who)], ...(theirs.length ? [["ZREM", roomKey(id), ...theirs]] : [])];
  // Each deletion answered with its count, or the erasure is not said done.
  const replies = repliesFor(await redisPipeline(commands), commands.length);
  if (!replies || replies.some((reply) => countOf(reply) === null)) throw new UnknownReplyError(what);
  return theirs.length;
}

/** What one member said in the community's room, for the copy of their data (619 [SZ3]): the messages the erasure deletes. Only reads. */
export async function chatMessagesOf(id: string, who: string): Promise<{ text: string; at: number }[]> {
  const replies = copyArray(await redisPipeline([["ZRANGEBYSCORE", roomKey(id), "-inf", "+inf"]]));
  if (replies.length !== 1) throw new Error("Incomplete community chat record");
  return copyArray(replies[0]).map(copyMessage).flatMap((message) => (message.a === who ? [{ text: message.text, at: message.at }] : []));
}
