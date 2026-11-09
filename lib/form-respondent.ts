/**
 * Whose a kept form response is, one rule for everything that looks for one
 * person's responses: the copy of their data (lib/person-copy.ts), their
 * erasure (lib/form-store.ts, FORGET_FORM_PERSON, whose Lua says these same
 * rules line for line) and the deal drafted from a response
 * (lib/form-deal.ts). Claude 6's audit R19, MEDIUM 1: an address typed in any
 * answer used to make the response that person's, so when Olly answered "Who
 * referred you?" with Tess's address, Tess's copy carried Olly's answers and
 * deleting Tess deleted Olly's response.
 *
 * Who sent a response: the address its email questions hold, when every one
 * of them that holds an address holds the same one. When two hold different
 * addresses ("Invite a friend (email)" before "Your email"), who sent it
 * cannot be told, and the response is "unknown" to both. An address in any
 * other question never makes the response that person's.
 *
 * For one person, a response is:
 *
 *   "sent"     they sent it: the copy gives all of it, the erasure deletes it.
 *   "named"    a known other address sent it and some answers are this
 *              person's address: the copy gives those answers alone, never
 *              the sender's; the erasure takes those answers out and keeps
 *              the rest of the sender's response.
 *   "unknown"  no email question of the form as it is now holds an address
 *              (a form without one, one left empty, one removed or changed
 *              since), or two hold different ones, and some answers are this
 *              person's address: who sent it cannot be told. The copy gives those answers alone, so nobody
 *              else's words go out on a guess; the erasure deletes the whole
 *              response, because taking it for somebody else's would leave
 *              this person's other answers behind if it is theirs.
 *   "none"     nothing in it is theirs.
 *
 * Addresses are compared folded the way Redis's Lua can fold them: spaces,
 * tabs and line breaks trimmed at both ends, and A to Z lowered, nothing
 * else. A form keeps what is typed in an email question already lowered
 * (readAnswers); an address typed with capitals outside A to Z in another
 * question ("ÖLAF@...") is not found by either side, the same for both.
 * Lengths are counted as lib/forms.ts counts them when an address is typed
 * (its EMAIL pattern and the slice to 254): in JavaScript's units, one for a
 * character up to U+FFFF and two for one above it. The Lua counts the same
 * from the UTF-8 bytes: one for each byte that does not continue a character,
 * and one more for each that starts a four-byte one.
 */
import type { Answers, FormDef } from "@/lib/forms";

export type FormPersonRole = "sent" | "named" | "unknown" | "none";

const EDGE = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
const SPACE = /[\t\n\v\f\r ]/;

/** A text folded as Lua folds it: string.lower(string.match(text, "^%s*(.-)%s*$")). */
export function foldAddress(text: string): string {
  return text.replace(EDGE, "").replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

/** The person's own address, as it is compared and as it is sent to the erasure's script. */
export function personAddress(email: string): string {
  return foldAddress(email.trim().toLowerCase());
}

/**
 * Whether a folded text is an address, the rule lib/forms.ts checks when it is
 * typed (one "@", 1 to 64 before it, then 1 to 255, a dot and 2 or more), at
 * most 254 in all, every length in JavaScript's units as the form counts it.
 */
export function isAddress(text: string): boolean {
  if (text.length > 254 || SPACE.test(text)) return false;
  const at = text.indexOf("@");
  if (at < 0 || text.indexOf("@", at + 1) >= 0) return false;
  if (at < 1 || at > 64) return false;
  const domain = text.slice(at + 1);
  for (let dot = domain.indexOf("."); dot >= 0; dot = domain.indexOf(".", dot + 1)) {
    if (dot > 255) return false;
    if (dot >= 1 && domain.length - dot - 1 >= 2) return true;
  }
  return false;
}

/** The form's email questions, in its order: the address they hold tells who sent a response. */
export function emailQuestionIds(form: Pick<FormDef, "fields">): string[] {
  return form.fields.filter((field) => field.type === "email").map((field) => field.id);
}

/**
 * Who sent a response (folded): the address its email questions hold. Null
 * when none of them holds one, or when two hold different ones, since the
 * first may be a friend's ("Invite a friend (email)" before "Your email").
 */
export function respondentOf(emailIds: readonly string[], answers: Answers): string | null {
  let sender: string | null = null;
  for (const id of emailIds) {
    const given = Object.hasOwn(answers, id) ? answers[id] : undefined;
    if (typeof given !== "string") continue;
    const address = foldAddress(given);
    if (!isAddress(address)) continue;
    if (sender !== null && sender !== address) return null;
    sender = address;
  }
  return sender;
}

/**
 * Whether any of the email questions holds an address: when none does and the sender cannot be told, it is
 * because no address was given, not because two disagree (respondentOf is null for both).
 */
export function anyAddressGiven(emailIds: readonly string[], answers: Answers): boolean {
  return emailIds.some((id) => {
    const given = Object.hasOwn(answers, id) ? answers[id] : undefined;
    return typeof given === "string" && isAddress(foldAddress(given));
  });
}

/** The questions (by id, any kept answer, a removed question's included) whose answer is this address. */
export function answersNaming(answers: Answers, address: string): string[] {
  return Object.keys(answers).filter((id) => {
    const given = answers[id];
    return typeof given === "string" && foldAddress(given) === address;
  });
}

/** What one response is to one person (`address` from personAddress), and which answers are their address. */
export function personInResponse(emailIds: readonly string[], answers: Answers, address: string): { role: FormPersonRole; named: string[] } {
  const named = answersNaming(answers, address);
  const sender = respondentOf(emailIds, answers);
  if (sender !== null && sender === address) return { role: "sent", named };
  if (!named.length) return { role: "none", named };
  return { role: sender === null ? "unknown" : "named", named };
}
