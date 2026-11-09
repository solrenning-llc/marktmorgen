/**
 * Assignments on a lesson (lib/assignment.ts, added 11 October 2026). What
 * is checked:
 *
 *   - an assignment needs a prompt, and its three switches are read as given;
 *   - a student's file can only be one in their own folder for that lesson,
 *     of a kind that is taken;
 *   - handing in finishes the lesson at once when nobody reviews it, and
 *     waits for the creator when they do; approving finishes it, asking for
 *     another try does not, and work already answered is not answered twice;
 *   - an assignment that must be finished holds the lessons after it shut
 *     until it is;
 *   - a new file replaces the old one, which is handed back to be deleted;
 *   - what a store's students keep is held to its figure, and given back;
 *   - removing an assignment forgets the work and returns its files;
 *   - a file uploaded and never handed in is found a day later, and a door
 *     is used once;
 *   - the creator is emailed once an hour at most, the student in the
 *     store's language.
 */
import { type Course, editCourse, emptyCourse, newItemId } from "@/lib/course";
import { MAX_STORE_TASK_BYTES, type Task, cleanFileName, ownsTaskPath, readTask, taskExtension, taskFolder } from "@/lib/assignment-rules";
import {
  DOOR_SECONDS,
  dropTask,
  handIn,
  noteTaskUpload,
  releaseBytes,
  review,
  saveTask,
  readTaskFor,
  submissionOf,
  sweepTaskUploads,
  takeRoom,
  takeTaskUpload,
  waitingWork,
} from "@/lib/assignment";
import { tellCreatorOfWork, tellStudentOfReview } from "@/lib/assignment-notify";
import { heldBack, passedQuizzes } from "@/lib/quiz";
import { doneLessons } from "@/lib/learn";
import { writeFeedback } from "@/lib/ai";
import { claimHandle, storeForEmail, type Listing } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

const sent: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const FOLDER = "0123456789abcdef0123456789abcdef";
const WHO = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const file = (n: string, ext = "pdf") => ({ path: `${n}.${ext}`, name: `work.${ext}`, bytes: 1000, type: "application/pdf" });

function courseWith(): { course: Course; first: string; second: string; third: string } {
  let course = emptyCourse();
  const moduleId = course.modules[0].id;
  for (const title of ["One", "Two", "Three"]) {
    const added = editCourse(course, { op: "lesson-add", moduleId, title });
    if (!added.ok) throw new Error("could not add a lesson");
    course = added.course;
  }
  const [first, second, third] = course.modules[0].lessons.map((l) => l.id);
  return { course, first, second, third };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_assignments_only_a_stand_in";

  part("An assignment and its switches");
  is("an assignment with no prompt is refused", readTask({ prompt: "   " }).ok, false);
  const read = readTask({ prompt: " Write your opening paragraph.\r\n", review: true, gate: "yes", file: true });
  is("the prompt is trimmed, its line ends made plain", read.ok && read.task.prompt, "Write your opening paragraph.");
  is("a switch is on only when it is true", read.ok && [read.task.review, read.task.gate, read.task.file].join(), "true,false,true");
  is("a file's name loses what could break a download", cleanFileName('../evil"name<>.pdf'), ".. evil name .pdf");

  part("A student's file is theirs, for that lesson, of a kind taken");
  const mine = taskFolder(FOLDER, "c".repeat(32), "abcdefghijkl", WHO);
  is("a fresh name in their own folder", ownsTaskPath(`${mine}${"1".repeat(32)}.pdf`, mine), true);
  is("another student's folder", ownsTaskPath(`${taskFolder(FOLDER, "c".repeat(32), "abcdefghijkl", OTHER)}${"1".repeat(32)}.pdf`, mine), false);
  is("a kind that is not taken", ownsTaskPath(`${mine}${"1".repeat(32)}.exe`, mine), false);
  is("a folder inside it", ownsTaskPath(`${mine}x/${"1".repeat(32)}.pdf`, mine), false);
  is("a way out of it", ownsTaskPath(`${mine}../${"1".repeat(32)}.pdf`, mine), false);
  is("a Word file is taken", taskExtension("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  is("a web page is not", taskExtension("text/html"), null);
  is("nor anything that only looks like a key", taskExtension("constructor"), null);

  part("The lesson carries the switches, and a quiz or an assignment");
  const { course: base, first, second, third } = courseWith();
  const withTask = editCourse(base, { op: "task", lessonId: first, task: { review: true, gate: true, file: true } });
  is("the switches are on the lesson", withTask.ok && withTask.course.modules[0].lessons[0].task?.gate, true);
  const without = withTask.ok ? editCourse(withTask.course, { op: "task", lessonId: first, task: null }) : null;
  is("taking it off leaves no trace on the lesson", without?.ok && "task" in without.course.modules[0].lessons[0], false);
  if (!withTask.ok) throw new Error("no course");
  const course = withTask.course;

  part("A must-finish assignment holds the rest shut until it is done");
  is("the next lesson waits on it", heldBack(course, new Set()).get(second), first);
  is("and the one after", heldBack(course, new Set()).get(third), first);
  is("the lesson itself is open", heldBack(course, new Set()).has(first), false);

  part("Reviewed: waiting, another try, approved");
  const task: Task = { prompt: "Write it.", review: true, gate: true, file: true };
  await saveTask(course.id, first, task, ROOM);
  is("the prompt is kept apart from the outline", (await readTaskFor(course.id, first))?.prompt, "Write it.");
  const one = await handIn({ data: ROOM, courseId: course.id, lessonId: first, who: WHO, email: "student@example.com", task, text: "My first go.", file: file("one"), now: 100 });
  is("handed in, it waits for the creator", one.state, "waiting");
  is("and is in the creator's list", (await waitingWork(course.id)).rows.map((r) => r.who).join(), WHO);
  is("the lesson is not done yet", (await doneLessons(course.id, "student@example.com")).has(first), false);
  is("the next lesson still waits", heldBack(course, await passedQuizzes(course.id, WHO)).has(second), true);

  const again = await review({ data: ROOM, courseId: course.id, lessonId: first, who: WHO, email: "student@example.com", verdict: "again", feedback: "Say who it is for." });
  is("another try asked for", again.ok && again.submission.state, "again");
  is("nothing waits any more", (await waitingWork(course.id)).total, 0);
  is("work already answered is not answered twice", (await review({ data: ROOM, courseId: course.id, lessonId: first, who: WHO, email: "", verdict: "approved", feedback: "" })).ok, false);

  const two = await handIn({ data: ROOM, courseId: course.id, lessonId: first, who: WHO, email: "student@example.com", task, text: "For beginners.", file: file("two"), now: 200 });
  is("the old file is handed back to be deleted", two.replaced?.path, "one.pdf");
  is("the second try is counted", (await submissionOf(course.id, first, WHO))?.tries, 2);
  is("and the old answer is cleared with it", (await submissionOf(course.id, first, WHO))?.feedback, "");
  const three = await handIn({ data: ROOM, courseId: course.id, lessonId: first, who: WHO, email: "student@example.com", task, text: "For beginners, again.", file: file("two"), now: 300 });
  is("the same file kept is not deleted", three.replaced, null);

  const yes = await review({ data: ROOM, courseId: course.id, lessonId: first, who: WHO, email: "student@example.com", verdict: "approved", feedback: "Clear now." });
  is("approved", yes.ok && yes.submission.state, "approved");
  is("approving finishes the lesson", (await doneLessons(course.id, "student@example.com")).has(first), true);
  is("and opens the lessons after it", heldBack(course, await passedQuizzes(course.id, WHO)).has(second), false);

  part("Not reviewed: handing in is enough");
  const quick: Task = { prompt: "Share a link.", review: false, gate: false, file: false };
  const handed = await handIn({ data: ROOM, courseId: course.id, lessonId: second, who: OTHER, email: "other@example.com", task: quick, text: "Here.", file: null, now: 400 });
  is("done at once", handed.state, "approved");
  is("the lesson is marked done", (await doneLessons(course.id, "other@example.com")).has(second), true);
  is("nothing waits for the creator", (await waitingWork(course.id)).total, 0);
  is("everything handed in, newest first", (await waitingWork(course.id, 50, true)).rows[0]?.who, OTHER);

  part("What a store's students keep is held to its figure");
  is("room up to the figure", await takeRoom("store-1", MAX_STORE_TASK_BYTES - 5), true);
  is("no room past it", await takeRoom("store-1", 10), false);
  await releaseBytes("store-1", 100);
  is("room given back is room again", await takeRoom("store-1", 10), true);

  part("Removing an assignment forgets the work and returns its files");
  const files = await dropTask(course.id, first, "store-1", ROOM);
  is("every file still kept for it, to delete: the replaced one went when it was replaced", files.join(), "two.pdf");
  is("the student's work is forgotten", await submissionOf(course.id, first, WHO), null);
  is("and the assignment", await readTaskFor(course.id, first), null);

  part("Uploads never handed in, and doors used once");
  const now = Date.now();
  await noteTaskUpload("old.pdf", now - (DOOR_SECONDS + 60) * 1000);
  await noteTaskUpload("new.pdf", now);
  const swept: string[] = [];
  is("the old one is deleted, the new one left", (await sweepTaskUploads(async (paths) => void swept.push(...paths), now)).join(), "old.pdf");
  is("and handed to the deletion once", swept.join(), "old.pdf");
  is("a door is used", await takeTaskUpload("new.pdf"), true);
  is("once", await takeTaskUpload("new.pdf"), false);

  part("Who hears about it");
  await claimHandle("creator@example.com", "teacher", "Escola Clara", "");
  const store = { ...(await storeForEmail("creator@example.com"))!, language: "pt" as const };
  const product = { id: "p1", title: "Vender melhor" } as Listing;
  is("the creator is told", await tellCreatorOfWork({ store, product, courseId: course.id, lessonTitle: "One", origin: "https://marktmorgen.com" }), true);
  is("not again within the hour", await tellCreatorOfWork({ store, product, courseId: course.id, lessonTitle: "One", origin: "https://marktmorgen.com" }), false);
  is("at the store's address", sent[0]?.to, "creator@example.com");
  const answered = { text: "", file: null, at: 1, state: "again" as const, feedback: "Diga para quem é.", reviewedAt: 2, tries: 1 };
  await tellStudentOfReview({ store, product, lessonId: first, lessonTitle: "Abertura", to: "student@example.com", submission: answered, origin: "https://marktmorgen.com" });
  const mail = sent[sent.length - 1];
  is("the student's email is in the store's language", mail?.subject, "O seu trabalho em «Abertura»");
  is("with what the creator wrote, and the way back", mail?.text.includes("Diga para quem é.") && mail.text.includes("/@teacher/course/p1/"), true);

  part("AI needs something to go on");
  const ai = await writeFeedback(store, { course: "C", lesson: "L", prompt: "P", answer: "  ", file: "x.pdf", notes: "" });
  is("a file alone, with nothing said about it, is not enough", !ai.ok && ai.reason, "notes");

  void newItemId;
  done();
}

main();
