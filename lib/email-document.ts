/**
 * The page around an HTML email (AX274 Part A, item 5). A mail app shows the
 * HTML part as a page: WCAG 2.4.2 asks it to have a title that says what it
 * is (the subject), and 3.1.1 asks for its language on <html>, so a screen
 * reader picks the right voice before the first word. The charset keeps
 * accented words whole; the viewport lets the text reflow on a phone (1.4.10).
 * Pure: no IO, nothing sent.
 */

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** A whole HTML email: `body` is already HTML, `title` (the subject) and `lang` are plain text. */
export function emailDocument(page: { lang: string; title: string; body: string; bodyStyle?: string }): string {
  const title = page.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Email";
  const style = page.bodyStyle ? ` style="${page.bodyStyle.replace(/"/g, "&quot;")}"` : "";
  return `<!doctype html><html lang="${escape(page.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title></head><body${style}>${page.body}</body></html>`;
}
