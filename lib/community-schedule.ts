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
 * Who has one is decided inside Redis, in one script at a time, never by a
 * read followed by a write:
 *
 *   CLAIM  the job takes it off the due list and marks it "publishing" in the
 *          same step, only while the record still reads as the job read it
 *          and its time has come. Nothing else can come between the two.
 *   SWAP   the studio's edit and cancel, the job's outcome, a clear from the
 *          list and putting a lost one back: the record is replaced or
 *          deleted, and its two places set, only while it still reads as the
 *          caller read it (compare and set). A record the job has marked no
 *          longer reads "waiting", so an edit or a cancel read before the
 *          job's claim is refused, never half done.
 *   ADD    scheduling writes the record and both places together, under the
 *          community's cap.
 *
 * A failed claim (no answer from Redis) leaves the record waiting and due,
 * as it was. A try whose post write may have landed is said as not confirmed
 * and never made again.
 *
 * Posting goes through createPost, with the rules as they are at that moment:
 * the space still there, the community's post cap and the store's data room.
 * Members mentioned are told then, and an announcement's email is asked for
 * then (lib/community-mail.ts), never at scheduling.
 */
import { randomBytes } from "node:crypto";
import { redisPipeline } from "@/lib/redis";
import { withCutoff } from "@/lib/fetch-timeout";
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
  MIN_LEAD_SECONDS,
  PUBLISH_MIN_MS,
  PUBLISH_TRIES,
  RETRY_SECONDS,
  RUN_BATCH,
  expired,
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

/**
 * KEYS[1] the community's list, KEYS[2] the record, KEYS[3] the due list.
 * ARGV[1] id, ARGV[2] its time, ARGV[3] its due member, ARGV[4] the record,
 * ARGV[5] the cap. 1 written; 0 the list is full; -1 the record is there already.
 */
export const SCHEDULE_ADD = `-- marktmorgen:cm-schedule-add:v1
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
redis.call('SET', KEYS[2], ARGV[4])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[3])
return 1`;

/**
 * KEYS[1] the due list, KEYS[2] the record. ARGV[1] the due member, ARGV[2]
 * now (seconds), ARGV[3] the record as the job read it, ARGV[4] the record
 * marked "publishing". 1 held and marked; 0 not on the due list; 2 not due
 * yet; 3 changed since it was read; -1 its record is gone (its member taken off).
 */
export const SCHEDULE_CLAIM = `-- marktmorgen:cm-schedule-claim:v1
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then return 0 end
if tonumber(score) > tonumber(ARGV[2]) then return 2 end
local current = redis.call('GET', KEYS[2])
if not current then
  redis.call('ZREM', KEYS[1], ARGV[1])
  return -1
end
if current ~= ARGV[3] then return 3 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[4])
return 1`;

/**
 * KEYS[1] the record, KEYS[2] the due list, KEYS[3] the community's list.
 * ARGV[1] the record as the caller read it, ARGV[2] the new record ("" deletes
 * it), ARGV[3] the due member, ARGV[4] the id, ARGV[5] its time on the due
 * list ("" takes it off), ARGV[6] its time on the community's list ("" takes
 * it off). 1 done; 0 the record no longer reads as it was read, nothing done.
 */
export const SCHEDULE_SWAP = `-- marktmorgen:cm-schedule-swap:v1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then redis.call('DEL', KEYS[1]) else redis.call('SET', KEYS[1], ARGV[2]) end
if ARGV[5] == '' then redis.call('ZREM', KEYS[2], ARGV[3]) else redis.call('ZADD', KEYS[2], ARGV[5], ARGV[3]) end
if ARGV[6] == '' then redis.call('ZREM', KEYS[3], ARGV[4]) else redis.call('ZADD', KEYS[3], ARGV[6], ARGV[4]) end
return 1`;

const STORE_ID = /^[0-9a-f]{32}$/;
const toSeconds = (ms: number) => Math.floor(ms / 1000);

function readMember(member: string): { store: string; community: string; id: string } | null {
  const [store, community, id, ...rest] = member.split(":");
  if (rest.length || !STORE_ID.test(store ?? "") || !COMMUNITY_ID.test(community ?? "") || !ITEM_ID.test(id ?? "")) return null;
  return { store, community, id };
}

const room = (id: string, bytes: number) => [{ slot: scheduleSlot(id), bytes, set: true }];

/** One compare-and-set (SCHEDULE_SWAP): true when the record still read as `expected` and the change was made. */
async function swap(
  community: string,
  member: string,
  id: string,
  expected: string,
  next: string,
  due: number | null,
  listed: number | null,
): Promise<boolean> {
  const keys = scheduleKeys(community);
  const [done] = await redisPipeline([
    ["EVAL", SCHEDULE_SWAP, 3, keys.record(id), DUE_KEY, keys.list, expected, next, member, id, due === null ? "" : due, listed === null ? "" : listed],
  ]);
  return done === 1;
}

/** One record as it is now: its raw text, for the compare-and-set, and what it says. */
async function readRaw(community: string, id: string): Promise<{ raw: string | null; post: ScheduledPost | null }> {
  const [raw] = await redisPipeline([["GET", scheduleKeys(community).record(id)]]);
  return typeof raw === "string" ? { raw, post: parseRecord(raw) } : { raw: null, post: null };
}

/**
 * Keeps one to go up at its time. Done ones past their week are cleared
 * first, so they never keep a new one out. Its room is taken next: refused
 * there, nothing is written (DataRoomError). Past the community's cap, its
 * room is given back and the answer is "full".
 */
export async function schedulePost(
  store: Store,
  input: ScheduleInput,
  now = Date.now(),
): Promise<{ ok: true; post: ScheduledPost } | { ok: false; reason: "full" | "off" }> {
  const community = store.community?.id;
  if (!community || !store.sid) return { ok: false, reason: "off" };
  await listScheduled(store, now);
  const at = toSeconds(now);
  const post: ScheduledPost = { ...input, id: randomBytes(6).toString("hex"), made: at, state: "waiting", tries: 0, post: "", mail: "", why: "", at };
  const keys = scheduleKeys(community);
  await needData(store, room(post.id, recordBytes(post)), now);
  // A failure here leaves it unknown whether it was written: its room stays counted, the safe side.
  const [added] = await redisPipeline([
    ["EVAL", SCHEDULE_ADD, 3, keys.list, keys.record(post.id), DUE_KEY, post.id, post.due, dueMember(store.sid, community, post.id), JSON.stringify(post), MAX_SCHEDULED_POSTS],
  ]);
  if (added === 1) return { ok: true, post };
  await giveData(store, room(post.id, 0), now);
  if (added === 0) return { ok: false, reason: "full" };
  throw new Error("a scheduled post could not be written");
}

/**
 * Changes one that is still waiting: its words, its space, its kind and its
 * time. Refused once the job has it ("busy"), once it is done ("done"), and
 * within the lead before its time ("too_close"), when the job may take it any
 * minute: a cancel still works then. One changed between its read and its
 * write is read again and said as it is then: gone, being posted, done, or
 * changed by another edit ("changed").
 */
export async function editScheduled(
  store: Store,
  id: string,
  input: ScheduleInput,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: "gone" | "busy" | "done" | "changed" | "too_close" }> {
  const community = store.community?.id;
  if (!community || !store.sid || !ITEM_ID.test(id)) return { ok: false, reason: "gone" };
  const { raw, post: current } = await readRaw(community, id);
  if (!raw || !current) return { ok: false, reason: "gone" };
  if (current.state === "publishing") return { ok: false, reason: "busy" };
  if (current.state !== "waiting") return { ok: false, reason: "done" };
  if (current.due < toSeconds(now) + MIN_LEAD_SECONDS) return { ok: false, reason: "too_close" };
  const next: ScheduledPost = { ...current, ...input, at: toSeconds(now) };
  await needData(store, room(id, recordBytes(next)), now);
  if (await swap(community, dueMember(store.sid, community, id), id, raw, JSON.stringify(next), next.due, next.due)) return { ok: true };
  // Changed since it was read (the job took it, another edit, or a cancel): read again, and its room is
  // set to what is there now, never to what was read; a record that is gone keeps no room. A read that
  // fails throws and leaves the room taken above, the safe side.
  const again = await readRaw(community, id);
  if (again.raw === null) {
    await giveData(store, room(id, 0), now);
    return { ok: false, reason: "gone" };
  }
  // One that no longer reads as a record keeps the larger of the two sizes counted.
  await giveData(store, room(id, again.post ? recordBytes(again.post) : Math.max(recordBytes(current), recordBytes(next))), now);
  if (!again.post || again.post.state === "publishing") return { ok: false, reason: "busy" };
  return { ok: false, reason: again.post.state === "waiting" ? "changed" : "done" };
}

/**
 * Takes one off: a waiting one, while the job has not taken it, or one the
 * job is done with (posted, failed, not confirmed, or marked by a run long
 * over), cleared from the list. Its record, its places and its room all go.
 */
export async function cancelScheduled(
  store: Store,
  id: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; reason: "gone" | "busy" }> {
  const community = store.community?.id;
  if (!community || !store.sid || !ITEM_ID.test(id)) return { ok: false, reason: "gone" };
  const { raw, post: current } = await readRaw(community, id);
  if (!raw || !current) return { ok: false, reason: "gone" };
  if (current.state === "publishing" && !settled(current, toSeconds(now))) return { ok: false, reason: "busy" };
  if (!(await swap(community, dueMember(store.sid, community, id), id, raw, "", null, null))) {
    // Changed since it was read: gone (another cancel, or the list's clear, gave its room back) is said as gone.
    return { ok: false, reason: (await readRaw(community, id)).raw === null ? "gone" : "busy" };
  }
  await giveData(store, room(id, 0), now);
  return { ok: true };
}

/**
 * The community's scheduled posts, soonest first, for the studio. On the
 * way: done ones past their week are cleared with their room; a place whose
 * record is gone is taken off; a waiting one that is not on the due list
 * (which the scripts never leave behind, but a hand or a restore could) is put
 * back on it, and says it is late.
 *
 * Known limit, not built yet (review of 293 [SQ4]): this is the only clear of
 * done ones past their week, run when the studio's community page is opened
 * or one is scheduled; a community whose studio is not opened keeps them, and
 * their room, until then (bounded by MAX_SCHEDULED_POSTS records).
 */
export async function listScheduled(store: Store, now = Date.now()): Promise<ScheduledPost[]> {
  const community = store.community?.id;
  if (!community || !store.sid) return [];
  const keys = scheduleKeys(community);
  const [ids] = await redisPipeline([["ZRANGEBYSCORE", keys.list, "-inf", "+inf", "LIMIT", 0, MAX_SCHEDULED_POSTS + 5]]);
  const list = Array.isArray(ids) ? ids.filter((one): one is string => typeof one === "string" && ITEM_ID.test(one)) : [];
  if (!list.length) return [];
  const replies = await redisPipeline([
    ["MGET", ...list.map((one) => keys.record(one))],
    ...list.map((one) => ["ZSCORE", DUE_KEY, dueMember(store.sid, community, one)]),
  ]);
  const raws = Array.isArray(replies[0]) ? (replies[0] as unknown[]) : [];
  const at = toSeconds(now);
  const shown: ScheduledPost[] = [];
  for (const [i, one] of list.entries()) {
    const raw = raws[i];
    const post = parseRecord(raw);
    const member = dueMember(store.sid, community, one);
    if (typeof raw !== "string") {
      const [taken] = await redisPipeline([["ZREM", keys.list, one]]);
      if (taken === 1) await giveData(store, room(one, 0), now);
      continue;
    }
    if (!post || post.id !== one) continue;
    if (expired(post, at)) {
      if (await swap(community, member, one, raw, "", null, null)) await giveData(store, room(one, 0), now);
      continue;
    }
    if (post.state === "waiting" && replies[i + 1] === null) await swap(community, member, one, raw, raw, post.due, post.due);
    shown.push(post);
  }
  return shown;
}

export type RunCounts = { posted: number; failed: number; unknown: number; later: number };

/**
 * The five-minute job's part: puts up what is due, at most RUN_BATCH a run.
 * It takes one only with PUBLISH_MIN_MS left before `deadline`
 * (milliseconds), and each post's own work is cut off at `deadline`. `now`
 * is the job's clock.
 *
 * Known limit, not built yet (review of 293 [SQ4]): PUBLISH_MIN_MS is checked
 * before a post is taken, not before its announcement email is asked for. A
 * post put up close to `deadline` can have queueAnnouncement given up by the
 * cutoff: the post stands, its record says mail "error", and the email is not
 * asked for again (no new read is spent to retry it).
 */
export async function runScheduledPosts(deadline: number, now = Date.now()): Promise<RunCounts> {
  const counts: RunCounts = { posted: 0, failed: 0, unknown: 0, later: 0 };
  const at = toSeconds(now);
  if (Date.now() + PUBLISH_MIN_MS > deadline) return counts;
  const [due] = await redisPipeline([["ZRANGEBYSCORE", DUE_KEY, "-inf", at, "LIMIT", 0, RUN_BATCH]]);
  const members = Array.isArray(due) ? due.filter((one): one is string => typeof one === "string") : [];
  for (const member of members) {
    if (Date.now() + PUBLISH_MIN_MS > deadline) break;
    const where = readMember(member);
    if (!where) {
      await redisPipeline([["ZREM", DUE_KEY, member]]);
      continue;
    }
    const keys = scheduleKeys(where.community);
    const { raw, post } = await readRaw(where.community, where.id);
    if (raw !== null && !post) {
      // A record that does not read as one is never posted, and never becomes one.
      await redisPipeline([["ZREM", DUE_KEY, member]]);
      continue;
    }
    if (post && post.state !== "waiting") {
      // Done with: its place on the due list only, while it reads the same.
      await swap(where.community, member, where.id, raw!, raw!, null, post.due);
      continue;
    }
    const marked: ScheduledPost | null = post ? { ...post, state: "publishing", tries: post.tries + 1, at } : null;
    const [held] = await redisPipeline([["EVAL", SCHEDULE_CLAIM, 2, DUE_KEY, keys.record(where.id), member, at, raw ?? "", marked ? JSON.stringify(marked) : ""]]);
    if (held !== 1 || !marked) continue;
    const outcome = await withCutoff(deadline, () => publish(where.store, where.community, marked)).catch((error: unknown): Outcome => {
      console.error("posting a scheduled community post failed", error);
      return { kind: "unknown" };
    });
    let next: ScheduledPost;
    if (outcome.kind === "posted") {
      next = { ...marked, state: "posted", post: outcome.post, mail: outcome.mail, at };
      counts.posted += 1;
    } else if (outcome.kind === "unknown") {
      next = { ...marked, state: "unknown", at };
      counts.unknown += 1;
    } else if (outcome.kind === "later" && marked.tries < PUBLISH_TRIES) {
      next = { ...marked, state: "waiting", at };
      counts.later += 1;
    } else {
      next = { ...marked, state: "failed", why: outcome.kind === "later" ? "error" : outcome.why, at };
      counts.failed += 1;
    }
    await swap(where.community, member, where.id, JSON.stringify(marked), JSON.stringify(next), next.state === "waiting" ? at + RETRY_SECONDS : null, marked.due);
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
