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
 *   nl:cm:<id>:ap:f          the picture of each held post still on the
 *                            queue: item -> its author and path (hash)
 *
 * A held post's picture is listed apart from its record, which runs out by
 * itself: an item swept, removed or erased after its record ran out still
 * has its picture deleted (review of #3020, finding 3). A line goes when its
 * item leaves the queue, so the list is never longer than the queue.
 *
 * Bounded: at most MAX_HELD waiting in a community and MAX_MINE items and
 * notes per member; a hold past either is refused, and nothing of it stays.
 * Each hold first sweeps a few items that expired (HOLD_SWEEP), more than
 * the one it adds, so what expired never piles up on the queue, and only
 * what still waits counts toward MAX_HELD (finding 4).
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
import { CREATOR, type Comment, type CommunityImage, type NewPost, type Post, addComment, createPost, newItemId, readComment, readPost } from "@/lib/community";
import { type Poll, parsePoll } from "@/lib/community-polls";
import { ITEM_ID, MAX_COMMENT_TEXT, MAX_POST_TEXT, MAX_POST_TITLE, cleanLine } from "@/lib/community-text";
import { removeCommunityImage } from "@/lib/community-files";
import { DataRoomError, type DataStore, needData } from "@/lib/store-data";
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
/** How many a member's hold sweeps first: a few, so sending stays quick. */
const HOLD_SWEEP = 5;
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
const picturesKey = (id: string) => `${base(id)}:ap:f`;

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
  // A few that expired go first, so they never pile up on the queue. Best
  // effort: a sweep that failed never stops a member's post, which counts
  // only what still waits anyway.
  await sweepHeld(id, now, HOLD_SWEEP).catch((error) => console.error("sweeping expired held community items failed", error));
  const json = JSON.stringify(held);
  const picture = held.img ? JSON.stringify({ a: held.a, p: held.img.path }) : null;
  // The record and its places (and its picture's line), kept until it is gone by itself.
  await needData(room, [{ until: (now + KEEP_SECONDS) * 1000, bytes: dataBytes([json, picture], picture ? 4 : 3) }]);
  const written = repliesFor(await redisPipeline([["SET", itemKey(id, held.id), json, "EX", KEEP_SECONDS, "NX"]]), 1);
  if (!written || written[0] !== "OK") throw new UnknownReplyError("writing a held community item");
  const replies = repliesFor(
    await redisPipeline([
      // Its picture is listed before the item is on the queue, so nothing on the queue has a picture nobody can find.
      ...(picture ? [["HSET", picturesKey(id), held.id, picture]] : []),
      ["ZREMRANGEBYSCORE", mineKey(id, held.a), "-inf", now - KEEP_SECONDS],
      ["ZADD", queueKey(id), held.at, held.id],
      // Only what still waits takes the community's room: what expired was already refused (finding 4).
      ["ZCOUNT", queueKey(id), `(${now - HELD_DAYS * DAY}`, "+inf"],
      ["ZADD", mineKey(id, held.a), held.at, held.id],
      ["ZCARD", mineKey(id, held.a)],
      ["EXPIRE", mineKey(id, held.a), KEEP_SECONDS],
    ]),
    picture ? 7 : 6,
  );
  const counts = replies?.slice(picture ? 1 : 0).map(countOf);
  if (!replies || !counts || counts.some((n) => n === null) || counts[1] !== 1 || counts[3] !== 1 || (picture && countOf(replies[0]) === null)) {
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
      // The picture is the route's to delete, as it was never held.
      ...(picture ? [["HDEL", picturesKey(id), held.id]] : []),
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

/**
 * A held item's picture deleted, and only then its line in the pictures list (removeCommunityImage): a file that could
 * not be deleted keeps its line, where its author's erasure finds it again (Codex G on #3020, 6751455863). True when
 * both are gone.
 */
async function dropHeldPicture(id: string, item: string, path: string): Promise<boolean> {
  return removeCommunityImage(path, async () => countOf(repliesFor(await redisPipeline([["HDEL", picturesKey(id), item]]), 1)?.[0]) !== null);
}

/** Writes the note in the item's place, for what is left of its time; its picture is deleted, then its line. */
async function leaveNote(id: string, note: Held, picture: string | null | undefined, now: number): Promise<void> {
  // At most TOLD_DAYS from now, and never past the record's own end.
  const left = Math.min(note.at + KEEP_SECONDS - now, TOLD_DAYS * DAY);
  await redisPipeline([left > 0 ? ["SET", itemKey(id, note.id), JSON.stringify(note), "EX", left, "XX"] : ["DEL", itemKey(id, note.id)]]);
  if (picture) await dropHeldPicture(id, note.id, picture);
}

/** One line of the pictures list: whose post it was and its path, or null for anything else. */
function pictureOf(raw: unknown): { a: string; p: string } | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return v && typeof v.a === "string" && v.a && typeof v.p === "string" && v.p ? { a: v.a, p: v.p } : null;
  } catch {
    return null;
  }
}

/**
 * The picture of an item that left the queue with no record to read (it ran
 * out by itself, KEEP_DAYS): found in the pictures list, deleted, and its
 * line with it (finding 3). Nothing when it had none.
 */
async function dropListedPicture(id: string, item: string): Promise<void> {
  const replies = repliesFor(await redisPipeline([["HGET", picturesKey(id), item]]), 1);
  if (!replies) throw new UnknownReplyError("a held community picture");
  if (replies[0] === null) return;
  const path = pictureOf(replies[0])?.p;
  // A line that does not read names no file: it goes; otherwise the file first, then the line.
  if (!path) await redisPipeline([["HDEL", picturesKey(id), item]]);
  else await dropHeldPicture(id, item, path);
}

/** Whether an item has waited HELD_DAYS: refused by itself, as its author already reads it (heldOf). */
const isDue = (held: Pick<Held, "at">, now: number) => held.at <= now - HELD_DAYS * DAY;

/** Refuses one item that waited HELD_DAYS, when this caller takes it: a note for its author, its picture deleted. */
async function expire(id: string, held: Held, now: number): Promise<void> {
  if (await claim(id, held.id)) await leaveNote(id, noteOf(held, "expired", "", now), held.img?.path, now);
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
 * each leaves a note for its author. At most `limit` a call, so a sweep is
 * never long; what it did not reach is still never approved nor shown as
 * waiting, since the queue is read and acted on by age too (finding 1).
 */
export async function sweepHeld(id: string, now = nowSeconds(), limit = SWEEP_BATCH): Promise<number> {
  const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", queueKey(id), "-inf", now - HELD_DAYS * DAY, "LIMIT", 0, limit]]), 1);
  const due = replies ? stringList(replies[0]) : null;
  if (!due) throw new UnknownReplyError("the held items that are due");
  let swept = 0;
  for (const item of due) {
    const held = ITEM_ID.test(item) ? await readItem(id, item) : null;
    if (!(await claim(id, item))) continue;
    swept += 1;
    if (held?.state === "held") await leaveNote(id, noteOf(held, "expired", "", now), held.img?.path, now);
    // Its record ran out: its picture is found in the list (finding 3).
    else await dropListedPicture(id, item);
  }
  return swept;
}

/**
 * The creator's queue: what waits, oldest first. Only what was sent less than
 * HELD_DAYS ago, however many expired ones the sweep has not reached yet.
 */
export async function heldQueue(id: string, now = nowSeconds()): Promise<Held[]> {
  await sweepHeld(id, now);
  const replies = repliesFor(await redisPipeline([["ZRANGEBYSCORE", queueKey(id), `(${now - HELD_DAYS * DAY}`, "+inf", "LIMIT", 0, MAX_HELD]]), 1);
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
  // An entry whose record is gone, or no longer waits, is not waiting: taken
  // off by whoever takes it, with the picture it may have left (finding 3).
  for (const item of stale) if (await claim(id, item)) await dropListedPicture(id, item);
  return out;
}

/**
 * One member's own items, newest first: what waits, and the notes about what
 * was not published. Only theirs: the list is kept under their own key and
 * each record is checked to be theirs. An item past HELD_DAYS reads as
 * expired here even before a sweep has written its note.
 */
export async function heldOf(id: string, who: string, now = nowSeconds()): Promise<Held[]> {
  // Read on every visit of a member to the community, so one read and no
  // write: what ran out is left out here, and pruned by the member's next
  // hold (and by the list's own expiry), not by every visit (finding 5).
  const replies = repliesFor(await redisPipeline([["ZREVRANGEBYSCORE", mineKey(id, who), "+inf", `(${now - KEEP_SECONDS}`, "LIMIT", 0, MAX_MINE]]), 1);
  const ids = replies ? stringList(replies[0]) : null;
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

/** Puts a claimed item back on the queue, when it could not be published after all, with its picture's line. */
async function putBack(id: string, held: Held): Promise<void> {
  await redisPipeline([
    ...(held.img ? [["HSET", picturesKey(id), held.id, JSON.stringify({ a: held.a, p: held.img.path })]] : []),
    ["ZADD", queueKey(id), held.at, held.id],
  ]);
}

type Published = { post: Post; comment: Comment | null };

/**
 * The post or comment this item was already published as, or null. It is
 * published under the item's own id, so a write whose reply was lost after
 * Redis applied it is found here, and never written twice (finding 2).
 */
async function publishedAs(id: string, held: Held): Promise<Published | null> {
  if (held.kind === "post") {
    const post = await readPost(id, held.id);
    return post && post.a === held.a ? { post, comment: null } : null;
  }
  const above = await readPost(id, held.post);
  const comment = above ? await readComment(id, above.id, held.id) : null;
  return above && comment && comment.a === held.a ? { post: above, comment } : null;
}

/** Writes the item into the community, under its own id: "full" when there is no room, "post" when the post it answers is gone. */
async function publish(id: string, held: Held, room: DataStore): Promise<Published | "full" | "post"> {
  if (held.kind === "post") {
    const input: NewPost = { space: held.sp, author: held.a, title: held.title, text: held.text, img: held.img, kind: "post", poll: held.poll, id: held.id };
    const made = await createPost(id, input, room);
    return made.ok ? { post: made.post, comment: null } : "full";
  }
  const above = await readPost(id, held.post);
  if (!above) return "post";
  let made = await addComment(id, above.id, { parent: held.parent, author: held.a, text: held.text, id: held.id }, room);
  // The comment it answered is gone: it goes straight under the post.
  if (!made.ok && made.reason === "parent") made = await addComment(id, above.id, { parent: "", author: held.a, text: held.text, id: held.id }, room);
  return made.ok ? { post: above, comment: made.comment } : "full";
}

/**
 * The creator approves: the item is published as its author wrote it, through
 * createPost or addComment, and counted toward its author's approved ones.
 * Published only when its record was read exactly, it was sent less than
 * HELD_DAYS ago, and this call took it off the queue; anything else
 * publishes nothing. Published once: under the item's own id, found again
 * when a write's reply was lost.
 */
export async function approveHeld(id: string, item: string, room: DataStore, now = nowSeconds()): Promise<ApproveResult> {
  if (!ITEM_ID.test(item)) return { ok: false, reason: "gone" };
  await sweepHeld(id, now);
  const held = await readItem(id, item);
  if (!held || held.state !== "held") return { ok: false, reason: "gone" };
  // Its author already reads it as not published, swept or not (finding 1).
  if (isDue(held, now)) {
    await expire(id, held, now);
    return { ok: false, reason: "gone" };
  }
  const field = `${held.a}:${held.kind === "post" ? "p" : "c"}`;
  // The count's room, before anything is published (lib/store-data.ts).
  const exists = repliesFor(await redisPipeline([["HEXISTS", countKey(id), field]]), 1);
  const there = exists ? countOf(exists[0]) : null;
  if (there === null || there > 1) throw new UnknownReplyError("a member's approved count");
  if (there === 0) await needData(room, [{ slot: COUNT_SLOT, bytes: dataBytes([field, "99"], 1) }]);
  if (!(await claim(id, item))) return { ok: false, reason: "gone" };

  let made: Published | "full" | "post";
  try {
    // Its picture is the post's from now on, no longer one to delete with what waits.
    if (held.img) await redisPipeline([["HDEL", picturesKey(id), item]]);
    // An earlier approval whose reply was lost may have published it already.
    made = (await publishedAs(id, held)) ?? (await publish(id, held, room));
  } catch (error) {
    // A write whose reply was lost (a timeout) may have been applied all the
    // same: then it is published, and said so. It waits again only when it
    // was not found; a later approval looks for it first, so even a write
    // applied after this look is never published twice (finding 2).
    const found = error instanceof DataRoomError ? null : await publishedAs(id, held).catch(() => null);
    if (!found) {
      await putBack(id, held).catch(() => {});
      throw error;
    }
    made = found;
  }
  if (made === "full") {
    await putBack(id, held);
    return { ok: false, reason: "full" };
  }
  if (made === "post") {
    // The post it answered was deleted while it waited: told, never published.
    await leaveNote(id, noteOf(held, "gone", "", now), null, now);
    return { ok: false, reason: "post" };
  }
  const { post, comment } = made;
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
  // Already refused by itself: its author keeps reading "expired" (finding 1).
  if (isDue(held, now)) {
    await expire(id, held, now);
    return { ok: false, reason: "gone" };
  }
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
  // Its picture, then its line: a file not deleted keeps the line its author's erasure finds it by.
  if (held.state === "held" && held.img?.path) await dropHeldPicture(id, item, held.img.path);
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
      ["HGETALL", picturesKey(id)],
    ]),
    3,
  );
  const mine = replies ? stringList(replies[0]) : null;
  const queued = replies ? stringList(replies[1]) : null;
  const lines = replies ? stringList(replies[2]) : null;
  if (!mine || !queued || !lines || lines.length % 2) throw new UnknownReplyError("a member's held community items");
  // Their pictures still listed, found even when the record ran out (finding 3).
  const pictures = new Map<string, string>();
  for (let i = 0; i < lines.length; i += 2) {
    const line = pictureOf(lines[i + 1]);
    if (line?.a === who && ITEM_ID.test(lines[i])) pictures.set(lines[i], line.p);
  }
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
  for (const item of pictures.keys()) if (!theirs.some((h) => h.id === item)) theirs.push({ id: item } as Held);
  const items = theirs.map((h) => h.id);
  // Each picture once, by the item it is held for: from the list, or from the record while it waits. One the record
  // names and the list does not is written into the list with the records' deletion, so it is never left unnamed.
  const held = new Map<string, string>(pictures);
  const unlisted: [string, string][] = [];
  for (const h of theirs) {
    if (h.state === "held" && h.img?.path && !held.has(h.id)) {
      held.set(h.id, h.img.path);
      unlisted.push([h.id, h.img.path]);
    }
  }
  const kept = items.length ? 4 : 2;
  const done = repliesFor(
    await redisPipeline([
      ...(items.length ? [["ZREM", queueKey(id), ...items], ["DEL", ...items.map((item) => itemKey(id, item))]] : []),
      ["DEL", mineKey(id, who)],
      ["HDEL", countKey(id), `${who}:p`, `${who}:c`],
      ...unlisted.map(([item, path]) => ["HSET", picturesKey(id), item, JSON.stringify({ a: who, p: path })]),
    ]),
    kept + unlisted.length,
  );
  const counts = done?.map(countOf);
  if (!counts || counts.some((n) => n === null)) throw new Error("Community held items erasure was not confirmed");
  // The pictures last, each file before its line (Codex G on #3020, 6751455863): one that could not be deleted keeps
  // its line, and the erasure says it did not finish, so the next one deletes it.
  let left = 0;
  for (const [item, path] of held) if (!(await dropHeldPicture(id, item, path))) left += 1;
  if (left) throw new Error("Community held items erasure: a picture could not be deleted");
  // The records, the member's list and their counts that went (a picture's line is not a record of its own).
  const tail = counts.slice(items.length ? 1 : 0, kept) as number[];
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
