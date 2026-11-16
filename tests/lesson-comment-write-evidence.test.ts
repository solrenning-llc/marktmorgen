import assert from "node:assert/strict";
import test from "node:test";
import { addComment, readComment } from "@/lib/lesson-comments";
import { CREATOR_AUTHOR } from "@/lib/lesson-comments-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const course = "d".repeat(32), lesson = "lessonone001";

async function question() {
  redis.clear();
  const parent = await addComment({
    room: ROOM,
    courseId: course,
    lessonId: lesson,
    by: "synthetic-student",
    name: "Student fixture",
    text: "A question",
    now: 100,
  });
  assert.ok(parent.ok);
  return parent.comment;
}

test("a known write stores a creator's answer under the real lesson", async () => {
  const parent = await question();
  const answer = await addComment({
    room: ROOM,
    courseId: course,
    lessonId: lesson,
    by: CREATOR_AUTHOR,
    text: "Known answer",
    parent: parent.id,
    now: 101,
  });
  assert.ok(answer.ok);
  assert.equal((await readComment(course, answer.comment.id))?.text, "Known answer");
});

const unknownReplies: Array<{ name: string; make: (read: () => void) => unknown }> = [
  { name: "missing", make: () => [] },
  { name: "short", make: () => [1] },
  { name: "extra", make: () => [1, 1, 1, 0, 1, 0] },
  { name: "hash not inserted", make: () => [0, 1, 1, 0, 1] },
  { name: "lesson index not inserted", make: () => [1, 0, 1, 0, 1] },
  { name: "course index not inserted", make: () => [1, 1, 0, 0, 1] },
  { name: "negative trim count", make: () => [1, 1, 1, -1, 1] },
  { name: "reply count not incremented", make: () => [1, 1, 1, 0, 0] },
  { name: "text result", make: () => [1, 1, 1, 0, "1"] },
  { name: "inherited slots", make: () => Object.setPrototypeOf(new Array(5), [1, 1, 1, 0, 1]) },
  { name: "getter slot", make: (read) => Object.defineProperty([1, 1, 1, 0, 1], "0", { get() { read(); return 1; } }) },
];

for (const applied of [false, true]) {
  for (const reply of unknownReplies) {
    test(`an unknown answer-write acknowledgement cannot certify success: applied=${applied}, ${reply.name}`, async () => {
      const parent = await question(), original = redis.pipeline.bind(redis);
      let intercepted = 0, answerId = "", claimed = false, getterReads = 0;
      redis.pipeline = async (commands) => {
        if (commands.length === 1 && commands[0][0] === "EVAL" && String(commands[0][1]).startsWith("-- marktmorgen:lesson-comments-add:v2\n")) {
          intercepted++;
          answerId = String(commands[0][9]);
          if (applied) await original(commands);
          return [reply.make(() => { getterReads++; })] as never;
        }
        return original(commands);
      };
      try {
        const answer = await addComment({
          room: ROOM,
          courseId: course,
          lessonId: lesson,
          by: CREATOR_AUTHOR,
          text: "Unconfirmed answer",
          parent: parent.id,
          now: 101,
        });
        claimed = answer.ok;
      } finally {
        redis.pipeline = original;
      }
      assert.equal(intercepted, 1, "only the actual five-field answer write is intercepted; no retry");
      assert.equal((await readComment(course, answerId))?.text ?? null, applied ? "Unconfirmed answer" : null);
      assert.equal((await readComment(course, parent.id))?.text, "A question");
      assert.equal(claimed, false, "unknown write evidence cannot promise that the answer is under the lesson");
      assert.equal(getterReads, 0, "an acknowledgement accessor is never executed");
    });
  }
}
