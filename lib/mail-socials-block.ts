/**
 * The store's profiles elsewhere in an email (546 [EB1], unit 1; added
 * 2 November 2026): the rules and the drawing, pure and browser-safe, as for
 * a product (lib/mail-product-block.ts).
 *
 *   - Written as a paragraph of its own: SOCIALS_LINE.
 *   - Drawn from the profiles the store keeps (lib/store-socials.ts, the row
 *     under its name on the store page), as they are when the email is
 *     drawn: only those, each address rebuilt there from what was typed and
 *     only on that network's own host. Never a company's logo: each is its
 *     name, as a link.
 *   - With none kept that the store page would link (https, or an email
 *     address), the email is refused before it goes, never sent with an
 *     empty row.
 *   - A line that starts like the row but is not it (@Socials, @social, or
 *     inside a paragraph) stops the email too, saying why, so a reader never
 *     gets it as raw text.
 *   - Links carry the email's tag, as every other link; an email address
 *     opens the reader's mail app and carries none.
 */
import { SOCIALS, type Social } from "@/lib/store-socials";

export const SOCIALS_LINE = "@socials";
const STARTS_SOCIALS = /^@socials?\b/i;

/** Whether a paragraph is the profiles' row. */
export function isSocialsLine(paragraph: string): boolean {
  return paragraph.trim() === SOCIALS_LINE;
}

/** Whether an email's text holds the row. */
export function hasSocials(body: string): boolean {
  return body.replace(/\r\n?/g, "\n").split(/\n{2,}/).some(isSocialsLine);
}

/** Only addresses the store page itself would link: https, or an email address. */
const linkable = (url: string) => /^https:\/\/[^\s<>"']+$/.test(url) || /^mailto:[^\s<>"']+$/.test(url);

/**
 * Why an email cannot go with its row, in plain words, or null: a line that
 * starts like the row and is not it, or a row with no profile to show.
 */
export function socialsProblem(body: string, socials: readonly Social[]): string | null {
  for (const paragraph of body.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = paragraph.trim().split("\n");
    if (lines.some((line) => STARTS_SOCIALS.test(line.trim())) && !isSocialsLine(paragraph)) {
      return `A line starting with ${SOCIALS_LINE} must be a paragraph of its own, written ${SOCIALS_LINE}. Add the profiles from the editor, or take the line out.`;
    }
  }
  return hasSocials(body) && !socials.some((social) => linkable(social.url)) ? "Your store has no profiles to show yet. Add them under your store's name in the studio, or take the profiles out of the email." : null;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The row in the email's HTML: each profile's name as a link, in the store's order; empty with none. */
export function socialsHtml(socials: readonly Social[], goesTo?: (href: string) => string): string {
  const links = socials
    .filter((social) => linkable(social.url))
    .map((social) => {
      const href = social.url.startsWith("https://") && goesTo ? goesTo(social.url) : social.url;
      return `<a href="${escape(href)}" style="color:#4c1d95;text-decoration:underline">${escape(SOCIALS[social.network].label)}</a>`;
    });
  return links.length ? `<p style="margin:0 0 16px">${links.join(" · ")}</p>` : "";
}

/** The row in the plain-text email: each name and where it goes. */
export function socialsText(socials: readonly Social[]): string {
  return socials
    .filter((social) => linkable(social.url))
    .map((social) => `${SOCIALS[social.network].label}: ${social.url.replace(/^mailto:/, "")}`)
    .join("\n");
}
