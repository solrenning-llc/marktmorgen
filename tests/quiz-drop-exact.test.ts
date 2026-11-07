/**
 * Taking a lesson's quiz away reads what it takes away exactly, before the course is saved without it (CX-123 rules
 * 24 and 30; Claude 5, the sibling of readQuizFor and of readTaskDrop):
 *
 *   - a reply of the quiz record cut short or of another shape is unknown: the route answers 503 and the course, the
 *     quiz record and the room it takes stay as they were, so the course is never saved without a quiz whose record
 *     is still kept (and counted) with nothing pointing at it, and the deletion never says it was done;
 *   - a record that is there but does not read is still deleted, and its own bytes come back to the store's data room:
 *     taking it away is what the creator asked for;
 *   - both doors: taking the quiz off the lesson, and removing the lesson.
 *
 * And the studio, saving a quiz again where the outline says there is one but the record is confirmed absent (GET nil),
 * saves it as a new quiz instead of answering 503 for good.
 *
 * Synthetic data only, through the real route.
 */
import { NextRequest } from "next/server";
import { GET as courseRead, POST as courseRoute } from "@/app/api/store/course/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { findLesson, readCourse } from "@/lib/course";
import { readListing } from "@/lib/catalog";
import { dataKey } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { store as redis } from "./redis-stub";

const OWNER = "quiz-drop-exact@example.com";
const QUIZ = { passPercent: 70, attempts: 3, questions: [{ text: "Which one?", choices: ["One", "Two"], correct: [0] }] };
const BROKEN = "{\"passPercent\":";

type Batch = (string | number)[][];

async function main(): Promise<void> {
  redis.clear();
  process.env.UPSTASH_REDIS_REST_URL ??= "http://stub";
  await claimHandle(OWNER, "quizdropexact", "Quiz Drop Exact", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setStripeAccount(OWNER, "acct_QuizDropExact", true);
  await setSubscription(OWNER, { customerId: "cus_quiz_drop_exact", subscriptionId: "sub_quiz_drop_exact", active: true, tier: "creator", period: paidPeriod() });
  const session = await openSession(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const headers = { "content-type": "application/json", "x-nimbus-store": store.sid!, cookie: `${SESSION_COOKIE}=${session}` };
  const call = async (body: Record<string, unknown>) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; error?: string } };
  };
  /** What the studio's quiz editor reads when it opens a lesson's quiz. */
  const opened = async (lessonId: string) => {
    const response = await courseRead(new NextRequest(`https://marktmorgen.com/api/store/course?id=${id}&lessonId=${lessonId}&quiz=1`, { headers }));
    return { status: response.status, body: (await response.json()) as { ok?: boolean; quiz?: unknown; unread?: boolean } };
  };

  const made = await addProduct(OWNER, "Quiz course", "", "40");
  if (!made.ok) throw new Error("product not made");
  const id = made.product.id;
  if (!(await call({ action: "enable", id })).body.ok) throw new Error("course not enabled");
  const courseId = (await readListing((await storeForEmail(OWNER))!, id))!.course!.id;
  if (!(await call({ action: "edit", id, op: "module-add", title: "Start" })).body.ok) throw new Error("module not added");
  const moduleId = (await readCourse(courseId))!.modules[0].id;

  const quizKey = (lessonId: string) => `nl:course:${courseId}:quiz:${lessonId}`;
  const slot = () => Number(redis.run(["HGET", dataKey(store)!, `cq:${courseId}`]) ?? 0);
  const kept = (lessonId: string) => Number(redis.run(["EXISTS", quizKey(lessonId)])) === 1;
  const hasQuiz = async (lessonId: string) => Boolean(findLesson((await readCourse(courseId))!, lessonId)?.lesson.quiz);
  const hasLesson = async (lessonId: string) => Boolean(findLesson((await readCourse(courseId))!, lessonId));
  const lessonWithQuiz = async (title: string) => {
    const before = new Set((await readCourse(courseId))!.modules.flatMap((m) => m.lessons.map((l) => l.id)));
    if (!(await call({ action: "edit", id, op: "lesson-add", moduleId, title })).body.ok) throw new Error("lesson not added");
    const lessonId = (await readCourse(courseId))!.modules.flatMap((m) => m.lessons.map((l) => l.id)).find((l) => !before.has(l))!;
    const saved = await call({ action: "quiz", id, lessonId, quiz: QUIZ });
    if (!saved.body.ok) throw new Error(`quiz not saved: ${saved.body.error}`);
    return lessonId;
  };
  /** The quiz record's GET answered with `reply` instead of what Redis said; every other command as it is. */
  const withQuizReply = async <T>(lessonId: string, reply: unknown[], run: () => Promise<T>): Promise<T> => {
    const original = redis.pipeline.bind(redis);
    redis.pipeline = (async (batch: Batch) => {
      if (batch.some((c) => c[0] === "GET" && c[1] === quizKey(lessonId))) return reply;
      return original(batch);
    }) as typeof redis.pipeline;
    try {
      return await run();
    } finally {
      redis.pipeline = original;
    }
  };

  const UNKNOWN: [string, unknown[]][] = [
    ["no reply at all", []],
    ["a number", [42]],
  ];

  part("Taking a quiz off: an unknown reply changes nothing");
  const off = await lessonWithQuiz("Quiz taken off");
  const room = slot();
  is("the saved quiz takes room", room > 0, true);
  for (const [what, reply] of UNKNOWN) {
    const answer = await withQuizReply(off, reply, () => call({ action: "quiz", id, lessonId: off, quiz: null }));
    is(`${what}: 503, try again`, [answer.status, answer.body.error], [503, "unavailable"]);
    is(`${what}: the course still has the quiz, its record is kept and its room still counted`, [await hasQuiz(off), kept(off), slot()], [true, true, room]);
  }

  part("Removing the lesson: an unknown reply changes nothing");
  const gone = await lessonWithQuiz("Lesson removed");
  const room2 = slot();
  for (const [what, reply] of UNKNOWN) {
    const answer = await withQuizReply(gone, reply, () => call({ action: "edit", id, op: "lesson-remove", lessonId: gone }));
    is(`${what}: 503, try again`, [answer.status, answer.body.error], [503, "unavailable"]);
    is(`${what}: the lesson, its quiz record and its room are kept`, [await hasLesson(gone), await hasQuiz(gone), kept(gone), slot()], [true, true, true, room2]);
  }

  part("A record that does not read is still taken away, and its own bytes come back");
  redis.run(["SET", quizKey(off), BROKEN]);
  const before = slot();
  const offUnread = await call({ action: "quiz", id, lessonId: off, quiz: null });
  is("taking an unread quiz off works", [offUnread.status, offUnread.body.ok], [200, true]);
  is("the course has no quiz there, the record is gone and its bytes are given back", [await hasQuiz(off), kept(off), slot()], [false, false, before - dataBytes([BROKEN], 1)]);

  redis.run(["SET", quizKey(gone), BROKEN]);
  const before2 = slot();
  const goneUnread = await call({ action: "edit", id, op: "lesson-remove", lessonId: gone });
  is("removing a lesson with an unread quiz works", [goneUnread.status, goneUnread.body.ok], [200, true]);
  is("the lesson and its record are gone and the record's bytes are given back", [await hasLesson(gone), kept(gone), slot()], [false, false, before2 - dataBytes([BROKEN], 1)]);

  part("A healthy quiz goes with its lesson, and all its room comes back");
  const whole = await lessonWithQuiz("Healthy lesson");
  const room3 = slot();
  const healthy = await call({ action: "edit", id, op: "lesson-remove", lessonId: whole });
  is("removed", [healthy.status, healthy.body.ok, await hasLesson(whole), kept(whole)], [200, true, false, false]);
  is("its room is given back", slot() < room3, true);

  part("Saving again over a record confirmed absent while the outline says there is a quiz");
  const missing = await lessonWithQuiz("Record missing");
  redis.run(["DEL", quizKey(missing)]);
  is("the outline still says there is a quiz, the record is absent", [await hasQuiz(missing), kept(missing)], [true, false]);
  const editor = await opened(missing);
  is("the studio's editor is told the saved questions cannot be read, so it opens a fresh quiz to save over them (never \"could not be read just now\" for good)", [editor.status, editor.body.ok, editor.body.quiz, editor.body.unread], [200, true, null, true]);
  const again = await call({ action: "quiz", id, lessonId: missing, quiz: { ...QUIZ, passPercent: 80 } });
  is("saved as a new quiz, never a 503 for good", [again.status, again.body.ok, kept(missing)], [200, true, true]);
  const unknownSave = await withQuizReply(missing, [], () => call({ action: "quiz", id, lessonId: missing, quiz: { ...QUIZ, passPercent: 90 } }));
  const reopened = await opened(missing);
  is("once saved, the editor reads it as it is", [reopened.body.unread, (reopened.body.quiz as { passPercent?: number } | null)?.passPercent], [undefined, 80]);
  const plain = await call({ action: "edit", id, op: "lesson-add", moduleId, title: "No quiz" });
  const plainId = (await readCourse(courseId))!.modules.flatMap((m) => m.lessons).find((l) => l.title === "No quiz")?.id;
  is("a lesson the outline gives no quiz opens as no quiz, not as unread", [plain.body.ok, plainId ? (await opened(plainId)).body : null], [true, { ok: true, quiz: null }]);
  is("an unknown reply while saving still changes nothing", [unknownSave.status, (JSON.parse(String(redis.run(["GET", quizKey(missing)]))) as { passPercent?: number } | null)?.passPercent], [503, 80]);

  done();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
