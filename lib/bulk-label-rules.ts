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

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** One contact's labels after the change: a new list, "same" when already as asked, or "skip" when it holds the most labels already. */
export function labelsAfter(tags: readonly string[], label: string, change: BulkChange): string[] | "same" | "skip" {
  const has = tags.some((tag) => same(tag, label));
  if (change === "remove") return has ? tags.filter((tag) => !same(tag, label)) : "same";
  if (has) return "same";
  if (tags.length >= MAX_CONTACT_TAGS) return "skip";
  return [...tags, label];
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
