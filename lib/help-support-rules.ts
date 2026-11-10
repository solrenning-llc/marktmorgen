/**
 * The words and bounds of "Send this to support" (lib/help-support.ts), shared by the server and the studio's form:
 * nothing here sends, reads or keeps anything.
 */
/** The most a creator sends in one request, after editing it. */
export const MAX_SUPPORT_TEXT = 4_000;
/** The least that is a request at all. */
export const MIN_SUPPORT_TEXT = 10;
/** Requests a store may send in 24 hours: two emails each, on the company's meter. */
export const SUPPORT_PER_DAY = 5;
export const SUPPORT_WINDOW_SECONDS = 86_400;
/** Emails one request sends: the support inbox and the copy to the creator. */
export const SUPPORT_EMAILS_PER_REQUEST = 2;

/** A request's number: "SR-" and two groups of four symbols, without I, L, O or U. */
export const SUPPORT_NUMBER = /^SR-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

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
