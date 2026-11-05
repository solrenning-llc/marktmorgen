/** Unknown thread reads must not delete a parent and leave its replies behind. */
import { addComment, deleteComment, lessonComments, readComment } from "@/lib/lesson-comments";
import { CREATOR_AUTHOR, serializeComment } from "@/lib/lesson-comments-rules";
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
  type Mode = "parent-missing" | "parent-extra" | "parent-invalid" | "parent-mismatch" | "index-missing" | "index-extra" | "index-invalid" | "index-duplicate" | "rows-missing" | "rows-short" | "rows-invalid" | "rows-mismatch" | "rows-wrong-lesson";
  const modes: Mode[] = ["parent-missing", "parent-extra", "parent-invalid", "parent-mismatch", "index-missing", "index-extra", "index-invalid", "index-duplicate", "rows-missing", "rows-short", "rows-invalid", "rows-mismatch", "rows-wrong-lesson"];
  part("Complete thread evidence before destructive work");
  try {
    for (const mode of modes) {
      const { parent, reply } = await seed();
      const parentRaw = serializeComment(parent), replyRaw = serializeComment(reply);
      let destructive = 0;
      redis.pipeline = async commands => {
        destructive += commands.filter(command => !["HGET", "GET", "HMGET", "ZREVRANGE"].includes(String(command[0]))).length;
        if (commands[0]?.[0] === "HGET" && commands[0][1] === hash && commands[0][2] === parent.id) {
          if (mode === "parent-missing") return [] as never;
          if (mode === "parent-extra") return [parentRaw, null] as never;
          if (mode === "parent-invalid") return ["broken JSON"] as never;
          if (mode === "parent-mismatch") return [serializeComment({ ...parent, id: "mismatch0001" })] as never;
        }
        if (commands[0]?.[0] === "ZREVRANGE" && commands[0][1] === index) {
          if (mode === "index-missing") return [] as never;
          if (mode === "index-extra") return [[reply.id, parent.id], []] as never;
          if (mode === "index-invalid") return [["bad-id"]] as never;
          if (mode === "index-duplicate") return [[parent.id, parent.id]] as never;
        }
        if (commands[0]?.[0] === "HMGET" && commands[0][1] === hash) {
          const rows = commands[0].slice(2).map(id => id === parent.id ? parentRaw : replyRaw);
          if (mode === "rows-missing") return [] as never;
          if (mode === "rows-short") return [[rows[0]]] as never;
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
