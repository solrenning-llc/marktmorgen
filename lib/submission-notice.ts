/**
 * The buyer is told when the creator replies to a file they sent for review
 * (750 [CD1] unit 6): one email for each reply, sent through the one place
 * that sends email (lib/email.ts, sendEmail), counted against the store's
 * own emails (meter "store", kind "email"), which lib/email.ts takes before
 * the email goes: a store whose emails are spent, or whose figure cannot be
 * read, sends nothing, and the buyer still sees the reply on the lesson page.
 *
 *   - Once: a mark (nl:sub:told:<folder>:<id>) is claimed before sending
 *     (lib/claim-mark.ts) and kept, so a reply is never emailed twice, not
 *     even after a send that may have gone; a mark that cannot be read sends
 *     nothing. The record itself moves to "reviewed" only once
 *     (lib/submission-store.ts, replySubmission), and this is called only on
 *     that move, so the mark guards the rest: a retry, or two calls at once.
 *   - Never to an address that bounced or complained (lib/contacts.ts, gone)
 *     or that was deleted from the store (lib/suppression.ts). One that only
 *     left the creator's list is still told: this is about their own file,
 *     not the creator's news. A check that cannot be read sends nothing.
 *   - From the store's name, as every course email (noticeSender).
 *   - Honest: the subject says who replied and on which lesson; the email
 *     carries the reply, the way back to the lesson, why it came, the
 *     creator's name and postal address when the store has one, and who sent
 *     it. A text and an HTML version, the HTML with its language, every
 *     value escaped, and no image, so nothing reports that it was opened.
 *   - In the store's language (lib/buyer-words/submissions.ts).
 */
import { normaliseEmail } from "@/lib/auth";
import { claimMark } from "@/lib/claim-mark";
import { leadsKey, parseContact } from "@/lib/contacts";
import { NIMBUS_FROM, oneAddress, sendEmail } from "@/lib/email";
import { SITE_URL } from "@/lib/site-url";
import { redisPipeline } from "@/lib/redis";
import { repliesFor } from "@/lib/redis-reply";
import { suppressedCommand } from "@/lib/suppression";
import { submissionsWords } from "@/lib/buyer-words/submissions";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import type { KeptSubmission } from "@/lib/submission-store";
import type { Store } from "@/lib/store";

/** How long the once-only mark is kept: past any retry of the reply that sent it. */
export const SUBMISSION_TOLD_SECONDS = 2 * 86_400;
/**
 * Redis commands this file sends for one reply, at most: the contact and the
 * deletion check (one batch of two), the mark and its read-back. The email's
 * own allowance take is lib/email.ts's, priced with each store email.
 */
export const SUBMISSION_NOTICE_COMMANDS = 4;

export type NoticeMessage = Parameters<typeof sendEmail>[0];
export type ReplyNotice = "sent" | "unsent" | "already" | "stopped" | "unknown" | "none";

type NoticeInput = { store: Store; productId: string; productTitle: string; lessonTitle: string; submission: KeptSubmission };

const ID = /^[0-9a-f]{32}$/;
const toldKey = (folder: string, id: string) => `nl:sub:told:${folder}:${id}`;

/**
 * The From line of every course email, as lib/learn.ts (courseSender) writes
 * it: the store's name "via Marktmorgen", from the company's sending
 * address. Written here so this file does not load the whole course module;
 * tests/submission-notice.test.ts holds the two the same.
 */
export function noticeSender(store: Pick<Store, "name">): string {
  const name = String(store.name ?? "").replace(/["\\<>\r\n]/g, "").trim().slice(0, 60) || "A store";
  const match = NIMBUS_FROM.match(/<([^>]+)>/);
  return `"${name} via Marktmorgen" <${(match ? match[1] : NIMBUS_FROM).trim()}>`;
}

function excerpt(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The email for one reply, in the store's language: its subject, its text and the same as a page. */
export function replyNoticeMessage(input: NoticeInput): { subject: string; text: string; html: string } {
  const { store, submission } = input;
  const w = submissionsWords(store.language);
  const name = excerpt(store.name, 80);
  const lesson = excerpt(input.lessonTitle, 120);
  const course = excerpt(input.productTitle, 120);
  const file = excerpt(submission.file?.name ?? "", 120);
  const reply = String(submission.reply?.text ?? "");
  const lessonId = submission.target.kind === "lesson" ? submission.target.lessonId : "";
  // On this site, where every store's pages are: a creator's own domain is not assumed to be live.
  const link = `${SITE_URL}/@${store.handle}/course/${encodeURIComponent(input.productId)}/${encodeURIComponent(lessonId)}#submission`;
  const fromName = store.mail?.fromName || store.name;
  const address = store.mail?.address?.trim() ?? "";
  const postal = address ? `${fromName} · ${address}` : "";
  const subject = w.mailSubject(name, lesson).slice(0, 200);
  const lead = w.mailLead(name, file, lesson, course);
  const text = [lead, "", w.mailWrote(name), "", reply, "", w.mailOpen, link, "", "—", w.mailWhy, ...(postal ? [postal] : []), w.mailSentBy(name)].join("\n");
  const html = `<!doctype html><html lang="${escape(LANGUAGES[parseLanguage(store.language)].locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(subject)}</title></head><body style="margin:0;padding:0;background:#f7f5f0">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1c1917">
<div style="background:#ffffff;border-radius:16px;padding:28px 24px">
<p style="margin:0 0 16px">${escape(lead)}</p>
<p style="margin:0 0 8px;font-weight:600">${escape(w.mailWrote(name))}</p>
<blockquote style="margin:0 0 16px;padding:0 0 0 12px;border-left:3px solid #57534e;white-space:pre-wrap">${escape(reply)}</blockquote>
<p style="margin:0">${escape(w.mailOpen)} <a href="${escape(link)}" style="color:#1c1917;text-decoration:underline">${escape(w.mailOpenLink(lesson))}</a></p>
</div>
<div style="padding:20px 8px 0;font-size:13px;line-height:1.5;color:#57534e">
<p style="margin:0 0 8px">${escape(w.mailWhy)}</p>
${postal ? `<p style="margin:0 0 8px">${escape(postal)}</p>\n` : ""}<p style="margin:0">${escape(w.mailSentBy(name))}</p>
</div></div></body></html>`;
  return { subject, text, html };
}

/**
 * What the studio is told about the email (750 [CD1] unit 6): true only when
 * it went; false only when none was tried; "unknown" when a send was tried and
 * not confirmed, or an earlier try holds the mark, since lib/email.ts answers
 * false also for a send that may have gone. Never "none went" for an unknown.
 */
export function emailedAnswer(told: ReplyNotice): boolean | "unknown" {
  if (told === "sent") return true;
  if (told === "unsent" || told === "already") return "unknown";
  return false;
}

/**
 * Whether this address may be told: "open", "stopped" (bounced, complained,
 * or deleted from the store) or "unknown" when a check did not read exactly.
 */
async function recipient(store: Store, email: string): Promise<"open" | "stopped" | "unknown"> {
  const listId = store.listId ?? null;
  let replies: unknown[] | null;
  try {
    replies = repliesFor(
      await redisPipeline([listId ? ["HGET", leadsKey(listId), normaliseEmail(email)] : ["EXISTS", "nl:none"], suppressedCommand(listId, email)]),
      2,
    );
  } catch {
    return "unknown";
  }
  if (!replies) return "unknown";
  const [contact, erased] = replies;
  if (erased !== 0 && erased !== 1) return "unknown";
  if (erased === 1) return "stopped";
  if (!listId) return contact === 0 ? "open" : "unknown";
  if (contact === null) return "open";
  const read = parseContact(contact);
  if (typeof contact !== "string" || !read) return "unknown";
  return read.gone === "bounced" || read.gone === "complained" ? "stopped" : "open";
}

/**
 * Tells the buyer of the creator's reply to one of their files, once. Called
 * by the studio's reply route only after the record moved to "reviewed".
 * Answers what happened: "sent"; "unsent" (the sender did not confirm it
 * went: the store's emails are spent, the sender refused, or its answer did
 * not say, so it may have gone; it is not tried again); "already" (the mark
 * was taken before, by a send that went or did not);
 * "stopped" (an address not to write to); "unknown" (a check or the mark did
 * not read, so nothing was sent); "none" (nothing to tell, or no address).
 */
export async function tellBuyerOfReply(input: NoticeInput, send: (message: NoticeMessage) => Promise<boolean> = sendEmail): Promise<ReplyNotice> {
  const { store, submission } = input;
  if (submission.state !== "reviewed" || !submission.reply || submission.target.kind !== "lesson") return "none";
  if (!ID.test(submission.folder) || !ID.test(submission.id)) return "none";
  const to = oneAddress(submission.buyer);
  if (!to) return "none";
  const open = await recipient(store, to);
  if (open !== "open") return open;
  const claimed = await claimMark(toldKey(submission.folder, submission.id), SUBMISSION_TOLD_SECONDS);
  if (claimed === "taken") return "already";
  if (claimed === "unknown") return "unknown";
  const message = replyNoticeMessage(input);
  // The mark stays whatever happens next: a send that may have gone is never repeated.
  const went = await send({
    meter: { by: "store", store, kind: "email" },
    from: noticeSender(store),
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    idempotencyKey: `submission-reply:${submission.folder}:${submission.id}`,
  }).catch(() => false);
  return went ? "sent" : "unsent";
}
