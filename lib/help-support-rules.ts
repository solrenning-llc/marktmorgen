/**
 * The words and bounds of "Send this to support" (lib/help-support.ts), shared by the server and the studio's form:
 * nothing here sends, reads or keeps anything.
 */
import { SUPPORT_EMAIL } from "@/lib/creator-research";

/** The most a creator sends in one request, after editing it. */
export const MAX_SUPPORT_TEXT = 4_000;
/** The least that is a request at all. */
export const MIN_SUPPORT_TEXT = 10;
/** Requests a store may send in 24 hours: two emails each, on the company's meter. */
export const SUPPORT_PER_DAY = 5;
export const SUPPORT_WINDOW_SECONDS = 86_400;
/** Emails one request sends: the support inbox and the copy to the creator. */
export const SUPPORT_EMAILS_PER_REQUEST = 2;

/**
 * The inbox's email did not confirm, said by the server and by the form alike. A false from sendEmail, or no answer
 * read in the browser, may be a refusal or an email taken whose answer was lost, so it is never said "nothing was
 * sent" (rule 24). A try sent again keeps the number but is counted toward SUPPORT_PER_DAY like any other (the cap is
 * taken before any email), so the words point to the support address first and say that each try counts.
 */
export function unconfirmedWords(number: string): string {
  return `We could not confirm that your request reached support, so it may or may not have been sent. Its number is ${number}. To be sure, write to ${SUPPORT_EMAIL} and give that number. Or send it again: it keeps the same number, so support sees one request, but each try counts toward your store's ${SUPPORT_PER_DAY} requests a day.`;
}

/** A request's number: "SR-" and two groups of four symbols, without I, L, O or U. */
export const SUPPORT_NUMBER = /^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A request's number from 5 random bytes: 40 bits, five at a time by shifts and masks, so each symbol is as likely.
 * Pure, so the studio's form makes one number per request in the browser and sends it with every try: a try whose
 * answer was lost and the next one are then the same request, under the same idempotency key (Codex U on #3617).
 */
export function supportNumberOf(bytes: Uint8Array): string {
  if (bytes.length < 5) throw new Error("a support request number needs 5 random bytes");
  let buffer = 0;
  let held = 0;
  let out = "";
  for (let i = 0; i < 5; i++) {
    buffer = ((buffer << 8) | bytes[i]) & 0xfff;
    held += 8;
    while (held >= 5) {
      held -= 5;
      out += BASE32[(buffer >> held) & 31];
    }
  }
  return `SR-${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

/** Text as it can be sent: invisible and control characters taken out (new lines and tabs kept), then trimmed. */
export function cleanSupportText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}]/gu, "")
    .trim();
}

/** The draft the creator sees and can edit before sending: their question and the answer they were given. */
export function supportDraft(question: string, answer: string): string {
  const q = cleanSupportText(question).slice(0, 1_000);
  const a = cleanSupportText(answer).slice(0, 2_000);
  return [`My question: ${q}`, "", `The answer I got: ${a}`, "", "What I still need: "].join("\n");
}

/** The studio screen a request came from, only when it is one: never a link elsewhere written into the email. */
export function supportScreen(raw: unknown): string {
  if (typeof raw !== "string") return "the studio";
  const path = raw.split(/[?#]/)[0];
  return /^\/studio(\/[a-z0-9-]{1,40}){0,3}$/.test(path) ? path : "the studio";
}
