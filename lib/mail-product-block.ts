/**
 * Products of the store in an email (546 [EB1], unit 1; added 2 November
 * 2026): the rules and the drawing, pure and browser-safe. Putting a block
 * in from the designer, its preview and drawing it at sending are the next
 * units, and come together: until then nothing writes the line, and a line
 * typed by hand is refused before sending once that unit reads it (sending
 * lives in lib/mail.ts, which another open pull request holds).
 *
 *   - A block of 1 to MAX_MAIL_PRODUCTS products, written in the email's text
 *     as a paragraph of its own: PRODUCTS_PREFIX and the products' ids,
 *     space apart ("@products 3f9a1c2b4d 8e7d6c5b4a"). The email stays text
 *     the creator can read, and every way of making one writes the same.
 *   - The pictures, names and prices are never typed: they are read from the
 *     store when the email is drawn, as the products are then, and only for
 *     products of this store on sale (not a draft, not removed). One that is
 *     not leaves the block by itself and the creator is told which; a block
 *     left with none stops the email (blockProblems), never sent empty.
 *   - A line that starts like one but is not a block (inside a paragraph, an
 *     id that is not one, more than the most) stops the email too, saying
 *     why, so a reader never gets it as raw text.
 *   - Each card: the product's picture (only one kept by the store's own
 *     image service; none otherwise), its name as a heading, its price as
 *     the store shows it, and a button to its page whose words name it, in
 *     the store's language, on the store's own button colours (their pair
 *     keeps 7:1). No pixel, discount, countdown, stock count or rating.
 */

export const PRODUCTS_PREFIX = "@products";
export const MAX_MAIL_PRODUCTS = 4;

// A product's id as the store keeps it (SAFE_ID in lib/catalog.ts, which is not browser-safe).
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const STARTS = /^@products?\b/i;

/** What a product card shows, read from the store when the email is drawn. */
export type MailProduct = {
  id: string;
  title: string;
  /** The price as the store shows it, in its language ("$29", "Free"). */
  price: string;
  /** Its picture from the store's image service, or null. */
  picture: { url: string; alt: string } | null;
  /** Its page, an https address. */
  href: string;
};

/** The line for a block of products. */
export function productsLine(ids: string[]): string {
  return `${PRODUCTS_PREFIX} ${ids.join(" ")}`;
}

/** The products a paragraph's block names, or null when it is not a well-made block. */
export function readProductsLine(paragraph: string): string[] | null {
  const words = paragraph.trim().split(/[ \t]+/);
  if (words[0] !== PRODUCTS_PREFIX) return null;
  const ids = words.slice(1);
  if (ids.length < 1 || ids.length > MAX_MAIL_PRODUCTS || !ids.every((id) => ID.test(id)) || new Set(ids).size !== ids.length) return null;
  return ids;
}

const paragraphs = (body: string) => body.replace(/\r\n?/g, "\n").split(/\n{2,}/);

/** Every block of an email's text, in order. */
export function productBlocksIn(body: string): string[][] {
  return paragraphs(body).map(readProductsLine).filter((ids): ids is string[] => ids !== null);
}

export type BlockProblem = { why: "malformed" } | { why: "empty"; ids: string[] };

/**
 * What stops an email for its products, or null: a line that starts like a
 * block and is not one, or a block none of whose products is on sale here
 * now (`onSale`).
 */
export function blockProblems(body: string, onSale: ReadonlySet<string>): BlockProblem | null {
  for (const paragraph of paragraphs(body)) {
    const lines = paragraph.trim().split("\n");
    if (lines.some((line) => STARTS.test(line.trim())) && (lines.length > 1 || readProductsLine(paragraph) === null)) return { why: "malformed" };
  }
  for (const ids of productBlocksIn(body)) if (!ids.some((id) => onSale.has(id))) return { why: "empty", ids };
  return null;
}

/** The products of a block that leave it now, to tell the creator; the email still goes with the rest. */
export function leavingProducts(body: string, onSale: ReadonlySet<string>): string[] {
  return [...new Set(productBlocksIn(body).flat().filter((id) => !onSale.has(id)))];
}

/** “A”, “B” and “C”. */
const names = (titles: string[]) => {
  const q = titles.map((t) => `“${t}”`);
  return q.length > 1 ? `${q.slice(0, -1).join(", ")} and ${q.at(-1)}` : q.join("");
};

/** What the studio says, in plain words. `titleOf` gives a product's name, or null when it was removed. */
export function blockWords(problem: BlockProblem | { why: "leaving"; ids: string[] }, titleOf: (id: string) => string | null): string {
  if (problem.why === "malformed") return `A line starting with ${PRODUCTS_PREFIX} must be a paragraph of its own with 1 to ${MAX_MAIL_PRODUCTS} of your products. Add products from the editor, or take the line out.`;
  const known = [...new Set(problem.ids.map(titleOf).filter((t): t is string => Boolean(t)))];
  const removed = problem.ids.filter((id) => !titleOf(id)).length;
  const parts = [...(known.length ? [names(known)] : []), ...(removed ? [removed === 1 ? "1 removed product" : `${removed} removed products`] : [])];
  const who = parts.join(" and ");
  const one = problem.ids.length === 1;
  if (problem.why === "leaving") return `${who} ${one ? "is" : "are"} not on sale in your store now, so ${one ? "it is" : "they are"} left out of this email.`;
  return `None of the products in a block is on sale in your store now (${who}), so this email can't be sent. ${known.length ? "Publish one, or take the block out." : "Take the block out."}`;
}

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HEX = /^#[0-9a-f]{6}$/i;

export type CardStyle = {
  /** The store's own button colours (lookColours in lib/store-look.ts: accent and onAccent), whose pair keeps 7:1. */
  button: { fill: string; on: string };
  /** The button's words for a product, in the store's language ("See …"). */
  see: (title: string) => string;
  /** The heading level for the name: one below the email's last heading before it, 2 with none. */
  level: 2 | 3;
  /** Where the store's image service answers: a picture is drawn only from there. */
  images: string;
  /** The email's tag on a link, as for every other link. */
  goesTo?: (href: string) => string;
};

const DEFAULT_BUTTON = { fill: "#4c1d95", on: "#ffffff" };

/** One card in the email's HTML, or "" when its page is not an https address. */
export function productCardHtml(product: MailProduct, style: CardStyle): string {
  if (!/^https:\/\/[^\s<>"']+$/.test(product.href)) return "";
  const pair = HEX.test(style.button.fill) && HEX.test(style.button.on) ? style.button : DEFAULT_BUTTON;
  const href = escape(style.goesTo ? style.goesTo(product.href) : product.href);
  const fromImages = product.picture && style.images.startsWith("https://") && product.picture.url.startsWith(`${style.images.replace(/\/$/, "")}/api/image/`) && !/[\s<>"']/.test(product.picture.url);
  // The card's inner width in the email: Outlook on Windows takes the width attribute as it is.
  const picture = fromImages
    ? `<img src="${escape(product.picture!.url)}" alt="${escape(product.picture!.alt)}" width="438" style="display:block;width:100%;max-width:438px;height:auto;border:0;border-radius:12px;margin:0 0 12px">`
    : "";
  const h = `h${style.level}`;
  return (
    `<div style="margin:0 0 24px;padding:16px;border:1px solid #e7e5e4;border-radius:16px">` +
    picture +
    `<${h} style="margin:0 0 4px;font-size:18px;line-height:1.3;font-weight:700;color:#1c1917">${escape(product.title)}</${h}>` +
    `<p style="margin:0 0 12px;color:#1c1917">${escape(product.price)}</p>` +
    `<p style="margin:0"><a href="${href}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:${pair.fill};color:${pair.on};font-weight:700;text-decoration:none">${escape(style.see(product.title))}</a></p>` +
    `</div>`
  );
}

/** A card in the plain-text email: its name, its price and its page. */
export function productCardText(product: MailProduct): string {
  return `${product.title} (${product.price}): ${product.href}`;
}
