/**
 * Telling somebody something happened to them.
 *
 * Stan's own help centre says it plainly: "All Community notifications are
 * sent via email!", and the member's only choice is daily, weekly or never —
 * with the creator able to override a member's "never" on any post they tick
 * a box for. There is no in-app list to come back to. Circle, Skool, Mighty
 * Networks, Whop and Kajabi all have one.
 *
 * So there is one here, and it is the honest kind: it holds only things that
 * happened TO this person — somebody answered their post, answered their
 * comment, or named them — and never "there is new activity", which is not
 * news about anybody and is the reason people switch notifications off.
 *
 * Kept under the community's own id:
 *
 *   nl:cm:<id>:nt:<who>    what happened to them, newest first (sorted set)
 *   nl:cm:<id>:nt:s:<who>  when they last looked
 *
 * Nobody is ever told about their own doing: answering your own post, or
 * naming yourself, notifies nobody. A hidden post's comments notify nobody
 * either — a post the creator took down should not keep reaching into
 * somebody's day.
 *
 * A phone is told at the same moment, from here, so the two can never say
 * different things: whatever is worth a row in somebody's list is worth
 * waking their phone for, and nothing else is. What the phone is sent is
 * thinner still — who did what, and where to go, never the words.
 */
import { redisPipeline } from "@/lib/redis";
import { UnknownReplyError, countOf, repliesFor, stringList } from "@/lib/redis-reply";
import { type DataOwner, orderWrite } from "@/lib/order-data";
import { pushMembers } from "@/lib/community-push";
import { communityWords } from "@/lib/buyer-words/community";
import { type DataStore, takeData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";

/** Where notices are counted in the store's data room (lib/store-data.ts): one slot for every member's lists. */
const NOTICES_SLOT = "cm:nt";

const base = (id: string) => `nl:cm:${id}`;
const listKey = (id: string, who: string) => `${base(id)}:nt:${who}`;
const seenKey = (id: string, who: string) => `${base(id)}:nt:s:${who}`;

/** How many one person's list holds. Older ones fall off the end. */
export const MAX_NOTICES = 100;
export const NOTICE_PAGE = 30;

export type NoticeKind = "reply" | "answer" | "mention";

export type Notice = {
  kind: NoticeKind;
  /** The post it happened on. */
  post: string;
  /** The comment, when it was one. */
  comment: string;
  /** Who did it: CREATOR or a member key. */
  by: string;
  /** The first words of what they wrote, for the list. */
  words: string;
  at: number;
};

const now = () => Math.floor(Date.now() / 1000);
const SNIP = 140;
/** The most one notice weighs: its words at three bytes a character, its ids and its field. */
export const NOTICE_BYTES = dataBytes(["x".repeat(SNIP * 3 + 160)], 1);

function parse(raw: unknown): Notice | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Notice>;
    if (typeof v.post !== "string" || typeof v.by !== "string") return null;
    const kind: NoticeKind = v.kind === "answer" ? "answer" : v.kind === "mention" ? "mention" : "reply";
    return {
      kind,
      post: v.post,
      comment: typeof v.comment === "string" ? v.comment : "",
      by: v.by,
      words: typeof v.words === "string" ? v.words : "",
      at: typeof v.at === "number" ? v.at : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Files one thing for each of these people, leaving out whoever did it.
 *
 * Never throws into the caller: a comment that failed to save because a
 * notification did would be a lost comment, and a notification that never
 * arrived is a smaller loss than the thing it was about.
 */
export async function tell(
  id: string,
  to: string[],
  notice: Omit<Notice, "at" | "words"> & { words: string },
  /** The store whose data room the notices take from. */
  room: DataStore,
  /** Where a phone should be sent, and by what name. Left out, none is sent. */
  phone?: { handle: string; who: string; language?: unknown },
): Promise<void> {
  const who = [...new Set(to)].filter((one) => one && one !== notice.by);
  if (!who.length) return;
  const row = JSON.stringify({ ...notice, words: notice.words.slice(0, SNIP), at: now() } satisfies Notice);
  try {
    // Each list that is not yet full grows by the notice; a full one lets its
    // oldest go, and none of its own room changes hands for it (each is
    // counted at the most a notice weighs). With no room left, nothing is
    // filed: what it is about was written, and that is what matters.
    // Rule 24: a size in an unknown shape files nothing, so no list grows without its room.
    const sizes = repliesFor(await redisPipeline(who.map((one) => ["ZCARD", listKey(id, one)])), who.length)?.map(countOf);
    if (!sizes || sizes.some((n) => n === null)) throw new UnknownReplyError("a community notice list's size");
    const growing = sizes.filter((n) => n !== null && n < MAX_NOTICES).length;
    const taken = growing ? await takeData(room, [{ slot: NOTICES_SLOT, bytes: growing * NOTICE_BYTES }]) : { ok: true as const };
    if (taken.ok) {
      await redisPipeline(
        who.flatMap((one) => [
          ["ZADD", listKey(id, one), now(), row],
          ["ZREMRANGEBYRANK", listKey(id, one), 0, -(MAX_NOTICES + 1)],
        ]),
      );
    }
  } catch (error) {
    console.error("filing a community notification failed", error);
  }
  if (!phone) return;
  // The words are deliberately absent: a notification is read on a lock
  // screen, and this one says who did what and where, nothing more.
  // In the store's language, like the pages it opens.
  const w = communityWords(phone.language);
  const said =
    notice.kind === "reply" ? w.whatReply(phone.who) : notice.kind === "answer" ? w.whatAnswer(phone.who) : w.whatMention(phone.who);
  await pushMembers(id, who, {
    title: said,
    body: w.pushOpen,
    url: notice.comment
      ? `/@${phone.handle}/community/post/${notice.post}#comment-${notice.comment}`
      : `/@${phone.handle}/community/post/${notice.post}`,
    // One per post: a second answer replaces the first rather than stacking
    // up ten times overnight.
    tag: notice.post,
  }).catch((error) => console.error("pushing a community notification failed", error));
}

/** What happened to somebody, newest first, and how many are new. */
export async function noticesFor(id: string, who: string): Promise<{ notices: Notice[]; unread: number }> {
  const [raw, seen] = await redisPipeline([
    ["ZREVRANGE", listKey(id, who), 0, NOTICE_PAGE - 1],
    ["GET", seenKey(id, who)],
  ]);
  const notices = (Array.isArray(raw) ? raw : []).map(parse).filter((n): n is Notice => n !== null);
  const last = Number(seen) || 0;
  return { notices, unread: notices.filter((n) => n.at > last).length };
}

/** Just the count, for the badge on every page. */
export async function unreadCount(id: string, who: string): Promise<number> {
  const [raw, seen] = await redisPipeline([
    ["ZREVRANGE", listKey(id, who), 0, MAX_NOTICES - 1, "WITHSCORES"],
    ["GET", seenKey(id, who)],
  ]);
  const flat = Array.isArray(raw) ? raw.map(String) : [];
  const last = Number(seen) || 0;
  let n = 0;
  for (let i = 1; i < flat.length; i += 2) if ((Number(flat[i]) || 0) > last) n += 1;
  return n;
}

/** Marks everything up to now as looked at: a member's mark, counted in the store's room once (lib/order-data.ts). */
export async function markSeen(id: string, who: string, owner: DataOwner): Promise<void> {
  await orderWrite(owner, [["SET", seenKey(id, who), String(now())]]).catch(() => {});
}

/** What a member leaves behind when they are removed. */
export function noticeKeys(id: string, who: string): string[] {
  return [listKey(id, who), seenKey(id, who)];
}

/** Deletes what one member was told and when they last looked (lib/community-erasure.ts). */
export async function forgetNoticesPerson(id: string, who: string): Promise<number> {
  const reply = await redisPipeline([["DEL", ...noticeKeys(id, who)]]);
  const length = Array.isArray(reply) ? Object.getOwnPropertyDescriptor(reply, "length") : undefined;
  const gone = Array.isArray(reply) ? Object.getOwnPropertyDescriptor(reply, "0") : undefined;
  if (length?.value !== 1 || !gone || !Object.hasOwn(gone, "value") || typeof gone.value !== "number" || !Number.isSafeInteger(gone.value) || gone.value < 0 || gone.value > 2) {
    throw new Error("Community notice erasure was not confirmed");
  }
  return gone.value;
}

/**
 * Every notice one member has, newest first, for the copy of their data (619 [SZ3]); only reads, never marks them seen.
 * Read in its exact shape (CX-123 rule 24): a reply of another shape, or a kept notice that does not read, throws
 * UnknownReplyError, and copyPerson fails the whole copy rather than hand it over as complete without them. Only an
 * empty list (no key) is "no notices". The member's own list and badge (noticesFor, unreadCount) stay as they are:
 * they show, and decide nothing.
 */
export async function allNoticesOf(id: string, who: string): Promise<Notice[]> {
  const replies = repliesFor(await redisPipeline([["ZREVRANGE", listKey(id, who), 0, MAX_NOTICES - 1]]), 1);
  const rows = replies ? stringList(replies[0]) : null;
  if (!rows) throw new UnknownReplyError("a member's community notices");
  return rows.map((row) => {
    const notice = parse(row);
    if (!notice) throw new UnknownReplyError("a kept community notice");
    return notice;
  });
}
