/**
 * Unsaved changes set aside when another email is opened over them, and
 * brought back (485 [IT2]; added 1 November 2026): the rules, apart from the
 * composer so each step can be tested on its own.
 *
 *   - set aside: what is unsaved goes on the end of the list, with the email
 *     it belonged to; a switch from a clean composer adds nothing and drops
 *     nothing, so a second switch never loses what a first set aside;
 *   - brought back: the newest comes off the list; a draft deleted since
 *     comes back as a new email (no draft id, nothing counted as saved), so
 *     saving it makes a draft rather than meeting one that is gone;
 *   - each step has its own sentence, so the page's live region reads it out.
 *
 * Browser-safe: plain data and pure functions. Nothing here is stored or sent.
 */

export type SetAsideSnapshot = { subject: string; draftId: string; draftSavedAt: string; savedContent: string };
export type SetAsideItem<S extends SetAsideSnapshot, D extends { id: string }> = { snapshot: S; from: D | null };

/** The list after a switch: what was unsaved, if anything, added at the end. */
export function afterSwitch<S extends SetAsideSnapshot, D extends { id: string }>(list: SetAsideItem<S, D>[], kept: S | null, from: D | null): SetAsideItem<S, D>[] {
  return kept ? [...list, { snapshot: kept, from }] : list;
}

/** The newest item to bring back, as it should come back, and the list without it; null when there is none. */
export function takeNewest<S extends SetAsideSnapshot, D extends { id: string }>(list: SetAsideItem<S, D>[], drafts: { id: string }[]): { from: D | null; snapshot: S; rest: SetAsideItem<S, D>[] } | null {
  const last = list.at(-1);
  if (!last) return null;
  const still = last.from && drafts.some((d) => d.id === last.from?.id) ? last.from : null;
  const snapshot = still || !last.snapshot.draftId ? last.snapshot : { ...last.snapshot, draftId: "", draftSavedAt: "", savedContent: "" };
  return { from: still, snapshot, rest: list.slice(0, -1) };
}

/** How an email is named in the sentences: its subject, or what it is without one. */
export function emailName(snapshot: Pick<SetAsideSnapshot, "subject">): string {
  const subject = snapshot.subject.trim();
  return subject ? `"${subject.slice(0, 80)}"` : "the email with no subject yet";
}

/** What the live region says after a switch. */
export function setAsideNote(kept: Pick<SetAsideSnapshot, "subject"> | null, restoring: Pick<SetAsideSnapshot, "subject"> | null): string {
  if (restoring) return `Brought back your changes to ${emailName(restoring)}.${kept ? ` Your changes to ${emailName(kept)} were set aside.` : ""}`;
  return kept ? `Your unsaved changes to ${emailName(kept)} were set aside.` : "";
}

/** What it says when nothing just happened but the list is not empty. */
export function setAsideCount(count: number): string {
  return count === 1 ? "Changes to 1 other email are set aside." : `Changes to ${count} other emails are set aside.`;
}
