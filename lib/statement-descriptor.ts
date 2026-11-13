/**
 * The store's name on the buyer's card statement (607 [WP6], unit 1, 10
 * November 2026): pure rules, no Stripe call and no Redis.
 *
 * A buyer who does not recognise a charge on their statement may dispute it
 * ("not recognised"), and a dispute costs the creator its fee and puts their
 * Stripe account at risk. Every charge here is a direct charge on the
 * creator's own Stripe account, so the statement shows that account's
 * descriptor; when the creator sells under a store name that is not their
 * business name, the buyer may not connect the two. Stripe lets a card charge
 * add a suffix after the account's prefix: "JANESMITH* Yoga Flow".
 *
 * Source read (10 November 2026): Stripe's own Node library, stripe@23.1.0,
 * generated from Stripe's OpenAPI for API version 2026-10-28.endive.
 * - Checkout Session create: `payment_intent_data.statement_descriptor_suffix`
 *   "Provides information about a card charge. Concatenated to the account's
 *   statement descriptor prefix to form the complete statement descriptor that
 *   appears on the customer's statement." `payment_intent_data` is "for
 *   Checkout Sessions in `payment` mode"; `subscription_data` has no such
 *   field, so a subscription's Checkout gets no suffix here.
 * - The account's prefix: `settings.card_payments.statement_descriptor_prefix`
 *   ("This field prefixes any dynamic `statement_descriptor` specified on the
 *   charge"), `string | null`.
 * - Statement descriptors carry "the 22-character limit"; for the Japanese
 *   variant, "the concatenation of both prefix and suffix (including
 *   separators) will appear truncated to 22 characters"; an invoice's
 *   descriptor "must contain at least one letter".
 * docs.stripe.com itself could not be reached from the session that wrote
 * this, so everything the library does not state is taken at its most
 * restrictive reading, never a guess that could be refused or truncated:
 * the whole line, prefix and a two-character separator ("* ") included, fits
 * in 22; only unaccented Latin letters, digits and single spaces are sent;
 * at least one letter; and an unknown prefix sends nothing (rule 24: unknown
 * is never success). Reading the prefix from the creator's account and
 * sending the parameter from each checkout are later units.
 *
 * The prefix's own shape (Codex H2 on #3594, from
 * docs.stripe.com/get-started/account/statement-descriptors, read 10 November
 * 2026): 2 to 10 characters, at least one letter, none of < > \ ' " *. A
 * prefix in any other shape is unknown here, so it never stands in for a
 * verified one.
 */

/** The longest statement descriptor a card statement shows, prefix and separator included. */
export const STATEMENT_DESCRIPTOR_MAX = 22;
/** The shortest and longest account prefix Stripe gives (docs.stripe.com/get-started/account/statement-descriptors, read by Codex H2 on 10 November 2026). */
export const PREFIX_MIN = 2;
export const PREFIX_MAX = 10;
/** Room kept for what joins the prefix and the suffix ("* "). */
export const SEPARATOR_ROOM = 2;
/** A suffix shorter than this tells the buyer nothing; nothing is sent. */
export const MIN_SUFFIX_LENGTH = 2;
/** The Checkout Session parameter, in the form-encoded shape the checkouts send. */
export const SUFFIX_PARAM = "payment_intent_data[statement_descriptor_suffix]";

export type SuffixSkip = "prefix-unknown" | "no-letter" | "too-short" | "no-room" | "in-prefix";

export type SuffixDecision =
  | { kind: "send"; suffix: string; full: string }
  | { kind: "skip"; reason: SuffixSkip };

/**
 * A name as a statement can show it: accents folded to their letters ("Café"
 * → "Cafe"), apostrophes dropped inside a word ("Jane's" → "Janes"), every
 * other character (signs, other scripts, emoji) turned into a space, and the
 * spaces collapsed and trimmed. Only A–Z, a–z, 0–9 and single spaces remain.
 */
export function descriptorText(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/['’‘`]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
}

/** An account prefix in the shape Stripe gives one; anything else is unknown. */
function isPrefix(prefix: unknown): prefix is string {
  return (
    typeof prefix === "string" &&
    prefix.length >= PREFIX_MIN &&
    prefix.length <= PREFIX_MAX &&
    prefix === prefix.trim() &&
    /^[\x20-\x7e]+$/.test(prefix) &&
    !/[<>\\'"*]/.test(prefix) &&
    /[A-Za-z]/.test(prefix)
  );
}

/** Cut to the room, at the last whole word when one fits, otherwise at the room itself. */
function cut(text: string, room: number): string {
  if (text.length <= room) return text;
  const head = text.slice(0, room);
  if (text[room] === " ") return head.trimEnd();
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head).trimEnd();
}

/**
 * What to send after the creator's account prefix for a store named
 * `storeName`, or why nothing is sent. `prefix` is the account's
 * `settings.card_payments.statement_descriptor_prefix` exactly as read; any
 * value not in the shape Stripe gives a prefix (PREFIX_MIN to PREFIX_MAX
 * characters, at least one letter, printable ASCII without < > \ ' " *, no
 * space at either end) is unknown, never taken as verified (Codex H2 on #3594).
 */
export function statementSuffix(storeName: unknown, prefix: unknown): SuffixDecision {
  if (!isPrefix(prefix)) return { kind: "skip", reason: "prefix-unknown" };
  const name = typeof storeName === "string" ? descriptorText(storeName) : "";
  if (!/[A-Za-z]/.test(name)) return { kind: "skip", reason: "no-letter" };
  if (name.length < MIN_SUFFIX_LENGTH) return { kind: "skip", reason: "too-short" };
  const room = STATEMENT_DESCRIPTOR_MAX - prefix.length - SEPARATOR_ROOM;
  if (room < MIN_SUFFIX_LENGTH) return { kind: "skip", reason: "no-room" };
  const suffix = cut(name, room);
  if (suffix.length < MIN_SUFFIX_LENGTH || !/[A-Za-z]/.test(suffix)) return { kind: "skip", reason: "no-room" };
  if (` ${descriptorText(prefix).toUpperCase()} `.includes(` ${suffix.toUpperCase()} `)) {
    return { kind: "skip", reason: "in-prefix" };
  }
  return { kind: "send", suffix, full: `${prefix}* ${suffix}` };
}

/**
 * The Checkout Session parameters that carry the suffix: only a one-time
 * payment (`payment` mode) takes `payment_intent_data`, and only a decision
 * to send adds anything.
 */
export function suffixParams(mode: "payment" | "subscription" | "setup", decision: SuffixDecision): Record<string, string> {
  if (mode !== "payment" || decision.kind !== "send") return {};
  return { [SUFFIX_PARAM]: decision.suffix };
}
