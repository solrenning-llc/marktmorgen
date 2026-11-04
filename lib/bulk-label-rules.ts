/**
 * The rules of a label put on or taken off many contacts at once (639
 * [GL7](3), unit 1), shared by the studio's screen and the server
 * (lib/bulk-labels.ts). Browser-safe.
 */
import { MAX_CONTACT_TAGS, MAX_TAG_LENGTH } from "@/lib/contact-rules";

/** The most addresses one change takes. */
export const MAX_BULK_ADDRESSES = 1_000;

/**
 * The most pasted text one change takes, in bytes as it is sent (JSON, UTF-8):
 * 1,000 addresses of the longest kind fit with room. More is refused with a
 * sentence, never cut, since a cut can fall inside an address and make it
 * another one.
 */
export const MAX_BULK_TEXT_BYTES = 400_000;

/** How many contacts one atomic write takes: a change of 1,000 is written 200 at a time. */
export const BULK_WRITE_BATCH = 200;

/** The bytes a value takes as JSON, in UTF-8: what the screen sends and the route counts. */
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

// The longest an address can be (lib/auth.ts MAX_EMAIL_LENGTH; kept here so the browser need not load auth).
const MAX_ADDRESS_LENGTH = 254;
// The most JSON bytes one UTF-16 unit of text can take: a control character or a lone surrogate, written \u0001.
const JSON_BYTES_PER_UNIT = 6;
const ADDRESS_JSON = MAX_ADDRESS_LENGTH * JSON_BYTES_PER_UNIT + 2;
const LABEL_JSON = MAX_TAG_LENGTH * JSON_BYTES_PER_UNIT + 2;
// One entry an undo of a removal sends back: {"email":…,"label":…,"at":9,"forms":10}, and its comma.
const RESTORE_ENTRY_JSON = ADDRESS_JSON + LABEL_JSON + '{"email":,"label":,"at":9,"forms":10},'.length;
// Everything around the list: the action, the change and the label named.
const ENVELOPE_JSON = LABEL_JSON + '{"action":"review","label":,"change":"remove","emails":[],"restore":[],"text":""}'.length;

/**
 * The most bytes the route reads, worked out from the limits above: the
 * largest of the pasted text, an undo of an add (the addresses it changed) and
 * an undo of a removal (each address with the label it lost), all at their
 * longest. So an undo the screen was handed always fits.
 */
export const MAX_BULK_BODY_BYTES = ENVELOPE_JSON + Math.max(MAX_BULK_TEXT_BYTES, MAX_BULK_ADDRESSES * (ADDRESS_JSON + 1), MAX_BULK_ADDRESSES * RESTORE_ENTRY_JSON);

export type BulkChange = "add" | "remove";
export type BulkRefusal = "label" | "none" | "many" | "long" | "change";

/** What each refusal tells the creator, in plain words, with what to do. */
export const BULK_REFUSALS: Record<BulkRefusal, string> = {
  label: `Type the label, up to ${MAX_TAG_LENGTH} characters, with at least one letter, number or symbol. An emoji counts as 2.`,
  none: "Paste at least one email address.",
  many: `Paste up to ${MAX_BULK_ADDRESSES.toLocaleString("en-US")} addresses at a time.`,
  long: `Paste less text at a time, up to ${MAX_BULK_ADDRESSES.toLocaleString("en-US")} addresses. Nothing was cut or changed.`,
  change: "Choose whether to add the label or take it off.",
};

// Characters that show nothing: format characters (zero-width space, direction marks, word joiner), control characters and blank letters.
const INVISIBLE = /[\p{Cf}\p{Cc}\u115F\u1160\u3164\uFFA0]/u;
// Joiners that do show something between two visible characters of other scripts or emoji (an emoji family, a Persian word).
const JOINERS = new Set(["\u200C", "\u200D"]);
const shown = (char: string | undefined) => !!char && char > "\u007F" && !/\s/u.test(char) && !INVISIBLE.test(char);

/**
 * A label as it is written: composed (NFC), spaces collapsed, with no
 * character that shows nothing, except a joiner between two that show. So
 * "VIP" with a zero-width space, or wrapped in direction marks, is "VIP".
 */
export function cleanLabel(typed: string): string {
  const chars = Array.from(typed.normalize("NFC").replace(/\s+/gu, " "));
  const kept = chars.filter((char, i) => !INVISIBLE.test(char) || (JOINERS.has(char) && shown(chars[i - 1]) && shown(chars[i + 1])));
  return kept.join("").replace(/\s+/gu, " ").trim();
}

/**
 * What two labels are compared by: the same letters, whatever their case,
 * width or composition (NFKC, so "ＶＩＰ" is "VIP" and a decomposed "Café" is
 * "Café"), and nothing that shows nothing. Empty when nothing would show.
 */
export function labelKey(label: string): string {
  return Array.from(cleanLabel(label).normalize("NFKC").toLowerCase())
    .filter((char) => !INVISIBLE.test(char))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

export const same = (a: string, b: string) => labelKey(a) === labelKey(b);

/** A number of things in plain words: "1 contact", "1,200 contacts". */
export const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The label one contact had, exactly as it was written there, and where it stood in its list. */
export type Removed = { label: string; at: number };

/**
 * What a removal took from one contact: kept so an undo puts back the very
 * same label in the same place. `forms`, only when the contact held the label
 * written more than one way (an older look-alike, "VIP" and "ＶＩＰ"): all of
 * them are taken off, and an undo puts back the first one.
 */
export function removedFrom(tags: readonly string[], label: string): (Removed & { forms?: number }) | null {
  const at = tags.findIndex((tag) => same(tag, label));
  if (at < 0) return null;
  const forms = tags.filter((tag) => same(tag, label)).length;
  return forms > 1 ? { label: tags[at], at, forms } : { label: tags[at], at };
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

/** What a change did to the addresses it was sent (the route's answer). `noRoom`: not written, the store's data room being full. */
export type BulkOutcome = { changed: number; already: number; full: number; notOnList: number; noRoom?: number };

/**
 * What a change applied tells the creator: how many it changed and, when any
 * address was left out, how many and why, in plain words. `asked` is how many
 * different addresses were sent; what no other reason explains was being
 * changed somewhere else at that moment.
 */
export function applySummary(asked: number, answer: BulkOutcome, change: BulkChange): { short: string; words: string } {
  const changed = Math.min(asked, answer.changed);
  const done = `Done: ${count(changed, "contact", "contacts")} changed.`;
  const left = asked - changed;
  if (left <= 0) return { short: done, words: done };
  const already = Math.min(left, answer.already);
  const full = change === "add" ? Math.min(left - already, answer.full) : 0;
  const gone = Math.min(left - already - full, answer.notOnList);
  const noRoom = Math.min(left - already - full - gone, answer.noRoom ?? 0);
  const busy = left - already - full - gone - noRoom;
  const why = [
    already ? (change === "add" ? `${count(already, "contact already has", "contacts already have")} the label` : `${count(already, "contact doesn't", "contacts don't")} have it`) : "",
    full ? `${count(full, "contact has", "contacts have")} ${MAX_CONTACT_TAGS} labels already, the most a contact can have` : "",
    gone ? `${count(gone, "address is", "addresses are")} not on your list` : "",
    noRoom ? `${count(noRoom, "contact was", "contacts were")} not changed because your store has no room left for more records` : "",
    busy ? `${count(busy, "contact was", "contacts were")} being changed somewhere else at the same moment, so ${busy === 1 ? "it was" : "they were"} left as ${busy === 1 ? "it is" : "they are"}` : "",
  ].filter(Boolean);
  const out = `${left.toLocaleString("en-US")} ${left === 1 ? "was" : "were"} left out`;
  return { short: `${done} ${out}.`, words: `${done} ${out}: ${why.join("; ")}.` };
}

/**
 * What an undo tells the creator, from what the route answers: every contact
 * as it was only when every one sent back went back; otherwise how many did
 * not, and why, in plain words. A contact already as it was before (the label
 * taken off, or put back, some other way since) counts as back. `merged`:
 * contacts put back that had held the label written more than one way, which
 * got it back once, as first written.
 */
export function undoSummary(asked: number, answer: BulkOutcome, undo: BulkChange, merged = 0): { allBack: boolean; short: string; words: string } {
  const back = Math.min(asked, answer.changed + answer.already);
  const notBack = asked - back;
  const once = merged > 0 ? ` ${count(merged, "contact", "contacts")} had this label written in more than one way; it went back on once, as first written.` : "";
  if (notBack <= 0) {
    if (once) return { allBack: false, short: "Undone. Every contact has the label back.", words: `Undone. Every contact has the label back.${once}` };
    return { allBack: true, short: "Undone. Every contact is as it was.", words: "Undone. Every contact is as it was." };
  }
  const gone = Math.min(notBack, answer.notOnList);
  const full = undo === "add" ? Math.min(notBack - gone, answer.full) : 0;
  const noRoom = Math.min(notBack - gone - full, answer.noRoom ?? 0);
  const busy = notBack - gone - full - noRoom;
  const why = [
    gone ? `${count(gone, "contact is", "contacts are")} no longer on your list` : "",
    full ? `${count(full, "contact has", "contacts have")} ${MAX_CONTACT_TAGS} labels now, the most a contact can have, so the label could not go back on` : "",
    noRoom ? `${count(noRoom, "contact", "contacts")} could not get the label back because your store has no room left for more records` : "",
    busy ? `${count(busy, "contact was", "contacts were")} being changed somewhere else at the same moment, so ${busy === 1 ? "it was" : "they were"} left as ${busy === 1 ? "it is" : "they are"}` : "",
  ].filter(Boolean);
  const head = `Undone for ${back.toLocaleString("en-US")} of ${count(asked, "contact", "contacts")}.`;
  return { allBack: false, short: `${head} ${count(notBack, "contact", "contacts")} did not go back.`, words: `${head} ${count(notBack, "contact", "contacts")} did not go back: ${why.join("; ")}.${once}` };
}
