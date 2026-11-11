/**
 * "Make a copy" of a form, survey or quiz (582 [KB3], unit 1; added 10
 * November 2026): the same questions, branches, results, points and
 * categories, opened in the studio's own form editor as a new form, unsaved,
 * so a creator can run the same application or quiz again, or change a few
 * questions, without typing it all again.
 *
 * What a copy never takes: the original's answers (they are kept under the
 * original's id, and a copy has none until it is saved and given its own),
 * its id, and its open and close times, which were set for the original and
 * would often have passed already. Nothing is written here: the copy is
 * saved, or not, by the creator, through the same route and the same checks
 * as any new form (app/api/store/forms/route.ts), so the store's most forms
 * (MAX_FORMS) and every other rule hold for it too.
 *
 * Pure and browser-safe.
 */
import { MAX_FORM_NAME, MAX_FORMS, type FormDef } from "@/lib/forms";

export const COPY_PREFIX = "Copy of ";

/** The name without any "Copy of " in front and any " (n)" after, so a copy of a copy is not "Copy of Copy of …". */
export function copyBase(name: string): string {
  let base = name.trim();
  while (/^copy of(\s|$)/i.test(base)) base = base.slice(COPY_PREFIX.length - 1).trimStart();
  return base.replace(/\s\(\d+\)$/, "").trim();
}

/**
 * "Copy of <name>", or "Copy of <name> (2)", (3)… when that name is already
 * one of the store's forms, never longer than a form's name may be: the
 * original's name is shortened, never the number.
 */
export function copyName(name: string, taken: readonly string[]): string {
  const base = copyBase(name) || "form";
  const names = new Set(taken.map((t) => t.trim().toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : ` (${n})`;
    const room = MAX_FORM_NAME - COPY_PREFIX.length - suffix.length;
    const candidate = `${COPY_PREFIX}${base.slice(0, room).trimEnd()}${suffix}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

/** Whether the store has room for one more form, so whether "Make a copy" is offered at all. */
export const canCopy = (savedCount: number): boolean => savedCount < MAX_FORMS;

/**
 * The copy, as the editor opens it: a new form (no id), named by copyName,
 * with every question, option, branch, result, point and category of the
 * original, and without its schedule. A deep copy: changing it never changes
 * the original in the page.
 */
export function formCopy(form: FormDef, taken: readonly string[]): FormDef {
  const copy = structuredClone(form);
  delete copy.opensAt;
  delete copy.closesAt;
  return { ...copy, id: "", name: copyName(form.name, taken), updatedAt: 0 };
}
