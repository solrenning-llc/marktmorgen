/** Unknown thread reads must not delete a parent and leave its replies behind. */
import { addComment, deleteComment, lessonComments, readComment } from "@/lib/lesson-comments";
import { CREATOR_AUTHOR, MAX_LESSON_THREADS, serializeComment } from "@/lib/lesson-comments-rules";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

async function main() {
  const original = redis.pipeline.bind(redis), course = "c".repeat(32), lesson = "lessonone001";
  const hash = `nl:lc:${course}:c`, index = `nl:lc:${course}:l:${lesson}`;
  async function seed() {
    redis.clear();
    const parent = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by: CREATOR_AUTHOR, text: "Question to preserve", now: 100 });
    if (!parent.ok) throw Error("Parent fixture missing");
    const reply = await addComment({ room: ROOM, courseId: course, lessonId: lesson, by: CREATOR_AUTHOR, text: "Reply to preserve", parent: parent.comment.id, now: 101 });
    if (!reply.ok) throw Error("Reply fixture missing");
    return { parent: parent.comment, reply: reply.comment };
  }
  const modes = ["parent-missing", "parent-extra", "parent-invalid", "parent-mismatch", "parent-getter", "parent-inherited", "index-missing", "index-extra", "index-invalid", "index-duplicate", "index-sparse", "index-overflow", "rows-missing", "rows-short", "rows-extra", "rows-sparse", "rows-invalid", "rows-mismatch", "rows-wrong-lesson"] as const;
  let getters = 0;
  part("Complete thread evidence before destructive work");
  try {
    for (const mode of modes) {
      const { parent, reply } = await seed();
      const parentRaw = serializeComment(parent), replyRaw = serializeComment(reply);
      let destructive = 0;
      redis.pipeline = async commands => {
        if (commands[0]?.[0] === "HGET" && commands[0][1] === hash && commands[0][2] === parent.id) {
          if (mode === "parent-missing") return [] as never;
          if (mode === "parent-extra") return [parentRaw, null] as never;
          if (mode === "parent-invalid") return ["broken JSON"] as never;
          if (mode === "parent-mismatch") return [serializeComment({ ...parent, id: "mismatch0001" })] as never;
          if (mode === "parent-getter") return Object.defineProperty(new Array(1), "0", { get() { getters++; return parentRaw; } }) as never;
          if (mode === "parent-inherited") return Object.setPrototypeOf(new Array(1), [parentRaw]) as never;
        }
        if (commands.length === 1 && commands[0]?.[0] === "EVAL" && String(commands[0]?.[1]).startsWith("-- marktmorgen:lesson-comment-thread-delete:v1\n")) {
          if (mode === "index-missing") return [] as never;
          if (mode === "index-extra") return [[2, 1_248], null] as never;
          if (mode === "index-invalid") return [["2", 1_248]] as never;
          if (mode === "index-duplicate") return [[2, 1_248, 0]] as never;
          if (mode === "index-sparse") return [new Array(2)] as never;
          if (mode === "index-overflow") return [[MAX_LESSON_THREADS * 4 + 1, 1_248]] as never;
          if (mode === "rows-missing") return [0] as never;
          if (mode === "rows-short") return [[2]] as never;
          if (mode === "rows-extra") return [[2, 1_248, 0]] as never;
          if (mode === "rows-sparse") return [new Array(2)] as never;
          if (mode === "rows-invalid") return [[2, "1248"]] as never;
          if (mode === "rows-mismatch") return [[-1, 0]] as never;
          if (mode === "rows-wrong-lesson") return [[2, -1]] as never;
        }
        destructive += commands.filter(command => !["HGET", "GET", "HMGET", "ZREVRANGE"].includes(String(command[0]))).length;
        if (commands[0]?.[0] === "ZREVRANGE" && commands[0][1] === index) {
          if (mode === "index-missing") return [] as never;
          if (mode === "index-extra") return [[reply.id, parent.id], []] as never;
          if (mode === "index-invalid") return [["bad-id"]] as never;
          if (mode === "index-duplicate") return [[parent.id, parent.id]] as never;
          if (mode === "index-sparse") return [new Array(2)] as never;
          if (mode === "index-overflow") return [Array.from({ length: MAX_LESSON_THREADS * 4 + 1 }, (_, i) => `overflow${String(i).padStart(4, "0")}`)] as never;
        }
        if (commands[0]?.[0] === "HMGET" && commands[0][1] === hash) {
          const rows = commands[0].slice(2).map(id => id === parent.id ? parentRaw : replyRaw);
          if (mode === "rows-missing") return [] as never;
          if (mode === "rows-short") return [[rows[0]]] as never;
          if (mode === "rows-extra") return [rows, null] as never;
          if (mode === "rows-sparse") return [new Array(rows.length)] as never;
          if (mode === "rows-invalid") return [rows.map((raw, i) => i === 0 ? "broken JSON" : raw)] as never;
          if (mode === "rows-mismatch") return [rows.map((raw, i) => i === 0 ? serializeComment({ ...reply, id: "mismatch0001" }) : raw)] as never;
          if (mode === "rows-wrong-lesson") return [rows.map((raw, i) => i === 0 ? serializeComment({ ...reply, lesson: "lessontwo002" }) : raw)] as never;
        }
        return original(commands);
      };
      let refused = false;
      try { await deleteComment(course, parent.id, ROOM); } catch { refused = true; }
      redis.pipeline = original;
      is(`${mode}: an unknown thread never certifies completed deletion`, refused, true);
      is(`${mode}: no destructive command or storage adjustment after unknown evidence`, destructive, 0);
      is(`${mode}: both stored comments stay available for a confirmed retry`, await original([["HGET", hash, parent.id], ["HGET", hash, reply.id]]), [parentRaw, replyRaw]);
    }
    is("a reply getter is never executed as deletion evidence", getters, 0);
    part("Confirmed data keeps the ordinary behavior");
    const { parent, reply } = await seed();
    is("the real reader retains both comments in order", (await lessonComments(course, lesson)).map(comment => comment.id), [reply.id, parent.id]);
    is("a complete confirmed thread deletes its parent and reply", await deleteComment(course, parent.id, ROOM), 2);
    is("both records are actually removed", await original([["HGET", hash, parent.id], ["HGET", hash, reply.id]]), [null, null]);
    is("a repeated confirmed deletion is empty", await deleteComment(course, parent.id, ROOM), 0);
    is("a confirmed absent record remains absent", await readComment(course, parent.id), null);
    is("a confirmed empty lesson remains readable", await lessonComments(course, lesson), []);
    const kept = await seed();
    // A stale index can retain an explicitly deleted record; that known absence is omittable.
    await original([["HDEL", hash, kept.reply.id]]);
    is("an explicit null row is distinct from an incomplete reply", (await lessonComments(course, lesson)).map(comment => comment.id), [kept.parent.id]);
  } finally { redis.pipeline = original; }
  done();
}
void main().catch(error => { console.error(error); process.exit(1); });
