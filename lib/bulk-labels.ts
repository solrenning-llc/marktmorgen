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
import { BULK_REFUSALS, BULK_WRITE_BATCH, type BulkChange, type BulkRefusal, type BulkReview, MAX_BULK_ADDRESSES, MAX_BULK_TEXT_BYTES, type Removed, cleanLabel, jsonBytes, labelsAfter, opposite, removedFrom, replacedFrom, same, sendableAddress, showsSomething } from "@/lib/bulk-label-rules";
import { MAX_CONTACT_TAGS, MAX_TAG_LENGTH } from "@/lib/contact-rules";
import { changeLabels, leadsKey, parseContact, readAddresses, readTags } from "@/lib/contacts";
import { redisPipeline } from "@/lib/redis";
import type { DataStore } from "@/lib/store-data";
import { StoreFullError } from "@/lib/store-full";

export { BULK_REFUSALS, MAX_BULK_ADDRESSES, labelsAfter, opposite };
export type { BulkChange, BulkRefusal, BulkReview, Removed };

/**
 * What a change took from one contact, by address: on a removal the form it
 * lost, on an add the look-alike form it replaced. The route answers with
 * these and an undo sends them back. The label is cleaned (cleanLabel):
 * `cleaned` when that took out characters that show nothing, so the undo
 * puts back the form as it was shown.
 */
export type RemovedFrom = Removed & { email: string; forms?: number; cleaned?: true };

/** `back`, only on an undo: each contact's own form of the label and where it stood. */
export type BulkAsk = { label: string; change: BulkChange; emails: string[]; skipped: number; back?: Record<string, Removed> };

/**
 * What an undo says each contact had, kept only where it is the same label as
 * asked (in any form), cleaned, so it can never put on another label nor a
 * character that shows nothing; a place outside a contact's list means the
 * end. Each address once.
 */
function readBack(raw: unknown[], label: string): Record<string, Removed> {
  const back: Record<string, Removed> = {};
  for (const entry of raw.slice(0, MAX_BULK_ADDRESSES)) {
    if (!entry || typeof entry !== "object") continue;
    const { email: typedEmail, label: typedLabel, at } = entry as Record<string, unknown>;
    const [email] = readAddresses(typeof typedEmail === "string" ? typedEmail : "").emails.filter(sendableAddress);
    const [kept] = readTags([cleanLabel(typeof typedLabel === "string" ? typedLabel : "")]);
    if (!email || back[email] || !kept || !same(kept, label)) continue;
    back[email] = { label: kept, at: Number.isInteger(at) && (at as number) >= 0 && (at as number) < MAX_CONTACT_TAGS ? (at as number) : MAX_CONTACT_TAGS };
  }
  return back;
}

/**
 * The label named, written as it will be kept (lib/bulk-label-rules.ts,
 * cleanLabel), or null when nothing in it shows or it is longer than a
 * contact's label can be. Counted after the spaces are collapsed, in the
 * units a contact's labels are kept in (MAX_TAG_LENGTH); the screen counts
 * the same way, so the number it shows is the one held.
 */
function readLabel(typed: unknown): string | null {
  const label = cleanLabel(typeof typed === "string" ? typed : "");
  return showsSomething(label) && label.length <= MAX_TAG_LENGTH ? label : null;
}

/**
 * What the creator sent, made safe, or what is wrong with it. Addresses from
 * pasted text (never cut: more than MAX_BULK_TEXT_BYTES is refused), or, on
 * an undo, the addresses it sends back (`emails`) and those with the form
 * each contact had (`restore`). An address JSON would have to escape
 * (sendableAddress) is skipped.
 */
export function readBulk(raw: Record<string, unknown>): { ok: true; ask: BulkAsk } | { ok: false; error: BulkRefusal } {
  const change = raw.change === "add" || raw.change === "remove" ? raw.change : null;
  if (!change) return { ok: false, error: "change" };
  const label = readLabel(raw.label);
  if (!label) return { ok: false, error: "label" };
  const listed = Array.isArray(raw.emails) || Array.isArray(raw.restore);
  if (!listed && typeof raw.text === "string" && jsonBytes(raw.text) > MAX_BULK_TEXT_BYTES) return { ok: false, error: "long" };
  if (Array.isArray(raw.restore) && raw.restore.length > MAX_BULK_ADDRESSES) return { ok: false, error: "many" };
  const read = listed
    ? readAddresses((Array.isArray(raw.emails) ? raw.emails : []).filter((e): e is string => typeof e === "string").join("\n"))
    : readAddresses(typeof raw.text === "string" ? raw.text : "");
  const sendable = read.emails.filter(sendableAddress);
  const back = Array.isArray(raw.restore) ? readBack(raw.restore, label) : undefined;
  const emails = [...new Set([...sendable, ...Object.keys(back ?? {})])];
  if (!emails.length) return { ok: false, error: "none" };
  if (emails.length > MAX_BULK_ADDRESSES) return { ok: false, error: "many" };
  const ask: BulkAsk = { label, change, emails, skipped: read.skipped + read.emails.length - sendable.length };
  if (back) ask.back = back;
  return { ok: true, ask };
}

/** What the change would do, read now, with nothing written. */
export async function reviewBulk(listId: string, ask: BulkAsk): Promise<BulkReview> {
  const [rows] = await redisPipeline([["HMGET", leadsKey(listId), ...ask.emails]]);
  const review: BulkReview = { changes: 0, already: 0, notOnList: 0, full: 0, skipped: ask.skipped, replaced: 0 };
  ask.emails.forEach((_, i) => {
    const contact = parseContact(Array.isArray(rows) ? rows[i] : null);
    if (!contact) {
      review.notOnList += 1;
      return;
    }
    const after = labelsAfter(contact.tags, ask.label, ask.change);
    if (after === "same") review.already += 1;
    else if (after === "skip") review.full += 1;
    else {
      review.changes += 1;
      if (ask.change === "add" && replacedFrom(contact.tags, ask.label)) review.replaced! += 1;
    }
  });
  return review;
}

export type BulkDone = {
  /** How many different addresses were sent. */
  asked: number;
  /** The addresses it changed. */
  changed: string[];
  /** Contacts already as asked. */
  already: number;
  /** Contacts that hold the most labels a contact can (adding only). */
  full: number;
  /** Addresses not on the list (or no longer, when written). */
  notOnList: number;
  /** Contacts not written because the store's data room was full (only after some were written). */
  noRoom: number;
  /** Contacts left when something went wrong part way (only after some were written): they may or may not have been written. */
  failed: number;
  /** On a removal: what each changed contact lost, and where it stood. */
  removed: RemovedFrom[];
  /** On an add: the look-alike form each changed contact held, replaced with the label, and where it stood. */
  replaced: RemovedFrom[];
};

/**
 * The change applied, each contact as it is at that moment, BULK_WRITE_BATCH
 * contacts per atomic write. The answer lists the addresses it changed, how
 * many were left and why, and the form each one lost or had replaced: an
 * undo sends exactly those back, with the opposite change. When a batch
 * fails part way (a full data room or any other error), what was written is
 * still answered, so it can be undone, and the rest is counted as not
 * written (`noRoom`) or not known (`failed`); a change that wrote nothing is
 * refused with the error, as before. It starts no automation.
 */
export async function applyBulk(listId: string, ask: BulkAsk, room: DataStore): Promise<BulkDone> {
  const emails = [...new Set(ask.emails)];
  // The last reading of each contact decides why it was left: the rounds read again only those whose write lost a race.
  const seen = new Map<string, "same" | "skip" | (Removed & { forms?: number }) | null>();
  const changed: string[] = [];
  const gone = new Set<string>();
  let already = 0;
  let noRoom = 0;
  let failed = 0;
  let failure: unknown;
  for (let from = 0; from < emails.length; from += BULK_WRITE_BATCH) {
    const batch = emails.slice(from, from + BULK_WRITE_BATCH);
    const later = emails.length - from - batch.length;
    let done: Awaited<ReturnType<typeof changeLabels>>;
    try {
      done = await changeLabels(
        listId,
        batch,
        (tags, email) => {
          const next = labelsAfter(tags, ask.label, ask.change, ask.back?.[email]);
          seen.set(email, typeof next === "string" ? next : ask.change === "remove" ? removedFrom(tags, ask.label) : ask.back?.[email] ? null : replacedFrom(tags, ask.label));
          return next;
        },
        room,
        { keepWritten: true },
      );
    } catch (error) {
      // An error thrown outside changeLabels' own rounds: nothing of this batch is known to be written.
      if (!changed.length) throw error;
      failed = batch.length + later;
      failure = error;
      break;
    }
    changed.push(...done.changed);
    already += done.same.length;
    for (const email of done.gone) gone.add(email);
    if (done.noRoom.length || done.failed.length) {
      noRoom = done.noRoom.length + (done.noRoom.length ? later : 0);
      failed = done.failed.length + (done.noRoom.length ? 0 : later);
      failure = done.error;
      break;
    }
  }
  if (!changed.length && noRoom) throw new StoreFullError();
  if (!changed.length && failed) throw failure ?? new Error("changing labels failed before anything was written");
  const wrote = new Set(changed);
  const formsOf = (email: string): RemovedFrom[] => {
    const was = seen.get(email);
    if (!was || typeof was !== "object") return [];
    const label = cleanLabel(was.label);
    return [{ email, ...was, label, ...(label !== was.label ? { cleaned: true as const } : {}) }];
  };
  const taken = changed.flatMap(formsOf);
  // A contact counted full only when that was its last reading and it was not written.
  const full = emails.filter((email) => seen.get(email) === "skip" && !wrote.has(email) && !gone.has(email)).length;
  return { asked: emails.length, changed, already, full, notOnList: gone.size, noRoom, failed, removed: ask.change === "remove" ? taken : [], replaced: ask.change === "add" ? taken : [] };
}
