import { originFrom } from "@/lib/request-origin";
import { addComment, deleteComment, dropLessonComments, readComment, setCommentsOn, setHidden } from "@/lib/lesson-comments";
import { COMMENT_ID_PATTERN, CREATOR_AUTHOR } from "@/lib/lesson-comments-rules";
import { tellStudent } from "@/lib/lesson-comment-notify";
import type { NextRequest } from "next/server";
import { DataRoomError } from "@/lib/store-data";
import { MAX_AI_LESSONS, MAX_AI_MODULES } from "@/lib/ai-rules";
import { deleteFile as del, headFile as head } from "@/lib/file-store";
import { setCourseLessons, setProductCourse, setProductHidden, storeForEmail, storeFolder } from "@/lib/store";
import { jsonAccess } from "@/lib/studio-route";
import { guardStoreWrite, text } from "@/lib/store-request";
import { MAX_LINK_LENGTH, readLink } from "@/lib/product-link";
import { ownsPath, safeFileName, type ProductFile } from "@/lib/product-file";
import {
  type Course,
  type CourseEdit,
  MAX_BODY_LENGTH,
  cleanBody,
  dropBody,
  dropCourse,
  editCourse,
  emptyCourse,
  filesInCourse,
  findLesson,
  lessonCount,
  lessonsInOrder,
  readBody,
  readCourse,
  saveBody,
  saveCourse,
} from "@/lib/course";
import { emailKey, registerDrip, setBlocked, storeKey, studentEmail } from "@/lib/learn";
import { dropTask, readTaskFor, review, saveTask } from "@/lib/assignment";
import { readTask } from "@/lib/assignment-rules";
import { tellStudentOfReview } from "@/lib/assignment-notify";
import { EMAIL_PATTERN } from "@/lib/auth";
import { dropQuiz, readQuiz, readQuizFor, resetTries, saveQuiz, setupOf } from "@/lib/quiz";
import { CERT_ID_PATTERN, withdrawCertificate } from "@/lib/certificate";
import { readListing } from "@/lib/catalog";
import { communityOf, courseChanged, unindexCourse } from "@/lib/community-index";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { claimUpload, dropStream } from "@/lib/stream";
import { type StreamState, isStreamPath } from "@/lib/stream-rules";
import { noteIfFinished } from "@/lib/course-finish";
import { applyTemplate, templateById } from "@/lib/course-templates";

const OPS = new Set([
  "outline",
  "module-add",
  "module-edit",
  "module-move",
  "module-remove",
  "lesson-add",
  "lesson-edit",
  "lesson-move",
  "lesson-remove",
  "media-remove",
]);

/**
 * A lesson's text, or with `&quiz=1` its quiz with the right answers, for the
 * studio to edit. The creator's own courses only.
 */
export async function GET(request: NextRequest) {
  const access = await jsonAccess(request, "products");
  if (access instanceof Response) return access;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  const lessonId = request.nextUrl.searchParams.get("lessonId") ?? "";
  const store = access.store;
  const product = await readListing(store, id);
  const course = product?.course ? await readCourse(product.course.id) : null;
  if (!course || !findLesson(course, lessonId)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
  if (request.nextUrl.searchParams.get("task") === "1") {
    return Response.json({ ok: true, task: await readTaskFor(course.id, lessonId) }, { headers: { "Cache-Control": "no-store" } });
  }
  if (request.nextUrl.searchParams.get("quiz") === "1") {
    return Response.json({ ok: true, quiz: await readQuizFor(course.id, lessonId) }, { headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({ ok: true, text: await readBody(course.id, lessonId) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Everything the studio changes about a course.
 *
 * `{ action: "enable", id }` makes a product a course; `{ action: "disable",
 * id }` turns an empty one back; `{ action: "edit", id, op, ... }` changes
 * the outline; `{ action: "body", id, lessonId, text }` saves a lesson's
 * text; `{ action: "media", id, lessonId, kind, pathname, name }` puts an
 * uploaded video or file on a lesson (a video's path is either one in the
 * file store or one at the video service, lib/stream-rules.ts); `{ action: "block", id, email, blocked
 * }` takes a student off the course or lets them back; `{ action: "quiz", id,
 * lessonId, quiz }` saves a lesson's quiz and `quiz: null` takes it off;
 * `{ action: "cert", id, on }` switches certificates on or off; `{ action:
 * "withdraw", id, certificate }` withdraws one; `{ action: "retries", id,
 * email }` gives a student their quiz tries back; `{ action: "task", id,
 * lessonId, task }` saves a lesson's assignment and `task: null` takes it off,
 * with the work handed in for it; `{ action: "review", id, lessonId, who,
 * verdict, feedback }` approves a student's work or asks for another try;
 * `{ action: "template", id, template }` gives a new course one of the ready
 * structures (lib/course-templates.ts) by its id, applied here to the course
 * as it is kept, in one write.
 *
 * `id` is always the product's, and the course is found through the
 * creator's own store, so nothing here can reach anyone else's course.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", MAX_BODY_LENGTH * 4 + 4_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const action = text(body.action, 10);
  const id = text(body.id, 40);
  if (!id) return Response.json({ ok: false, error: "unknown" }, { status: 400 });

  try {
    const store = await storeForEmail(ref);
    if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
    const product = await readListing(store, id);
    if (!product) return Response.json({ ok: false, error: "unknown" }, { status: 404 });

    if (action === "enable") {
      if (product.course) return Response.json({ ok: true, courseId: product.course.id });
      const course = emptyCourse();
      const result = await setProductCourse(ref, id, { id: course.id, lessons: 0 });
      if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
      await saveCourse(course, store);
      return Response.json({ ok: true, courseId: course.id });
    }

    if (!product.course) return Response.json({ ok: false, error: "not_course" }, { status: 400 });

    // Comments under lessons (lib/lesson-comments.ts): kept apart from the
    // outline, so none of these waits for the outline's lock.
    if (action.startsWith("cm-")) {
      const courseId = product.course.id;
      if (action === "cm-on") {
        await setCommentsOn(courseId, body.on === true);
        return Response.json({ ok: true });
      }
      const commentId = text(body.comment, 20);
      const comment = COMMENT_ID_PATTERN.test(commentId) ? await readComment(courseId, commentId) : null;
      if (!comment) return Response.json({ ok: false, error: "gone" }, { status: 404 });
      if (action === "cm-hide") {
        await setHidden(courseId, commentId, body.hidden === true);
        return Response.json({ ok: true });
      }
      if (action === "cm-delete") {
        await deleteComment(courseId, commentId, store);
        return Response.json({ ok: true });
      }
      if (action === "cm-reply") {
        const course = await readCourse(courseId);
        const found = course ? findLesson(course, comment.lesson) : null;
        if (!found) return Response.json({ ok: false, error: "gone" }, { status: 404 });
        const result = await addComment({ courseId, lessonId: comment.lesson, by: CREATOR_AUTHOR, text: body.text, parent: comment.parent ?? comment.id, room: store });
        if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
        if (result.parent) {
          await tellStudent({
            store,
            product,
            courseId,
            lessonTitle: found.lesson.title,
            parent: result.parent,
            reply: result.comment,
            origin: originFrom(request),
          }).catch((error) => console.error("a comment answer email failed", error));
        }
        return Response.json({ ok: true, comment: result.comment.id });
      }
      return Response.json({ ok: false, error: "invalid" }, { status: 400 });
    }
    // A student's work read and answered (lib/assignment.ts): kept apart from
    // the outline, so it never waits for the outline's lock.
    if (action === "review") {
      const courseId = product.course.id;
      const course = await readCourse(courseId);
      const found = course ? findLesson(course, text(body.lessonId, 20)) : null;
      const who = text(body.who, 64);
      if (!found?.lesson.task) return Response.json({ ok: false, error: "gone" }, { status: 404 });
      const verdict = body.verdict === "approved" ? "approved" : body.verdict === "again" ? "again" : null;
      if (!verdict) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      const feedback = typeof body.feedback === "string" ? body.feedback : "";
      // Asking for another try without saying what to change leaves the student with nothing to go on.
      if (verdict === "again" && !feedback.trim()) return Response.json({ ok: false, error: "feedback" }, { status: 400 });
      const to = await studentEmail(courseId, who);
      const result = await review({ courseId, lessonId: found.lesson.id, who, email: to ?? "", verdict, feedback, data: store });
      if (!result.ok) return Response.json({ ok: false, error: result.reason === "unknown" ? "gone" : "reviewed" }, { status: 409 });
      // Approved work may be the last lesson of the course (lib/course-finish.ts).
      if (verdict === "approved" && to) await noteIfFinished(store, product.id, courseId, to);
      const told = to
        ? await tellStudentOfReview({
            store,
            product,
            lessonId: found.lesson.id,
            lessonTitle: found.lesson.title,
            to,
            submission: result.submission,
            origin: originFrom(request),
          }).catch((error: unknown) => {
            console.error("a review email failed", error);
            return false;
          })
        : false;
      return Response.json({ ok: true, submission: result.submission, told });
    }

    // One change at a time per course: each reads the whole outline and writes it
    // back, so two at once (two lessons uploading, two tabs) would drop one.
    const courseInfo = product.course;
    return await withLock(`nl:course:${courseInfo.id}:lock`, 60, 15_000, async () => {
      const course = await readCourse(courseInfo.id);
      if (!course) return Response.json({ ok: false, error: "unknown" }, { status: 404 });

      // Every write to the outline goes through here, so the community's
      // search index is level with the course after any of them — including
      // whatever branch is added to this handler next. Indexing never decides
      // whether a save succeeded: the creator's change is written either way.
      const community = communityOf(store);
      const save = async (next: Course) => {
        await saveCourse(next, store);
        if (community) await courseChanged(community, product, course, next).catch(() => {});
      };

      if (action === "disable") {
        if (lessonCount(course) > 0) return Response.json({ ok: false, error: "not_empty" }, { status: 400 });
        const result = await setProductCourse(ref, id, null);
        if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
        await dropCourse(course, store);
        if (community) await unindexCourse(community, product.id, course).catch(() => {});
        await registerDrip(store, product, { ...course, modules: [] });
        return Response.json({ ok: true });
      }

      if (action === "block") {
        const who = text(body.email, 254).trim();
        if (!EMAIL_PATTERN.test(who)) return Response.json({ ok: false, error: "email" }, { status: 400 });
        await setBlocked(store, course.id, who, body.blocked === true);
        return Response.json({ ok: true });
      }

      if (action === "task") {
        const lessonId = text(body.lessonId, 20);
        const found = findLesson(course, lessonId);
        if (!found) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
        if (body.task === null) {
          const result = editCourse(course, { op: "task", lessonId, task: null });
          if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
          await save(result.course);
          // The work handed in for it goes with it, files and all.
          const files = await dropTask(course.id, lessonId, storeKey(store), store);
          if (files.length) await del(files).catch((error: unknown) => console.error("could not delete handed-in work", error));
          return Response.json({ ok: true, course: result.course });
        }
        // A lesson is done by its quiz or by its assignment, never by both.
        if (found.lesson.quiz) return Response.json({ ok: false, error: "quiz_there" }, { status: 400 });
        const read = readTask(body.task);
        if (!read.ok) return Response.json({ ok: false, error: "prompt" }, { status: 400 });
        await saveTask(course.id, lessonId, read.task, store);
        const { prompt: _prompt, ...setup } = read.task;
        void _prompt;
        const result = editCourse(course, { op: "task", lessonId, task: setup });
        if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
        await save(result.course);
        return Response.json({ ok: true, course: result.course, task: read.task });
      }

      if (action === "quiz") {
        const lessonId = text(body.lessonId, 20);
        const hasTask = findLesson(course, lessonId)?.lesson.task;
        if (!findLesson(course, lessonId)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
        if (hasTask && body.quiz !== null) return Response.json({ ok: false, error: "task_there" }, { status: 400 });
        if (body.quiz === null) {
          const result = editCourse(course, { op: "quiz", lessonId, quiz: null });
          if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
          await save(result.course);
          await dropQuiz(course.id, lessonId, store);
          return Response.json({ ok: true, course: result.course });
        }
        const hadQuiz = !!findLesson(course, lessonId)?.lesson.quiz;
        const existingQuiz = hadQuiz ? await readQuizFor(course.id, lessonId) : null;
        if (hadQuiz && !existingQuiz) return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
        const read = readQuiz(body.quiz, existingQuiz);
        if (!read.ok) {
          // Which question, and what is wrong with it, so the studio can say so.
          const at = "at" in read ? read.at : null;
          return Response.json({ ok: false, error: "quiz", problem: { reason: read.reason, at } }, { status: 400 });
        }
        await saveQuiz(course.id, lessonId, read.quiz, store);
        const result = editCourse(course, { op: "quiz", lessonId, quiz: setupOf(read.quiz) });
        if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
        await save(result.course);
        return Response.json({ ok: true, course: result.course, quiz: read.quiz });
      }

      /*
        The course's start date, or null to take it off.
        Sent as a day the creator picked, already turned into seconds at
        midnight in their own zone by the studio, because "the 4th" is a
        different moment in Auckland and in Los Angeles and the one who
        decides which is the creator running the course.
      */
      if (action === "start") {
        const at = body.at === null ? null : Number(body.at);
        const result = editCourse(course, { op: "start", at });
        if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
        await save(result.course);
        return Response.json({ ok: true, course: result.course });
      }

      // A ready structure (540 [CU1]): only its id comes from the browser, and it
      // is applied to the course as kept, under this lock, in one write. A course
      // the creator has touched, or one a structure was already given, is refused.
      if (action === "template") {
        const template = templateById(text(body.template, 20));
        if (!template) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
        const applied = applyTemplate(course, template);
        if (!applied.ok) return Response.json({ ok: false, error: "not_new" }, { status: 409 });
        if (applied.course === course) return Response.json({ ok: true, course });
        // Off the store first: its example titles are never shown to a buyer or put in a module's email. A
        // course a structure fits has no lesson, so nothing of it could be sold yet; publishing it again is
        // refused until every example title is replaced (app/api/store/product/route.ts).
        if (!product.hidden) {
          const hidden = await setProductHidden(ref, id, true);
          if (!hidden.ok) return Response.json({ ok: false, error: hidden.reason }, { status: 400 });
        }
        await save(applied.course);
        const lessons = lessonCount(applied.course);
        if (lessons !== courseInfo.lessons) await setCourseLessons(ref, id, lessons);
        await registerDrip(store, product, applied.course);
        return Response.json({ ok: true, course: applied.course, hidden: true });
      }

      if (action === "cert") {
        const result = editCourse(course, { op: "certificate", on: body.on === true });
        if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
        await save(result.course);
        return Response.json({ ok: true, course: result.course });
      }

      if (action === "withdraw") {
        const certificate = text(body.certificate, 20);
        if (!CERT_ID_PATTERN.test(certificate)) return Response.json({ ok: false, error: "unknown" }, { status: 400 });
        const done = await withdrawCertificate(course.id, certificate);
        return done ? Response.json({ ok: true }) : Response.json({ ok: false, error: "unknown" }, { status: 404 });
      }

      if (action === "retries") {
        const who = text(body.email, 254).trim();
        if (!EMAIL_PATTERN.test(who)) return Response.json({ ok: false, error: "email" }, { status: 400 });
        await resetTries(course, emailKey(who), store);
        return Response.json({ ok: true });
      }

      if (action === "body") {
        const lessonId = text(body.lessonId, 20);
        if (!findLesson(course, lessonId)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
        const cleaned = cleanBody(body.text);
        await saveBody(course.id, lessonId, cleaned, store);
        const found = findLesson(course, lessonId)!;
        const result = editCourse(course, {
          op: "lesson-edit",
          lessonId,
          title: found.lesson.title,
          preview: found.lesson.preview,
          link: found.lesson.link,
          hasBody: cleaned.length > 0,
        });
        if (!result.ok) return Response.json({ ok: false, error: result.reason }, { status: 400 });
        await save(result.course);
        return Response.json({ ok: true, course: result.course });
      }

      let edit: CourseEdit;
      // Where a video just put on a lesson stands at the video service, for the studio to say.
      let stream: StreamState | null = null;
      if (action === "media") {
        const lessonId = text(body.lessonId, 20);
        const pathname = text(body.pathname, 400);
        const kind = body.kind === "video" ? "video" : "file";
        if (!findLesson(course, lessonId)) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
        // The file has to sit in this account's folder for this very lesson,
        // and what it is is read from storage, not from the browser.
        const folder = await storeFolder(ref);
        let file: ProductFile;
        if (kind === "video" && isStreamPath(pathname)) {
          // A video sent to the service that keeps it in several sizes
          // (lib/stream.ts): it has to be the one whose door was opened for
          // this store and this lesson, and what it is comes from what was
          // written down then, not from the browser.
          const record = await claimUpload(pathname, folder, lessonId);
          if (!record) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
          stream = record.state;
          file = { pathname, name: record.name, bytes: record.bytes, contentType: record.type, addedAt: new Date().toISOString() };
        } else {
          if (!ownsPath(pathname, folder, lessonId)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
          const found = await head(pathname);
          file = {
            pathname,
            name: safeFileName(text(body.name, 200) || found.pathname),
            bytes: found.size,
            contentType: found.contentType,
            addedAt: new Date().toISOString(),
          };
        }
        edit = { op: "media", lessonId, kind, file };
      } else if (action === "edit") {
        const op = text(body.op, 20);
        if (!OPS.has(op)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
        const direction = body.direction === "up" ? "up" : "down";
        if (op === "lesson-edit") {
          // One past the length kept, so a longer link is refused as too long rather than cut and kept broken.
          const rawLink = text(body.link, MAX_LINK_LENGTH + 1).trim();
          let link: string | null = null;
          if (rawLink) {
            const read = readLink(rawLink);
            if (!read.ok) return Response.json({ ok: false, error: "link", reason: read.reason }, { status: 400 });
            link = read.url;
          }
          edit = { op, lessonId: text(body.lessonId, 20), title: body.title, preview: body.preview, link };
        } else if (op === "outline") {
          const asked = Array.isArray(body.modules) ? body.modules.slice(0, MAX_AI_MODULES) : [];
          edit = {
            op,
            modules: asked.map((m) => {
              const unit = (m && typeof m === "object" ? m : {}) as { title?: unknown; lessons?: unknown };
              return { title: unit.title, lessons: Array.isArray(unit.lessons) ? unit.lessons.slice(0, MAX_AI_LESSONS) : [] };
            }),
          };
        } else if (op === "module-add") edit = { op, title: body.title };
        else if (op === "module-edit") edit = { op, moduleId: text(body.moduleId, 20), title: body.title, dripDays: body.dripDays };
        else if (op === "module-move") edit = { op, moduleId: text(body.moduleId, 20), direction };
        else if (op === "module-remove") edit = { op, moduleId: text(body.moduleId, 20) };
        else if (op === "lesson-add") edit = { op, moduleId: text(body.moduleId, 20), title: body.title };
        else if (op === "lesson-move") edit = { op, lessonId: text(body.lessonId, 20), direction };
        else if (op === "lesson-remove") edit = { op, lessonId: text(body.lessonId, 20) };
        else edit = { op: "media-remove", lessonId: text(body.lessonId, 20), pathname: text(body.pathname, 400) };
      } else {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }

      const result = editCourse(course, edit);
      if (!result.ok) {
        return Response.json({ ok: false, error: result.reason }, { status: result.reason === "unknown" ? 404 : 400 });
      }
      await save(result.course);
      const lessons = lessonCount(result.course);
      if (lessons !== courseInfo.lessons) await setCourseLessons(ref, id, lessons);
      if (edit.op === "lesson-remove") {
        await dropBody(course.id, edit.lessonId, store);
        await dropQuiz(course.id, edit.lessonId, store);
      }
      if (edit.op === "lesson-remove" || edit.op === "module-remove") {
        const kept = new Set(lessonsInOrder(result.course).map(({ lesson }) => lesson.id));
        const goneLessons = lessonsInOrder(course).filter(({ lesson }) => !kept.has(lesson.id));
        const gone = goneLessons.map(({ lesson }) => lesson.id);
        await dropLessonComments(course.id, gone, store).catch((error) => console.error("could not delete a lesson's comments", error));
        // An assignment goes with its lesson, and the work handed in for it.
        for (const { lesson } of goneLessons) {
          if (!lesson.task) continue;
          const files = await dropTask(course.id, lesson.id, storeKey(store), store).catch(() => [] as string[]);
          if (files.length) await del(files).catch((error: unknown) => console.error("could not delete handed-in work", error));
        }
      }
      if (edit.op === "module-edit" || edit.op === "module-remove" || edit.op === "lesson-add" || edit.op === "outline") {
        await registerDrip(store, product, result.course);
      }

      // Storage is released only after the record that no longer points at it
      // is written, the same order every other file here is handled in.
      for (const file of result.removed) {
        if (filesInCourse(result.course).some((f) => f.pathname === file.pathname)) continue;
        // A video the video service keeps is taken away there; anything else, from the file store.
        if (await dropStream(file.pathname, store).catch(() => false)) continue;
        await del(file.pathname).catch((error: unknown) => console.error("could not delete a lesson file", error));
      }
      return Response.json({ ok: true, course: result.course, addedId: result.addedId, ...(stream ? { stream } : {}) });
    });
  } catch (error) {
    if (error instanceof LockBusyError) return Response.json({ ok: false, error: "busy" }, { status: 409 });
    // What does not fit in the store's data room is not written (lib/store-data.ts).
    if (error instanceof DataRoomError) return Response.json({ ok: false, error: "store_full", message: error.message }, { status: 409 });
    console.error("changing a course failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
