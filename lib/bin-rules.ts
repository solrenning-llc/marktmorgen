/**
 * The 30-day bin (417 [CC1], unit 1; added 1 November 2026): what a creator
 * deletes waits 30 days, hidden from everyone else, and comes back in one
 * press. These are its rules, before anything is kept; keeping a deleted
 * thing needs new records, registered first in tests/store-data-registry.ts
 * (held by an open PR), and is the next unit.
 *
 * What goes in, and in what state it comes back. Anything that acts outside
 * the studio by itself comes back stopped, so a restore never sells, sends
 * or charges on its own:
 *
 *   product         hidden from the store until the creator shows it again
 *   page            unpublished
 *   email draft     a draft, as it was
 *   sequence        paused; nobody is put back in it, and no step that was due while it was gone is sent
 *   community space as it was (hidden stays hidden), with its posts; closed to members when
 *                   the products its access named are gone, until the creator sets it again
 *   community post  as it was (a post the creator hid stays hidden), with its comments; nobody is told again
 *   comment         as it was; under a post that is itself in the bin, only with that post
 *
 * A product's buyers are never touched by any of it: deleting a product
 * cancels no subscription or membership and takes no access away (as
 * removeProduct in lib/store.ts already does), the purge after 30 days does
 * not either, and a restore never opens a checkout, starts a charge or sends
 * an email.
 *
 * What is never in the bin: whatever a person's right to erasure took
 * (lib/community-erasure.ts, lib/person-erasure.ts). That is gone at once,
 * and a thing whose content or author was erased since it went in cannot
 * come back. A space or a post put back around others' posts and comments
 * is checked one by one (restorableChildren): what an erasure took stays
 * out, and the creator is told how many.
 *
 * What a restore checks first: that the 30 days have not passed, and that
 * the plan has room for it again (a product, a page or a sequence counts as
 * it did). A purge after 30 days is the only way out of the bin other than
 * a restore, and running it twice is the same as once.
 *
 * Browser-safe: plain data and pure functions.
 */

export const BIN_DAYS = 30;
const DAY_MS = 86_400_000;

export type BinKind = "product" | "page" | "emailDraft" | "sequence" | "space" | "post" | "comment";

/** How each kind comes back, said to the creator beside the restore button. */
export const RESTORED_AS: Record<BinKind, { state: "hidden" | "unpublished" | "draft" | "paused" | "asItWas"; words: string }> = {
  product: { state: "hidden", words: "Comes back hidden from your store. Show it again when you are ready to sell it." },
  page: { state: "unpublished", words: "Comes back unpublished. Publish it again when you are ready." },
  emailDraft: { state: "draft", words: "Comes back as the draft it was. Nothing is sent." },
  sequence: { state: "paused", words: "Comes back paused, with nobody in it. No step that was due while it was in the bin is sent. People who went through it before could start it again once you switch it on." },
  space: { state: "asItWas", words: "Comes back as it was, with its posts. Nobody is told again." },
  post: { state: "asItWas", words: "Comes back as it was, with its comments. Nobody is told again." },
  comment: { state: "asItWas", words: "Comes back as it was. Nobody is told again." },
};

/**
 * A space put back whose access named products that are gone is closed to
 * members (only the creator sees it) until the creator sets its access
 * again, so it never comes back open to everyone by itself.
 */
export function spaceOpenToMembers(accessProducts: string[], productsThere: ReadonlySet<string>): boolean {
  return accessProducts.length === 0 || accessProducts.every((id) => productsThere.has(id));
}

/** Of the posts or comments put back with a space or a post, the ones that may come back, and how many an erasure keeps out. */
export function restorableChildren<C extends { erased: boolean }>(children: C[]): { back: C[]; keptOut: number } {
  const back = children.filter((child) => !child.erased);
  return { back, keptOut: children.length - back.length };
}

/** What the creator reads when some of it stayed out. */
export function keptOutWords(keptOut: number): string {
  if (keptOut <= 0) return "";
  return `${keptOut === 1 ? "One post or comment stays" : `${keptOut} posts or comments stay`} deleted: someone asked for their data to be deleted.`;
}

/** A comment comes back by itself only when its post is not in the bin; otherwise only with its post. */
export function commentAlone(postInBin: boolean): boolean {
  return !postInBin;
}

export type BinEntry = { kind: BinKind; deletedAt: number };

/** The last moment a deleted thing can come back, in milliseconds. */
export function restoreBy(entry: BinEntry): number {
  return entry.deletedAt + BIN_DAYS * DAY_MS;
}

/** Whether the purge may take it for good now: only once its 30 days are over. */
export function purgeDue(entry: BinEntry, now = Date.now()): boolean {
  return now >= restoreBy(entry);
}

export type RestoreRefusal = "expired" | "erased" | "full" | "unknown";

/**
 * Whether it can come back now. `erased` is true when its content or its
 * author was taken by a right to erasure since it went in; `room` is
 * whether the plan has room for one more of its kind (null when that could
 * not be read: then it does not come back on a guess).
 */
export function restoreRefusal(entry: BinEntry, input: { erased: boolean; room: boolean | null }, now = Date.now()): RestoreRefusal | null {
  if (!Number.isSafeInteger(entry.deletedAt) || entry.deletedAt <= 0 || entry.deletedAt > now) return "unknown";
  if (input.erased) return "erased";
  if (now >= restoreBy(entry)) return "expired";
  if (input.room === null) return "unknown";
  if (!input.room) return "full";
  return null;
}

/** What the creator reads when it cannot come back. */
export const REFUSED_WORDS: Record<RestoreRefusal, string> = {
  expired: "Its 30 days in the bin are over, so it is being deleted for good.",
  erased: "Someone asked for their data to be deleted, and this contained it. It cannot come back.",
  full: "Your plan has no room for one more of these right now. Delete another, then try again.",
  unknown: "We could not check this just now, so nothing was changed. Try again in a moment.",
};

/** "Deleted for good on November 30", from the entry, in the creator's own words. */
export function binLine(entry: BinEntry, now = Date.now()): string {
  const left = Math.max(0, Math.ceil((restoreBy(entry) - now) / DAY_MS));
  const day = new Date(restoreBy(entry)).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  return left === 0 ? "Deleted for good today." : `Deleted for good on ${day} (UTC), in ${left} ${left === 1 ? "day" : "days"}.`;
}

/**
 * What a product put back takes with it of where it was. Back by itself:
 * its place in the store's sections and collections that still exist.
 * Never back by itself, because the creator may have moved on, and listed
 * for the creator to put back by hand: a line of news that pointed to it, a
 * page whose button led to it, a bundle that held it (a bundle a buyer can
 * see changing by itself is a promise changing), a collection its deleting
 * left empty and so took away, and a section that started at it and now
 * starts at the next product.
 */
export const PRODUCT_LINKS = {
  back: ["sections", "collections"] as const,
  listed: ["announcement", "sitePages", "bundles", "emptiedCollections", "sectionStarts"] as const,
};

/** What deleting, purging or restoring a product does to its buyers: nothing, said beside the delete button. */
export const PRODUCT_BUYERS_WORDS = "Nobody who bought it loses access, and no subscription to it is canceled. Putting it back starts no charge and sends no email.";
