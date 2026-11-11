/**
 * The studio's words and choices for a store's learning paths (249 [ST2],
 * unit 3). Pure, so the editor in the browser and the route read the same
 * sentences: no storage, no network.
 */
import { MAX_PATHS, MAX_PATH_COURSES, MAX_PATH_NAME, MIN_PATH_COURSES, type PathsProblem } from "@/lib/learning-path-rules";

/**
 * The longest body the save route takes: MAX_PATHS paths, each with an id,
 * a name of MAX_PATH_NAME characters at two bytes each, MAX_PATH_COURSES
 * course ids of 64 characters and an order, with room for JSON's own marks.
 */
export const PATHS_BODY_BYTES = 12 + MAX_PATHS * (80 + MAX_PATH_NAME * 2 + MAX_PATH_COURSES * 67);

/** What the creator reads when a save is refused; `index` is the path's place from 0, or -1 for the whole list. */
export function pathsRefusal(problem: PathsProblem, index: number): string {
  const which = index >= 0 ? `Path ${index + 1}: ` : "";
  switch (problem) {
    case "name":
      return `${which}give it a name of 1 to ${MAX_PATH_NAME} characters.`;
    case "courses":
      return `${which}choose ${MIN_PATH_COURSES} to ${MAX_PATH_COURSES} of your courses, each once.`;
    case "order":
      return `${which}choose whether its courses open one after another or in any order.`;
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
