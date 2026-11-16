import { COURSE_IMPORT_FORMAT, previewCourseImport } from "@/lib/course-import";
import { done, is, part } from "./check";

function outline(video: string | null, files: string[]) {
  return JSON.stringify({ format: COURSE_IMPORT_FORMAT, ownsContent: true, title: "Synthetic outline", modules: [{ title: "Module", lessons: [{ title: "Lesson", text: "", video, files }] }] });
}

part("Different invalid UTF-16 names are not different UTF-8 files");
const first = "assets/\ud800.bin", second = "assets/\ud801.bin";
is("the source strings differ", Object.is(first, second), false);
is("the encoded filenames collide", [...new TextEncoder().encode(first)], [...new TextEncoder().encode(second)]);
const ambiguous = previewCourseImport(outline(null, [first, second]));
is("the preview refuses the whole ambiguous asset list", ambiguous.ok, false);

part("Reject unpaired high and low surrogates in every asset position");
for (const value of ["\ud800", "\udbff", "\udc00", "\udfff", "\ud800x", "x\udc00", "\ud800\ud800", "\udc00\udc00"]) {
  const path = `assets/${value}.bin`;
  for (const kind of ["video", "file"] as const) {
    const result = previewCourseImport(outline(kind === "video" ? path : null, kind === "file" ? [path] : []));
    is(`${kind} refuses ${JSON.stringify(value)} before returning a draft`, result.ok, false);
  }
}

part("Valid Unicode paths are preserved, including surrogate pairs and a literal replacement character");
for (const value of ["\ud800\udc00", "\udbff\udfff", "\ud83d\udcc4", "\ufffd", "資料", "café"]) {
  const path = `assets/${value}.bin`;
  const video = previewCourseImport(outline(path, []));
  is(`valid video ${JSON.stringify(value)} stays exact`, video.ok ? video.assets : video, [path]);
  const file = previewCourseImport(outline(null, [path]));
  is(`valid download ${JSON.stringify(value)} stays exact`, file.ok ? file.assets : file, [path]);
}
const valid = previewCourseImport(outline("assets/lesson.mp4", ["assets/notes.pdf"]));
is("this remains an uncosted preview without stored files", valid.ok ? [valid.state, valid.storageBytes, valid.videoSeconds, valid.costUsd] : valid, ["preview_only", null, null, null]);
done();
