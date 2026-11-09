/**
 * Deleting a person's form responses and lesson comments reads what each
 * script answered only from a complete reply (Codex G's review of #2584): a
 * pipeline that answers fewer replies than it was sent, or a reply of the
 * wrong shape, leaves the outcome unknown. Then the eraser throws (lib/person-erasure.ts
 * reports the module as incomplete), the person's records are not taken for
 * gone, and no room is given back. A confirmed empty answer is still a valid
 * absence.
 */
import { parseForm, type FormResponse } from "@/lib/forms";
import { addResponse, forgetFormsPerson, readResponses, writeForm } from "@/lib/form-store";
import { addComment, forgetLessonCommentsPerson, lessonComments } from "@/lib/lesson-comments";
import { emailKey } from "@/lib/learn";
import { dataUsed } from "@/lib/store-data";
import { store as redis } from "./redis-stub";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

type Pipeline = typeof redis.pipeline;
const real = redis.pipeline.bind(redis) as Pipeline;
const used = async () => (await dataUsed(ROOM))?.used ?? 0;

/** Runs `erase` while every pipeline holding `script` is answered `bad` (and not applied); whether it threw. */
async function refused(script: string, bad: unknown[], erase: () => Promise<unknown>): Promise<boolean> {
  redis.pipeline = (async (commands: (string | number)[][]) =>
    commands.some((c) => c[0] === "EVAL" && String(c[1]).startsWith(`-- marktmorgen:${script}:`)) ? bad : real(commands)) as Pipeline;
  try {
    await erase();
    return false;
  } catch {
    return true;
  } finally {
    redis.pipeline = real;
  }
}

async function forms(): Promise<void> {
  part("Form responses: an unknown reply is never taken for none");
  const STATS = "g".repeat(16);
  const form = parseForm({ id: "exactform1", name: "Application", fields: [{ id: "email1", type: "email", label: "Email", required: true }], offerList: false })!;
  await writeForm(STATS, form);
  const answer = (email: string, at: number): FormResponse => ({ at, page: "/apply", answers: { email1: email }, outcome: "", joined: false });
  await addResponse(STATS, form.id, answer("ana@example.com", 1), ROOM);
  const before = await used();
  const raw = JSON.stringify(answer("ana@example.com", 1));
  for (const bad of [[], [undefined], [0], [{}], [[1, raw]], [[2, raw, 1]], [[1, raw, 0]], [[1, 7, 1]], [["1", raw, 1]], [[1, raw, 1], 0]]) {
    is(`refused on ${JSON.stringify(bad)}`, await refused("form-forget", bad, () => forgetFormsPerson(STATS, "ana@example.com", ROOM)), true);
    is(`no room given back on ${JSON.stringify(bad)}`, await used(), before);
  }
  is("her response is still kept", (await readResponses(STATS, form.id)).total, 1);
  is("then deleted for real", await forgetFormsPerson(STATS, "ana@example.com", ROOM), 1);
  is("a confirmed empty answer is none", await forgetFormsPerson(STATS, "ana@example.com", ROOM), 0);
}

async function comments(): Promise<void> {
  part("Lesson comments: an unknown reply is never taken for none");
  const COURSE = "h".repeat(32);
  const L1 = "lessonone001";
  const ana = emailKey("ana@example.com");
  const made = await addComment({ room: ROOM, courseId: COURSE, lessonId: L1, by: ana, text: "How warm should the kitchen be?", name: "Ana Lopes", parent: null });
  if (!made.ok) throw new Error(`no comment: ${made.reason}`);
  const before = await used();
  // Rule 23 (pre-review of 9 November 2026, finding 2): a step of the erasure answers {cursor, how many went, their
  // room, threads waiting}, no longer {the name, every comment's words}; these are the shapes of that answer it
  // refuses (the name is read and deleted after, in its own commands).
  for (const bad of [[], [undefined], [0], [[]], [["x"]], [["0"]], [["0", 1, 640]], [[0, 1, 640, 0]], [["", 1, 640, 0]], [["0 ", 1, 640, 0]], [["0", -1, 0, 0]], [["0", 1, 0, 0]], [["0", 0, 16, 0]], [["0", 1, 640, null]], [["0", 1, 640, 0, 1]], [["0", 1, 640, 0], 0]]) {
    is(`refused on ${JSON.stringify(bad)}`, await refused("lesson-comments-forget", bad, () => forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM)), true);
    is(`no room given back on ${JSON.stringify(bad)}`, await used(), before);
  }
  is("her comment is still kept", (await lessonComments(COURSE, L1)).length, 1);
  is("then deleted for real", await forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM), 1);
  is("a confirmed empty answer is none", await forgetLessonCommentsPerson(COURSE, [L1], ana, ROOM), 0);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await forms();
  await comments();
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
