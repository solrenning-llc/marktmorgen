import assert from "node:assert/strict";
import test from "node:test";
import { addComment, readComment } from "@/lib/lesson-comments";
import { CREATOR_AUTHOR } from "@/lib/lesson-comments-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";

const course = "d".repeat(32), lesson = "lessonone001";
async function question() {
  redis.clear();
  const parent = await addComment({ room: ROOM, courseId: course, lessonId: lesson,
    by: "synthetic-student", name: "Student fixture", text: "A question", now: 100 });
  assert.ok(parent.ok);
  return parent.comment;
}

test("a known write stores a creator's answer under the real lesson", async () => {
  const parent = await question();
  const answer = await addComment({ room: ROOM, courseId: course, lessonId: lesson,
    by: CREATOR_AUTHOR, text: "Known answer", parent: parent.id, now: 101 });
  assert.ok(answer.ok);
  assert.equal((await readComment(course, answer.comment.id))?.text, "Known answer");
});

for (const applied of [false, true]) {
  for (const response of [[], [1]]) {
    test(`an incomplete answer-write acknowledgement cannot certify success: applied=${applied}, slots=${response.length}`, async () => {
      const parent = await question(), original = redis.pipeline.bind(redis);
      let intercepted = 0, answerId = "", claimed = false;
      redis.pipeline = async (commands) => {
        const command = commands[0];
        const pipelined = commands.length === 5 && command?.[0] === "HSET" && command[1] === `nl:lc:${course}:c`;
        const atomic = commands.length === 1 && command?.[0] === "EVAL" && String(command[1]).startsWith("-- marktmorgen:lesson-comments-add:v2") && command[7] === parent.id;
        if (pipelined || atomic) {
          intercepted++;
          answerId = String(command[atomic ? 9 : 2]);
          if (applied) await original(commands);
          return response;
        }
        return original(commands);
      };
      try {
        try {
          const answer = await addComment({ room: ROOM, courseId: course, lessonId: lesson,
            by: CREATOR_AUTHOR, text: "Unconfirmed answer", parent: parent.id, now: 101 });
          claimed = answer.ok;
        } catch {
          // Refusal/unknown is acceptable; it must not be promoted to confirmed storage.
        }
      } finally {
        redis.pipeline = original;
      }
      assert.equal(intercepted, 1, "only the actual answer write is intercepted; no retry");
      assert.equal((await readComment(course, answerId))?.text ?? null, applied ? "Unconfirmed answer" : null);
      assert.equal((await readComment(course, parent.id))?.text, "A question");
      assert.equal(claimed, false, "unknown write evidence cannot promise that the answer is under the lesson");
    });
  }
}
