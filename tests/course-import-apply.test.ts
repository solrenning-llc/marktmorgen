/**
 * 260 [KJ5], unit 2: an outline the preview accepted (lib/course-import.ts)
 * is applied to a new course through the course's own edits (lib/course.ts),
 * whole or not at all: modules, lesson titles and lesson text in order.
 * Videos and files are only listed as still to upload. Anything the course
 * editor's own cleaning would change is listed before saving, never changed
 * silently. Pure: nothing is read, written, uploaded or spent.
 */
import { COURSE_IMPORT_FORMAT, previewCourseImport, type CourseImportDraft } from "@/lib/course-import";
import { planCourseImport } from "@/lib/course-import-apply";
import { MAX_LESSONS, MAX_MODULES, cleanBody, editCourse, emptyCourse, lessonCount, lessonsInOrder } from "@/lib/course";
import { done, is, part } from "./check";

function draftOf(modules: CourseImportDraft["modules"]): CourseImportDraft {
  const preview = previewCourseImport(JSON.stringify({ format: COURSE_IMPORT_FORMAT, ownsContent: true, title: "Pottery basics", modules }));
  if (!preview.ok) throw new Error(`fixture refused: ${preview.path} ${preview.reason}`);
  return preview.draft;
}

const draft = draftOf([
  { title: "Start here", lessons: [
    { title: "Welcome", text: "Clay, water and patience.", video: "media/welcome.mp4", files: ["files/kit.pdf"] },
    { title: "Tools", text: "", video: null, files: [] },
  ] },
  { title: "Throwing", lessons: [{ title: "Centering", text: "Keep your elbows in.", video: "media/center.mp4", files: [] }] },
]);

part("A new course takes the whole outline, in order");
const fresh = emptyCourse();
const plan = planCourseImport(fresh, draft);
if (!plan.ok) throw new Error("refused");
is("modules in order", plan.course.modules.map((m) => m.title), ["Start here", "Throwing"]);
is("the new course's own empty module is gone", plan.course.modules.some((m) => m.id === fresh.modules[0].id), false);
is("lessons in order", lessonsInOrder(plan.course).map(({ lesson }) => lesson.title), ["Welcome", "Tools", "Centering"]);
is("same course id", plan.course.id, fresh.id);
is("nothing opens later, no certificate", [plan.course.modules.every((m) => m.dripDays === 0), plan.course.certificate], [true, false]);
const ids = lessonsInOrder(plan.course).map(({ lesson }) => lesson.id);
is("text to save for each lesson that has it, by its new id", plan.bodies, [
  { lessonId: ids[0], text: "Clay, water and patience." },
  { lessonId: ids[2], text: "Keep your elbows in." },
]);
is("only lessons with text say they have it", lessonsInOrder(plan.course).map(({ lesson }) => lesson.hasBody), [true, false, true]);
is("videos and files only listed, still to upload", plan.toUpload, [
  { lessonId: ids[0], kind: "video", path: "media/welcome.mp4" },
  { lessonId: ids[0], kind: "file", path: "files/kit.pdf" },
  { lessonId: ids[2], kind: "video", path: "media/center.mp4" },
]);
is("no media attached yet", lessonsInOrder(plan.course).every(({ lesson }) => lesson.video === null && lesson.files.length === 0), true);
is("nothing changed by cleaning", plan.changed, []);
is("the course given is not touched", fresh.modules.length === 1 && fresh.modules[0].lessons.length === 0, true);

part("A course the creator already touched is never written over");
const touched = editCourse(fresh, { op: "module-edit", moduleId: fresh.modules[0].id, title: "Mine", dripDays: 0 });
if (!touched.ok) throw new Error("edit");
is("refused", planCourseImport(touched.course, draft), { ok: false, why: "not-new" });

part("What the editor's own cleaning would change is listed, never changed silently");
const messy = draftOf([{ title: "Start  here", lessons: [{ title: " Welcome", text: "Line one\r\nLine two\n", video: null, files: [] }] }]);
const cleaned = planCourseImport(emptyCourse(), messy);
if (!cleaned.ok) throw new Error("refused");
is("listed by place", cleaned.changed, [
  { path: "modules[0].title", from: "Start  here", to: "Start here" },
  { path: "modules[0].lessons[0].title", from: " Welcome", to: "Welcome" },
  { path: "modules[0].lessons[0].text", from: "Line one\r\nLine two\n", to: cleanBody("Line one\r\nLine two\n") },
]);
is("saved as the editor keeps it", cleaned.bodies[0].text, "Line one\nLine two");

part("At the course editor's own module limit (Claude 3 on #3816)");
const most = draftOf(Array.from({ length: MAX_MODULES }, (_, i) => ({ title: `M${i + 1}`, lessons: [{ title: "L", text: "", video: null, files: [] }] })));
const allModules = planCourseImport(emptyCourse(), most);
is("an outline the preview takes fits whole", allModules.ok && allModules.course.modules.length, MAX_MODULES);

part("At the course editor's own lesson limit, whole or nothing");
const many = draftOf([{ title: "All", lessons: Array.from({ length: MAX_LESSONS }, (_, i) => ({ title: `L${i + 1}`, text: "", video: null, files: [] })) }]);
const full = planCourseImport(emptyCourse(), many);
is("all of them fit", full.ok && lessonCount(full.course), MAX_LESSONS);
done();
