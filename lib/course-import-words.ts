/**
 * The words of the studio's course import box (260 [KJ5], unit 4): where
 * a problem is, said as a person reads the course ("Module 2, lesson 3, its
 * text"), and what to do about each problem the import route answers.
 * Browser-safe: plain data and pure functions. US English, plain.
 */
import { COURSE_IMPORT_FORMAT } from "@/lib/course-import";
import { IMPORT_MAX_BYTES } from "@/lib/course-import-apply";

const FIELDS: Record<string, string> = { title: "its title", text: "its text", video: "its video", files: "its downloads", lessons: "its lessons" };
const TOP: Record<string, string> = { file: "The file", ownsContent: "The line that says you own the content", title: "The course's title", modules: "The modules" };

/** A place in the outline, in words: "modules[1].lessons[2].text" is "Module 2, lesson 3, its text". */
export function placeWords(path: string): string {
  if (Object.hasOwn(TOP, path)) return TOP[path];
  const found = /^modules\[(\d+)\](?:\.lessons\[(\d+)\])?(?:\.(title|text|video|files|lessons))?(?:\[(\d+)\])?$/.exec(path);
  if (!found) return "The file";
  const [, mod, lesson, field, file] = found;
  const parts = [`Module ${Number(mod) + 1}`];
  if (lesson !== undefined) parts.push(`lesson ${Number(lesson) + 1}`);
  if (field === "files" && file !== undefined) parts.push(`download ${Number(file) + 1}`);
  else if (field) parts.push(FIELDS[field]);
  return parts.join(", ");
}

export type ImportAnswer = { error?: string; path?: string; reason?: string; message?: string };

/** What to tell the creator about an answer that was not ok: always what happened and what to do. */
export function importProblem(answer: ImportAnswer): string {
  switch (answer.error) {
    case "invalid":
      return answer.path && answer.reason ? `${placeWords(answer.path)}: ${answer.reason}` : "This file can't be read as a course outline. Nothing was imported.";
    case "not_new":
      return "This course already has your changes, so an outline can't be brought into it. Make a new course for it instead.";
    case "store_full":
      return `${answer.message ?? "Your store's data room is full."} Nothing was imported.`;
    case "busy":
      return "This course is being saved somewhere else. Try again in a moment. Nothing was imported.";
    case "too_large":
      return `This file is larger than ${IMPORT_MAX_BYTES / 1_000_000} MB. Split the course into smaller outlines.`;
    default:
      // The studio's own refusals (its requests used up, a session that needs signing in again) carry their own words.
      return answer.message ?? "Something went wrong, and nothing was imported. Try again.";
  }
}

/** A complete outline, shown as the format's example; the preview accepts it as it is. */
export const IMPORT_EXAMPLE = JSON.stringify(
  {
    format: COURSE_IMPORT_FORMAT,
    ownsContent: true,
    title: "Bread at home",
    modules: [
      {
        title: "Start here",
        lessons: [
          { title: "Welcome", text: "What you will bake, and what you need.", video: "media/welcome.mp4", files: ["files/shopping-list.pdf"] },
          { title: "Your first loaf", text: "Mix, rest, shape and bake.", video: null, files: [] },
        ],
      },
    ],
  },
  null,
  2,
);
