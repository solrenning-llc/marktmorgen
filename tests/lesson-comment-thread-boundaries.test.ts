/** Regression proof for atomic lesson-thread deletion and storage accounting. */
import assert from "node:assert/strict";
import test from "node:test";
import { addComment, deleteComment, readComment } from "@/lib/lesson-comments";
import { CREATOR_AUTHOR, MAX_LESSON_THREADS, serializeComment } from "@/lib/lesson-comments-rules";
import { COURSE_ID_PATTERN } from "@/lib/course";
import { dataKey } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const course = "e".repeat(32), lesson = "lessonone001", hash = `nl:lc:${course}:c`, slot = `lc:${course}`;

async function seed() {
  redis.clear();
  assert.match(course, COURSE_ID_PATTERN);
  const p = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by: CREATOR_AUTHOR, text: "Parent to remove", now: 100 });
  assert.ok(p.ok);
  const r = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by: CREATOR_AUTHOR, text: "Answer to remove", parent: p.comment.id, now: 101 });
  assert.ok(r.ok);
  return { parent: p.comment, reply: r.comment };
}

const held = () => Number(redis.run(["HGET", dataKey(ROOM)!, slot]) ?? 0);
const deleting = (commands: (string | number)[][]) => commands.length === 1 && commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).startsWith("-- marktmorgen:lesson-comment-thread-delete:v1\n");
async function attempt(id: string) {
  let count: number | null = null, unknown = false;
  try { count = await deleteComment(course, id, ROOM); } catch { unknown = true; }
  return { count, unknown };
}

test("confirmed whole-thread deletion removes both records and releases their room once", async () => {
  const s = await seed();
  assert.ok(held() > 0);
  assert.equal(await deleteComment(course, s.parent.id, ROOM), 2);
  assert.equal(await readComment(course, s.parent.id), null);
  assert.equal(await readComment(course, s.reply.id), null);
  assert.equal(held(), 0);
  assert.equal(await deleteComment(course, s.parent.id, ROOM), 0);
});

for (const receipt of [[], [0]]) test(`unconfirmed unapplied delete cannot certify removal or release room ${JSON.stringify(receipt)}`, async () => {
  const s = await seed(), before = held(), original = redis.pipeline.bind(redis);
  let intercepted = 0;
  redis.pipeline = async commands => {
    if (deleting(commands)) { intercepted++; return receipt as never; }
    return original(commands);
  };
  let result;
  try { result = await attempt(s.parent.id); } finally { redis.pipeline = original; }
  assert.equal(intercepted, 1);
  assert.ok(await readComment(course, s.parent.id));
  assert.ok(await readComment(course, s.reply.id));
  assert.deepEqual({ confirmed: !result.unknown, returned: result.count, held: held() }, { confirmed: false, returned: null, held: before });
});

test("an applied deletion with a lost receipt is retained as unknown and never releases room twice", async () => {
  const s = await seed(), before = held(), original = redis.pipeline.bind(redis);
  let intercepted = 0;
  redis.pipeline = async commands => {
    if (deleting(commands)) {
      intercepted++;
      await original(commands);
      return [] as never;
    }
    return original(commands);
  };
  let result;
  try { result = await attempt(s.parent.id); } finally { redis.pipeline = original; }
  assert.equal(intercepted, 1);
  assert.deepEqual(result, { count: null, unknown: true });
  assert.equal(await readComment(course, s.parent.id), null);
  assert.equal(await readComment(course, s.reply.id), null);
  assert.equal(held(), before, "unconfirmed release stays reserved");
  assert.equal(await deleteComment(course, s.parent.id, ROOM), 0);
  assert.equal(held(), before, "retry cannot release the same bytes");
});

test("malformed stored parent reference cannot be normalized into a complete deletable thread", async () => {
  const s = await seed(), before = held(), raw = JSON.parse(String(redis.run(["HGET", hash, s.reply.id])));
  raw.r = { unknown: true };
  redis.run(["HSET", hash, s.reply.id, JSON.stringify(raw)]);
  const result = await attempt(s.parent.id);
  assert.deepEqual({ unknown: result.unknown, returned: result.count, parent: redis.run(["HEXISTS", hash, s.parent.id]), reply: redis.run(["HEXISTS", hash, s.reply.id]), held: held() }, { unknown: true, returned: null, parent: 1, reply: 1, held: before });
});

test("reply accepted after the deletion snapshot cannot survive as an orphan after confirmed success", async () => {
  const s = await seed(), original = redis.pipeline.bind(redis);
  let successor = "", injected = false;
  redis.pipeline = async commands => {
    if (!injected && deleting(commands)) {
      injected = true;
      const r = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by: CREATOR_AUTHOR, text: "Concurrent confirmed answer", parent: s.parent.id, now: 102 });
      assert.ok(r.ok);
      successor = r.comment.id;
    }
    return original(commands);
  };
  let result;
  try { result = await attempt(s.parent.id); } finally { redis.pipeline = original; }
  assert.ok(successor);
  const parent = await readComment(course, s.parent.id), reply = await readComment(course, successor);
  assert.equal(!result.unknown && parent === null && reply !== null, false, JSON.stringify({ result, parent, reply }));
});

test("two deletions with the same snapshot cannot release room belonging to an unrelated thread", async () => {
  const s = await seed();
  const other = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by: CREATOR_AUTHOR, text: "Unrelated kept thread", now: 102 });
  assert.ok(other.ok);
  const original = redis.pipeline.bind(redis);
  let nested = false, afterFirst = -1;
  redis.pipeline = async commands => {
    if (!nested && deleting(commands)) {
      nested = true;
      assert.equal(await deleteComment(course, s.parent.id, ROOM), 2);
      afterFirst = held();
    }
    return original(commands);
  };
  try { await attempt(s.parent.id); } finally { redis.pipeline = original; }
  assert.ok(await readComment(course, other.comment.id));
  assert.ok(afterFirst > 0);
  assert.equal(held(), afterFirst);
});

test("replies above the lesson reader window do not block creator moderation", async () => {
  const s = await seed(), index = `nl:lc:${course}:l:${lesson}`;
  const readerWindow = MAX_LESSON_THREADS * 4;
  let sample = "";
  for (let i = 0; i < readerWindow - 1; i += 1) {
    const id = `kept${i.toString(36).padStart(8, "0")}`;
    sample ||= id;
    const comment = {
      id,
      lesson,
      by: CREATOR_AUTHOR,
      name: "",
      text: "Unrelated retained comment",
      at: 200 + i,
      parent: null,
      hidden: false,
    };
    redis.run(["HSET", hash, id, serializeComment(comment)]);
    redis.run(["ZADD", index, comment.at, id]);
  }
  assert.equal(Number(redis.run(["ZCARD", index])), readerWindow + 1);
  assert.equal(await deleteComment(course, s.parent.id, ROOM), 2);
  assert.equal(await readComment(course, s.parent.id), null);
  assert.equal(await readComment(course, s.reply.id), null);
  assert.ok(await readComment(course, sample));
});
