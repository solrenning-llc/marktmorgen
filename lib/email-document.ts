/**
 * The whole HTML document around a plain email (AX274 Part A, item 5: every
 * transactional email is accessible HTML with a text version beside it).
 *
 * A bare `<div>` or `<p>` fragment leaves the message without a document
 * language a screen reader can pick a voice by (WCAG 3.1.1), without a title
 * when the HTML is opened on its own, saved or forwarded (2.4.2), and without a
 * character set, so an accented store name can be read wrongly. This wraps the
 * same words in a complete document: `lang`, a `<title>` from the subject,
 * the character set, a viewport for a small screen (1.4.10), the message as
 * one named article, text at 16 px with a line height of 1.6 (1.4.8) in a
 * column no wider than about 70 characters, and ink on paper far above 7:1
 * (1.4.6). It changes no word of the message; the text part stays the same.
 */

/** The ink and paper of a plain email: #1c1917 on #ffffff reads at about 17.5:1 (WCAG 1.4.6 asks 7:1). */
export const EMAIL_INK = "#1c1917";
export const EMAIL_PAPER = "#ffffff";

export function escapeEmailHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A plain-text email's paragraphs (separated by a blank line) as HTML paragraphs, its single line breaks kept. */
export function emailParagraphs(text: string): string {
  return text
    .split("\n\n")
    .map((para) => `<p style="margin:0 0 16px">${escapeEmailHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * The complete document. `lang` is the BCP 47 tag the words are written in,
 * `title` the email's subject, `body` HTML already escaped by the caller.
 */
export function emailDocument({ lang, title, body }: { lang: string; title: string; body: string }): string {
  const tag = escapeEmailHtml(lang.trim() || "en-US");
  const name = escapeEmailHtml(title.replace(/[\r\n]+/g, " ").trim().slice(0, 200));
  return (
    `<!doctype html><html lang="${tag}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${name}</title></head><body style="margin:0;padding:0;background:${EMAIL_PAPER};color:${EMAIL_INK}">` +
    `<div role="article" aria-roledescription="email" aria-label="${name}" lang="${tag}" style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${EMAIL_INK};background:${EMAIL_PAPER}">` +
    `${body}</div></body></html>`
  );
}
