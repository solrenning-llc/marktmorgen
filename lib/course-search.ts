/**
 * "Find a lesson" on a course's front door (291 [SQ2], unit 1).
 *
 * A student types a word and the course's outline narrows to the lessons
 * whose title, or whose module's name ("Module 2", "Cutting"), holds every
 * word typed. It runs in the student's browser over the outline the page
 * already drew (components/course-outline.tsx marks it with data-find-*), so
 * a search reads nothing, sends nothing and costs nothing: no request, no
 * database command, no supplier. That is also why no per-minute limit is
 * needed here; one becomes needed with unit 2, when lesson text and
 * transcripts are searched on the server from an index built on publishing.
 *
 * What is searched is what the outline shows a title as, so what a student
 * sees is what they can find. A lesson that is locked stays locked: the
 * outline draws it as it always did, only fewer lessons are left in view.
 *
 * This file has no server imports: the page's client code uses it as it is.
 */

/** Below this many lessons the outline fits on a screen or two, and a box is only one more thing to read. */
export const COURSE_SEARCH_FROM_LESSONS = 8;
/** The most of a query that is read: a line, longer than any lesson title (lib/course.ts, MAX_ITEM_TITLE is 120). */
export const MAX_COURSE_QUERY = 80;
/** The most words a query is split into. */
export const MAX_QUERY_WORDS = 8;

export function showsCourseSearch(lessons: number): boolean {
  return lessons >= COURSE_SEARCH_FROM_LESSONS;
}

/** Text as it is compared: no case, no accents, ß as ss, one kind of apostrophe, single spaces. */
export function foldForSearch(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** The distinct words of what was typed, folded. */
export function queryWords(query: string): string[] {
  const words = foldForSearch(String(query).slice(0, MAX_COURSE_QUERY)).split(" ").filter(Boolean);
  return [...new Set(words)].slice(0, MAX_QUERY_WORDS);
}

/** A module as the outline shows it: its number and name, and each lesson's title. */
export type OutlineModule = { name: string; lessons: string[] };

export type Narrowed = {
  modules: { shown: boolean; lessons: boolean[] }[];
  /** Lessons left in view. */
  matches: number;
  /** Lessons in the course. */
  total: number;
};

/**
 * Which lessons a query keeps: a lesson stays when every word is in its title
 * or in its module's name, and a module stays when one of its lessons does.
 * Null when nothing was typed: then nothing is narrowed.
 */
export function narrowOutline(modules: OutlineModule[], query: string): Narrowed | null {
  const words = queryWords(query);
  if (!words.length) return null;
  let matches = 0;
  let total = 0;
  const shown = modules.map((unit) => {
    const name = foldForSearch(unit.name);
    const lessons = unit.lessons.map((title) => {
      const text = `${name} ${foldForSearch(title)}`;
      return words.every((word) => text.includes(word));
    });
    total += lessons.length;
    const kept = lessons.filter(Boolean).length;
    matches += kept;
    return { shown: kept > 0, lessons };
  });
  return { modules: shown, matches, total };
}

/** Just what narrowDom reads and sets on an element. */
export type FindNode = {
  hidden: boolean;
  readonly textContent: string | null;
  querySelectorAll(selector: string): ArrayLike<FindNode>;
};

const all = (node: FindNode, selector: string): FindNode[] => Array.from(node.querySelectorAll(selector));
const text = (nodes: FindNode[]) => nodes.map((node) => node.textContent ?? "").join(" ");

/**
 * Narrows the outline under `root` to what `query` keeps, by hiding the rest,
 * and says how many lessons are left of how many. Nothing typed shows every
 * lesson again and returns null.
 */
export function narrowDom(root: FindNode, query: string): { matches: number; total: number } | null {
  const units = all(root, "[data-find-module]");
  const lessons = units.map((unit) => all(unit, "[data-find-lesson]"));
  const outline = units.map((unit, i) => ({
    name: text(all(unit, "[data-find-name]")),
    lessons: lessons[i].map((lesson) => text(all(lesson, "[data-find-text]"))),
  }));
  const narrowed = narrowOutline(outline, query);
  units.forEach((unit, i) => {
    unit.hidden = narrowed ? !narrowed.modules[i].shown : false;
    lessons[i].forEach((lesson, j) => {
      lesson.hidden = narrowed ? !narrowed.modules[i].lessons[j] : false;
    });
  });
  return narrowed ? { matches: narrowed.matches, total: narrowed.total } : null;
}
