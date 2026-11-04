/**
 * Labels put on or taken off many contacts at once: 639 [GL7](3), unit 1.
 * The creator pastes the addresses and names one label; a review says, before
 * anything is written, how many contacts it changes, how many already are as
 * asked, how many are not on the list and how many already have the most
 * labels a contact can; then it is applied, and can be undone, exactly, for
 * the contacts it changed.
 *
 * It starts no automation. A label's automations (lib/flows.ts, "enroll")
 * start only from the single-contact ways that already start them; adding it
 * here writes the label and nothing else, the screen says so before the
 * creator confirms, and so the undo takes back everything that was done:
 * nothing was sent. (Starting them, with the count of emails it could send
 * counted inside the plan first, is a later unit.)
 *
 * Every write goes through changeLabels (lib/contacts.ts), which reads each
 * contact the moment before, writes only if it is still as read, and takes
 * room in the store's data room first.
 */
import { BULK_REFUSALS, type BulkChange, type BulkRefusal, type BulkReview, MAX_BULK_ADDRESSES, type Removed, labelsAfter, opposite, removedFrom, same } from "@/lib/bulk-label-rules";
import { MAX_CONTACT_TAGS } from "@/lib/contact-rules";
import { changeLabels, leadsKey, parseContact, readAddresses, readTags } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import type { DataStore } from "@/lib/store-data";

export { BULK_REFUSALS, MAX_BULK_ADDRESSES, labelsAfter, opposite };
export type { BulkChange, BulkRefusal, BulkReview, Removed };

/** What one contact lost in a removal, by address: the route answers with these, and an undo sends them back. */
export type RemovedFrom = Removed & { email: string };

/** `back`, only on an undo of a removal: each contact's own label as it was written and where it stood. */
export type BulkAsk = { label: string; change: BulkChange; emails: string[]; skipped: number; back?: Record<string, Removed> };

/**
 * What an undo of a removal says each contact had, kept only where it is one
 * of the addresses sent and the same label as asked (in any case), so it can
 * never put on a label other than the one named; a place outside a contact's
 * list means the end.
 */
function readBack(raw: unknown, emails: readonly string[], label: string): Record<string, Removed> {
  const back: Record<string, Removed> = {};
  if (!Array.isArray(raw)) return back;
  for (const entry of raw.slice(0, MAX_BULK_ADDRESSES)) {
    if (!entry || typeof entry !== "object") continue;
    const { email: typedEmail, label: typedLabel, at } = entry as Record<string, unknown>;
    const [email] = readAddresses(typeof typedEmail === "string" ? typedEmail : "").emails;
    const [kept] = readTags([typeof typedLabel === "string" ? typedLabel : ""]);
    if (!email || !emails.includes(email) || !kept || !same(kept, label)) continue;
    back[email] = { label: kept, at: Number.isInteger(at) && (at as number) >= 0 && (at as number) < MAX_CONTACT_TAGS ? (at as number) : MAX_CONTACT_TAGS };
  }
  return back;
}

/** What the creator sent, made safe, or what is wrong with it. Addresses from pasted text, or the exact list an undo sends back. */
export function readBulk(raw: Record<string, unknown>): { ok: true; ask: BulkAsk } | { ok: false; error: BulkRefusal } {
  const change = raw.change === "add" || raw.change === "remove" ? raw.change : null;
  if (!change) return { ok: false, error: "change" };
  const typed = typeof raw.label === "string" ? raw.label : "";
  const [label] = readTags([typed]);
  if (!label || typed.trim().length > 40) return { ok: false, error: "label" };
  const read = Array.isArray(raw.emails)
    ? readAddresses(raw.emails.filter((e): e is string => typeof e === "string").join("\n"))
    : readAddresses(typeof raw.text === "string" ? raw.text.slice(0, 400_000) : "");
  if (!read.emails.length) return { ok: false, error: "none" };
  if (read.emails.length > MAX_BULK_ADDRESSES) return { ok: false, error: "many" };
  const ask: BulkAsk = { label, change, emails: read.emails, skipped: read.skipped };
  if (change === "add" && Array.isArray(raw.emails) && raw.restore !== undefined) ask.back = readBack(raw.restore, read.emails, label);
  return { ok: true, ask };
}

/** What the change would do, read now, with nothing written. */
export async function reviewBulk(listId: string, ask: BulkAsk): Promise<BulkReview> {
  const [rows] = await redisPipeline([["HMGET", leadsKey(listId), ...ask.emails]]);
  const review: BulkReview = { changes: 0, already: 0, notOnList: 0, full: 0, skipped: ask.skipped };
  ask.emails.forEach((_, i) => {
    const contact = parseContact(Array.isArray(rows) ? rows[i] : null);
    if (!contact) {
      review.notOnList += 1;
      return;
    }
    const after = labelsAfter(contact.tags, ask.label, ask.change);
    if (after === "same") review.already += 1;
    else if (after === "skip") review.full += 1;
    else review.changes += 1;
  });
  return review;
}

export type BulkDone = {
  /** The addresses it changed. */
  changed: string[];
  /** Contacts already as asked. */
  already: number;
  /** Contacts that hold the most labels a contact can (adding only). */
  full: number;
  /** Addresses not on the list (or no longer). */
  notOnList: number;
  /** On a removal: what each changed contact lost, exactly as written there, and where it stood. */
  removed: RemovedFrom[];
};

/**
 * The change applied, each contact as it is at that moment. The answer lists
 * the addresses it changed, how many were left and why, and on a removal the
 * label each contact lost as it was written there: an undo sends exactly
 * those back, with the opposite change. It starts no automation.
 */
export async function applyBulk(listId: string, ask: BulkAsk, room: DataStore): Promise<BulkDone> {
  // The last reading of each contact decides why it was left: the rounds read again only those whose write lost a race.
  const seen = new Map<string, "same" | "skip" | Removed | null>();
  const { changed, same: already } = await changeLabels(
    listId,
    ask.emails,
    (tags, email) => {
      const next = labelsAfter(tags, ask.label, ask.change, ask.back?.[email]);
      seen.set(email, typeof next === "string" ? next : ask.change === "remove" ? removedFrom(tags, ask.label) : null);
      return next;
    },
    room,
  );
  const removed = changed.flatMap((email) => {
    const was = seen.get(email);
    return was && typeof was === "object" ? [{ email, ...was }] : [];
  });
  const full = ask.emails.filter((email) => seen.get(email) === "skip").length;
  const notOnList = ask.emails.filter((email) => !seen.has(email)).length;
  return { changed, already: already.length, full, notOnList, removed };
}
