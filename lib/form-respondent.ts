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
 * Who sent a response: the address in the form's first email question that
 * holds one, in the form's order, as readAnswers keeps `email` (lib/forms.ts)
 * for the list offer. An address in any other question does not make the
 * response that person's.
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
 *              since) and some answers are this person's address: who sent it
 *              cannot be told. The copy gives those answers alone, so nobody
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
 * Lengths are counted in UTF-8 bytes, as Lua counts them.
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

const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * Whether a folded text is an address, the rule lib/forms.ts checks when it is
 * typed (one "@", 1 to 64 before it, then 1 to 255, a dot and 2 or more), in
 * UTF-8 bytes, at most 254 in all.
 */
export function isAddress(text: string): boolean {
  if (bytes(text) > 254 || SPACE.test(text)) return false;
  const at = text.indexOf("@");
  if (at < 0 || text.indexOf("@", at + 1) >= 0) return false;
  const user = bytes(text.slice(0, at));
  if (user < 1 || user > 64) return false;
  const domain = text.slice(at + 1);
  for (let dot = domain.indexOf("."); dot >= 0; dot = domain.indexOf(".", dot + 1)) {
    const before = bytes(domain.slice(0, dot));
    if (before > 255) return false;
    if (before >= 1 && bytes(domain.slice(dot + 1)) >= 2) return true;
  }
  return false;
}

/** The form's email questions, in its order: the first that holds an address tells who sent a response. */
export function emailQuestionIds(form: Pick<FormDef, "fields">): string[] {
  return form.fields.filter((field) => field.type === "email").map((field) => field.id);
}

/** Who sent a response (folded), or null when none of these email questions holds an address. */
export function respondentOf(emailIds: readonly string[], answers: Answers): string | null {
  for (const id of emailIds) {
    const given = Object.hasOwn(answers, id) ? answers[id] : undefined;
    if (typeof given !== "string") continue;
    const address = foldAddress(given);
    if (isAddress(address)) return address;
  }
  return null;
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
