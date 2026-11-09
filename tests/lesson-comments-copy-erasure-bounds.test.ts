/**
 * Pre-review of claude5/lesson-comments-copy-whole (Claude 5, 9 November 2026), the findings held here:
 *
 *   1. GRAVE: the copy of what a store keeps about a person (lib/person-copy.ts) paid its read of a student's lesson
 *      comments from the creator's studio figure. A store whose figure was small or used up could never give the copy
 *      (a right of access, GDPR art. 15), and the refusal said "This opens again on December 1" (VR rule 2). The copy
 *      takes nothing from the studio figure; its read is bounded by what the store's data room can hold, never by an
 *      answer from Redis.
 *   2. HIGH, older: the erasure counts a fixed 70 KB a course (lib/erasure-rules.ts), but FORGET_LESSON_COMMENTS
 *      answered with the text of every comment it deleted. It answers counts and bytes, never words.
 *   3. MEDIUM: both scripts decoded a course's whole record of comments (HGETALL) in one call, whatever its size. They
 *      walk it in HSCAN pages, so each call's work and time have a ceiling, and the erasure counts its pages.
 *   4. LOW: copyReadWork counts the EVAL and the HSCAN it runs, both billed (docs/backup.md); and the name a student
 *      chose, which the erasure deletes (lib/person-data.ts), is in the copy even without a comment.
 */
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { COPIERS } from "@/lib/person-copy";
import { emailKey } from "@/lib/learn";
import { FORGET_LESSON_COMMENTS, LESSON_COMMENTS_OF, copyReadWork, forgetLessonCommentsPerson, lessonComments } from "@/lib/lesson-comments";
import { serializeComment, type LessonComment } from "@/lib/lesson-comments-rules";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { erasureWork, type ErasureScope } from "@/lib/erasure-rules";
import { erasureSize } from "@/lib/person-erasure";
import { dataUsed, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "bounds@example.com";
const COURSE = "e".repeat(32);
const L1 = "lessonone001";
const L2 = "lessontwo002";
const ana = emailKey("ana@example.com");
const ben = emailKey("ben@example.com");
const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(12 - prefix.length, "0")}`;
const SCRIPTS = ["-- marktmorgen:lesson-comments-of:", "-- marktmorgen:lesson-comments-forget:"];

/** Writes comments as addComment keeps them (lib/lesson-comments.ts): the record, the lesson's list and the newest. */
function keep(comments: LessonComment[]): void {
  for (const c of comments) {
    redis.run(["HSET", `nl:lc:${COURSE}:c`, c.id, serializeComment(c)]);
    redis.run(["ZADD", `nl:lc:${COURSE}:l:${c.lesson}`, c.at, c.id]);
    redis.run(["ZADD", `nl:lc:${COURSE}:all`, c.at, c.id]);
    if (c.parent) redis.run(["HINCRBY", `nl:lc:${COURSE}:r`, c.parent, 1]);
  }
}

const comment = (c: Partial<LessonComment> & Pick<LessonComment, "id" | "by" | "at">): LessonComment => ({
  lesson: L1, name: c.by === ana ? "Ana" : "Ben", text: `Words ${c.id}`, parent: null, hidden: false, ...c,
});

async function failed(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Every pipeline sent while `run` runs: its commands, the bytes sent and answered, and the comment scripts' answers. */
async function measured<T>(run: () => Promise<T>): Promise<{ value: T; commands: number; bytes: number; evals: number; answers: unknown[] }> {
  const pipeline = redis.pipeline;
  const seen = { commands: 0, bytes: 0, evals: 0, answers: [] as unknown[] };
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const reply = await pipeline.call(redis, commands);
    seen.commands += commands.length;
    seen.bytes += JSON.stringify(commands).length + JSON.stringify(reply).length;
    commands.forEach((c, k) => {
      if (c[0] === "EVAL" && SCRIPTS.some((s) => String(c[1]).startsWith(s))) {
        seen.evals += 1;
        seen.answers.push((reply as unknown[])[k]);
      }
    });
    return reply;
  }) as typeof redis.pipeline;
  try {
    return { value: await run(), ...seen };
  } finally {
    redis.pipeline = pipeline;
  }
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "boundsstore", "Bounds", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const now = Math.floor(Date.now() / 1000);
  // A plan that ended: the store still keeps the student's comments, and its studio figure is the smallest.
  await setSubscription(OWNER, { customerId: "cus_Bounds0001", subscriptionId: "sub_Bounds0001", active: false, tier: "pro", period: { start: now - 60 * 86_400, end: now - 30 * 86_400, renews: false } });
  const store = (await storeForEmail(OWNER))!;
  const scope = {
    store, sid: store.sid, statsId: store.statsId, listId: store.listId, email: "ana@example.com", person: "", learner: ana,
    courses: [{ productId: "prodcourse01", courseId: COURSE, lessonIds: [L1, L2], moduleIds: [] }], productIds: ["prodcourse01"], communityId: null,
  } as unknown as ErasureScope;
  const copy = COPIERS["lib/lesson-comments.ts"];

  part("1. The copy is never held by the studio figure: a store whose figure is used up still gives it, whole");
  const mine: LessonComment[] = [];
  for (let k = 0; k < 60; k += 1) mine.push(comment({ id: id("an", k), by: ana, at: now - 100_000 + k, text: `${k} ${"x".repeat(1_990)}` }));
  keep(mine);
  const left = allowanceFor(store, "studio") - (await allowanceUsed(store, "studio"));
  if (left > 0) await takeAllowance(store, "studio", left);
  const usedBefore = await allowanceUsed(store, "studio");
  let rows: unknown[] = [];
  const error = await failed(async () => { rows = await copy(scope); });
  is("the copy is made, with no refusal", error, "");
  is("every one of her 60 comments is in it", rows.filter((r) => typeof (r as { text?: unknown }).text === "string").length, 60);
  is("and nothing was taken from the studio figure", await allowanceUsed(store, "studio"), usedBefore);

  part("2. What a read of the copy is counted at: the EVAL and the HSCAN it runs, both billed");
  is("copyReadWork counts at least the two billed commands", copyReadWork(COURSE, ana).commands >= 2, true);

  part("3. The erasure's answers carry counts, never the words it deletes, and its bytes are within what it counts");
  const size = await erasureSize(scope);
  const { products: _p, deals: _d, conversations: _c, dmConversations: _m, roomMessages: _r, events: _e, certificates: _t, ...courseParts } = size;
  const counted = erasureWork(courseParts);
  const base = erasureWork({});
  const share = { commands: counted.commands - base.commands, bytes: counted.bytes - base.bytes };
  const forget = await measured(() => forgetLessonCommentsPerson(COURSE, [L1, L2], ana));
  is("all 60 go", forget.value, 60);
  is("no answer of the erasure carries her words", forget.answers.some((a) => JSON.stringify(a).includes("x".repeat(100))), false);
  is(`its bytes (${forget.bytes}) are within the course's share of the erasure (${share.bytes})`, forget.bytes <= share.bytes, true);
  is(`its commands (${forget.commands}) too (${share.commands})`, forget.commands <= share.commands, true);

  part("4. The name a student chose is in the copy, also without any comment, because the erasure deletes it");
  redis.clear();
  redis.run(["HSET", `nl:lc:${COURSE}:names`, ana, "Ana Lopes"]);
  const named = await copy(scope);
  is("her chosen name is there", JSON.stringify(named).includes("Ana Lopes"), true);

  part("5. Neither script decodes a course's whole record in one call");
  for (const [name, script] of [["the copy's read", LESSON_COMMENTS_OF], ["the erasure", FORGET_LESSON_COMMENTS]] as const) {
    const calls = [...script.matchAll(/redis\.call\("([A-Z]+)"/g)].map((m) => m[1]);
    is(`${name} walks by HSCAN, never HGETALL`, [calls.includes("HSCAN"), calls.includes("HGETALL")], [true, false]);
  }

  part("6. A course past one page: the copy and the erasure walk every page, and a thread split across pages goes whole");
  redis.clear();
  // Ana's thread first in the record's order, Ben's 500 comments after it, and Ben's answers under her thread last:
  // her thread is read in an earlier page than the answers under it.
  const top = comment({ id: id("a", 1), by: ana, at: now - 9_000, text: "My question" });
  const bens: LessonComment[] = [];
  for (let k = 0; k < 500; k += 1) bens.push(comment({ id: id("m", k), by: ben, at: now - 8_000 + k, lesson: k % 2 ? L1 : L2 }));
  const answers = [0, 1, 2].map((k) => comment({ id: id("z", k), by: ben, at: now - 1_000 + k, parent: top.id, text: `Answer ${k}` }));
  const herAnswer = comment({ id: id("y", 1), by: ana, at: now - 500, parent: bens[3].id, lesson: bens[3].lesson, text: "My answer to Ben" });
  const all = [top, ...bens, ...answers, herAnswer];
  keep(all);
  const room = store;
  await needData(room, all.map((c) => ({ slot: `lc:${COURSE}`, bytes: dataBytes([serializeComment(c)], 4) })));
  await needData(room, [{ slot: `lc:${COURSE}`, bytes: dataBytes([ana, "Ana"], 1) }]);
  redis.run(["HSET", `nl:lc:${COURSE}:names`, ana, "Ana"]);
  const benRoom = bens.reduce((s, c) => s + dataBytes([serializeComment(c)], 4), 0);
  const copied = await measured(() => copy(scope));
  is("the copy read more than one page", copied.evals > 1, true);
  is("and has her two comments", (copied.value as { text?: string }[]).filter((r) => r.text).map((r) => r.text).sort(), ["My answer to Ben", "My question"]);
  const erased = await measured(() => forgetLessonCommentsPerson(COURSE, [L1, L2], ana, room));
  is("the erasure walked more than one page", erased.evals > 1, true);
  is("her two and the three answers under her thread go", erased.value, 5);
  const [kept, newest, count, name] = await redis.pipeline([
    ["HLEN", `nl:lc:${COURSE}:c`], ["ZCARD", `nl:lc:${COURSE}:all`], ["HGET", `nl:lc:${COURSE}:r`, top.id], ["HGET", `nl:lc:${COURSE}:names`, ana],
  ]);
  is("only Ben's 500 are kept, nothing orphaned, no count for her thread, no name", [kept, newest, count, name], [500, 500, null, null]);
  is("Ben's comment she answered counts no answer", (await redis.pipeline([["HGET", `nl:lc:${COURSE}:r`, bens[3].id]]))[0], "0");
  is("the lessons list only Ben's", (await lessonComments(COURSE, L1)).length + (await lessonComments(COURSE, L2)).length, 500);
  is("the room keeps exactly Ben's", (await dataUsed(room))?.used, benRoom);
  done();
}

void main();
