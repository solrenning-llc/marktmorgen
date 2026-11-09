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
 *
 * Rule 24 and the final pre-review of the branch (Claude 5, 9 November 2026):
 *
 *   5. MEDIUM, older: the commands FORGET_LESSON_COMMENTS runs for each comment it deletes (HDEL, ZREM, HINCRBY...)
 *      were counted nowhere, and nothing bounded how many it could delete. They are counted in the erasure's size
 *      (commentTakes), the script deletes no more than it is given, and it runs at most four for each.
 *   6. MEDIUM: the erasure was charged for the pages of the course's record as it was counted (erasureSize), then
 *      counted it again before it walked and walked as far as the new count allowed. It walks no further, and deletes
 *      no more, than what was charged; past it the walk stops and says so.
 *   7. LOW: a step's HMGET were counted twice a step whatever HSCAN answered; a step of more than 1,000 fields is
 *      refused before anything changes, so they are.
 */
import { claimHandle, ensureListId, ensureStatsId, setSubscription, storeForEmail } from "@/lib/store";
import { COPIERS } from "@/lib/person-copy";
import { emailKey } from "@/lib/learn";
import { FORGET_LESSON_COMMENTS, FORGET_PASSES, LESSON_COMMENTS_OF, copyReadWork, forgetLessonCommentsPerson, forgetPageWork, lessonComments } from "@/lib/lesson-comments";
import { serializeComment, type LessonComment } from "@/lib/lesson-comments-rules";
import { allowanceFor } from "@/lib/store-allowance-rules";
import { allowanceUsed, takeAllowance } from "@/lib/store-allowance";
import { ERASE_PER, erasureWork, type ErasureScope, type ErasureSize } from "@/lib/erasure-rules";
import { ERASERS, erasureSize } from "@/lib/person-erasure";
import { dataUsed, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NOT_A_COST } from "./plan-cost-registry";
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

/**
 * What `run` sends and what the erasure's script runs inside: each pipeline's commands, and, inside every step of
 * FORGET_LESSON_COMMENTS, its HSCAN (scanStep, not a command of the stand-in) and every command it runs, which
 * Upstash bills one by one (docs/backup.md).
 */
async function everyCommand<T>(run: () => Promise<T>): Promise<{ value: T | undefined; error: string; outside: number; inside: number; steps: number }> {
  const own = redis.run;
  const seen = { outside: 0, inside: 0, steps: 0 };
  let depth = 0;
  redis.run = function (this: typeof redis, command: (string | number)[]) {
    const step = command[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:lesson-comments-forget:");
    if (depth > 0) seen.inside += 1;
    else seen.outside += 1;
    if (step) {
      seen.steps += 1;
      seen.inside += 1;
      depth += 1;
    }
    try {
      return own.call(this, command);
    } finally {
      if (step) depth -= 1;
    }
  } as typeof redis.run;
  try {
    let value: T | undefined;
    const error = await failed(async () => { value = await run(); });
    return { value, error, ...seen };
  } finally {
    redis.run = own;
  }
}

/** The commands an erasure of this size counts for its courses, past what every erasure counts. */
function courseCommands(size: ErasureSize): number {
  const { products: _p, deals: _d, conversations: _c, dmConversations: _m, roomMessages: _r, events: _e, certificates: _t, ...courseParts } = size;
  return erasureWork(courseParts).commands - erasureWork({}).commands;
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
  // Rule 23: the RED commit expected Ben's comments alone; the room also counts its own field for the slot, 64 bytes
  // while it holds anything (lib/store-data.ts, TAKE_DATA), which stays with Ben's comments.
  is("the room keeps exactly Ben's, with the slot's own field", (await dataUsed(room))?.used, benRoom + 64);

  part("7. What the erasure counts for a step covers what a step moves, every pass");
  for (const lessons of [[], [L1], [L1, L2], Array.from({ length: 300 }, (_, k) => id("lesson", k))]) {
    const step = forgetPageWork(COURSE, lessons, ana);
    const counted = erasureWork({ commentPages: 1, commentPageLessons: lessons.length });
    const base = erasureWork({});
    is(`a step over ${lessons.length} lessons: ${FORGET_PASSES} × ${step.commands} commands and ${step.bytes} bytes counted`,
      [counted.commands - base.commands >= FORGET_PASSES * step.commands, counted.bytes - base.bytes >= FORGET_PASSES * step.bytes], [true, true]);
  }
  is("a step's lessons are counted by the step", ERASE_PER.commentPageLessons[1] > 0, true);

  part("8. The copy has no budget of its own yet: the pending is written, and no door gives it");
  is("the cost registry names what it needs", typeof NOT_A_COST.PERSON_COPY_BUDGET === "string" && NOT_A_COST.PERSON_COPY_BUDGET.startsWith("PENDING"), true);
  const callers: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && path !== join("lib", "person-copy.ts") && /\bcopyPerson\(/.test(readFileSync(path, "utf8"))) callers.push(path);
    }
  };
  for (const dir of ["app", "lib", "components"]) walk(dir);
  is("nothing outside lib/person-copy.ts calls copyPerson", callers, []);

  const freshScope = () => ({ ...scope, courses: scope.courses.map((c) => ({ ...c })) }) as ErasureScope;
  const eraser = ERASERS.find((e) => e.module === "lib/lesson-comments.ts")!;

  part("9. Every command the erasure runs, a script's inside too, is within what it counts (rule 24)");
  redis.clear();
  // Ana's 40 threads with two answers of Ben under each, and Ben's 30 threads with an answer of Ana under each.
  const many: LessonComment[] = [];
  for (let k = 0; k < 40; k += 1) {
    const thread = comment({ id: id("at", k), by: ana, at: now - 50_000 + k });
    many.push(thread, comment({ id: id("ba", k), by: ben, at: now - 40_000 + k, parent: thread.id }), comment({ id: id("bb", k), by: ben, at: now - 30_000 + k, parent: thread.id }));
  }
  for (let k = 0; k < 30; k += 1) {
    const thread = comment({ id: id("bt", k), by: ben, at: now - 20_000 + k, lesson: L2 });
    many.push(thread, comment({ id: id("aa", k), by: ana, at: now - 10_000 + k, parent: thread.id, lesson: L2 }));
  }
  keep(many);
  const scope9 = freshScope();
  const counted9 = courseCommands(await erasureSize(scope9));
  const ran9 = await everyCommand(() => eraser.run(scope9, [], new Set()));
  is("it finishes", ran9.error, "");
  is("her 70 and the 80 answers under her threads go", ran9.value, 150);
  is("only Ben's 30 threads are kept", (await redis.pipeline([["HLEN", `nl:lc:${COURSE}:c`]]))[0], 30);
  is(`every command it runs (${ran9.outside} sent and ${ran9.inside} inside its ${ran9.steps} steps) is within what it counts (${counted9})`,
    ran9.outside + ran9.inside <= counted9, true);

  part("10. Comments written after the erasure was counted: it walks no further, and deletes no more, than it was charged for");
  redis.clear();
  keep(mine);
  const scope10 = freshScope();
  const counted10 = courseCommands(await erasureSize(scope10));
  const later: LessonComment[] = [];
  for (let k = 0; k < 3_000; k += 1) later.push(comment({ id: id("n", k), by: ben, at: now - 5_000 + k }));
  keep(later);
  const ran10 = await everyCommand(() => eraser.run(scope10, [], new Set()));
  is("the walk stops where it was counted and says so, never walks on unpaid", ran10.error !== "", true);
  is(`what it ran (${ran10.outside} sent and ${ran10.inside} inside) is within what was counted (${counted10})`,
    ran10.outside + ran10.inside <= counted10, true);

  // FORGET_LESSON_COMMENTS's own arguments, as forgetLessonCommentsPerson sends them: KEYS the comments, the newest,
  // the answer counts, each lesson's comments; ARGV the student, the cursor, the COUNT, the mode, ENTRY_BYTES,
  // DATA_STEP_BYTES, the most it may delete, then each lesson's id.
  const step = (count: number, most: number, mode = "all") => ["EVAL", FORGET_LESSON_COMMENTS, 4, `nl:lc:${COURSE}:c`, `nl:lc:${COURSE}:all`, `nl:lc:${COURSE}:r`, `nl:lc:${COURSE}:l:${L1}`, ana, "0", count, mode, 128, 16, most, L1];

  part("11. A step that would delete more than it was given deletes nothing");
  redis.clear();
  keep([0, 1, 2].map((k) => comment({ id: id("as", k), by: ana, at: now - 100 + k })));
  keep([0, 1].map((k) => comment({ id: id("bs", k), by: ben, at: now - 50 + k })));
  is("given two for her three, it is refused", (await redis.pipeline([step(200, 2)]))[0], ["x"]);
  is("and all five are kept", (await redis.pipeline([["HLEN", `nl:lc:${COURSE}:c`]]))[0], 5);
  const given3 = (await redis.pipeline([step(200, 3)]))[0] as unknown[];
  is("given three, her three go", [given3[0], given3[1], given3[3]], ["0", 3, 0]);

  part("12. A step HSCAN answers with more than 1,000 fields is refused before anything changes");
  redis.clear();
  const crowd: LessonComment[] = [];
  for (let k = 0; k < 1_200; k += 1) crowd.push(comment({ id: id("c", k), by: ben, at: now - 9_000 + k }));
  keep([comment({ id: id("a", 7), by: ana, at: now - 10_000 }), ...crowd]);
  is("a step of 1,201 fields is refused", (await redis.pipeline([step(1_500, 10)]))[0], ["x"]);
  is("and nothing went", (await redis.pipeline([["HLEN", `nl:lc:${COURSE}:c`]]))[0], 1_201);
  done();
}

void main();
