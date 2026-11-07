/**
 * 293 [SQ4]: posts and announcements written ahead and put up in the
 * community at their time (the rules are in lib/community-schedule-rules.ts).
 *
 *   nl:cm:{community}:sch        sorted set: the community's scheduled posts, by time
 *   nl:cm:{community}:sch:{id}   one scheduled post's record (JSON)
 *   nl:cm:schq                   sorted set: every store's, "{store}:{community}:{id}" by time
 *
 * Each one takes room in the store's data room before it is written, in its
 * own slot, and gives it back when it is cleared (lib/store-data.ts).
 *
 * Who may change one is decided by one command: taking its member off the
 * due list (ZREM). Whoever gets 1 back holds it, the five-minute job to post
 * it or the studio to edit or cancel it, and the other is refused, so a post
 * is never put up with words the creator had already changed, and never
 * changed once the job has it. The record is read and written only by the
 * holder; the job marks it "publishing" before it writes the post, so a try
 * whose outcome is not known is said as such and never made again.
 *
 * Posting goes through createPost, with the rules as they are at that moment:
 * the space still there, the community's post cap and the store's data room.
 * Members mentioned are told then, and an announcement's email is asked for
 * then (lib/community-mail.ts), never at scheduling.
 */
import { randomBytes } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { countOf } from "@/lib/redis-reply";
import { storeForId, type Store } from "@/lib/store";
import { CREATOR, createPost, readConfig } from "@/lib/community";
import { COMMUNITY_ID, ITEM_ID } from "@/lib/community-text";
import { queueAnnouncement } from "@/lib/community-mail";
import { mentionsIn, whoIs } from "@/lib/community-mentions";
import { tell } from "@/lib/community-notify";
import { DataRoomError, giveData, needData } from "@/lib/store-data";
import {
  type FailReason,
  type MailOutcome,
  type ScheduleInput,
  type ScheduledPost,
  MAX_SCHEDULED_POSTS,
  POSTED_KEEP_SECONDS,
  PUBLISH_TRIES,
  RETRY_SECONDS,
  RUN_BATCH,
  parseRecord,
  recordBytes,
  settled,
} from "@/lib/community-schedule-rules";

export { parseRecord };

/** The job's due list, for every store. */
export const DUE_KEY = "nl:cm:schq";

export function scheduleKeys(community: string): { list: string; record: (id: string) => string } {
  return { list: `nl:cm:${community}:sch`, record: (id: string) => `nl:cm:${community}:sch:${id}` };
}

/** The data room slot one scheduled post is counted in. */
export function scheduleSlot(id: string): string {
  return `cm:s:${id}`;
}

export function dueMember(store: string, community: string, id: string): string {
  return `${store}:${community}:${id}`;
}

const STORE_ID = /^[0-9a-f]{32}$/;
const toSeconds = (ms: number) => Math.floor(ms / 1000);

function readMember(member: string): { store: string; community: string; id: string } | null {
  const [store, community, id, ...rest] = member.split(":");
  if (rest.length || !STORE_ID.test(store ?? "") || !COMMUNITY_ID.test(community ?? "") || !ITEM_ID.test(id ?? "")) return null;
  return { store, community, id };
}

const room = (id: string, bytes: number) => [{ slot: scheduleSlot(id), bytes, set: true }];

/**
 * Keeps one to go up at its time. Its room is taken first: refused there,
 * nothing is written (DataRoomError). Past the community's cap, its place is
 * taken back with its room, and the answer is "full".
 */
export async function schedulePost(
  store: Store,
  input: ScheduleInput,
  now = Date.now(),
): Promise<{ ok: true; post: ScheduledPost } | { ok: false; reason: "full" | "off" }> {
  const community = store.community?.id;
  if (!community || !store.sid) return { ok: false, reason: "off" };
  const at = toSeconds(now);
  const post: ScheduledPost = { ...input, id: randomBytes(6).toString("hex"), made: at, state: "waiting", tries: 0, post: "", mail: "", why: "", at };
  const keys = scheduleKeys(community);
  await needData(store, room(post.id, recordBytes(post)), now);
  let count: number | null = null;
  try {
    const [, size] = await redisPipeline([["ZADD", keys.list, "NX", post.due, post.id], ["ZCARD", keys.list]]);
    count = countOf(size);
  } catch (error) {
    await giveData(store, room(post.id, 0), now);
    throw error;
  }
  if (count === null || count > MAX_SCHEDULED_POSTS) {
    await redisPipeline([["ZREM", keys.list, post.id]]).catch(() => undefined);
    await giveData(store, room(post.id, 0), now);
    if (count === null) throw new Error("the community's scheduled posts could not be counted");
    return { ok: false, reason: "full" };
  }
  await redisPipeline([
    ["SET", keys.record(post.id), JSON.stringify(post)],
    ["ZADD", DUE_KEY, post.due, dueMember(store.sid, community, post.id)],
  ]);
  return { ok: true, post };
}

/**
 * Changes one that is still waiting: its words, its space, its kind and its
 * time. Refused ("busy") once the job holds it.
 */
export async function editScheduled(
  store: Store,
  id: string,
  input: ScheduleInput,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: "gone" | "busy" }> {
  const community = store.community?.id;
  if (!community || !store.sid || !ITEM_ID.test(id)) return { ok: false, reason: "gone" };
  const keys = scheduleKeys(community);
  const member = dueMember(store.sid, community, id);
  const [removed, raw] = await redisPipeline([["ZREM", DUE_KEY, member], ["GET", keys.record(id)]]);
  const current = parseRecord(raw);
  if (removed !== 1) return { ok: false, reason: current ? "busy" : "gone" };
  // Held from here: only this request reads and writes the record until it is back on the due list.
  if (!current || current.state !== "waiting") return { ok: false, reason: "gone" };
  const next: ScheduledPost = { ...current, ...input, at: toSeconds(now) };
  try {
    await needData(store, room(id, recordBytes(next)), now);
  } catch (error) {
    await redisPipeline([["ZADD", DUE_KEY, current.due, member]]);
    throw error;
  }
  await redisPipeline([
    ["SET", keys.record(id), JSON.stringify(next)],
    ["ZADD", keys.list, next.due, id],
    ["ZADD", DUE_KEY, next.due, member],
  ]);
  return { ok: true };
}

/**
 * Takes one off: a waiting one before the job holds it, or one the job is
 * done with (posted, failed, not confirmed), or one held up well past its
 * time. Its record, its places and its room all go.
 */
export async function cancelScheduled(
  store: Store,
  id: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: "gone" | "busy" }> {
  const community = store.community?.id;
  if (!community || !store.sid || !ITEM_ID.test(id)) return { ok: false, reason: "gone" };
  const keys = scheduleKeys(community);
  const [removed, raw] = await redisPipeline([["ZREM", DUE_KEY, dueMember(store.sid, community, id)], ["GET", keys.record(id)]]);
  const current = parseRecord(raw);
  if (!current) {
    // Nothing to clear but a place left behind, if any.
    const [listed] = await redisPipeline([["ZREM", keys.list, id]]);
    if (listed === 1) await giveData(store, room(id, 0), now);
    return { ok: false, reason: "gone" };
  }
  if (removed !== 1 && !settled(current, toSeconds(now))) return { ok: false, reason: "busy" };
  await redisPipeline([["DEL", keys.record(id)], ["ZREM", keys.list, id]]);
  await giveData(store, room(id, 0), now);
  return { ok: true };
}

/**
 * The community's scheduled posts, soonest first, for the studio. Posted
 * ones past their week, and places whose record is gone, are cleared on the
 * way, with their room.
 */
export async function listScheduled(store: Store, now = Date.now()): Promise<ScheduledPost[]> {
  const community = store.community?.id;
  if (!community) return [];
  const keys = scheduleKeys(community);
  const [ids] = await redisPipeline([["ZRANGEBYSCORE", keys.list, "-inf", "+inf", "LIMIT", 0, MAX_SCHEDULED_POSTS + 5]]);
  const list = Array.isArray(ids) ? ids.filter((one): one is string => typeof one === "string" && ITEM_ID.test(one)) : [];
  if (!list.length) return [];
  const [raws] = await redisPipeline([["MGET", ...list.map((one) => keys.record(one))]]);
  const records = Array.isArray(raws) ? raws : [];
  const at = toSeconds(now);
  const shown: ScheduledPost[] = [];
  for (const [i, one] of list.entries()) {
    const post = parseRecord(records[i]);
    if (post && post.id === one && !(post.state === "posted" && post.at + POSTED_KEEP_SECONDS < at)) {
      shown.push(post);
      continue;
    }
    if (post && post.id !== one) continue;
    await redisPipeline([["DEL", keys.record(one)], ["ZREM", keys.list, one]]);
    await giveData(store, room(one, 0), now);
  }
  return shown;
}

export type RunCounts = { posted: number; failed: number; unknown: number; later: number };

/**
 * The five-minute job's part: puts up what is due, at most RUN_BATCH a run,
 * starting nothing after `deadline` (milliseconds). `now` is the job's clock.
 */
export async function runScheduledPosts(deadline: number, now = Date.now()): Promise<RunCounts> {
  const counts: RunCounts = { posted: 0, failed: 0, unknown: 0, later: 0 };
  const at = toSeconds(now);
  const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "-inf", at, "LIMIT", 0, RUN_BATCH]]);
  const members = Array.isArray(due) ? due.filter((one): one is string => typeof one === "string") : [];
  for (const member of members) {
    if (Date.now() >= deadline) break;
    const where = readMember(member);
    if (!where) {
      await redisPipeline([["ZREM", DUE_KEY, member]]);
      continue;
    }
    const keys = scheduleKeys(where.community);
    const [removed, raw] = await redisPipeline([["ZREM", DUE_KEY, member], ["GET", keys.record(where.id)]]);
    // Taken already, by another run or by the studio.
    if (removed !== 1) continue;
    const post = parseRecord(raw);
    // Canceled meanwhile: nothing to post.
    if (!post || post.state !== "waiting") continue;
    // Moved to later by the studio between the read of the due list and this hold.
    if (post.due > at) {
      await redisPipeline([["ZADD", DUE_KEY, post.due, member]]);
      continue;
    }
    const [marked] = await redisPipeline([["SET", keys.record(post.id), JSON.stringify({ ...post, state: "publishing", tries: post.tries + 1, at }), "XX"]]);
    // Cleared by the studio between the hold and the mark: not posted.
    if (marked !== "OK") continue;
    const tried: ScheduledPost = { ...post, tries: post.tries + 1 };
    const outcome = await publish(where.store, where.community, tried);
    let next: ScheduledPost;
    if (outcome.kind === "posted") {
      next = { ...tried, state: "posted", post: outcome.post, mail: outcome.mail, at };
      counts.posted += 1;
    } else if (outcome.kind === "unknown") {
      next = { ...tried, state: "unknown", at };
      counts.unknown += 1;
    } else if (outcome.kind === "later" && tried.tries < PUBLISH_TRIES) {
      next = { ...tried, state: "waiting", at };
      counts.later += 1;
    } else {
      next = { ...tried, state: "failed", why: outcome.kind === "later" ? "error" : outcome.why, at };
      counts.failed += 1;
    }
    await redisPipeline([
      ["SET", keys.record(post.id), JSON.stringify(next), "XX"],
      ...(next.state === "waiting" ? [["ZADD", DUE_KEY, at + RETRY_SECONDS, member]] : []),
    ]);
  }
  return counts;
}

type Outcome = { kind: "posted"; post: string; mail: MailOutcome } | { kind: "failed"; why: FailReason } | { kind: "unknown" } | { kind: "later" };

/** One post put up, under the rules as they are now. */
async function publish(sid: string, community: string, post: ScheduledPost): Promise<Outcome> {
  let store: Store | null;
  let config: Awaited<ReturnType<typeof readConfig>>;
  try {
    store = await storeForId(sid);
    config = store?.community?.id === community ? await readConfig(community) : null;
  } catch (error) {
    // Nothing written yet: tried again, a bounded number of times.
    console.error("reading a store for a scheduled community post failed", error);
    return { kind: "later" };
  }
  if (!store || store.community?.id !== community || !config) return { kind: "failed", why: "gone" };
  if (store.suspended) return { kind: "failed", why: "store" };
  if (!config.spaces.some((s) => s.id === post.sp)) return { kind: "failed", why: "space" };
  let made: Awaited<ReturnType<typeof createPost>>;
  try {
    made = await createPost(community, { space: post.sp, author: CREATOR, title: post.title, text: post.text, img: null, kind: post.kind, poll: null }, store);
  } catch (error) {
    // Refused by the data room before anything was written.
    if (error instanceof DataRoomError) return { kind: "failed", why: "room" };
    // Anything else may have written the post: never tried again.
    console.error("posting a scheduled community post failed", error);
    return { kind: "unknown" };
  }
  if (!made.ok) return { kind: "failed", why: "full" };
  // From here the post is up; what follows never takes it down.
  try {
    const named = await whoIs(community, mentionsIn(`${post.title}\n${post.text}`));
    await tell(community, [...named.values()], { kind: "mention", post: made.post.id, comment: "", by: CREATOR, words: post.title || post.text }, store, {
      handle: store.handle,
      who: store.name,
      language: store.language,
    });
  } catch (error) {
    console.error("telling members mentioned in a scheduled post failed", error);
  }
  let mail: MailOutcome = "";
  if (post.kind === "announcement" && post.email) {
    try {
      const queued = await queueAnnouncement(store, config, made.post);
      mail = queued.ok ? "queued" : queued.reason;
    } catch (error) {
      console.error("starting a scheduled announcement's email failed", error);
      mail = "error";
    }
  }
  return { kind: "posted", post: made.post.id, mail };
}
