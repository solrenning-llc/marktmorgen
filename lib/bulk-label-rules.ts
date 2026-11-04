/**
 * The rules of a label put on or taken off many contacts at once (639
 * [GL7](3), unit 1), shared by the studio's screen and the server
 * (lib/bulk-labels.ts). Browser-safe.
 */
import { MAX_CONTACT_TAGS } from "@/lib/contact-rules";

/** The most addresses one change takes. */
export const MAX_BULK_ADDRESSES = 1_000;

export type BulkChange = "add" | "remove";
export type BulkRefusal = "label" | "none" | "many" | "change";

/** What each refusal tells the creator, in plain words, with what to do. */
export const BULK_REFUSALS: Record<BulkRefusal, string> = {
  label: "Type the label, up to 40 characters.",
  none: "Paste at least one email address.",
  many: `Paste up to ${MAX_BULK_ADDRESSES.toLocaleString("en-US")} addresses at a time.`,
  change: "Choose whether to add the label or take it off.",
};

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A number of things in plain words: "1 contact", "1,200 contacts". */
export const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The label one contact had, exactly as it was written there, and where it stood in its list. */
export type Removed = { label: string; at: number };

/** What a removal took from one contact: kept so an undo puts back the very same label in the same place. */
export function removedFrom(tags: readonly string[], label: string): Removed | null {
  const at = tags.findIndex((tag) => same(tag, label));
  return at < 0 ? null : { label: tags[at], at };
}

/**
 * One contact's labels after the change: a new list, "same" when already as
 * asked, or "skip" when it holds the most labels already. Adding back what a
 * removal took (`back`) puts that contact's own label, as it was written, where
 * it stood, or at the end when the list is shorter now.
 */
export function labelsAfter(tags: readonly string[], label: string, change: BulkChange, back?: Removed): string[] | "same" | "skip" {
  const has = tags.some((tag) => same(tag, label));
  if (change === "remove") return has ? tags.filter((tag) => !same(tag, label)) : "same";
  if (has) return "same";
  if (tags.length >= MAX_CONTACT_TAGS) return "skip";
  if (!back || !same(back.label, label)) return [...tags, label];
  const out = [...tags];
  out.splice(Math.min(Math.max(0, back.at), out.length), 0, back.label);
  return out;
}

export type BulkReview = {
  /** Contacts this would change. */
  changes: number;
  /** Contacts already as asked. */
  already: number;
  /** Addresses that are not on the store's list. */
  notOnList: number;
  /** Contacts that already hold the most labels a contact can (adding only). */
  full: number;
  /** Pieces of the pasted text that looked like an address but were not one. */
  skipped: number;
};

/** The change that takes one back. */
export const opposite = (change: BulkChange): BulkChange => (change === "add" ? "remove" : "add");

/** What a change did to the addresses it was sent (the route's answer). */
export type BulkOutcome = { changed: number; already: number; full: number; notOnList: number };

/**
 * What an undo tells the creator, from what the route answers: every contact
 * as it was only when every one sent back went back; otherwise how many did
 * not, and why, in plain words. A contact already as it was before (the label
 * taken off, or put back, some other way since) counts as back.
 */
export function undoSummary(asked: number, answer: BulkOutcome, undo: BulkChange): { allBack: boolean; words: string } {
  const back = Math.min(asked, answer.changed + answer.already);
  const notBack = asked - back;
  if (notBack <= 0) return { allBack: true, words: "Undone. Every contact is as it was." };
  const gone = Math.min(notBack, answer.notOnList);
  const full = undo === "add" ? Math.min(notBack - gone, answer.full) : 0;
  const busy = notBack - gone - full;
  const why = [
    gone ? `${count(gone, "contact is", "contacts are")} no longer on your list` : "",
    full ? `${count(full, "contact has", "contacts have")} ${MAX_CONTACT_TAGS} labels now, the most a contact can have, so the label could not go back on` : "",
    busy ? `${count(busy, "contact was", "contacts were")} being changed somewhere else at the same moment, so ${busy === 1 ? "it was" : "they were"} left as ${busy === 1 ? "it is" : "they are"}` : "",
  ].filter(Boolean);
  return { allBack: false, words: `Undone for ${back.toLocaleString("en-US")} of ${count(asked, "contact", "contacts")}. ${count(notBack, "contact", "contacts")} did not go back: ${why.join("; ")}.` };
}
