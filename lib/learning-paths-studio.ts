/**
 * The studio's words and choices for a store's learning paths (249 [ST2],
 * unit 3). Pure, so the editor in the browser and the route read the same
 * sentences: no storage, no network.
 */
import { MAX_PATHS, MAX_PATH_COURSES, MAX_PATH_NAME, MIN_PATH_COURSES, type PathsProblem } from "@/lib/learning-path-rules";

/** The longest course id the rules take (lib/learning-path-rules.ts ID) and a kept path's id (PATH_ID). */
const COURSE_ID_MAX = 64;
const PATH_ID_LENGTH = 8;
/** The most bytes one UTF-16 unit of a kept name takes in the JSON body: three, for a BMP character such as 漢 (Codex X4 on #3723). */
const NAME_UNIT_BYTES = 3;
/** One path as the editor sends it, at its longest: JSON's own marks, its id, its name, its courses and the longer order. */
const PATH_BYTES =
  '{"id":"","name":"","courses":[],"order":"sequence"}'.length + PATH_ID_LENGTH + MAX_PATH_NAME * NAME_UNIT_BYTES + MAX_PATH_COURSES * (COURSE_ID_MAX + 2) + (MAX_PATH_COURSES - 1);

/**
 * The longest body the save route takes: exactly the longest body the editor
 * sends for a list the rules keep as it is (tests/learning-paths-studio.test.ts
 * builds it and holds the two equal). MAX_PATHS paths, each with its 8-letter
 * id, a name of MAX_PATH_NAME UTF-16 units at three UTF-8 bytes each (a
 * character outside the BMP is two units at four bytes; a quote or backslash,
 * escaped, two; control and format characters and doubled spaces are taken
 * out by the rules, so a name holding them is not kept as sent),
 * MAX_PATH_COURSES course ids of 64 characters and "sequence". A name with a
 * lone surrogate, which no keyboard types, is escaped to six bytes and may be
 * refused for its size: refused, never cut.
 */
export const PATHS_BODY_BYTES = '{"paths":[]}'.length + MAX_PATHS * PATH_BYTES + (MAX_PATHS - 1);

/** What the creator reads when a save is refused; `index` is the path's place from 0, or -1 for the whole list. */
export function pathsRefusal(problem: PathsProblem, index: number): string {
  const which = index >= 0 ? `Path ${index + 1}: ` : "";
  switch (problem) {
    case "name":
      return `${which}give it a name of 1 to ${MAX_PATH_NAME} characters.`;
    case "courses":
      return `${which}choose ${MIN_PATH_COURSES} to ${MAX_PATH_COURSES} of your courses, each once.`;
    case "order":
      return `${which}choose whether the path suggests its courses one after another or in no order.`;
    case "too_many":
      return `A store keeps up to ${MAX_PATHS} paths. Remove one before adding another.`;
    case "list":
      return "Your paths could not be read from the page. Reload it and try again; nothing was saved.";
  }
}

/** The products a path can hold: those with a course, in the catalog's order, by title. */
export function courseChoices(listings: readonly { id: string; title: string; course: unknown }[]): { id: string; title: string }[] {
  return listings.filter((p) => Boolean(p.course)).map((p) => ({ id: p.id, title: p.title }));
}
