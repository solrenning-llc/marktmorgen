/**
 * A store's community: the place where the people who bought from a creator
 * talk to the creator and to each other.
 *
 * Who may come in is decided in lib/community-access.ts, on every request.
 * This file only keeps what they write, and keeps it small and bounded, with
 * every key under the community's own id so nothing here can be reached from
 * another store:
 *
 *   nl:cm:<id>:cfg            the settings: name, spaces, who gets in, pins (JSON)
 *   nl:cm:<id>:seq            a counter; every post takes the next number
 *   nl:cm:<id>:p:<post>       one post (JSON)
 *   nl:cm:<id>:feed           every post, by number (sorted set)
 *   nl:cm:<id>:sp:<space>     the posts of one space, by number (sorted set)
 *   nl:cm:<id>:c:<post>       the comments under one post (hash)
 *   nl:cm:<id>:l:<post>       who liked one post (set of member keys)
 *   nl:cm:<id>:lc:<post>:<c>  who liked one comment (set of member keys)
 *   nl:cm:<id>:m              everyone who has come in: key -> Member (hash)
 *   nl:cm:<id>:dir            those who chose to be listed, by joining time
 *   nl:cm:<id>:rep            reported posts and comments, newest first
 *   nl:cm:<id>:rep:<target>   who reported one of them, so a report counts once
 *   nl:cm:rl:<id>:<who>:<k>   how much one member did lately, for the limits
 *
 * A member is known by a key made from their address (lib/learn.ts emailKey),
 * and the address itself is kept only in their own record, for the creator's
 * moderation list and for the announcement emails they asked for. No other
 * member ever sees it: the directory shows the name a member chose, and only
 * when they chose to be listed.
 *
 * Feeds are read a page at a time by post number, which is unique and only
 * grows, so a page never repeats or skips a post however many are written
 * while somebody reads.
 *
 * Every limit is in lib/community-text.ts, where the studio reads it too.
 *
 * What members and the creator write here takes room in the store's data
 * room before it is written (lib/store-data.ts), one slot a post: the post,
 * its places in the feeds, its comments, its likes and the words they are
 * found by (POST_SLOT). A post deleted gives its whole slot back; a comment
 * deleted gives back what it took. What does not fit is refused with
 * DataRoomError, and nothing is written. A member's own record is part of
 * what their order left, charged at what it really adds when it is first
 * made (lib/order-data.ts); what a member adds to it later (a name,
 * answers) takes room like a post.
 */
import { randomBytes } from "node:crypto";
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor } from "@/lib/redis-reply";
import { type DataOwner, orderWrite } from "@/lib/order-data";
import { normaliseEmail } from "@/lib/auth";
import { emailKey } from "@/lib/learn";
import {
  COMMUNITY_ID,
  FEED_PAGE,
  ITEM_ID,
  MAX_COMMENTS_PER_POST,
  MAX_COMMUNITY_ABOUT,
  MAX_COMMUNITY_NAME,
  MAX_DISPLAY_NAME,
  MAX_MEMBERS,
  MAX_PINNED,
  MAX_POSTS,
  MAX_REPORT_QUEUE,
  MAX_SPACES,
  MAX_SPACE_ABOUT,
  MAX_SPACE_NAME,
  MAX_ANSWER,
  MAX_QUESTION,
  MAX_QUESTIONS,
  MAX_WELCOME,
  RATE_LIMITS,
  type RateKind,
  cleanLine,
  cleanText,
} from "@/lib/community-text";
import { MAX_ALT_LENGTH } from "@/lib/product-image";
import { indexBytes, indexPost, partsOf, unindexPost } from "@/lib/community-search";
import { TRACED_SINCE, TRACE_ENTRY, traceKey } from "@/lib/community-trace";
import { type DataStore, needData, giveData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { indexMember } from "@/lib/community-index";
import { type Poll, parsePoll, pollKeys } from "@/lib/community-polls";
import { type DmSetting, NO_DM, parseDmSetting } from "@/lib/community-dm";
import { type ChatSetting, NO_CHAT, parseChatSetting } from "@/lib/community-chat";
import { claimHandle } from "@/lib/community-mentions";

/** The author of what the creator writes. Never a member key, which is hex. */
export const CREATOR = "creator";

export type Space = {
  id: string;
  name: string;
  about: string;
  /** Only the creator starts posts here; members still comment. */
  creatorOnly: boolean;
  /**
   * Only the buyers of these of the community's products, the way an event
   * can be kept for some of them (lib/community-events.ts). Empty means every
   * member. A product named here that no longer opens the community is
   * ignored, so nobody is shut out by a product the creator took off the
   * community's own list.
   */
  only: string[];
  /**
   * The level a member needs to start a post here (lib/community-points.ts),
   * or 0 for none. Every member still reads it and comments in it: a level
   * opens the right to start a conversation, never the right to take part.
   */
  level: number;
};

export type CommunityConfig = {
  name: string;
  about: string;
  /** The products whose buyers are let in (lib/community-access.ts). */
  access: string[];
  spaces: Space[];
  /** The post shown first to everyone, labelled "Start here". */
  start: string | null;
  /** Posts held at the top of the feed, in the order they were pinned. */
  pinned: string[];
  /** Goes up whenever `access` changes, so no answer about it outlives it. */
  v: number;
  /** Whether private messages happen here, and between whom. */
  dm: DmSetting;
  /** The live room: whether it exists, and how it is kept civil. */
  chat: ChatSetting;
  /** Asked of every member before their first post or comment; the answers are the creator's to read. */
  questions: string[];
  /** Sent privately to a member the first time they come in, from the creator, when messages are on. */
  welcome: string;
};

export type Member = {
  /** The key the member is known by. */
  k: string;
  /** Their address: for the creator and for emails they asked for, nobody else. */
  e: string;
  /** The name they chose to be seen by; empty until they choose one. */
  n: string;
  /**
   * What others type after an @ to name them: their name folded to lower
   * case, with a number on the end if it was taken. Empty until they choose
   * a name, and a member without one simply cannot be mentioned.
   */
  h: string;
  /** Listed in the member directory. */
  dir: boolean;
  /** Asked to be emailed the creator's announcements. */
  mail: boolean;
  at: number;
  seen: number;
  /** May read, may not write. */
  muted: boolean;
  /** Taken out by the creator: not let in, whatever they bought. */
  removed: boolean;
  /** The token in their unsubscribe link, made the first time they are emailed. */
  t: string;
  /** Their answers to the creator's questions, in the order asked. */
  q: string[];
  /** The questions as they were when answered, so a question reworded later never sits over an old answer. */
  qq: string[];
  /** When they answered, in seconds; 0 until they have. */
  qa: number;
};

export type CommunityImage = { path: string; w: number; h: number; alt: string };

export type Post = {
  id: string;
  /** Its number: the order of the feed. */
  n: number;
  /** The space it was posted in; may name a space since removed. */
  sp: string;
  /** CREATOR or a member key. */
  a: string;
  title: string;
  text: string;
  img: CommunityImage | null;
  at: number;
  /** An announcement is the creator's, labelled so, and may have been emailed. */
  kind: "post" | "announcement";
  /** Hidden by the creator: gone for members, kept for the creator to restore. */
  hid: boolean;
  /**
   * When it was last edited, in seconds, or 0 for never. Shown to everyone
   * who can see the post: a reader deserves to know the words changed after
   * the replies under them were written.
   */
  ed: number;
  /**
   * The poll on it, or null. A post either has one from the moment it is
   * written or never gets one: adding a poll to a post people have already
   * replied to changes what they were replying to.
   */
  poll: Poll | null;
};

export type Comment = {
  id: string;
  /** The comment this answers, or "" for one straight under the post. */
  parent: string;
  a: string;
  text: string;
  at: number;
  hid: boolean;
  /** When it was last edited, in seconds, or 0 for never. */
  ed: number;
};

const base = (id: string) => `nl:cm:${id}`;
const cfgKey = (id: string) => `${base(id)}:cfg`;
const seqKey = (id: string) => `${base(id)}:seq`;
const postKey = (id: string, post: string) => `${base(id)}:p:${post}`;
const feedKey = (id: string) => `${base(id)}:feed`;
const spaceKey = (id: string, space: string) => `${base(id)}:sp:${space}`;
const commentsKey = (id: string, post: string) => `${base(id)}:c:${post}`;
const likesKey = (id: string, post: string) => `${base(id)}:l:${post}`;
const commentLikesKey = (id: string, post: string, comment: string) => `${base(id)}:lc:${post}:${comment}`;
const membersKey = (id: string) => `${base(id)}:m`;
const dirKey = (id: string) => `${base(id)}:dir`;
const handlesKey = (id: string) => `${base(id)}:h`;
const reportsKey = (id: string) => `${base(id)}:rep`;
const reportersKey = (id: string, target: string) => `${base(id)}:rep:${target}`;
const rateKey = (id: string, who: string, kind: string) => `nl:cm:rl:${id}:${who}:${kind}`;
/** How long who-reported-what is kept, so the same member cannot report twice. */
const REPORTERS_SECONDS = 90 * 86_400;

export function newItemId(): string {
  return randomBytes(6).toString("hex");
}

const now = () => Math.floor(Date.now() / 1000);

/** The slot a post and everything under it is counted in. */
const POST_SLOT = (post: string) => `cm:p:${post}`;
/** The slot what members add to their own records is counted in. */
const MEMBERS_SLOT = "cm:m";
/** A like, a vote or a member key in a set: its member and Redis's own. */
export const SET_ENTRY_BYTES = 96;
/** What a post counts for: its record, its two places in the feeds, and its words. */
function postBytes(post: Post): number {
  return dataBytes([JSON.stringify(post)], 3) + indexBytes([post.title, post.text]);
}

/** What a comment counts for: its field, and the words it can add to its post's. */
function commentBytes(comment: Comment): number {
  return dataBytes([JSON.stringify(comment)], 1) + indexBytes([comment.text]);
}

// ------------------------------------------------------------------ settings

/** A new community: one space to start in, and nobody let in until chosen. */
export function freshConfig(storeName: string): CommunityConfig {
  return {
    name: `${storeName} Community`.slice(0, MAX_COMMUNITY_NAME),
    about: "",
    access: [],
    spaces: [{ id: newItemId(), name: "General", about: "", creatorOnly: false, only: [], level: 0 }],
    start: null,
    pinned: [],
    v: 1,
    // Off until the creator turns it on, like everything else that lets
    // people reach each other.
    dm: { ...NO_DM },
    chat: { ...NO_CHAT },
    questions: [],
    welcome: "",
  };
}

function parseConfig(raw: unknown): CommunityConfig | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CommunityConfig>;
    const ids = (list: unknown, max: number) =>
      Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === "string"))].slice(0, max) : [];
    const spaces: Space[] = [];
    for (const entry of Array.isArray(value.spaces) ? value.spaces : []) {
      if (!entry || typeof entry !== "object" || !ITEM_ID.test(String(entry.id))) continue;
      const name = cleanLine(entry.name, MAX_SPACE_NAME);
      if (!name) continue;
      spaces.push({
        id: entry.id,
        name,
        about: cleanLine(entry.about, MAX_SPACE_ABOUT),
        creatorOnly: entry.creatorOnly === true,
        // Spaces made before a space could be kept for some buyers have none.
        only: ids(entry.only, 50).filter((p) => p.length <= 40),
        // Spaces made before there were levels need none.
        level: Number.isInteger(entry.level) && entry.level >= 2 && entry.level <= 9 ? entry.level : 0,
      });
      if (spaces.length >= MAX_SPACES) break;
    }
    return {
      name: cleanLine(value.name, MAX_COMMUNITY_NAME) || "Community",
      about: typeof value.about === "string" ? value.about.slice(0, MAX_COMMUNITY_ABOUT) : "",
      access: ids(value.access, 200).filter((id) => id.length <= 40),
      spaces,
      start: typeof value.start === "string" && ITEM_ID.test(value.start) ? value.start : null,
      pinned: ids(value.pinned, MAX_PINNED).filter((id) => ITEM_ID.test(id)),
      v: typeof value.v === "number" && Number.isInteger(value.v) && value.v > 0 ? value.v : 1,
      // Communities written down before there were messages have none, and
      // parse as off, which is what they have always been.
      dm: parseDmSetting(value.dm),
      // Likewise for a community written down before there was a room.
      chat: parseChatSetting(value.chat),
      // And before new members were welcomed: none asked, nothing sent.
      questions: (Array.isArray(value.questions) ? value.questions : [])
        .map((q) => cleanLine(q, MAX_QUESTION))
        .filter(Boolean)
        .slice(0, MAX_QUESTIONS),
      welcome: typeof value.welcome === "string" ? value.welcome.slice(0, MAX_WELCOME) : "",
    };
  } catch {
    return null;
  }
}

export async function readConfig(id: string): Promise<CommunityConfig | null> {
  if (!COMMUNITY_ID.test(id) || !isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["GET", cfgKey(id)]]);
  return parseConfig(raw);
}

/**
 * A setup that Redis did answer, as text, but that is not settings: stored
 * damaged, so asking again gives the same answer. Still an unknown reply to
 * anyone who catches UnknownReplyError; only a caller that knows what such a
 * setup means for it may tell the two apart (lib/community-erasure.ts).
 */
export class DamagedConfigError extends UnknownReplyError {
  constructor() {
    super("a community setup stored damaged");
    this.name = "DamagedConfigError";
  }
}

/**
 * The settings, read before anything is written over them: null only when
 * the GET answered exactly nil, so there is no setup yet. A lost reply, one
 * in another shape or a value that does not parse throws, and the caller
 * writes nothing; a fresh setup over the creator's spaces and access would
 * lock every paying member out. A text value that does not parse throws
 * DamagedConfigError.
 */
export async function readConfigExact(id: string): Promise<CommunityConfig | null> {
  if (!COMMUNITY_ID.test(id)) throw new UnknownReplyError("a community id");
  const replies = repliesFor(await redisPipeline([["GET", cfgKey(id)]]), 1);
  if (!replies) throw new UnknownReplyError("a community setup");
  if (replies[0] === null) return null;
  const config = parseConfig(replies[0]);
  if (!config) throw typeof replies[0] === "string" ? new DamagedConfigError() : new UnknownReplyError("a community setup");
  return config;
}

export async function saveConfig(id: string, config: CommunityConfig): Promise<void> {
  await redisPipeline([["SET", cfgKey(id), JSON.stringify(config)]]);
}

// ------------------------------------------------------------------ members

function parseMember(raw: unknown): Member | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Member>;
    if (typeof v.k !== "string" || typeof v.e !== "string") return null;
    return {
      k: v.k,
      e: v.e,
      n: typeof v.n === "string" ? v.n.slice(0, MAX_DISPLAY_NAME) : "",
      // Members written down before there were handles have none until they
      // next save their name.
      h: typeof v.h === "string" ? v.h : "",
      dir: v.dir === true,
      mail: v.mail === true,
      at: typeof v.at === "number" ? v.at : 0,
      seen: typeof v.seen === "number" ? v.seen : 0,
      muted: v.muted === true,
      removed: v.removed === true,
      t: typeof v.t === "string" && /^[0-9a-f]{40}$/.test(v.t) ? v.t : "",
      q: Array.isArray(v.q) ? v.q.filter((a): a is string => typeof a === "string").map((a) => a.slice(0, MAX_ANSWER)).slice(0, MAX_QUESTIONS) : [],
      qa: typeof v.qa === "number" ? v.qa : 0,
      qq: Array.isArray(v.qq) ? v.qq.filter((a): a is string => typeof a === "string").map((a) => a.slice(0, MAX_QUESTION)).slice(0, MAX_QUESTIONS) : [],
    };
  } catch {
    return null;
  }
}

export function memberKey(email: string): string {
  return emailKey(email);
}

/**
 * When each of these addresses last came into the community (seconds, kept
 * to the hour), 0 for one who never came in or was taken out. One command for
 * them all, for the member scores in the studio (lib/member-health.ts).
 */
export async function lastSeenIn(id: string, emails: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!emails.length || !isRedisConfigured()) return out;
  const replies = repliesFor(await redisPipeline([["HMGET", membersKey(id), ...emails.map(memberKey)]]), 1);
  const rows = replies && repliesFor(replies[0], emails.length);
  if (!rows) throw new UnknownReplyError("community member activity");
  emails.forEach((email, i) => {
    const raw = rows[i];
    if (raw === null) { out.set(email, 0); return; }
    if (typeof raw !== "string") throw new UnknownReplyError("community member activity record");
    let member: Partial<Member>;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a member");
      member = value as Partial<Member>;
    } catch {
      throw new UnknownReplyError("community member activity record");
    }
    if (member.k !== memberKey(email) || member.e !== normaliseEmail(email) || typeof member.removed !== "boolean" ||
        typeof member.seen !== "number" || !Number.isSafeInteger(member.seen) || member.seen < 0 ||
        typeof member.at !== "number" || !Number.isSafeInteger(member.at) || member.at < 0) {
      throw new UnknownReplyError("community member activity fields");
    }
    out.set(email, member.removed ? 0 : member.seen || member.at);
  });
  return out;
}

/**
 * A member's record, or null only when Redis said there is none. A reply in
 * any other shape (missing, cut short, not a record, a record without its own
 * yes or no on a mute and a removal, or somebody else's) is thrown (CX-123
 * rule 24): read as "no record", it let a member the creator took out past
 * the removal and back in as somebody new (lib/community-access.ts
 * communityViewer, touchMember's re-read).
 */
export async function readMember(id: string, key: string): Promise<Member | null> {
  return (await readMemberExact(id, key))?.member ?? null;
}

/** The record as readMember reads it, with the exact text it was kept as (what a compare-and-set writes over). */
async function readMemberExact(id: string, key: string): Promise<{ raw: string; member: Member } | null> {
  const replies = repliesFor(await redisPipeline([["HGET", membersKey(id), key]]), 1);
  if (!replies) throw new UnknownReplyError("a community member record");
  const raw = replies[0];
  if (raw === null) return null;
  const member = exactMember(raw, key);
  if (!member || typeof raw !== "string") throw new UnknownReplyError("a community member record");
  return { raw, member };
}

/** The record kept under `key`, when it is one: its own key, and a mute and a removal each a yes or a no. */
function exactMember(raw: unknown, key: string): Member | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  if (typeof fields.removed !== "boolean" || typeof fields.muted !== "boolean") return null;
  const member = parseMember(raw);
  return member && member.k === key ? member : null;
}

export async function readMembers(id: string, keys: string[]): Promise<Map<string, Member>> {
  const out = new Map<string, Member>();
  const unique = [...new Set(keys)].filter((k) => k !== CREATOR);
  if (!unique.length) return out;
  const [rows] = await redisPipeline([["HMGET", membersKey(id), ...unique]]);
  const list = Array.isArray(rows) ? rows : [];
  unique.forEach((key, i) => {
    const member = parseMember(list[i]);
    if (member) out.set(key, member);
  });
  return out;
}

/**
 * The members of `keys`, read exactly (rules 24 and 30), for deciding who an email goes to: one left out of the map
 * only when its row answered exactly nil, so it is gone. A reply lost, cut short or in another shape, or a row that is
 * not that member's record, throws UnknownReplyError: a member who did not read is not one who is gone, and an email
 * meant for them is not counted as sent (lib/community-event-mail.ts).
 */
export async function readMembersExact(id: string, keys: string[]): Promise<Map<string, Member>> {
  const out = new Map<string, Member>();
  const unique = [...new Set(keys)].filter((k) => k !== CREATOR);
  if (!unique.length) return out;
  const replies = repliesFor(await redisPipeline([["HMGET", membersKey(id), ...unique]]), 1);
  const rows = replies && repliesFor(replies[0], unique.length);
  if (!rows) throw new UnknownReplyError("community members");
  unique.forEach((key, i) => {
    if (rows[i] === null) return;
    const member = parseMember(rows[i]);
    if (!member || member.k !== key) throw new UnknownReplyError("a community member record");
    out.set(key, member);
  });
  return out;
}

/** Writes a member's record only if it is still exactly what was read. */
const CAS_MEMBER = [
  'local cur = redis.call("HGET", KEYS[1], ARGV[1])',
  "if cur ~= ARGV[2] then return 0 end",
  'redis.call("HSET", KEYS[1], ARGV[1], ARGV[3])',
  // The directory lists only those who asked to be listed and are still here.
  'if ARGV[4] == "1" then redis.call("ZADD", KEYS[2], ARGV[5], ARGV[1]) else redis.call("ZREM", KEYS[2], ARGV[1]) end',
  "return 1",
].join("\n");

/**
 * Changes some of a member's fields on the record as it is now, so a change
 * the member makes never writes back a mute or a removal the creator just
 * undid, or undoes one they just made. Null only when Redis said there is no
 * record. A read or a write answered in any other shape throws
 * UnknownReplyError (CX-123 rule 24): read as "no record", it let a stop
 * link say "Unsubscribed." with the emails still on, and a mute say done
 * with nothing written.
 */
async function patchMember(id: string, key: string, change: (member: Member) => Partial<Member>): Promise<Member | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const read = await readMemberExact(id, key);
    if (!read) return null;
    const { raw, member } = read;
    const next: Member = { ...member, ...change(member), k: member.k };
    const listed = next.dir && next.n && !next.removed ? "1" : "0";
    const replies = repliesFor(await redisPipeline([
      ["EVAL", CAS_MEMBER, 2, membersKey(id), dirKey(id), key, raw, JSON.stringify(next), listed, next.at],
    ]), 1);
    // 1 written, 0 changed since it was read (read again); anything else is not known to be either.
    const written = replies?.[0];
    if (written === 0) continue;
    if (written !== 1) throw new UnknownReplyError("a change to a community member record");
    // The search index follows the very same switch the directory does, from
    // the very same place, so the two can never come to disagree about who is
    // findable. Somebody who took themselves off the list is taken out of the
    // index in the same breath.
    await indexMember(id, next).catch(() => {});
    return next;
  }
  throw new Error("a member's record kept changing");
}

/**
 * The record of someone who has just been let in, made the first time they
 * come and dated each time after, at most once an hour so reading costs no
 * write. Null when the community already holds as many people as it can.
 */
export async function touchMember(id: string, email: string, existing: Member | null, owner: DataOwner): Promise<Member | null> {
  const key = memberKey(email);
  const at = now();
  if (existing) {
    if (at - existing.seen < 3_600) return existing;
    return (await patchMember(id, key, () => ({ seen: at }))) ?? existing;
  }
  // The head count in its exact shape (CX-123 rule 24): read with Number(...), a missing or off-shape
  // HLEN was NaN, never at the ceiling, and a new record was written whatever the count was.
  const size = countOf(repliesFor(await redisPipeline([["HLEN", membersKey(id)]]), 1)?.[0]);
  if (size === null) throw new UnknownReplyError("a community's head count");
  if (Number(size) >= MAX_MEMBERS) return null;
  const member: Member = { k: key, e: normaliseEmail(email), n: "", h: "", dir: false, mail: false, at, seen: at, muted: false, removed: false, t: "", q: [], qa: 0, qq: [] };
  // HSETNX: two first visits at once make one record, not two. Counted in
  // the store's room at what it adds (lib/order-data.ts); what a member adds
  // to it later is taken from the room (MEMBERS_SLOT).
  await orderWrite(owner, [["HSETNX", membersKey(id), key, JSON.stringify(member)]]);
  return (await readMember(id, key)) ?? member;
}

/**
 * A member's own choices: the name they are seen by, the directory, the
 * emails — and, when given, their answers to the creator's questions, which
 * count as answered once each one asked has something in it.
 */
export async function setProfile(
  id: string,
  member: Member,
  change: { name: string; dir: boolean; mail: boolean; answers?: string[]; questions?: string[] },
  room: DataStore,
): Promise<Member> {
  const name = cleanLine(change.name, MAX_DISPLAY_NAME);
  // What the member adds to their record takes room before it is written:
  // the name and the answers, the handle they are mentioned by and the words
  // their name is found by. A record that shrinks gives it back.
  const answers = change.answers && change.questions ? answersFor(change.answers, change.questions, member.qa) : {};
  const after = JSON.stringify({ ...member, n: name, h: name.slice(0, 40), dir: change.dir && Boolean(name), mail: change.mail, ...answers });
  const grown = dataBytes([after]) - dataBytes([JSON.stringify(member)]) + (name ? indexBytes([name]) + SET_ENTRY_BYTES : 0) - (member.n ? indexBytes([member.n]) + SET_ENTRY_BYTES : 0);
  if (grown > 0) await needData(room, [{ slot: MEMBERS_SLOT, bytes: grown }]);
  else if (grown < 0) await giveData(room, [{ slot: MEMBERS_SLOT, bytes: -grown }]);
  // The handle is taken before the name is written, so a member is never left
  // named but unmentionable. Claiming gives back what they ended up with,
  // which may carry a number when somebody already held the plain one. It
  // only reserves: the handle they had stays theirs until the record is known
  // not to carry it any more (rule 30 on Codex G's review 5815632734 of #3123),
  // so a change that did not go in never lets the name they are still shown
  // under resolve to nobody, or to somebody else.
  const handle = await claimHandle(id, member.k, name, member.h);
  const had = member.h && member.h !== handle ? member.h : "";
  let replaced = "";
  let saved: Member | null;
  try {
    saved = await patchMember(id, member.k, (now) => {
      replaced = now.h;
      return {
        n: name,
        h: handle,
        dir: change.dir && Boolean(name),
        mail: change.mail,
        ...(change.answers && change.questions ? answersFor(change.answers, change.questions, now.qa) : {}),
      };
    });
  } catch (error) {
    // The read or the write after the claim answered in no known shape, so
    // whether the record took the new handle is not known: a lost answer may
    // hide a write that went in. Each of the two handles is given back only
    // when the record, read in the same step, does not carry it (rule 30 on
    // Codex G's reviews 5815559331 and 5815632734 of #3123): a record still
    // on the old one keeps the old one and lets the new one go, a record on
    // the new one keeps the new one and lets the old one go. When an answer
    // is not known, nothing more is given back, so both stay reserved: a
    // handle held too long is safe, one that stops resolving to the person
    // still shown under it is not. Either way the original failure is what
    // the caller sees.
    await giveBackUnlessCarried(id, member.k, [handle, had]).catch(() => 0);
    throw error;
  }
  // The erasure deletes only the handle the record holds (lib/community-erasure.ts),
  // so a handle the record does not carry is given back here, never left tied to
  // the member: the one this change claimed when the record went in between (an
  // erasure), the one the member had once the record no longer carries it, and
  // one a change made at the same time wrote and this one replaced (rule 30 on
  // Codex G's reviews 5815472405 and 5815632734 of #3123).
  if (!saved) {
    await giveBackUnlessCarried(id, member.k, [handle, had]);
    return member;
  }
  await giveBackUnlessCarried(id, member.k, [had, replaced && replaced !== handle ? replaced : ""]);
  return saved;
}

/**
 * Gives back each of these handles, one GIVE_BACK_HANDLE each, so each is let
 * go only while it still points at this member and the record, read in the
 * same step, does not carry it. Stops at the first answer that is not known,
 * keeping every handle not yet given back.
 */
async function giveBackUnlessCarried(id: string, who: string, handles: string[]): Promise<void> {
  for (const handle of [...new Set(handles)]) if (handle) await giveBackHandle(id, handle, who);
}

/**
 * Gives a handle back only while it still points at this member and the
 * member's record, read in the same step, does not carry it: a record that
 * names it keeps it, and one gone or naming another lets it go. 1 deleted,
 * 0 kept; -1 (a record that cannot be read) and any other answer are not
 * known to be either.
 */
const GIVE_BACK_HANDLE = [
  "-- marktmorgen:community-handle-give-back:v1",
  'if redis.call("HGET", KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end',
  'local raw = redis.call("HGET", KEYS[1], ARGV[2])',
  "if raw then",
  "  local ok, record = pcall(cjson.decode, raw)",
  '  if not ok or type(record) ~= "table" then return -1 end',
  "  if record.h == ARGV[1] then return 0 end",
  "end",
  'return redis.call("HDEL", KEYS[2], ARGV[1])',
].join("\n");

/** Runs GIVE_BACK_HANDLE; throws UnknownReplyError unless Redis answered 1 or 0 exactly. */
async function giveBackHandle(id: string, handle: string, who: string): Promise<number> {
  const replies = repliesFor(await redisPipeline([["EVAL", GIVE_BACK_HANDLE, 2, membersKey(id), handlesKey(id), handle, who]]), 1);
  const gone = replies?.[0];
  if (gone !== 0 && gone !== 1) throw new UnknownReplyError("giving back a community handle");
  return gone;
}

/**
 * A member's answers as they are kept: cleaned, one per question asked, with
 * the questions themselves, and answered only when every question has one.
 * The time they first answered is kept when they change an answer later.
 */
export function answersFor(
  raw: string[],
  questions: string[],
  before: number,
  now = Math.floor(Date.now() / 1000),
): Pick<Member, "q" | "qq" | "qa"> {
  const asked = questions.slice(0, MAX_QUESTIONS);
  const q = asked.map((_, i) => cleanText(raw[i] ?? "", MAX_ANSWER));
  const complete = asked.length > 0 && q.every(Boolean);
  return { q, qq: asked, qa: complete ? before || now : 0 };
}

/** Switches a member's announcement emails off (the unsubscribe link) or on. */
export async function setMail(id: string, member: Member, mail: boolean): Promise<Member> {
  return (await patchMember(id, member.k, () => ({ mail }))) ?? member;
}

/**
 * Keeps the unsubscribe token a member's emails carry, made once and never
 * replaced: the token is written only while the record holds none, so two
 * sends that read the member before either wrote (or one holding an old
 * snapshot) never undo a link already put in an email (Codex G on #3123).
 * Answers the token the record holds afterwards, which is `token` or the one
 * kept before it; null only when Redis said there is no record. Any other
 * answer throws (CX-123 rule 24).
 */
export async function setMemberToken(id: string, member: Member, token: string): Promise<string | null> {
  const kept = await patchMember(id, member.k, (now) => (now.t ? {} : { t: token }));
  if (!kept) return null;
  if (!/^[0-9a-f]{40}$/.test(kept.t)) throw new UnknownReplyError("a community member's stop link");
  return kept.t;
}

/** The creator mutes or unmutes, removes or lets back. */
export async function moderateMember(
  id: string,
  key: string,
  change: { muted?: boolean; removed?: boolean },
): Promise<Member | null> {
  return patchMember(id, key, (member) => ({
    muted: change.muted ?? member.muted,
    removed: change.removed ?? member.removed,
  }));
}

/** One page of the member directory: those who chose to be listed, newest first. */
export async function directory(id: string, before: number | null, page: number): Promise<{ members: Member[]; next: number | null }> {
  const max = before === null ? "+inf" : `(${before}`;
  const [raw] = await redisPipeline([["ZREVRANGEBYSCORE", dirKey(id), max, "-inf", "WITHSCORES", "LIMIT", 0, page + 1]]);
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const keys: string[] = [];
  const scores: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    keys.push(flat[i]);
    scores.push(Number(flat[i + 1]));
  }
  const more = keys.length > page;
  const shown = keys.slice(0, page);
  const found = await readMembers(id, shown);
  const members = shown.map((k) => found.get(k)).filter((m): m is Member => Boolean(m && m.dir && m.n && !m.removed));
  return { members, next: more ? scores[page - 1] : null };
}

export async function directorySize(id: string): Promise<number> {
  const [n] = await redisPipeline([["ZCARD", dirKey(id)]]);
  return Number(n) || 0;
}

/**
 * Everyone who has come in, for the creator's list: a page at a time, in the
 * order Redis keeps them. `cursor` is Redis's own, "0" to begin.
 */
export async function memberPage(id: string, cursor: string, count = 200): Promise<{ members: Member[]; next: string; total: number; bytes: number }> {
  const [reply, total] = await redisPipeline([
    ["HSCAN", membersKey(id), cursor, "COUNT", count],
    ["HLEN", membersKey(id)],
  ]);
  if (!Array.isArray(reply) || reply.length < 2) return { members: [], next: "0", total: Number(total) || 0, bytes: 0 };
  const flat = Array.isArray(reply[1]) ? (reply[1] as unknown[]) : [];
  const members: Member[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const member = parseMember(flat[i + 1]);
    if (member) members.push(member);
  }
  // The bytes the scan answered with, for a reading that pays for them (lib/api-read.ts, members).
  const bytes = flat.reduce((n: number, v) => n + Buffer.byteLength(String(v)), 0);
  return { members, next: String(reply[0]), total: Number(total) || 0, bytes };
}

/** Every member who asked for announcement emails and is still here. */
export async function mailableMembers(id: string): Promise<Member[]> {
  const out: Member[] = [];
  let cursor = "0";
  for (let page = 0; page < MAX_MEMBERS / 500 + 10; page += 1) {
    const { members, next } = await memberPage(id, cursor, 1000);
    for (const member of members) if (member.mail && !member.removed) out.push(member);
    cursor = next;
    if (cursor === "0") break;
  }
  return out;
}

// ------------------------------------------------------------------ limits

/**
 * Counts one more of `kind` for this member, and says whether it is allowed.
 * A count not read in its exact shape is never taken as room, nor said as
 * the limit reached: it is thrown, and the route answers with its error
 * (CX-123 rule 24).
 */
export async function within(id: string, who: string, kind: RateKind): Promise<boolean> {
  const { limit, seconds } = RATE_LIMITS[kind];
  const key = rateKey(id, who, kind);
  const both = repliesFor(
    await redisPipeline([
      ["SET", key, "0", "EX", seconds, "NX"],
      ["INCR", key],
    ]),
    2,
  );
  const count = both && (both[0] === "OK" || both[0] === null) ? countOf(both[1]) : null;
  if (count === null || count < 1) throw new UnknownReplyError(`a community ${kind} count`);
  return count <= limit;
}

// ------------------------------------------------------------------ posts

function parseImage(raw: unknown): CommunityImage | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const side = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 10_000 ? n : 0);
  if (typeof v.path !== "string" || !side(v.w) || !side(v.h)) return null;
  return {
    path: v.path,
    w: side(v.w),
    h: side(v.h),
    alt: typeof v.alt === "string" ? v.alt.slice(0, MAX_ALT_LENGTH) : "",
  };
}

function parsePost(raw: unknown): Post | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Post>;
    if (typeof v.id !== "string" || !ITEM_ID.test(v.id) || typeof v.a !== "string") return null;
    return {
      id: v.id,
      n: typeof v.n === "number" ? v.n : 0,
      sp: typeof v.sp === "string" ? v.sp : "",
      a: v.a,
      title: typeof v.title === "string" ? v.title : "",
      text: typeof v.text === "string" ? v.text : "",
      img: parseImage(v.img),
      at: typeof v.at === "number" ? v.at : 0,
      kind: v.kind === "announcement" ? "announcement" : "post",
      hid: v.hid === true,
      // Posts written before posts could be edited have none.
      ed: typeof v.ed === "number" ? v.ed : 0,
      // Likewise for posts written before there were polls.
      poll: parsePoll(v.poll),
    };
  } catch {
    return null;
  }
}

export async function readPost(id: string, post: string): Promise<Post | null> {
  if (!ITEM_ID.test(post)) return null;
  const [raw] = await redisPipeline([["GET", postKey(id, post)]]);
  return parsePost(raw);
}

export async function readPosts(id: string, posts: string[]): Promise<Post[]> {
  const ids = posts.filter((p) => ITEM_ID.test(p));
  if (!ids.length) return [];
  const rows = await redisPipeline(ids.map((p) => ["GET", postKey(id, p)]));
  return rows.map(parsePost).filter((p): p is Post => p !== null);
}

export type NewPost = {
  space: string;
  author: string;
  title: string;
  text: string;
  img: CommunityImage | null;
  kind: "post" | "announcement";
  poll: Poll | null;
  /**
   * The post's id, when it is fixed beforehand: a held post is published
   * under its own item's id (lib/community-approval.ts, 543 [CM2]), so a
   * write whose reply was lost can be found, and never made twice.
   */
  id?: string;
};

/** Writes a post. The caller has checked who may, and cleaned what it says. */
export async function createPost(id: string, input: NewPost, room: DataStore): Promise<{ ok: true; post: Post } | { ok: false; reason: "full" }> {
  const [count] = await redisPipeline([["ZCARD", feedKey(id)]]);
  if (Number(count) >= MAX_POSTS) return { ok: false, reason: "full" };
  const [n] = await redisPipeline([["INCR", seqKey(id)]]);
  const post: Post = {
    id: input.id && ITEM_ID.test(input.id) ? input.id : newItemId(),
    n: Number(n),
    sp: input.space,
    a: input.author,
    title: input.title,
    text: input.text,
    img: input.img,
    at: now(),
    kind: input.kind,
    hid: false,
    ed: 0,
    poll: input.poll,
  };
  // Its room first: refused here, nothing is written (DataRoomError).
  const traced = post.a !== CREATOR;
  await needData(room, [{ slot: POST_SLOT(post.id), bytes: postBytes(post), set: true }, ...(traced ? [TRACE_ENTRY] : [])]);
  await redisPipeline([
    ["SET", postKey(id, post.id), JSON.stringify(post)],
    ["ZADD", feedKey(id), post.n, post.id],
    ["ZADD", spaceKey(id, post.sp), post.n, post.id],
    ...(traced ? [["SADD", traceKey(id, post.a), `p:${post.id}`]] : []),
  ]);
  await reindex(id, post, []);
  return { ok: true, post };
}

/**
 * Writes what this post can be found by: its own words and its comments'.
 *
 * Called after anything that changes either. It never throws into the
 * caller's lap: a search index that missed one post is a worse result, while
 * a post that failed to save because its index did would be a lost post.
 */
async function reindex(id: string, post: Post, comments: { text: string }[]): Promise<void> {
  try {
    await indexPost(id, post.id, post.n, partsOf(post, comments));
  } catch (error) {
    console.error("indexing a community post for search failed", error);
  }
}

/** The same, when the comments have to be read back first. */
async function reindexWithComments(id: string, post: Post): Promise<void> {
  try {
    await reindex(id, post, await readComments(id, post.id));
  } catch (error) {
    console.error("reading comments to index a post failed", error);
  }
}

/**
 * The same again, from a post's id alone: what a comment being written,
 * rewritten or deleted has to hand. A post's words are the union of its own
 * and all its comments', so one comment going cannot simply have its words
 * taken out — another comment may use them too, and the post would stop being
 * findable by words that are still in it.
 */
async function reindexComments(id: string, post: string): Promise<void> {
  try {
    const found = await readPost(id, post);
    if (found) await reindexWithComments(id, found);
  } catch (error) {
    console.error("indexing a post after a comment changed failed", error);
  }
}

export async function setPostHidden(id: string, post: Post, hidden: boolean): Promise<void> {
  await redisPipeline([["SET", postKey(id, post.id), JSON.stringify({ ...post, hid: hidden })]]);
}

/**
 * Rewrites a post's words, and marks when.
 *
 * Only the words: never the space it is in, never its picture, never who
 * wrote it and never the number that fixes its place in the feed — so a post
 * cannot be edited into somebody else's, or moved somewhere it was never
 * approved for. The caller has checked that this is the author, and has
 * cleaned the text the same way a new post is cleaned.
 *
 * The edit is stamped rather than silent, because people reply to what a post
 * said, and a reader who cannot see that the words changed is being misled by
 * the software rather than by the author.
 */
export async function editPost(id: string, post: Post, input: { title: string; text: string }, room: DataStore): Promise<Post> {
  const next: Post = { ...post, title: input.title, text: input.text, ed: now() };
  await needData(room, [{ slot: POST_SLOT(post.id), bytes: postBytes(next) - postBytes(post) }]);
  await redisPipeline([["SET", postKey(id, post.id), JSON.stringify(next)]]);
  await reindexWithComments(id, next);
  return next;
}

/** Takes a post away for good, with its comments, likes and reports, and gives back its room. */
export async function deletePost(id: string, post: Post, room: DataStore): Promise<void> {
  const [raw] = await redisPipeline([["HKEYS", commentsKey(id, post.id)]]);
  const commentIds = Array.isArray(raw) ? (raw as string[]) : [];
  await redisPipeline([
    ["DEL", postKey(id, post.id), commentsKey(id, post.id), likesKey(id, post.id), reportersKey(id, `p:${post.id}`), ...pollKeys(id, post.id), ...commentIds.map((c) => commentLikesKey(id, post.id, c))],
    ["ZREM", feedKey(id), post.id],
    ["ZREM", spaceKey(id, post.sp), post.id],
    ["ZREM", reportsKey(id), `p:${post.id}`, ...commentIds.map((c) => `c:${post.id}:${c}`)],
    ...(post.a !== CREATOR ? [["SREM", traceKey(id, post.a), `p:${post.id}`]] : []),
  ]);
  if (post.a !== CREATOR) await giveData(room, [TRACE_ENTRY]);
  await unindexPost(id, post.id).catch((error) => {
    console.error("taking a deleted post out of the search index failed", error);
  });
  await giveData(room, [{ slot: POST_SLOT(post.id), bytes: 0, set: true }]);
}

export type FeedPage = { posts: Post[]; next: number | null };

/**
 * One page of posts, newest first: the whole community, or one space.
 * `before` is the number of the last post of the previous page. Hidden posts
 * are left out unless `withHidden`, which is the creator's view.
 */
export async function feed(
  id: string,
  options: { space?: string | null; before?: number | null; withHidden?: boolean; page?: number },
): Promise<FeedPage> {
  const page = options.page ?? FEED_PAGE;
  const key = options.space ? spaceKey(id, options.space) : feedKey(id);
  const max = options.before ? `(${options.before}` : "+inf";
  const [raw] = await redisPipeline([["ZREVRANGEBYSCORE", key, max, "-inf", "WITHSCORES", "LIMIT", 0, page + 1]]);
  const flat = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
  const ids: string[] = [];
  const scores: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    ids.push(flat[i]);
    scores.push(Number(flat[i + 1]));
  }
  const more = ids.length > page;
  const posts = (await readPosts(id, ids.slice(0, page))).filter((p) => options.withHidden || !p.hid);
  return { posts, next: more ? scores[page - 1] : null };
}

export async function postCount(id: string): Promise<number> {
  const [n] = await redisPipeline([["ZCARD", feedKey(id)]]);
  return Number(n) || 0;
}

/** How many liked each post, whether this member did, and how many comments each has. */
export async function postNumbers(
  id: string,
  posts: Post[],
  viewer: string | null,
): Promise<Map<string, { likes: number; liked: boolean; comments: number }>> {
  const out = new Map<string, { likes: number; liked: boolean; comments: number }>();
  if (!posts.length) return out;
  const commands: (string | number)[][] = [];
  for (const post of posts) {
    commands.push(["SCARD", likesKey(id, post.id)]);
    commands.push(["SISMEMBER", likesKey(id, post.id), viewer ?? "-"]);
    commands.push(["HLEN", commentsKey(id, post.id)]);
  }
  const rows = await redisPipeline(commands);
  posts.forEach((post, i) => {
    out.set(post.id, {
      likes: Number(rows[i * 3]) || 0,
      liked: rows[i * 3 + 1] === 1 || rows[i * 3 + 1] === "1",
      comments: Number(rows[i * 3 + 2]) || 0,
    });
  });
  return out;
}

/** One like per member per post: a second press takes it back. */
export async function toggleLike(id: string, post: string, who: string, room: DataStore): Promise<boolean> {
  return toggleIn(id, likesKey(id, post), `l:${post}`, post, who, room);
}

/** Adds `who` to a set of likes, or takes them out when they were in it: its room is taken first and given back after. */
async function toggleIn(id: string, key: string, ref: string, post: string, who: string, room: DataStore): Promise<boolean> {
  const [held] = await redisPipeline([["SISMEMBER", key, who]]);
  // The like and its entry in the member's trace (traceKey) take their room first.
  if (Number(held) !== 1) await needData(room, [{ slot: POST_SLOT(post), bytes: SET_ENTRY_BYTES }, TRACE_ENTRY]);
  const [added] = await redisPipeline([["SADD", key, who], ["SADD", traceKey(id, who), ref]]);
  if (Number(added) === 1) return true;
  await redisPipeline([["SREM", key, who], ["SREM", traceKey(id, who), ref]]);
  const times = Number(held) === 1 ? 1 : 2;
  await giveData(room, [{ slot: POST_SLOT(post), bytes: times * SET_ENTRY_BYTES }, { ...TRACE_ENTRY, bytes: times * TRACE_ENTRY.bytes }]);
  return false;
}

/** The same for a comment: one like per member, a second press takes it back. */
export async function toggleCommentLike(id: string, post: string, comment: string, who: string, room: DataStore): Promise<boolean> {
  return toggleIn(id, commentLikesKey(id, post, comment), `lc:${post}:${comment}`, post, who, room);
}

/** How many liked each comment under a post, and whether this member did. */
export async function commentNumbers(
  id: string,
  post: string,
  comments: Comment[],
  viewer: string | null,
): Promise<Map<string, { likes: number; liked: boolean }>> {
  const out = new Map<string, { likes: number; liked: boolean }>();
  if (!comments.length) return out;
  const rows = await redisPipeline(
    comments.flatMap((c) => [
      ["SCARD", commentLikesKey(id, post, c.id)],
      ["SISMEMBER", commentLikesKey(id, post, c.id), viewer ?? "-"],
    ]),
  );
  comments.forEach((c, i) => {
    out.set(c.id, { likes: Number(rows[i * 2]) || 0, liked: rows[i * 2 + 1] === 1 || rows[i * 2 + 1] === "1" });
  });
  return out;
}

/** Pins a post to the top, or unpins it. Refused past MAX_PINNED. */
export function withPin(config: CommunityConfig, post: string, pinned: boolean): CommunityConfig | null {
  const rest = config.pinned.filter((p) => p !== post);
  if (!pinned) return { ...config, pinned: rest };
  if (rest.length >= MAX_PINNED) return null;
  return { ...config, pinned: [...rest, post] };
}

// ------------------------------------------------------------------ comments

function parseComment(raw: unknown): Comment | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Comment>;
    if (typeof v.id !== "string" || !ITEM_ID.test(v.id) || typeof v.a !== "string") return null;
    return {
      id: v.id,
      parent: typeof v.parent === "string" && ITEM_ID.test(v.parent) ? v.parent : "",
      a: v.a,
      text: typeof v.text === "string" ? v.text : "",
      at: typeof v.at === "number" ? v.at : 0,
      hid: v.hid === true,
      ed: typeof v.ed === "number" ? v.ed : 0,
    };
  } catch {
    return null;
  }
}

/** Every comment under a post, oldest first. At most MAX_COMMENTS_PER_POST. */
export async function readComments(id: string, post: string): Promise<Comment[]> {
  const [raw] = await redisPipeline([["HGETALL", commentsKey(id, post)]]);
  const out: Comment[] = [];
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const comment = parseComment(raw[i + 1]);
      if (comment) out.push(comment);
    }
  } else if (raw && typeof raw === "object") {
    for (const value of Object.values(raw as Record<string, string>)) {
      const comment = parseComment(value);
      if (comment) out.push(comment);
    }
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

export async function readComment(id: string, post: string, comment: string): Promise<Comment | null> {
  if (!ITEM_ID.test(comment)) return null;
  const [raw] = await redisPipeline([["HGET", commentsKey(id, post), comment]]);
  return parseComment(raw);
}

/**
 * Adds a comment. A reply to a reply is filed under the comment that started
 * the thread: one level of replies, never a staircase.
 */
export async function addComment(
  id: string,
  post: string,
  input: { parent: string; author: string; text: string; id?: string },
  room: DataStore,
): Promise<{ ok: true; comment: Comment } | { ok: false; reason: "full" | "parent" }> {
  const [size] = await redisPipeline([["HLEN", commentsKey(id, post)]]);
  if (Number(size) >= MAX_COMMENTS_PER_POST) return { ok: false, reason: "full" };
  let parent = "";
  if (input.parent) {
    const above = await readComment(id, post, input.parent);
    if (!above) return { ok: false, reason: "parent" };
    parent = above.parent || above.id;
  }
  // A fixed id: a held comment is published under its item's id (543 [CM2]), as a held post is.
  const comment: Comment = { id: input.id && ITEM_ID.test(input.id) ? input.id : newItemId(), parent, a: input.author, text: input.text, at: now(), hid: false, ed: 0 };
  const traced = comment.a !== CREATOR;
  await needData(room, [{ slot: POST_SLOT(post), bytes: commentBytes(comment) }, ...(traced ? [TRACE_ENTRY] : [])]);
  await redisPipeline([["HSET", commentsKey(id, post), comment.id, JSON.stringify(comment)], ...(traced ? [["SADD", traceKey(id, comment.a), `c:${post}:${comment.id}`]] : [])]);
  await reindexComments(id, post);
  return { ok: true, comment };
}

/**
 * Rewrites a comment's words, and marks when. Only the words: never who wrote
 * it, and never which comment it answers, so an edit cannot move a reply on
 * to another thread. The caller has checked that this is the author.
 */
export async function editComment(id: string, post: string, comment: Comment, text: string, room: DataStore): Promise<Comment> {
  const next: Comment = { ...comment, text, ed: now() };
  await needData(room, [{ slot: POST_SLOT(post), bytes: commentBytes(next) - commentBytes(comment) }]);
  await redisPipeline([["HSET", commentsKey(id, post), comment.id, JSON.stringify(next)]]);
  await reindexComments(id, post);
  return next;
}

export async function setCommentHidden(id: string, post: string, comment: Comment, hidden: boolean): Promise<void> {
  await redisPipeline([["HSET", commentsKey(id, post), comment.id, JSON.stringify({ ...comment, hid: hidden })]]);
}

/** Deletes a comment, and the replies under it with it, and gives back what they took. */
export async function deleteComment(id: string, post: string, comment: Comment, room: DataStore): Promise<void> {
  const all = comment.parent ? [] : (await readComments(id, post)).filter((c) => c.parent === comment.id);
  const gone = [comment.id, ...all.map((c) => c.id)];
  const freed = [comment, ...all].reduce((sum, c) => sum + commentBytes(c), 0);
  await redisPipeline([
    ["HDEL", commentsKey(id, post), ...gone],
    ["DEL", ...gone.map((c) => commentLikesKey(id, post, c))],
    ["ZREM", reportsKey(id), ...gone.map((c) => `c:${post}:${c}`)],
    ...gone.map((c) => ["DEL", reportersKey(id, `c:${post}:${c}`)]),
    ...[comment, ...all].filter((c) => c.a !== CREATOR).map((c) => ["SREM", traceKey(id, c.a), `c:${post}:${c.id}`]),
  ]);
  const traced = [comment, ...all].filter((c) => c.a !== CREATOR).length;
  await giveData(room, [{ slot: POST_SLOT(post), bytes: freed }, ...(traced ? [{ ...TRACE_ENTRY, bytes: traced * TRACE_ENTRY.bytes }] : [])]);
  await reindexComments(id, post);
}

// ------------------------------------------------------------------ reports

/** What a report points at: "p:<post>" or "c:<post>:<comment>". */
export type ReportTarget = { kind: "post"; post: string } | { kind: "comment"; post: string; comment: string };

export function targetKey(target: ReportTarget): string {
  return target.kind === "post" ? `p:${target.post}` : `c:${target.post}:${target.comment}`;
}

export function parseTarget(raw: string): ReportTarget | null {
  const parts = raw.split(":");
  if (parts[0] === "p" && parts.length === 2 && ITEM_ID.test(parts[1])) return { kind: "post", post: parts[1] };
  if (parts[0] === "c" && parts.length === 3 && ITEM_ID.test(parts[1]) && ITEM_ID.test(parts[2])) {
    return { kind: "comment", post: parts[1], comment: parts[2] };
  }
  return null;
}

/**
 * A member flags a post or a comment for the creator. Counted once per
 * member; the queue keeps the most recent MAX_REPORT_QUEUE.
 */
export async function report(id: string, target: ReportTarget, who: string, room: DataStore): Promise<"added" | "again"> {
  const key = targetKey(target);
  // Its entry in the member's trace (traceKey) takes its room first; given back when it was a report made before.
  await needData(room, [TRACE_ENTRY]);
  const [added, , traced] = await redisPipeline([
    ["SADD", reportersKey(id, key), who],
    ["EXPIRE", reportersKey(id, key), REPORTERS_SECONDS],
    ["SADD", traceKey(id, who), `r:${key}`],
  ]);
  if (Number(traced) !== 1) await giveData(room, [TRACE_ENTRY]);
  if (Number(added) !== 1) return "again";
  await redisPipeline([
    ["ZADD", reportsKey(id), Date.now(), key],
    ["ZREMRANGEBYRANK", reportsKey(id), 0, -(MAX_REPORT_QUEUE + 1)],
  ]);
  return "added";
}

export type QueuedReport = { target: ReportTarget; key: string; at: number; count: number | null };

/** A failed moderation read is never evidence that nobody reported anything. */
export class ReportQueueReadError extends Error {
  constructor() {
    super("The community report queue could not be read completely.");
    this.name = "ReportQueueReadError";
  }
}

async function readReportedRecord<T>(command: (string | number)[], parse: (raw: unknown) => T | null): Promise<T | null> {
  const reply = await redisPipeline([command]);
  const slot = Array.isArray(reply) && reply.length === 1 ? Object.getOwnPropertyDescriptor(reply, "0") : undefined;
  if (!slot || !Object.hasOwn(slot, "value")) throw new ReportQueueReadError();
  if (slot.value === null) return null;
  const record = parse(slot.value);
  if (!record) throw new ReportQueueReadError();
  return record;
}

/** Resolve a confirmed report without treating a missing reply as a deleted target. */
export async function readReportedTarget(id: string, target: ReportTarget): Promise<{ post: Post; comment: Comment | null } | null> {
  const post = await readReportedRecord(["GET", postKey(id, target.post)], parsePost);
  if (!post) return null;
  if (post.id !== target.post) throw new ReportQueueReadError();
  if (target.kind === "post") return { post, comment: null };
  const comment = await readReportedRecord(["HGET", commentsKey(id, target.post), target.comment], parseComment);
  if (!comment) return null;
  if (comment.id !== target.comment) throw new ReportQueueReadError();
  return { post, comment };
}

function reportInteger(raw: unknown): number | null {
  if (typeof raw !== "number" && (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The creator's moderation queue, newest report first. */
export async function reportQueue(id: string, limit = 100): Promise<QueuedReport[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORT_QUEUE) throw new ReportQueueReadError();
  const reply = await redisPipeline([["ZREVRANGEBYSCORE", reportsKey(id), "+inf", "-inf", "WITHSCORES", "LIMIT", 0, limit]]);
  if (!Array.isArray(reply) || reply.length !== 1) throw new ReportQueueReadError();
  const flat: unknown = reply[0];
  if (!Array.isArray(flat) || flat.length % 2 !== 0 || flat.length > limit * 2) throw new ReportQueueReadError();
  const rows: { key: string; at: number; target: ReportTarget }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const key: unknown = flat[i];
    const target = typeof key === "string" ? parseTarget(key) : null;
    const score = reportInteger(flat[i + 1]);
    if (typeof key !== "string" || !target || score === null || score > 8_640_000_000_000_000 || seen.has(key)) throw new ReportQueueReadError();
    seen.add(key);
    rows.push({ key, at: Math.floor(score / 1000), target });
  }
  if (!rows.length) return [];
  const counts = await redisPipeline(rows.map((r) => ["SCARD", reportersKey(id, r.key)]));
  if (!Array.isArray(counts) || counts.length !== rows.length) throw new ReportQueueReadError();
  return rows.map((r, i) => {
    const count = reportInteger(counts[i]);
    if (count === null) throw new ReportQueueReadError();
    // Reporter sets expire after 90 days; their absence does not say how
    // many people originally reported an item that still waits in the queue.
    return { ...r, count: count === 0 ? null : count };
  });
}

/** Takes an item off the queue without touching it: the creator saw nothing wrong. */
export async function dismissReport(id: string, key: string): Promise<void> {
  await redisPipeline([["ZREM", reportsKey(id), key]]);
}

// ------------------------------------------------------------------ spaces

/** Removes a space. Its posts stay, in the whole-community feed. */
export async function dropSpace(id: string, space: string): Promise<void> {
  await redisPipeline([["DEL", spaceKey(id, space)]]);
}

/**
 * Deletes one member's own record (lib/community-erasure.ts): who they are,
 * their name and answers, their place in the directory, and the counts kept
 * for their limits. Answers the record as it was, for the keys it names
 * elsewhere (their handle, their unsubscribe token), or null.
 */
export async function forgetMemberRecord(id: string, who: string): Promise<Member | null> {
  if (!isRedisConfigured()) return null;
  const [raw] = await redisPipeline([["HGET", membersKey(id), who]]);
  const member = parseMember(raw);
  await redisPipeline([
    ["HDEL", membersKey(id), who],
    ["ZREM", dirKey(id), who],
    ["DEL", ...(Object.keys(RATE_LIMITS) as RateKind[]).map((kind) => rateKey(id, who, kind))],
  ]);
  return member;
}

/** Commands sent at once while reading a whole community for one member's copy. */
const TRACE_BATCH = 500;

export type MemberTraces = {
  posts: { post: string; space: string; title: string; text: string; at: number; edited: number; hidden: boolean }[];
  comments: { post: string; comment: string; text: string; at: number; edited: number; hidden: boolean }[];
  likedPosts: string[];
  likedComments: { post: string; comment: string }[];
  reported: string[];
  /** The posts that carry a poll, for reading their votes (lib/community-polls.ts, votesOf). */
  pollPosts: string[];
};

/**
 * What one member wrote and did in the community, for the copy of their data
 * (619 [SZ3], lib/person-copy.ts): their posts and comments (their own words
 * only, never the replies under them), the posts and comments they liked and
 * what they reported. These stay in the community after an erasure, without
 * their name (lib/person-data.ts, "open"), and are theirs to see all the
 * same. Reads every post the community keeps, at most MAX_POSTS, in batches.
 * Only reads.
 */
export async function memberTraces(id: string, who: string): Promise<MemberTraces> {
  if (!isRedisConfigured()) return { posts: [], comments: [], likedPosts: [], likedComments: [], reported: [], pollPosts: [] };
  // Read from the member's own trace when every post the community keeps is
  // from after the trace began; otherwise the whole community, as before it.
  const [oldestIds] = await redisPipeline([["ZRANGEBYSCORE", feedKey(id), "-inf", "+inf", "LIMIT", 0, 1]]);
  const oldestId = Array.isArray(oldestIds) && oldestIds.length ? String(oldestIds[0]) : "";
  const oldest = oldestId ? await readPost(id, oldestId) : null;
  if (oldestId && (!oldest || oldest.at < TRACED_SINCE)) return scanTraces(id, who);
  return tracedOf(id, who);
}

/** What the member's trace names (lib/community-trace.ts), each checked against what is kept now. */
async function tracedOf(id: string, who: string): Promise<MemberTraces> {
  const out: MemberTraces = { posts: [], comments: [], likedPosts: [], likedComments: [], reported: [], pollPosts: [] };
  const [raw] = await redisPipeline([["SMEMBERS", traceKey(id, who)]]);
  const refs = (Array.isArray(raw) ? raw : []).map(String).sort();
  const parts = refs.map((ref) => ref.split(":"));
  const postIds = [...new Set(parts.filter((p) => p[0] === "p" && p.length === 2).map((p) => p[1]))];
  const posts: Post[] = [];
  for (let i = 0; i < postIds.length; i += TRACE_BATCH) posts.push(...(await readPosts(id, postIds.slice(i, i + TRACE_BATCH))));
  for (const post of posts) {
    if (post.a === who) out.posts.push({ post: post.id, space: post.sp, title: post.title, text: post.text, at: post.at, edited: post.ed, hidden: post.hid });
  }
  const comments = parts.filter((p) => p[0] === "c" && p.length === 3);
  const likes = parts.filter((p) => p[0] === "l" && p.length === 2);
  const commentLikes = parts.filter((p) => p[0] === "lc" && p.length === 3);
  const reports = parts.filter((p) => p[0] === "r" && p.length >= 3).map((p) => p.slice(1).join(":"));
  const commands: (string | number)[][] = [
    ...comments.map(([, post, comment]) => ["HGET", commentsKey(id, post), comment]),
    ...likes.map(([, post]) => ["SISMEMBER", likesKey(id, post), who]),
    ...commentLikes.map(([, post, comment]) => ["SISMEMBER", commentLikesKey(id, post, comment), who]),
    ...reports.map((target) => ["SISMEMBER", reportersKey(id, target), who]),
  ];
  const replies: unknown[] = [];
  for (let i = 0; i < commands.length; i += TRACE_BATCH) replies.push(...(await redisPipeline(commands.slice(i, i + TRACE_BATCH))));
  let at = 0;
  for (const [, post] of comments) {
    const comment = parseComment(replies[at++]);
    if (comment && comment.a === who) out.comments.push({ post, comment: comment.id, text: comment.text, at: comment.at, edited: comment.ed, hidden: comment.hid });
  }
  for (const [, post] of likes) if (Number(replies[at++]) === 1) out.likedPosts.push(post);
  for (const [, post, comment] of commentLikes) if (Number(replies[at++]) === 1) out.likedComments.push({ post, comment });
  for (const target of reports) {
    if (Number(replies[at++]) !== 1) continue;
    const [kind, post, comment] = target.split(":");
    out.reported.push(kind === "p" ? `post ${post}` : `comment ${comment} under post ${post}`);
  }
  out.pollPosts = [...new Set(parts.filter((p) => p[0] === "v" && p.length === 2).map((p) => p[1]))];
  return out;
}

/** The whole community, read for one member: for a community with posts from before the trace began. */
async function scanTraces(id: string, who: string): Promise<MemberTraces> {
  const out: MemberTraces = { posts: [], comments: [], likedPosts: [], likedComments: [], reported: [], pollPosts: [] };
  if (!isRedisConfigured()) return out;
  const [raw] = await redisPipeline([["ZREVRANGE", feedKey(id), 0, MAX_POSTS - 1]]);
  const ids = (Array.isArray(raw) ? raw : []).map(String);
  for (let i = 0; i < ids.length; i += TRACE_BATCH) {
    const batch = ids.slice(i, i + TRACE_BATCH);
    const posts = await readPosts(id, batch);
    const replies = await redisPipeline(
      posts.flatMap((p) => [
        ["HGETALL", commentsKey(id, p.id)],
        ["SISMEMBER", likesKey(id, p.id), who],
        ["SISMEMBER", reportersKey(id, `p:${p.id}`), who],
      ]),
    );
    const theirComments: { post: string; comment: Comment }[] = [];
    const everyComment: { post: string; comment: Comment }[] = [];
    posts.forEach((p, k) => {
      if (p.a === who) out.posts.push({ post: p.id, space: p.sp, title: p.title, text: p.text, at: p.at, edited: p.ed, hidden: p.hid });
      if (p.poll) out.pollPosts.push(p.id);
      if (Number(replies[k * 3 + 1]) === 1) out.likedPosts.push(p.id);
      if (Number(replies[k * 3 + 2]) === 1) out.reported.push(`post ${p.id}`);
      const flat = replies[k * 3];
      const values = Array.isArray(flat) ? flat.filter((_, n) => n % 2 === 1) : flat && typeof flat === "object" ? Object.values(flat as Record<string, string>) : [];
      for (const value of values) {
        const comment = parseComment(value);
        if (!comment) continue;
        everyComment.push({ post: p.id, comment });
        if (comment.a === who) theirComments.push({ post: p.id, comment });
      }
    });
    for (const { post, comment } of theirComments) out.comments.push({ post, comment: comment.id, text: comment.text, at: comment.at, edited: comment.ed, hidden: comment.hid });
    for (let c = 0; c < everyComment.length; c += TRACE_BATCH) {
      const slice = everyComment.slice(c, c + TRACE_BATCH);
      const marks = await redisPipeline(slice.flatMap(({ post, comment }) => [["SISMEMBER", commentLikesKey(id, post, comment.id), who], ["SISMEMBER", reportersKey(id, `c:${post}:${comment.id}`), who]]));
      slice.forEach(({ post, comment }, k) => {
        if (Number(marks[k * 2]) === 1) out.likedComments.push({ post, comment: comment.id });
        if (Number(marks[k * 2 + 1]) === 1) out.reported.push(`comment ${comment.id} under post ${post}`);
      });
    }
  }
  return out;
}
