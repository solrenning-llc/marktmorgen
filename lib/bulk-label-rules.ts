/**
 * The rules of a label put on or taken off many contacts at once (639
 * [GL7](3), unit 1), shared by the studio's screen and the server
 * (lib/bulk-labels.ts). Browser-safe.
 */
import { MAX_CONTACT_TAGS, MAX_TAG_LENGTH } from "@/lib/contact-rules";

/** The most addresses one change takes. */
export const MAX_BULK_ADDRESSES = 1_000;

/** How many contacts one atomic write takes: a change of 1,000 is written 200 at a time. */
export const BULK_WRITE_BATCH = 200;

/** The bytes a value takes as JSON, in UTF-8: what the screen sends and the route counts. */
export const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

// The longest an address can be (lib/auth.ts MAX_EMAIL_LENGTH; kept here so the browser need not load auth).
const MAX_ADDRESS_LENGTH = 254;
// The most JSON bytes one UTF-16 unit takes in an address or a label this change sends: 3 (a character of
// another script); control characters and lone surrogates, which JSON writes as 6 (\u0001), are never in
// one (readBulk skips such an address, cleanLabel takes them out of a label).
const JSON_BYTES_PER_UNIT = 3;
const ADDRESS_JSON = MAX_ADDRESS_LENGTH * JSON_BYTES_PER_UNIT + 2;

/**
 * The most pasted text one change takes, in bytes as it is sent (JSON,
 * UTF-8): 1,000 of the longest addresses of any script, one per line, fit.
 * More is refused with a sentence, never cut, since a cut can fall inside an
 * address and make it another one.
 */
export const MAX_BULK_TEXT_BYTES = MAX_BULK_ADDRESSES * ADDRESS_JSON + 2;
const LABEL_JSON = MAX_TAG_LENGTH * JSON_BYTES_PER_UNIT + 2;
// One entry an undo sends back: {"email":…,"label":…,"at":9,"forms":10,"cleaned":true}, and its comma.
const RESTORE_ENTRY_JSON = ADDRESS_JSON + LABEL_JSON + '{"email":,"label":,"at":9,"forms":10,"cleaned":true},'.length;
// Everything around the lists: the action, the change and the label named.
const ENVELOPE_JSON = LABEL_JSON + '{"action":"review","label":,"change":"remove","emails":[],"restore":[],"text":""}'.length;

/**
 * The most bytes the route reads, worked out from the limits above: the
 * larger of the pasted text and an undo, whose 1,000 contacts at most are
 * each either an address or an entry with the label it had (the screen never
 * sends one twice), all at their longest. So an undo the screen was handed
 * always fits.
 */
export const MAX_BULK_BODY_BYTES = ENVELOPE_JSON + Math.max(MAX_BULK_TEXT_BYTES, MAX_BULK_ADDRESSES * Math.max(ADDRESS_JSON + 1, RESTORE_ENTRY_JSON));

/** An address this change can name: none with a character JSON has to escape as \u (a control character, a lone surrogate). */
export const sendableAddress = (email: string) => !/[\p{Cc}\p{Cs}]/u.test(email);

export type BulkChange = "add" | "remove";
export type BulkRefusal = "label" | "none" | "many" | "long" | "change";

/** What each refusal tells the creator, in plain words, with what to do. */
export const BULK_REFUSALS: Record<BulkRefusal, string> = {
  label: `Type the label, up to ${MAX_TAG_LENGTH} characters, with at least one letter, number or symbol. Some emoji count as 2 or more.`,
  none: "Paste at least one email address.",
  many: `Paste up to ${MAX_BULK_ADDRESSES.toLocaleString("en-US")} addresses at a time.`,
  long: `Paste less text at a time, up to ${MAX_BULK_ADDRESSES.toLocaleString("en-US")} addresses. Nothing was cut or changed.`,
  change: "Choose whether to add the label or take it off.",
};

/**
 * Characters that show nothing and are taken out of a label: control
 * characters, lone surrogates, the soft hyphen, the Arabic letter mark, blank
 * letters (Hangul fillers), Khmer inherent vowels, zero-width space, joiners
 * and direction marks, embeddings and isolates, invisible operators, the
 * byte-order mark, interlinear annotation, musical format controls, the
 * blank braille pattern and tag characters. Format characters that do show
 * or shape text (the Arabic number signs, the Mongolian vowel separator) are
 * not on it.
 */
const TAKEN_OUT = /[\p{Cc}\p{Cs}\u00AD\u061C\u115F\u1160\u17B4\u17B5\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\u{1D173}-\u{1D17A}\u{E0001}\u{E0020}-\u{E007F}]/u;
const JOINERS = new Set(["\u200C", "\u200D"]);
const BLACK_FLAG = "\u{1F3F4}";
// A character that shows, other than plain ASCII: what a joiner may follow (an emoji, a Malayalam chillu, a Persian word).
const shownAfter = (char: string | undefined) => !!char && char > "\u007F" && !/\s/u.test(char) && !TAKEN_OUT.test(char);
// CJK compatibility ideographs: NFC would turn each into its unified form, which is not how the creator wrote it.
const COMPATIBILITY_IDEOGRAPHS = /([\uF900-\uFAFF\u{2F800}-\u{2FA1F}])/u;
const composed = (text: string) =>
  text
    .split(COMPATIBILITY_IDEOGRAPHS)
    .map((piece) => (COMPATIBILITY_IDEOGRAPHS.test(piece) ? piece : piece.normalize("NFC")))
    .join("");

// Fullwidth Latin letters, digits and punctuation, as an input method types them, written as the plain ones.
const narrowLatin = (char: string) => (char >= "\uFF01" && char <= "\uFF5E" ? char.normalize("NFKC") : char);

// The subdivision flags emoji has (England, Scotland, Wales): a black flag, the tag letters of gbeng, gbsct or gbwls, and the cancel tag.
const TAG_FLAGS = ["gbeng", "gbsct", "gbwls"].map((code) => BLACK_FLAG + Array.from(code, (letter) => String.fromCodePoint(0xe0000 + letter.charCodeAt(0))).join("") + "\u{E007F}");

/**
 * The characters of a label without those that show nothing (TAKEN_OUT),
 * except a joiner after a character that shows (an emoji sequence, a
 * Malayalam chillu) and the tags of a subdivision flag (TAG_FLAGS). Any other
 * run of tags, which could spell hidden letters, is taken out.
 */
function visibleChars(chars: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char === BLACK_FLAG) {
      const flag = TAG_FLAGS.find((whole) => chars.slice(i, i + Array.from(whole).length).join("") === whole);
      if (flag) {
        kept.push(flag);
        i += Array.from(flag).length - 1;
        continue;
      }
    }
    if (!TAKEN_OUT.test(char) || (JOINERS.has(char) && shownAfter(kept[kept.length - 1]))) kept.push(char);
  }
  return kept;
}

/**
 * A form of a label kept on a contact, without the characters that show
 * nothing and with nothing else changed (its width, its composition): what
 * an undo puts back, so a look-alike goes back exactly as it was written.
 */
export const withoutHidden = (form: string) => visibleChars(Array.from(form)).join("").replace(/\s+/gu, " ").trim();

/**
 * A label as it is written: composed (NFC, compatibility ideographs left as
 * typed), fullwidth Latin made plain ("ＶＩＰ" is "VIP"), spaces collapsed,
 * with no character that shows nothing (visibleChars). So "VIP" with a
 * zero-width space, or wrapped in direction marks, is "VIP".
 */
export function cleanLabel(typed: string): string {
  return visibleChars(Array.from(composed(typed.replace(/\s+/gu, " "))).map(narrowLatin)).join("").replace(/\s+/gu, " ").trim();
}

/** Whether a label shows anything: a letter, a number, a mark of punctuation or a symbol. */
export const showsSomething = (label: string) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(cleanLabel(label));

/**
 * What two labels are compared by here: the same letters, whatever their
 * case, their width (fullwidth "ＶＩＰ" is "VIP") or their composition (a
 * decomposed "Café" is "Café"), with nothing that shows nothing. Only width
 * is folded: "x²" and "x2", "Ⅳ" and "IV", "H₂O" and "H2O" stay different.
 */
export function labelKey(label: string): string {
  const narrow = Array.from(cleanLabel(label))
    .map((char) => (char >= "\uFF00" && char <= "\uFFEF" ? char.normalize("NFKC") : char))
    .join("");
  return composed(narrow).toLowerCase().replace(/\s+/gu, " ").trim();
}

export const same = (a: string, b: string) => labelKey(a) === labelKey(b);

/**
 * How the rest of the studio compares labels (lib/flow-rules.ts sameTag, the
 * send filter in lib/contacts.ts, the API): only case and the spaces around.
 * A contact whose label matches here but not there holds a look-alike form,
 * which an add replaces with the clean one so that sending and automations
 * find it too.
 */
const plainKey = (label: string) => label.trim().toLocaleLowerCase();

/** A number of things in plain words: "1 contact", "1,200 contacts". */
export const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The label one contact had, exactly as it was written there, and where it stood in its list. */
export type Removed = { label: string; at: number };

/**
 * The form of the label one contact had where it stood: kept so an undo puts
 * it back in the same place. `forms`, only when the contact held it written
 * more than one way (an older look-alike, "VIP" and "ＶＩＰ"): all of them are
 * taken off, and an undo puts back the first one.
 */
export function removedFrom(tags: readonly string[], label: string): (Removed & { forms?: number }) | null {
  const at = tags.findIndex((tag) => same(tag, label));
  if (at < 0) return null;
  const forms = tags.filter((tag) => same(tag, label)).length;
  return forms > 1 ? { label: tags[at], at, forms } : { label: tags[at], at };
}

/** What an add replaces on one contact: its look-alike forms, when it holds the label only in a form the rest of the studio does not match. */
export function replacedFrom(tags: readonly string[], label: string): (Removed & { forms?: number }) | null {
  return tags.some((tag) => plainKey(tag) === plainKey(label)) ? null : removedFrom(tags, label);
}

/**
 * One contact's labels after the change: a new list, "same" when already as
 * asked, or "skip" when it holds the most labels already. Adding to a contact
 * that holds only a look-alike form replaces it with the label, where the
 * first form stood (or with `back`, when one appeared since the removal an
 * undo takes back). `back` is what an undo puts back, that contact's own form
 * where it stood (or at the end when the list is shorter now): on an add,
 * what a removal took; on a removal, the look-alike an add replaced.
 */
export function labelsAfter(tags: readonly string[], label: string, change: BulkChange, back?: Removed): string[] | "same" | "skip" {
  const at = tags.findIndex((tag) => same(tag, label));
  const putBack = (out: string[], form: Removed | undefined) => {
    if (form && same(form.label, label)) out.splice(Math.min(Math.max(0, form.at), out.length), 0, form.label);
    else if (change === "add") out.push(label);
    return out;
  };
  if (change === "remove") return at < 0 ? "same" : putBack(tags.filter((tag) => !same(tag, label)), back);
  if (tags.some((tag) => plainKey(tag) === plainKey(label))) return "same";
  // A look-alike form is replaced: by the form an undo puts back, where it stood, or else by the label.
  if (at >= 0) return putBack(tags.filter((tag) => !same(tag, label)), back && same(back.label, label) ? back : { label, at });
  if (tags.length >= MAX_CONTACT_TAGS) return "skip";
  return putBack([...tags], back);
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
  /** Of `changes`, contacts holding the label only in a look-alike form, which is replaced with it (adding only). */
  replaced?: number;
};

/** The change that takes one back. */
export const opposite = (change: BulkChange): BulkChange => (change === "add" ? "remove" : "add");

/**
 * What a change did to the addresses it was sent (the route's answer).
 * `noRoom`: not written, the store's data room being full; `failed`: left
 * when something went wrong part way, which may or may not have been
 * written; `replaced`: of those changed, contacts whose look-alike form was
 * replaced with the label.
 */
export type BulkOutcome = { changed: number; already: number; full: number; notOnList: number; noRoom?: number; failed?: number; replaced?: number };

const busyWords = (busy: number) => `${count(busy, "contact was", "contacts were")} being changed somewhere else at the same moment, so ${busy === 1 ? "it was" : "they were"} left as ${busy === 1 ? "it is" : "they are"}`;

/**
 * What a change applied tells the creator: how many it changed and, when any
 * address was left out, how many and why, in plain words. `asked` is how many
 * different addresses were sent; what no other reason explains was being
 * changed somewhere else at that moment.
 */
export function applySummary(asked: number, answer: BulkOutcome, change: BulkChange, label = ""): { short: string; words: string } {
  const changed = Math.min(asked, answer.changed);
  const done = `Done: ${count(changed, "contact", "contacts")} changed.`;
  const replaced = change === "add" ? Math.min(changed, answer.replaced ?? 0) : 0;
  const swap = replaced ? ` ${count(replaced, "contact", "contacts")} had this label written another way, now written as “${label}” so sending and automations find it.` : "";
  const left = asked - changed;
  if (left <= 0) return { short: done, words: `${done}${swap}` };
  const already = Math.min(left, answer.already);
  const full = change === "add" ? Math.min(left - already, answer.full) : 0;
  const gone = Math.min(left - already - full, answer.notOnList);
  const noRoom = Math.min(left - already - full - gone, answer.noRoom ?? 0);
  const failed = Math.min(left - already - full - gone - noRoom, answer.failed ?? 0);
  const busy = left - already - full - gone - noRoom - failed;
  const why = [
    already ? (change === "add" ? `${count(already, "contact already has", "contacts already have")} the label` : `${count(already, "contact doesn't", "contacts don't")} have it`) : "",
    full ? `${count(full, "contact has", "contacts have")} ${MAX_CONTACT_TAGS} labels already, the most a contact can have` : "",
    gone ? `${count(gone, "address is", "addresses are")} not on your list` : "",
    noRoom ? `${count(noRoom, "contact was", "contacts were")} not changed because your store has no room left for more records` : "",
    failed ? `something went wrong with ${count(failed, "contact", "contacts")}, so ${failed === 1 ? "it" : "they"} may not have changed; review again to see` : "",
    busy ? busyWords(busy) : "",
  ].filter(Boolean);
  const out = `${left.toLocaleString("en-US")} ${left === 1 ? "was" : "were"} left out`;
  return { short: `${done} ${out}.`, words: `${done} ${out}: ${why.join("; ")}.${swap}` };
}

/**
 * What an undo tells the creator, from what the route answers: every contact
 * as it was only when every one sent back went back; otherwise how many did
 * not, and why, in plain words. A contact already as it was before (the label
 * taken off, or put back, some other way since) counts as back. `merged`:
 * contacts put back that had held the label in more than one form, which got
 * the first one back; `cleaned`: contacts whose form went back without the
 * hidden characters it had (withoutHidden). Each is said for the undo it is:
 * of a removal (the label back) or of an add (the earlier form back).
 */
export function undoSummary(asked: number, answer: BulkOutcome, undo: BulkChange, notes: { merged?: number; cleaned?: number } = {}): { allBack: boolean; short: string; words: string } {
  const back = Math.min(asked, answer.changed + answer.already);
  const notBack = asked - back;
  const merged = notes.merged ?? 0;
  const cleaned = notes.cleaned ?? 0;
  // An undo of a removal puts the label back; an undo of an add puts back the earlier form an add replaced.
  const it = (n: number) => (n === 1 ? "it" : "they");
  const extra = [
    merged > 0
      ? undo === "add"
        ? `${count(merged, "contact", "contacts")} had this label in more than one form. ${merged === 1 ? "It" : "They"} got the label back once, in the first form.`
        : `${count(merged, "contact", "contacts")} had this label in more than one form before. ${merged === 1 ? "It" : "They"} got back only the first of them.`
      : "",
    cleaned > 0
      ? undo === "add"
        ? `${count(cleaned, "contact", "contacts")} got the label back without the hidden characters ${it(cleaned)} had.`
        : `${count(cleaned, "contact", "contacts")} got ${cleaned === 1 ? "its" : "their"} earlier form of the label back without the hidden characters ${it(cleaned)} had.`
      : "",
  ]
    .filter(Boolean)
    .map((words) => ` ${words}`)
    .join("");
  if (notBack <= 0) {
    const head = undo === "add" ? "Undone. Every contact has the label back as it was shown." : "Undone. Every contact has its earlier form of the label back as it was shown.";
    if (extra) return { allBack: false, short: head, words: `${head}${extra}` };
    return { allBack: true, short: "Undone. Every contact is as it was.", words: "Undone. Every contact is as it was." };
  }
  const gone = Math.min(notBack, answer.notOnList);
  const full = undo === "add" ? Math.min(notBack - gone, answer.full) : 0;
  const noRoom = Math.min(notBack - gone - full, answer.noRoom ?? 0);
  const failed = Math.min(notBack - gone - full - noRoom, answer.failed ?? 0);
  const busy = notBack - gone - full - noRoom - failed;
  const why = [
    gone ? `${count(gone, "contact is", "contacts are")} no longer on your list` : "",
    full ? `${count(full, "contact has", "contacts have")} ${MAX_CONTACT_TAGS} labels now, the most a contact can have, so the label could not go back on` : "",
    noRoom ? `${count(noRoom, "contact", "contacts")} could not get the label back because your store has no room left for more records` : "",
    failed ? `something went wrong with ${count(failed, "contact", "contacts")}, so ${failed === 1 ? "it" : "they"} may not be back; review again to see` : "",
    busy ? busyWords(busy) : "",
  ].filter(Boolean);
  const head = `Undone for ${back.toLocaleString("en-US")} of ${count(asked, "contact", "contacts")}.`;
  return { allBack: false, short: `${head} ${count(notBack, "contact", "contacts")} did not go back.`, words: `${head} ${count(notBack, "contact", "contacts")} did not go back: ${why.join("; ")}.${extra}` };
}
