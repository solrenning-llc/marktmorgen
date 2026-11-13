/**
 * The studio's course page in tabs (issue #4304; shape decided by the coordinator on 13/11/2026, unit A): each
 * tab is its own address (?tab=…&page=…), and a load reads only what that tab shows, a page at a time, so its
 * worst case fits the STUDIO_PAGE_UNITS the page is counted at. tests/course-tab-reads.test.ts adds up each tab's
 * worst case against that figure and fails when one goes past it.
 *
 * The lessons tab ("course") still reads every lesson video's state in this unit; reading it when a lesson is
 * opened is unit B. The students and certificates tabs walk a cursor (unit C), in no set order: an ordered index
 * with a migration of the data is a future item for the owner to decide (MODO PRODUZIR).
 */
import { certificatesPage } from "@/lib/certificate";
import type { Course } from "@/lib/course";
import { lessonsInOrder } from "@/lib/course";
import { emailKey, studentEmail, studentsPage } from "@/lib/learn";
import { passedFor } from "@/lib/quiz";
import { isUnreadSubmission, submissionsOf, waitingWork } from "@/lib/assignment";
import { recentComments } from "@/lib/lesson-comments";
import { readCardsOnly, visibleIds } from "@/lib/catalog";
import type { Store } from "@/lib/store";
import { streamCaptions, streamStates } from "@/lib/stream";
import { autoWriting } from "@/lib/auto-captions";

export const COURSE_TABS = ["course", "videos", "shelf", "work", "comments", "students", "certificates"] as const;
export type CourseTab = (typeof COURSE_TABS)[number];

/** How many rows a tab shows at a time, each sized so the tab's worst case fits the page's reads. */
export const COURSE_TAB_PAGE: Record<Exclude<CourseTab, "course" | "videos" | "shelf">, number> = {
  // A piece of work can hold MAX_ANSWER_TEXT and MAX_FEEDBACK characters (up to ~44 KB): three fit the page's
  // bytes with the ids of every page before it (MAX_WORK_PAGES).
  work: 3,
  // A comment holds MAX_LESSON_COMMENT characters (up to ~8 KB in four-byte characters): twenty fit.
  comments: 20,
  students: 25,
  certificates: 25,
};

/** The most pages a tab offers; past it the page says how many more there are instead of linking to them. */
export const MAX_TAB_PAGES = 400;
/** The work tab reads the ids of every page before the one shown (lib/assignment.ts has no offset yet), so fewer. */
export const MAX_WORK_PAGES = 250;

export function courseTab(raw: unknown): CourseTab {
  return typeof raw === "string" && (COURSE_TABS as readonly string[]).includes(raw) ? (raw as CourseTab) : "course";
}

export function tabPage(raw: unknown): number {
  const n = typeof raw === "string" && /^[1-9][0-9]{0,3}$/.test(raw) ? Number(raw) : 1;
  return Math.min(n, MAX_TAB_PAGES);
}

/** The work handed in, one page of it: the ids of the first pages are read (cheap), the records of this page only. */
export async function workTab(courseId: string, pageAsked: number, all: boolean) {
  const size = COURSE_TAB_PAGE.work;
  const page = Math.min(pageAsked, MAX_WORK_PAGES);
  const listed = await waitingWork(courseId, size * page, all);
  const rows = listed.rows.slice(size * (page - 1), size * page);
  const [handed, addresses] = await Promise.all([submissionsOf(courseId, rows), Promise.all(rows.map((row) => studentEmail(courseId, row.who).catch(() => null)))]);
  return { rows, handed, addresses, total: listed.total, unread: rows.filter((_, i) => isUnreadSubmission(handed[i])).length };
}

export async function commentsTab(courseId: string, page: number) {
  const size = COURSE_TAB_PAGE.comments;
  return recentComments(courseId, size, size * (page - 1));
}

/** The most bytes one load's answers may come to: STUDIO_PAGE_UNITS studio requests of 50 KB each. */
export const TAB_BYTES = 200_000;

/** A cursor as it comes in the address: digits, else the first page ("0"). */
export function tabCursor(raw: unknown): string {
  return typeof raw === "string" && /^[0-9]{1,20}$/.test(raw) ? raw : "0";
}

/** A page of the students by cursor (unit C); null when they could not be read (rule 24). */
export async function studentsTab(course: Course, cursor: string) {
  const read = await studentsPage(course, cursor, COURSE_TAB_PAGE.students, TAB_BYTES).catch(() => null);
  if (!read) return null;
  const quizLessons = lessonsInOrder(course).filter(({ lesson }) => lesson.quiz).map(({ lesson }) => lesson.id);
  const passed = quizLessons.length && read.students.length ? await passedFor(course.id, read.students.map((s) => emailKey(s.email))) : [];
  return { ...read, quizLessons, passed };
}

/** A page of the certificates by cursor (unit C); null when they could not be read (rule 24). */
export async function certificatesTab(courseId: string, cursor: string) {
  return certificatesPage(courseId, cursor, COURSE_TAB_PAGE.certificates, TAB_BYTES).catch(() => null);
}

/**
 * Lesson videos the Videos tab checks at a time (unit B): three reads a video (its state, its captions, its AI
 * captions), so twenty fit the page's reads with room.
 */
export const VIDEO_BLOCK = 20;

/**
 * One block of the course's lesson videos, in course order, with their states, captions and AI captions: what the
 * captions check reads. `from`–`to` of `total` say which lessons these are. Null when they could not be read.
 */
export async function videosTab(course: Course, pageAsked: number) {
  const all = lessonsInOrder(course).flatMap(({ lesson }) => (lesson.video ? [{ id: lesson.id, path: lesson.video.pathname }] : []));
  const pages = Math.max(1, Math.ceil(all.length / VIDEO_BLOCK));
  const page = Math.min(Math.max(1, pageAsked), pages);
  const block = all.slice((page - 1) * VIDEO_BLOCK, page * VIDEO_BLOCK);
  const paths = block.map((v) => v.path);
  try {
    const [states, captions, writing] = await Promise.all([streamStates(paths), streamCaptions(paths), autoWriting(paths)]);
    return { page, pages, from: block.length ? (page - 1) * VIDEO_BLOCK + 1 : 0, to: (page - 1) * VIDEO_BLOCK + block.length, total: all.length, only: new Set(block.map((v) => v.id)), states, captions, writing };
  } catch {
    return null;
  }
}

/** Products the Shelf tab offers at a time (unit E): their cards in one HMGET, with the six already chosen. */
export const SHELF_PAGE = 25;

/**
 * One page of the store's products to put on the course's "More from" shelf, in the creator's order, read from
 * their cards only (never healed from a listing on a load): `options` this page's products but the course, `saved`
 * the shelf as chosen, and `unnamed` how many asked had no card to read, said on the page as such.
 */
export async function shelfTab(store: Store, course: Course, productId: string, pageAsked: number) {
  const all = visibleIds(store).filter((pid) => pid !== productId);
  const pages = Math.max(1, Math.ceil(all.length / SHELF_PAGE));
  const page = Math.min(Math.max(1, pageAsked), pages);
  const shown = all.slice((page - 1) * SHELF_PAGE, page * SHELF_PAGE);
  const chosen = (course.shelf ?? []).slice(0, 6);
  const read = await readCardsOnly(store, [...shown, ...chosen]);
  const pick = (pid: string) => (read.found.has(pid) ? [{ id: pid, title: read.found.get(pid)!.title }] : []);
  return { page, pages, total: all.length, options: shown.flatMap(pick), saved: chosen.flatMap(pick), unnamed: shown.filter((pid) => !read.found.has(pid)).length };
}
