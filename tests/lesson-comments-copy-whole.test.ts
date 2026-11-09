/**
 * R19 MEDIUM 3 (Claude 6's audit, 9 November 2026): the copy of what a store
 * keeps about one person (lib/person-copy.ts) read a student's lesson
 * comments through lessonComments, which reads only a lesson's newest
 * LESSON_KEPT (2,000) entries. A lesson keeps up to 2,000 threads and 50
 * answers under each (the answers are not held by the 2,000), so a student's
 * older comments and answers fell out of the copy, and the copy came out
 * incomplete without a word. The erasure (FORGET_LESSON_COMMENTS) finds them
 * all, in the course's whole comment record.
 *
 * Held here: the copy finds every comment the student wrote in the course,
 * where the erasure finds them, whatever their age or lesson; a record it
 * cannot read, or a read too large for what it paid, fails the copy, never
 * leaves a part out in silence; and (since the pre-review of 9 November
 * 2026, tests/lesson-comments-copy-erasure-bounds.test.ts) the read takes
 * nothing from the store's studio figure, a right of access never held by a
 * store's month of requests, and walks the record in bounded steps.
 */
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { COPIERS } from "@/lib/person-copy";
import { emailKey } from "@/lib/learn";
import { COMMENT_SCAN_COUNT, LESSON_COMMENTS_OF, forgetLessonCommentsPerson } from "@/lib/lesson-comments";
import { MAX_LESSON_THREADS, MAX_REPLIES, serializeComment, type LessonComment } from "@/lib/lesson-comments-rules";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import type { ErasureScope } from "@/lib/erasure-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const OWNER = "copywhole@example.com";
const COURSE = "f".repeat(32);
const L1 = "lessonone001";
const L2 = "lessontwo002";
/** A lesson the course no longer lists, whose comments the erasure still finds in the course's record. */
const GONE = "lessongone03";
const ana = emailKey("ana@example.com");
const ben = emailKey("ben@example.com");

const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(12 - prefix.length, "0")}`;

/** Every command sent, in order, for the order of the charge and the read. */
const log: string[] = [];
const run = redis.run.bind(redis);
redis.run = (command: (string | number)[]) => {
  const verb = String(command[0]).toUpperCase();
  log.push(verb === "EVAL" ? `EVAL ${String(command[1]).split("\n")[0]}` : `${verb} ${String(command[1] ?? "")}`);
  return run(command);
};

/** Writes comments as addComment keeps them (lib/lesson-comments.ts): the record, the lesson's list and the newest. */
async function keep(comments: LessonComment[]): Promise<void> {
  for (const c of comments) {
    redis.run(["HSET", `nl:lc:${COURSE}:c`, c.id, serializeComment(c)]);
    redis.run(["ZADD", `nl:lc:${COURSE}:l:${c.lesson}`, c.at, c.id]);
    redis.run(["ZADD", `nl:lc:${COURSE}:all`, c.at, c.id]);
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

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "copywhole", "Copy Whole", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const now = Math.floor(Date.now() / 1000);
  await setSubscription(OWNER, { customerId: "cus_CopyWhole01", subscriptionId: "sub_CopyWhole01", active: true, tier: "pro", period: { start: now - 10 * 86_400, end: now + 20 * 86_400, renews: true } });
  const store = (await storeForEmail(OWNER))!;
  const scope = {
    store, sid: store.sid, statsId: store.statsId, listId: store.listId, email: "ana@example.com", person: "", learner: ana,
    courses: [{ productId: "prodcourse01", courseId: COURSE, lessonIds: [L1, L2], moduleIds: [] }], productIds: ["prodcourse01"], communityId: null,
  } as unknown as ErasureScope;
  const copy = COPIERS["lib/lesson-comments.ts"];
  const texts = async () => ((await copy(scope)) as { text: string }[]).map((r) => r.text).sort();

  part("A lesson past the newest 2,000 entries: Ana's older words are still in her copy");
  const base = now - 400 * 86_400;
  // Ana's first thread and an answer of hers under Ben's first thread, both the oldest of the lesson.
  const anaFirst = comment({ id: id("ana", 1), by: ana, at: base, text: "My first question, long ago." });
  const benFirst = comment({ id: id("ben", 0), by: ben, at: base + 1 });
  const anaAnswer = comment({ id: id("ana", 2), by: ana, at: base + 2, parent: benFirst.id, text: "My old answer to Ben." });
  // Then 41 of Ben's threads with 50 answers each from Ben: 2,091 newer entries, every one allowed by the caps.
  const newer: LessonComment[] = [];
  for (let t = 1; t <= 41; t += 1) {
    const top = comment({ id: id("bt", t), by: ben, at: base + 10 + t * 100 });
    newer.push(top);
    for (let r = 0; r < MAX_REPLIES; r += 1) newer.push(comment({ id: id(`b${String(t).padStart(2, "0")}r`, r), by: ben, at: top.at + 1 + r, parent: top.id }));
  }
  const anaNew = comment({ id: id("ana", 3), by: ana, at: base + 10_000, lesson: L2, text: "A newer one, on lesson two." });
  const anaGone = comment({ id: id("ana", 4), by: ana, at: base + 20_000, lesson: GONE, text: "Under a lesson the course no longer lists." });
  await keep([anaFirst, benFirst, anaAnswer, ...newer, anaNew, anaGone]);
  is("the lesson holds more than the 2,000 newest the lesson page reads", newer.length + 3 > MAX_LESSON_THREADS * 4, true);
  is("every one of Ana's comments is in her copy: the old thread, the old answer, the newer one and the one under a lesson since removed",
    await texts(), [anaFirst.text, anaAnswer.text, anaNew.text, anaGone.text].sort());
  is("only her own: none of Ben's words", (await copy(scope)).some((r) => JSON.stringify(r).includes(ben) || JSON.stringify(r).includes("Words b")), false);

  part("The copy has what the erasure deletes of hers");
  is("her four, each with its lesson and when", ((await copy(scope)) as { lesson: string; at: string }[]).map((r) => [r.lesson, r.at]).sort(),
    [anaFirst, anaAnswer, anaNew, anaGone].map((c) => [c.lesson, new Date(c.at * 1000).toISOString()]).sort());

  // Rule 23 (pre-review of 9 November 2026, finding 1, GRAVE): the copy no longer takes its read from the studio
  // figure, which held a right of access hostage to a store's month of requests; it was "the figure is taken, before
  // the read". Now nothing is taken, and the read is in steps of COMMENT_SCAN_COUNT fields (finding 3).
  part("The read takes nothing from the studio figure, and walks the record in steps");
  log.length = 0;
  const before = await allowanceUsed(store, "studio");
  await copy(scope);
  is("nothing is taken from the figure", (await allowanceUsed(store, "studio")) - before, 0);
  const steps = log.filter((l) => l.startsWith("EVAL -- marktmorgen:lesson-comments-of:")).length;
  is("one step for each COMMENT_SCAN_COUNT fields of the record, at the least", steps >= Math.ceil((newer.length + 5) / COMMENT_SCAN_COUNT), true);
  is("each step answers only hers, never the whole lesson", log.filter((l) => /^(HMGET|HGETALL|ZRANGE|ZREVRANGE|HSCAN) /.test(l)).length, 0);

  // Rule 23 (same pre-review, finding 1): "two reads, each paid before it is sent, what was taken covers the bytes"
  // held the studio figure's charge; the copy is now whole however long hers are, at no charge to the figure.
  part("Many long comments of hers: still whole, nothing taken from the figure");
  const many: LessonComment[] = [];
  for (let n = 0; n < 40; n += 1) many.push(comment({ id: id("anl", n), by: ana, at: base + 30_000 + n, text: `${n} ${"x".repeat(1_990)}` }));
  await keep(many);
  const beforeMany = await allowanceUsed(store, "studio");
  const all = await copy(scope);
  is("all of them, with the four before", all.filter((r) => typeof (r as { text?: unknown }).text === "string").length, 44);
  is("nothing taken from the figure", (await allowanceUsed(store, "studio")) - beforeMany, 0);

  // Rule 23 (same pre-review, finding 3): the script read the whole record with HGETALL; it walks it with HSCAN.
  part("The read changes nothing");
  const calls = [...LESSON_COMMENTS_OF.matchAll(/redis\.call\("([A-Z]+)"/g)].map((m) => m[1]);
  is("its script only reads the course's record, a step at a time", calls, ["HSCAN"]);

  part("A comment record that does not read fails the copy, never leaves it out in silence");
  redis.run(["HSET", `nl:lc:${COURSE}:c`, id("bad", 1), "{not json"]);
  is("the copy fails and says so", (await failed(() => copy(scope))) !== "", true);
  redis.run(["HDEL", `nl:lc:${COURSE}:c`, id("bad", 1)]);
  is("and reads again once it is gone", (await copy(scope)).length, 44);

  // Rule 23 (same pre-review, finding 1, GRAVE): it was "refused, and nothing is read", which left a store whose
  // figure was used unable to give the copy, saying "This opens again on December 1" (VR rule 2). Now it is given.
  part("A store whose studio figure is used: the copy is still given, whole");
  const used = allowanceFor(store, "studio") - (await allowanceUsed(store, "studio"));
  if (used > 0) await takeAllowance(store, "studio", used);
  is("the copy is made", (await failed(() => copy(scope))), "");
  is("whole", (await copy(scope)).filter((r) => typeof (r as { text?: unknown }).text === "string").length, 44);

  part("The erasure still finds every one of them");
  is("Ana's 44 go, with Ben's answers under her thread (none)", await forgetLessonCommentsPerson(COURSE, [L1, L2], ana), 44);
  done();
}

void main();
