/**
 * Item 260 [KJ5], unit 1: read a creator-authored outline, not a vendor export.
 * Pure, with no caller yet. Local paths are references, never stored files or
 * URLs. A successful preview is not permission to upload, spend or publish.
 */
import { MAX_MODULES, MAX_LESSONS, MAX_LESSON_FILES, MAX_ITEM_TITLE, MAX_BODY_LENGTH } from "@/lib/course";

export const COURSE_IMPORT_FORMAT = "marktmorgen-course-draft-v1";
/** Parsing ceiling only; does not change any plan's entitlement. Check before JSON.parse. */
export const MAX_COURSE_IMPORT_BYTES = 16 * 1024 * 1024;
export type CourseImportLesson = { title: string; text: string; video: string | null; files: string[] };
export type CourseImportDraft = { title: string; modules: { title: string; lessons: CourseImportLesson[] }[] };
export type CourseImportPreview =
  | { ok: true; state: "preview_only"; draft: CourseImportDraft; assets: string[]; lessonCount: number; storageBytes: null; videoSeconds: null; costUsd: null }
  | { ok: false; path: string; reason: string };

const refuse = (path: string, reason: string): CourseImportPreview => ({ ok: false, path, reason });
const record = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const title = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ITEM_TITLE && !/[\u0000-\u001f\u007f]/.test(value);

/** No absolute paths, traversal, URL/drive syntax, escapes or hidden direction controls. */
function localPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\\:%?#\u0000-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part === part.trim());
}

/** Accept only serialized data. Objects, getters and proxies are never inspected. */
export function previewCourseImport(raw: unknown): CourseImportPreview {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_COURSE_IMPORT_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_COURSE_IMPORT_BYTES) {
    return refuse("file", "Choose a course outline JSON file no larger than 16 MiB.");
  }
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return refuse("file", "This file is not valid JSON."); }
  if (!record(data, ["format", "ownsContent", "title", "modules"]) || data.format !== COURSE_IMPORT_FORMAT) {
    return refuse("file", "Use the Marktmorgen course outline format. Other platforms' export files are not supported here.");
  }
  if (data.ownsContent !== true) return refuse("ownsContent", "Confirm that you own or have permission to use all of this course's content.");
  if (!title(data.title)) return refuse("title", "Give the course a title within the course editor's title limit.");
  if (!Array.isArray(data.modules) || data.modules.length < 1 || data.modules.length > MAX_MODULES) {
    return refuse("modules", `Include from 1 to ${MAX_MODULES} modules. Nothing has been imported.`);
  }
  const modules: CourseImportDraft["modules"] = [];
  const assets = new Map<string, string>();
  const addPath = (value: string): boolean => {
    const key = value.normalize("NFC").toLowerCase();
    const previous = assets.get(key);
    if (previous !== undefined && previous !== value) return false;
    assets.set(key, value);
    return true;
  };
  let lessonCount = 0;
  for (let m = 0; m < data.modules.length; m++) {
    const unit: unknown = data.modules[m];
    const path = `modules[${m}]`;
    if (!record(unit, ["title", "lessons"])) return refuse(path, "Each module needs only a title and its lessons. Unsupported fields were not imported.");
    if (!title(unit.title)) return refuse(`${path}.title`, "Give this module a title within the course editor's title limit.");
    if (!Array.isArray(unit.lessons) || unit.lessons.length < 1 || unit.lessons.length > MAX_LESSONS - lessonCount) {
      return refuse(`${path}.lessons`, `Each module needs a lesson, with at most ${MAX_LESSONS} lessons across the course. Nothing was trimmed or imported.`);
    }
    const lessons: CourseImportLesson[] = [];
    for (let l = 0; l < unit.lessons.length; l++) {
      const item: unknown = unit.lessons[l];
      const at = `${path}.lessons[${l}]`;
      if (!record(item, ["title", "text", "video", "files"])) return refuse(at, "Each lesson needs only title, text, video and files. Unsupported fields were not imported.");
      if (!title(item.title)) return refuse(`${at}.title`, "Give this lesson a title within the course editor's title limit.");
      if (typeof item.text !== "string" || item.text.length > MAX_BODY_LENGTH) return refuse(`${at}.text`, "Use plain lesson text within the course editor's text limit.");
      const video = item.video;
      if (video !== null && (!localPath(video) || !addPath(video))) return refuse(`${at}.video`, "Choose an unambiguous local file path. Links and paths outside the chosen files are not supported.");
      if (!Array.isArray(item.files) || item.files.length > MAX_LESSON_FILES) return refuse(`${at}.files`, `A lesson can have at most ${MAX_LESSON_FILES} downloads. Nothing was trimmed or imported.`);
      const files: string[] = [];
      for (let f = 0; f < item.files.length; f++) {
        const file: unknown = item.files[f];
        if (!localPath(file) || !addPath(file)) return refuse(`${at}.files[${f}]`, "Choose an unambiguous local file path. Links and paths outside the chosen files are not supported.");
        files.push(file);
      }
      lessons.push({ title: item.title, text: item.text, video, files });
      lessonCount++;
    }
    modules.push({ title: unit.title, lessons });
  }
  return { ok: true, state: "preview_only", draft: { title: data.title, modules }, assets: [...assets.values()], lessonCount, storageBytes: null, videoSeconds: null, costUsd: null };
}
