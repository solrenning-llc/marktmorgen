/** Synthetic creator-authored manifests, never claimed as vendor exports. */
import { COURSE_IMPORT_FORMAT, MAX_COURSE_IMPORT_BYTES, previewCourseImport, type CourseImportLesson } from "@/lib/course-import";
import { MAX_MODULES, MAX_LESSONS, MAX_LESSON_FILES, MAX_ITEM_TITLE, MAX_BODY_LENGTH } from "@/lib/course";
import { done, is, part } from "./check";

const lesson = (): CourseImportLesson => ({ title: "Welcome", text: "First paragraph.\n\nSecond paragraph.", video: "media/welcome.mp4", files: ["files/worksheet.pdf"] });
const manifest = () => ({ format: COURSE_IMPORT_FORMAT, ownsContent: true, title: "A course", modules: [{ title: "Start here", lessons: [lesson()] }] });
const read = (value: unknown) => previewCourseImport(JSON.stringify(value));
const good = read(manifest());
part("A course preview, with no stored asset or funding claimed");
is("a creator-authored file can be previewed", good.ok, true);
is("the full outline and text stay in their original order", good.ok ? good.draft : null, { title: "A course", modules: manifest().modules });
is("all assets are local references only", good.ok ? good.assets : null, ["media/welcome.mp4", "files/worksheet.pdf"]);
is("size, video duration and supplier cost stay unknown", good.ok ? [good.state, good.lessonCount, good.storageBytes, good.videoSeconds, good.costUsd] : null, ["preview_only", 1, null, null, null]);
const textOnly = manifest(); textOnly.modules[0].lessons[0] = { ...lesson(), video: null, files: [], text: "Texto próprio — 日本語" };
is("a text-only course keeps Unicode", read(textOnly).ok, true);
const shared = manifest(); shared.modules[0].lessons.push(lesson());
const sharedPreview = read(shared);
is("an exact repeated asset reference is listed once without removing lessons", sharedPreview.ok ? [sharedPreview.assets.length, sharedPreview.lessonCount] : null, [2, 2]);

part("Invalid courses are refused whole, without dropping lessons or fields");
for (const value of [null, [], {}, { ...manifest(), ownsContent: false }, { ...manifest(), ownsContent: "true" }, { ...manifest(), format: "kajabi-export" }, { ...manifest(), title: " " }, { ...manifest(), ignored: true }, { ...manifest(), modules: [] }, { ...manifest(), modules: [null] }]) is("invalid top-level content is refused", read(value).ok, false);
for (const key of ["format", "ownsContent", "title", "modules"] as const) {
  const value: Record<string, unknown> = manifest(); delete value[key];
  is(`required own field ${key}`, read(value).ok, false);
}
for (const bad of [{ title: "Empty", lessons: [] }, { title: "Bad", lessons: [null] }, { ...manifest().modules[0], dripDays: 5 }]) is("unsupported module content is refused", read({ ...manifest(), modules: [bad] }).ok, false);
for (const bad of [{ ...lesson(), quiz: {} }, { ...lesson(), preview: true }, { ...lesson(), text: 5 }, { ...lesson(), title: "" }, { ...lesson(), files: [null] }, { ...lesson(), files: {} }, { ...lesson(), video: {} }]) is("unsupported lesson content is refused", read({ ...manifest(), modules: [{ title: "Unit", lessons: [bad] }] }).ok, false);
const broken = manifest(); broken.modules[0].lessons.push({ ...lesson(), title: "" });
const rejected = read(broken);
is("a later invalid lesson rejects the course, with its exact location", rejected.ok ? null : rejected.path, "modules[0].lessons[1].title");
is("a rejection never returns a partial draft", Object.hasOwn(rejected, "draft"), false);

part("Existing course limits, without truncation");
const atLimit = manifest(); atLimit.modules = Array.from({ length: MAX_MODULES }, (_, i) => ({ title: `Module ${i}`, lessons: Array.from({ length: i === 0 ? MAX_LESSONS - MAX_MODULES + 1 : 1 }, lesson) }));
is("all existing modules and lessons fit", read(atLimit).ok, true);
atLimit.modules[1].lessons.push(lesson());
is("the course-wide lesson ceiling counts every module", read(atLimit).ok, false);
is("too many modules are refused", read({ ...manifest(), modules: Array.from({ length: MAX_MODULES + 1 }, () => manifest().modules[0]) }).ok, false);
for (const bad of [{ ...lesson(), title: "x".repeat(MAX_ITEM_TITLE + 1) }, { ...lesson(), text: "x".repeat(MAX_BODY_LENGTH + 1) }, { ...lesson(), files: Array.from({ length: MAX_LESSON_FILES + 1 }, (_, i) => `file${i}.pdf`) }]) is("a field past its existing course ceiling is refused", read({ ...manifest(), modules: [{ title: "Unit", lessons: [bad] }] }).ok, false);
is("exact title and body ceilings are accepted", read({ ...manifest(), title: "x".repeat(MAX_ITEM_TITLE), modules: [{ title: "M", lessons: [{ ...lesson(), title: "x".repeat(MAX_ITEM_TITLE), text: "x".repeat(MAX_BODY_LENGTH) }] }] }).ok, true);

part("Local paths, never a remote fetch or an archive traversal");
for (const path of ["https://example.com/a.mp4", "//example.com/a.mp4", "/etc/passwd", "../x", "a/../x", "a/./x", "a//x", "a\\x", "C:/x", "a%2fx", "a?secret=x", "a#x", "a\u0000x", "a\u202ex", "a/", "./x", "a ", " a", "x".repeat(257)]) {
  is("an unsafe video reference is refused", read({ ...manifest(), modules: [{ title: "Unit", lessons: [{ ...lesson(), video: path }] }] }).ok, false);
  is("an unsafe download reference is refused", read({ ...manifest(), modules: [{ title: "Unit", lessons: [{ ...lesson(), files: [path] }] }] }).ok, false);
}
for (const files of [["files/A.pdf", "files/a.pdf"], ["files/é.pdf", "files/e\u0301.pdf"]]) is("ambiguous local asset names are refused", read({ ...manifest(), modules: [{ title: "Unit", lessons: [{ ...lesson(), files }] }] }).ok, false);
is("ordinary Unicode filenames are preserved", read({ ...manifest(), modules: [{ title: "Unit", lessons: [{ ...lesson(), files: ["files/aula própria.pdf"] }] }] }).ok, true);

part("Untrusted inputs and no IO");
let touched = 0;
const trap = new Proxy({}, { get() { touched++; throw Error("must not inspect"); }, ownKeys() { touched++; throw Error("must not inspect"); } });
for (const raw of [trap, new String("{}"), true, 5, "", "{", "null", "[]", "x".repeat(MAX_COURSE_IMPORT_BYTES + 1)]) is("not a bounded JSON string: refused", previewCourseImport(raw).ok, false);
is("no user getter or proxy trap ran", touched, 0);
const wide = previewCourseImport('"' + "é".repeat(MAX_COURSE_IMPORT_BYTES / 2) + '"');
is("the parsing ceiling counts UTF-8 bytes, before parsing", wide.ok ? null : wide.reason, "Choose a course outline JSON file no larger than 16 MiB.");
is("an explicit prototype key is refused", previewCourseImport(JSON.stringify(manifest()).replace('"title":"A course"', '"__proto__":{"polluted":true},"title":"A course"')).ok, false);
is("Object.prototype is unchanged", Object.hasOwn(Object.prototype, "polluted"), false);
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = (() => { touched++; throw Error("no fetch"); }) as typeof fetch;
  const before = touched; read(manifest()); is("a preview makes no network request", touched, before);
} finally { globalThis.fetch = originalFetch; }
done();
