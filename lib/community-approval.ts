/**
 * 543 [CM2]: approval of posts and comments before they publish, a choice
 * the creator makes per space (added 6 November 2026).
 *
 * For each space, separately for posts and for comments: publish right away
 * (the default, as before), approve the first 1 to 5 of each new member, or
 * approve every one. The creator is never held.
 *
 * What waits is kept apart from the community's posts and comments, never in
 * the feed, a space, a post's comments or the search index (lib/community.ts),
 * so nothing that reads the community can show it to anybody: only its author
 * (heldOf, marked "Waiting for approval") and the creator's queue in the
 * studio (heldQueue) read it. Approving writes it into the community through
 * createPost or addComment, as if it had just been sent; removing keeps a short
 * note for the author, with the creator's sentence; waiting HELD_DAYS without
 * an answer refuses it by itself, with a note too. Nothing is deleted without
 * the author being told.
 *
 * Kept under the community's own id:
 *
 *   nl:cm:<id>:ap:r          the rule of each space: space -> rule (hash)
 *   nl:cm:<id>:ap:q          what waits, by when it was sent (sorted set)
 *   nl:cm:<id>:ap:i:<item>   one item waiting, or the note left for its
 *                            author once it was removed or expired; gone by
 *                            itself KEEP_DAYS after it was sent
 *   nl:cm:<id>:ap:w:<who>    one member's items and notes (sorted set)
 *   nl:cm:<id>:ap:n          how many of each member's posts ("<who>:p")
 *                            and comments ("<who>:c") were approved (hash)
 *   nl:cm:<id>:ap:t:<day>    the creator was told today that items wait
 *                            (lib/community-held-notice.ts), two days
 *
 * And one list for the company (unit 2): nl:cm:ap:stores, the stores whose
 * community held something lately, by the time of the last hold, so the
 * daily notice reads only those. A store leaves it by itself a day after
 * nothing it held could still wait (storesWithHeld).
 *
 * Bounded: at most MAX_HELD waiting in a community and MAX_MINE items and
 * notes per member; a hold past either is refused, and nothing of it stays.
 * Each item takes its room in the store's data room before it is written,
 * counted until it is gone by itself (lib/store-data.ts); each member's count
 * takes its room the first time it is written.
 *
 * Every reply is read in its exact shape (CX-123 rule 24): an unknown reply
 * is thrown, so a rule never reads as "publish right away", a queue never
 * reads as empty, and a held item is never published on a reply that was
 * not exactly the item. Approving and removing claim the item by taking it
 * off the queue first (one ZREM, which only one caller can win), so two
 * moderators never publish it twice (rule 25).
 *
 * Deleting a person deletes what they had waiting and their counts
 * (forgetHeldPerson, from lib/community-erasure.ts); the copy of their data
 * includes it (lib/person-copy.ts).
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { CREATOR, type Comment, type CommunityImage, type NewPost, type Post, addComment, createPost, newItemId, readPost } from "@/lib/community";
import { type Poll, parsePoll } from "@/lib/community-polls";
import { ITEM_ID, MAX_COMMENT_TEXT, MAX_POST_TEXT, MAX_POST_TITLE, cleanLine } from "@/lib/community-text";
import { dropCommunityImage } from "@/lib/community-files";
import { type DataStore, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { MAX_ALT_LENGTH } from "@/lib/product-image";
import { HELD_DAYS, KEEP_DAYS, MAX_FIRST, MAX_HELD, MAX_MINE, MAX_WHY, TOLD_DAYS } from "@/lib/community-approval-rules";

export { HELD_DAYS, KEEP_DAYS, MAX_FIRST, MAX_HELD, MAX_MINE, MAX_WHY, TOLD_DAYS } from "@/lib/community-approval-rules";

const DAY = 86_400;
const KEEP_SECONDS = KEEP_DAYS * DAY;
/** What a note keeps of what was written, for its author to recognize it. */
const NOTE_SNIP = 140;
/** How many expired items one sweep refuses, so a sweep is never long. */
const SWEEP_BATCH = 50;
/** The slot members' approved counts are counted in (lib/store-data.ts). */
const COUNT_SLOT = "cm:ap:n";

export type ApprovalMode = "off" | "first" | "all";
/** `n` is how many first posts are approved ("first" only); `since` when "first" was chosen, in seconds. */
export type ApprovalRule = { mode: ApprovalMode; n: number; since: number };
export type SpaceApproval = { posts: ApprovalRule; comments: ApprovalRule };

const OFF: ApprovalRule = { mode: "off", n: 0, since: 0 };
export const PUBLISH_RIGHT_AWAY: SpaceApproval = { posts: OFF, comments: OFF };

export type HeldState = "held" | "removed" | "expired" | "gone";

export type Held = {
  id: string;
  kind: "post" | "comment";
  /** Its author's member key. */
  a: string;
  /** When it was sent, in seconds. */
  at: number;
  /** The space it was sent to (a post), or the space of the post it answers (a comment). */
  sp: string;
  /** The post a comment answers; "" for a post. */
  post: string;
  /** The comment a comment answers, or "". */
  parent: string;
  title: string;
  text: string;
  img: CommunityImage | null;
  poll: Poll | null;
  /**
   * "held" waits; "removed" was not published by the creator, with `why`;
   * "expired" waited HELD_DAYS without an answer; "gone" answered a post that
   * was deleted before it was approved.
   */
  state: HeldState;
  why: string;
  /** When it stopped waiting, in seconds; 0 while it waits. */
  done: number;
};

const base = (id: string) => `nl:cm:${id}`;
const rulesKey = (id: string) => `${base(id)}:ap:r`;
const queueKey = (id: string) => `${base(id)}:ap:q`;
const itemKey = (id: string, item: string) => `${base(id)}:ap:i:${item}`;
const mineKey = (id: string, who: string) => `${base(id)}:ap:w:${who}`;
const countKey = (id: string) => `${base(id)}:ap:n`;
/** The day's mark of the creator's notice (lib/community-held-notice.ts): `day` is YYYY-MM-DD. */
export const heldNoticeKey = (id: string, day: string) => `${base(id)}:ap:t:${day}`;
/** The company's list of stores whose community held something lately: store id -> last hold, in seconds. */
const HELD_STORES = "nl:cm:ap:stores";
/** A store's id as lib/store.ts makes it (STORE_ID_PATTERN); a room without one lists nothing. */
const STORE_SID = /^[0-9a-f]{32}$/;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ rules

function parseRule(raw: unknown): ApprovalRule | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const since = v.s === undefined ? 0 : v.s;
  if (typeof since !== "number" || !Number.isSafeInteger(since) || since < 0) return null;
  if (v.m === "off") return OFF;
  if (v.m === "all") return { mode: "all", n: 0, since: 0 };
  if (v.m === "first" && typeof v.n === "number" && Number.isInteger(v.n) && v.n >= 1 && v.n <= MAX_FIRST) return { mode: "first", n: v.n, since };
  return null;
}

/** A space's rule as it is kept, or null for anything else: never read as "publish right away". */
export function parseSpaceApproval(raw: unknown): SpaceApproval | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    const posts = parseRule(v.p);
    const comments = parseRule(v.c);
    return posts && comments ? { posts, comments } : null;
  } catch {
    return null;
  }
}

function writeRule(rule: ApprovalRule): Record<string, unknown> {
  return rule.mode === "first" ? { m: "first", n: rule.n, s: rule.since } : { m: rule.mode };
}

/** One space's rule. Never set is "publish right away"; anything not read exactly is thrown. */
export async function approvalFor(id: string, space: string): Promise<SpaceApproval> {
  const replies = repliesFor(await redisPipeline([["HGET", rulesKey(id), space]]), 1);
  if (!replies) throw new UnknownReplyError("a space's approval rule");
  const [raw] = replies;
  if (raw === null) return PUBLISH_RIGHT_AWAY;
  const rule = parseSpaceApproval(raw);
  if (!rule) throw new UnknownReplyError("a space's approval rule");
  return rule;
}

/** Every space's rule, for the studio. */
export async function approvalsOf(id: string, spaces: string[]): Promise<Map<string, SpaceApproval>> {
  const out = new Map<string, SpaceApproval>();
  for (const space of spaces) out.set(space, await approvalFor(id, space));
  return out;
}

export type WantedRule = { mode: unknown; n: unknown };

function wantedRule(wanted: WantedRule, before: ApprovalRule, now: number): ApprovalRule {
  if (wanted.mode === "off") return OFF;
  if (wanted.mode === "all") return { mode: "all", n: 0, since: 0 };
  if (wanted.mode === "first" && typeof wanted.n === "number" && Number.isInteger(wanted.n) && wanted.n >= 1 && wanted.n <= MAX_FIRST) {
    // Who counts as new is decided once, when "first" is chosen: changing the
    // number later does not make everybody who joined since then new again.
    return { mode: "first", n: wanted.n, since: before.mode === "first" ? before.since : now };
  }
  throw new RangeError("approval rule");
}

/**
 * Sets one space's rule. `spaces` are the community's spaces now: a space it
 * does not have is refused, and the rules of spaces since removed are
 * dropped, so the hash never holds more than the community's spaces.
 */
export async function setApproval(
  id: string,
  space: string,
  wanted: { posts: WantedRule; comments: WantedRule },
  spaces: string[],
  now = nowSeconds(),
): Promise<SpaceApproval> {
  if (!ITEM_ID.test(space) || !spaces.includes(space)) throw new RangeError("unknown space");
  const before = await approvalFor(id, space).catch((error) => {
    // A rule that cannot be read is replaced by the one chosen now, which is what the creator sees saved.
    if (error instanceof UnknownReplyError) return PUBLISH_RIGHT_AWAY;
    throw error;
  });
  const next: SpaceApproval = { posts: wantedRule(wanted.posts, before.posts, now), comments: wantedRule(wanted.comments, before.comments, now) };
  const replies = repliesFor(
    await redisPipeline([
      ["HSET", rulesKey(id), space, JSON.stringify({ p: writeRule(next.posts), c: writeRule(next.comments) })],
      ["HKEYS", rulesKey(id)],
    ]),
    2,
  );
  const fields = replies ? stringList(replies[1]) : null;
  if (!replies || countOf(replies[0]) === null || !fields) throw new UnknownReplyError("saving a space's approval rule");
  const stale = fields.filter((field) => !spaces.includes(field));
  if (stale.length) await redisPipeline([["HDEL", rulesKey(id), ...stale]]);
  return next;
}

/**
 * Whether what this member sends now waits for approval, under this rule.
 * "first": a member who joined before the rule was chosen is not new; one
 * with no record is held. The creator is never asked about (the route does
 * not ask for them). An approved count not read exactly is thrown.
 */
export async function mustHold(id: string, rule: ApprovalRule, kind: "p" | "c", member: { k: string; at: number } | null): Promise<boolean> {
  if (rule.mode === "off") return false;
  if (rule.mode === "all" || !member) return true;
  if (member.at < rule.since) return false;
  const replies = repliesFor(await redisPipeline([["HGET", countKey(id), `${member.k}:${kind}`]]), 1);
  if (!replies) throw new UnknownReplyError("a member's approved count");
  const raw = replies[0];
  const count = raw === null ? 0 : typeof raw === "string" && /^(0|[1-9][0-9]{0,8})$/.test(raw) ? Number(raw) : countOf(raw);
  if (count === null) throw new UnknownReplyError("a member's approved count");
  return count < rule.n;
}

// ------------------------------------------------------------------ items

function parseImage(raw: unknown): CommunityImage | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const v = raw as Record<string, unknown>;
  const side = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 10_000;
  if (typeof v.path !== "string" || !side(v.w) || !side(v.h) || typeof v.alt !== "string") return undefined;
  return { path: v.path, w: v.w as number, h: v.h as number, alt: v.alt.slice(0, MAX_ALT_LENGTH) };
}

const STATES = new Set<HeldState>(["held", "removed", "expired", "gone"]);
const time = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** One item as it is kept, or null for anything else. */
export function parseHeld(raw: unknown): Held | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (typeof v.id !== "string" || !ITEM_ID.test(v.id)) return null;
    if (v.kind !== "post" && v.kind !== "comment") return null;
    if (typeof v.a !== "string" || !v.a || v.a === CREATOR) return null;
    if (!time(v.at) || !time(v.done)) return null;
    if (typeof v.sp !== "string" || typeof v.post !== "string" || typeof v.parent !== "string") return null;
    if (v.kind === "comment" ? !ITEM_ID.test(v.post) : v.post !== "") return null;
    if (v.parent && !ITEM_ID.test(v.parent)) return null;
    if (typeof v.title !== "string" || typeof v.text !== "string" || typeof v.why !== "string") return null;
    if (typeof v.state !== "string" || !STATES.has(v.state as HeldState)) return null;
    const img = parseImage(v.img);
    if (img === undefined) return null;
    const poll = v.poll === null ? null : parsePoll(v.poll);
    if (v.poll !== null && !poll) return null;
    return {
      id: v.id,
      kind: v.kind,
      a: v.a,
      at: v.at as number,
      sp: v.sp,
      post: v.post,
      parent: v.parent,
      title: v.title.slice(0, MAX_POST_TITLE),
      text: v.text.slice(0, MAX_POST_TEXT),
      img,
      poll,
      state: v.state as HeldState,
      why: v.why.slice(0, MAX_WHY),
      done: v.done as number,
    };
  } catch {
    return null;
  }
}

/** The one reply of a GET of an item: the item, null when there is none, or thrown. */
function itemOf(raw: unknown, item: string): Held | null {
  if (raw === null) return null;
  const held = parseHeld(raw);
  if (!held || held.id !== item) throw new UnknownReplyError("a held community item");
  return held;
}

async function readItem(id: string, item: string): Promise<Held | null> {
  const replies = repliesFor(await redisPipeline([["GET", itemKey(id, item)]]), 1);
  if (!replies) throw new UnknownReplyError("a held community item");
  return itemOf(replies[0], item);
}

export type HoldResult = { ok: true; held: Held } | { ok: false; reason: "full" | "mine" };

/**
 * Keeps what a member sent for the creator to approve. Its room is taken
 * first (refused: DataRoomError, nothing written); past the community's or
 * the member's ceiling it is refused and nothing of it stays.
 */
async function hold(id: string, held: Held, room: DataStore, now: number): Promise<HoldResult> {
  if (held.a === CREATOR) throw new RangeError("the creator is never held");
  const json = JSON.stringify(held);
  // The record and its two places, kept until it is gone by itself.
  await needData(room, [{ until: (now + KEEP_SECONDS) * 1000, bytes: dataBytes([json], 3) }]);
  const written = repliesFor(await redisPipeline([["SET", itemKey(id, held.id), json, "EX", KEEP_SECONDS, "NX"]]), 1);
  if (!written || written[0] !== "OK") throw new UnknownReplyError("writing a held community item");
  const placing: (string | number)[][] = [
    ["ZREMRANGEBYSCORE", mineKey(id, held.a), "-inf", now - KEEP_SECONDS],
    ["ZADD", queueKey(id), held.at, held.id],
    ["ZCARD", queueKey(id)],
    ["ZADD", mineKey(id, held.a), held.at, held.id],
    ["ZCARD", mineKey(id, held.a)],
    ["EXPIRE", mineKey(id, held.a), KEEP_SECONDS],
  ];
  // Unit 2: the store goes on the list the daily notice reads, by the time of this hold.
  if (typeof room.sid === "string" && STORE_SID.test(room.sid)) placing.push(["ZADD", HELD_STORES, now, room.sid]);
  const replies = repliesFor(await redisPipeline(placing), placing.length);
  const counts = replies?.map(countOf);
  if (!counts || counts.some((n) => n === null) || counts[1] !== 1 || counts[3] !== 1) {
    throw new UnknownReplyError("placing a held community item");
  }
  // Added first and counted after: two sent at once at the ceiling are both
  // refused rather than both kept, and the queue is never left past it.
  const over = (counts[2] as number) > MAX_HELD ? "full" : (counts[4] as number) > MAX_MINE ? "mine" : null;
  if (over) {
    await redisPipeline([
      ["ZREM", queueKey(id), held.id],
      ["ZREM", mineKey(id, held.a), held.id],
      ["DEL", itemKey(id, held.id)],
    ]);
    return { ok: false, reason: over };
  }
  return { ok: true, held };
}

/** Holds a member's post. The caller has checked everything it checks for a post that publishes. */
export async function holdPost(id: string, input: NewPost, room: DataStore, now = nowSeconds()): Promise<HoldResult> {
  return hold(
    id,
    {
      id: newItemId(),
      kind: "post",
      a: input.author,
      at: now,
      sp: input.space,
      post: "",
      parent: "",
      title: input.title,
      text: input.text,
      img: input.img,
      poll: input.poll,
      state: "held",
      why: "",
      done: 0,
    },
    room,
    now,
  );
}

/** Holds a member's comment on a post they can see. */
export async function holdComment(
  id: string,
  input: { post: string; space: string; parent: string; author: string; text: string },
  room: DataStore,
  now = nowSeconds(),
): Promise<HoldResult> {
  return hold(
    id,
    {
      id: newItemId(),
      kind: "comment",
      a: input.author,
      at: now,
      sp: input.space,
      post: input.post,
      parent: ITEM_ID.test(input.parent) ? input.parent : "",
      title: "",
      text: input.text.slice(0, MAX_COMMENT_TEXT),
      img: null,
      poll: null,
      state: "held",
      why: "",
      done: 0,
    },
    room,
    now,
  );
}

/** The note an item leaves for its author when it stops waiting: a few words of it, and why. */
function noteOf(held: Held, state: Exclude<HeldState, "held">, why: string, now: number): Held {
  return {
    ...held,
    title: held.title.slice(0, NOTE_SNIP),
    text: held.text.slice(0, NOTE_SNIP),
    img: null,
    poll: null,
    state,
    why: cleanLine(why, MAX_WHY),
    done: now,
  };
}

/** Writes the note in the item's place, for what is left of its time; its picture is deleted. */
async function leaveNote(id: string, note: Held, picture: string | null | undefined, now: number): Promise<void> {
  // At most TOLD_DAYS from now, and never past the record's own end.
  const left = Math.min(note.at + KEEP_SECONDS - now, TOLD_DAYS * DAY);
  await redisPipeline([left > 0 ? ["SET", itemKey(id, note.id), JSON.stringify(note), "EX", left, "XX"] : ["DEL", itemKey(id, note.id)]]);
  await dropCommunityImage(picture);
}

/** Takes the item off the queue: true only for the one caller who took it. */
async function claim(id: string, item: string): Promise<boolean> {
  const replies = repliesFor(await redisPipeline([["ZREM", queueKey(id), item]]), 1);
  const taken = replies ? countOf(replies[0]) : null;
  if (taken === null || taken > 1) throw new UnknownReplyError("taking a held community item off the queue");
  return taken === 1;
}

/**
 * Refuses, by themselves, the items that waited HELD_DAYS without an answer:
 * each leaves a note for its author. Run before the queue is read or acted
 * on, so nothing older is ever approved or shown as waiting.
 */
export async function sweepHeld(id: string, now = nowSeconds()): Promise<number> {
  const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", queueKey(id), "-inf", now - HELD_DAYS * DAY, "LIMIT", 0, SWEEP_BATCH]]), 1);
  const due = replies ? stringList(replies[0]) : null;
  if (!due) throw new UnknownReplyError("the held items that are due");
  let swept = 0;
  for (const item of due) {
    const held = ITEM_ID.test(item) ? await readItem(id, item) : null;
    if (!(await claim(id, item))) continue;
    swept += 1;
    if (held?.state === "held") await leaveNote(id, noteOf(held, "expired", "", now), held.img?.path, now);
  }
  return swept;
}

/**
 * The stores whose community held something lately, the latest first, at most
 * `limit` (543 [CM2] unit 2). A store whose last hold is more than a day past
 * HELD_DAYS has nothing that can still wait, so it is let go here first; an
 * unknown reply is thrown, so a run never reads the list as empty.
 */
export async function storesWithHeld(now = nowSeconds(), limit = 500): Promise<string[]> {
  const replies = repliesFor(
    await redisPipeline([
      ["ZREMRANGEBYSCORE", HELD_STORES, "-inf", now - (HELD_DAYS + 1) * DAY],
      ["ZREVRANGE", HELD_STORES, 0, Math.max(0, limit - 1)],
    ]),
    2,
  );
  const sids = replies && countOf(replies[0]) !== null ? stringList(replies[1]) : null;
  if (!sids || sids.some((sid) => !STORE_SID.test(sid))) throw new UnknownReplyError("the stores with held community items");
  return sids;
}

/** The creator's queue: what waits, oldest first, after the sweep. */
export async function heldQueue(id: string, now = nowSeconds()): Promise<Held[]> {
  await sweepHeld(id, now);
  const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", queueKey(id), "-inf", "+inf", "LIMIT", 0, MAX_HELD]]), 1);
  const ids = replies ? stringList(replies[0]) : null;
  if (!ids) throw new UnknownReplyError("the held community queue");
  if (!ids.length) return [];
  if (ids.some((item) => !ITEM_ID.test(item))) throw new UnknownReplyError("the held community queue");
  const rows = repliesFor(await redisPipeline([["MGET", ...ids.map((item) => itemKey(id, item))]]), 1);
  const values = rows && Array.isArray(rows[0]) ? repliesFor(rows[0], ids.length) : null;
  if (!values) throw new UnknownReplyError("the held community items");
  const out: Held[] = [];
  const stale: string[] = [];
  ids.forEach((item, i) => {
    const held = itemOf(values[i], item);
    if (held?.state === "held") out.push(held);
    else stale.push(item);
  });
  // An entry whose record is gone, or no longer waits, is not waiting.
  if (stale.length) await redisPipeline([["ZREM", queueKey(id), ...stale]]);
  return out;
}

/**
 * One member's own items, newest first: what waits, and the notes about what
 * was not published. Only theirs: the list is kept under their own key and
 * each record is checked to be theirs. An item past HELD_DAYS reads as
 * expired here even before a sweep has written its note.
 */
export async function heldOf(id: string, who: string, now = nowSeconds()): Promise<Held[]> {
  const replies = repliesFor(
    await redisPipeline([
      ["ZREMRANGEBYSCORE", mineKey(id, who), "-inf", now - KEEP_SECONDS],
      ["ZREVRANGEBYSCORE", mineKey(id, who), "+inf", "-inf", "LIMIT", 0, MAX_MINE],
    ]),
    2,
  );
  const ids = replies && countOf(replies[0]) !== null ? stringList(replies[1]) : null;
  if (!ids || ids.some((item) => !ITEM_ID.test(item))) throw new UnknownReplyError("a member's held community items");
  if (!ids.length) return [];
  const rows = repliesFor(await redisPipeline([["MGET", ...ids.map((item) => itemKey(id, item))]]), 1);
  const values = rows && Array.isArray(rows[0]) ? repliesFor(rows[0], ids.length) : null;
  if (!values) throw new UnknownReplyError("a member's held community items");
  const out: Held[] = [];
  const stale: string[] = [];
  ids.forEach((item, i) => {
    const held = itemOf(values[i], item);
    if (!held || held.a !== who) {
      stale.push(item);
      return;
    }
    out.push(held.state === "held" && held.at <= now - HELD_DAYS * DAY ? noteOf(held, "expired", "", held.at + HELD_DAYS * DAY) : held);
  });
  if (stale.length) await redisPipeline([["ZREM", mineKey(id, who), ...stale]]);
  return out;
}

/** Whole days, rounded up and at least one, before a waiting item is refused by itself. */
export function heldDaysLeft(held: Pick<Held, "at">, now = nowSeconds()): number {
  return Math.max(1, Math.ceil((held.at + HELD_DAYS * DAY - now) / DAY));
}

export type ApproveResult =
  | { ok: true; held: Held; post: Post; comment: Comment | null }
  | { ok: false; reason: "gone" | "full" | "post" };

/** Puts a claimed item back on the queue, when it could not be published after all. */
async function putBack(id: string, held: Held): Promise<void> {
  await redisPipeline([["ZADD", queueKey(id), held.at, held.id]]);
}

/**
 * The creator approves: the item is published as its author wrote it, through
 * createPost or addComment, and counted toward its author's approved ones.
 * Published only when its record was read exactly and this call took it off
 * the queue; anything else publishes nothing.
 */
export async function approveHeld(id: string, item: string, room: DataStore, now = nowSeconds()): Promise<ApproveResult> {
  if (!ITEM_ID.test(item)) return { ok: false, reason: "gone" };
  await sweepHeld(id, now);
  const held = await readItem(id, item);
  if (!held || held.state !== "held") return { ok: false, reason: "gone" };
  const field = `${held.a}:${held.kind === "post" ? "p" : "c"}`;
  // The count's room, before anything is published (lib/store-data.ts).
  const exists = repliesFor(await redisPipeline([["HEXISTS", countKey(id), field]]), 1);
  const there = exists ? countOf(exists[0]) : null;
  if (there === null || there > 1) throw new UnknownReplyError("a member's approved count");
  if (there === 0) await needData(room, [{ slot: COUNT_SLOT, bytes: dataBytes([field, "99"], 1) }]);
  if (!(await claim(id, item))) return { ok: false, reason: "gone" };

  let post: Post;
  let comment: Comment | null = null;
  try {
    if (held.kind === "post") {
      const input: NewPost = { space: held.sp, author: held.a, title: held.title, text: held.text, img: held.img, kind: "post", poll: held.poll };
      const made = await createPost(id, input, room);
      if (!made.ok) {
        await putBack(id, held);
        return { ok: false, reason: "full" };
      }
      post = made.post;
    } else {
      const above = await readPost(id, held.post);
      if (!above) {
        // The post it answered was deleted while it waited: told, never published.
        await leaveNote(id, noteOf(held, "gone", "", now), null, now);
        return { ok: false, reason: "post" };
      }
      let made = await addComment(id, above.id, { parent: held.parent, author: held.a, text: held.text }, room);
      // The comment it answered is gone: it goes straight under the post.
      if (!made.ok && made.reason === "parent") made = await addComment(id, above.id, { parent: "", author: held.a, text: held.text }, room);
      if (!made.ok) {
        await putBack(id, held);
        return { ok: false, reason: "full" };
      }
      post = above;
      comment = made.comment;
    }
  } catch (error) {
    // Not published (no room, or an unknown reply before writing): it waits again.
    await putBack(id, held).catch(() => {});
    throw error;
  }
  try {
    await redisPipeline([
      ["DEL", itemKey(id, item)],
      ["ZREM", mineKey(id, held.a), item],
      ["HINCRBY", countKey(id), field, 1],
    ]);
  } catch (error) {
    // Published all the same; what is left over goes by itself (KEEP_DAYS).
    console.error("tidying an approved community item failed", error);
  }
  return { ok: true, held, post, comment };
}

/**
 * The creator removes: never published, and its author is told, with the
 * creator's sentence when they wrote one. The picture it carried is deleted.
 */
export async function removeHeld(id: string, item: string, why: string, now = nowSeconds()): Promise<{ ok: true; held: Held } | { ok: false; reason: "gone" }> {
  if (!ITEM_ID.test(item)) return { ok: false, reason: "gone" };
  await sweepHeld(id, now);
  const held = await readItem(id, item);
  if (!held || held.state !== "held") return { ok: false, reason: "gone" };
  if (!(await claim(id, item))) return { ok: false, reason: "gone" };
  await leaveNote(id, noteOf(held, "removed", why, now), held.img?.path, now);
  return { ok: true, held };
}

/**
 * Its author takes back what waits, or puts away a note: only their own.
 * "done" when it went, "gone" when there was nothing of theirs.
 */
export async function withdrawHeld(id: string, item: string, who: string): Promise<"done" | "gone"> {
  if (!ITEM_ID.test(item)) return "gone";
  const held = await readItem(id, item);
  if (!held || held.a !== who) return "gone";
  if (held.state === "held" && !(await claim(id, item))) return "gone";
  await redisPipeline([
    ["DEL", itemKey(id, item)],
    ["ZREM", mineKey(id, who), item],
  ]);
  if (held.state === "held") await dropCommunityImage(held.img?.path);
  return "done";
}

/**
 * Deletes one person's items, waiting or not, their pictures, their list and
 * their approved counts (lib/community-erasure.ts). Answers how many records
 * went. Anything not read exactly is thrown, so the erasure says it did not
 * finish rather than leaving something behind quietly.
 */
export async function forgetHeldPerson(id: string, who: string): Promise<number> {
  const replies = repliesFor(
    await redisPipeline([
      ["ZRANGEBYSCORE", mineKey(id, who), "-inf", "+inf"],
      ["ZRANGEBYSCORE", queueKey(id), "-inf", "+inf", "LIMIT", 0, MAX_HELD * 2],
    ]),
    2,
  );
  const mine = replies ? stringList(replies[0]) : null;
  const queued = replies ? stringList(replies[1]) : null;
  if (!mine || !queued) throw new UnknownReplyError("a member's held community items");
  const candidates = [...new Set([...mine, ...queued])].filter((item) => ITEM_ID.test(item));
  const theirs: Held[] = [];
  const listed = new Set(mine);
  if (candidates.length) {
    const rows = repliesFor(await redisPipeline([["MGET", ...candidates.map((item) => itemKey(id, item))]]), 1);
    const values = rows && Array.isArray(rows[0]) ? repliesFor(rows[0], candidates.length) : null;
    if (!values) throw new UnknownReplyError("a member's held community items");
    candidates.forEach((item, i) => {
      const held = itemOf(values[i], item);
      if (held?.a === who) theirs.push(held);
      else if (!held && listed.has(item)) theirs.push({ id: item } as Held);
    });
  }
  const items = theirs.map((h) => h.id);
  const done = repliesFor(
    await redisPipeline([
      ...(items.length ? [["ZREM", queueKey(id), ...items], ["DEL", ...items.map((item) => itemKey(id, item))]] : []),
      ["DEL", mineKey(id, who)],
      ["HDEL", countKey(id), `${who}:p`, `${who}:c`],
    ]),
    items.length ? 4 : 2,
  );
  const counts = done?.map(countOf);
  if (!counts || counts.some((n) => n === null)) throw new Error("Community held items erasure was not confirmed");
  for (const held of theirs) if (held.state === "held") await dropCommunityImage(held.img?.path);
  const tail = counts.slice(items.length ? 1 : 0) as number[];
  return tail.reduce((sum, n) => sum + n, 0);
}

/** What a member reads about one of their items, for the copy of their data. */
export function heldCopy(held: Held): { kind: string; space: string; post: string; title: string; text: string; sent: string; state: HeldState; why: string } {
  return {
    kind: held.kind,
    space: held.sp,
    post: held.post,
    title: held.title,
    text: held.text,
    sent: new Date(held.at * 1000).toISOString(),
    state: held.state,
    why: held.why,
  };
}
