/**
 * A product sold from the creator's own website: the code they paste there.
 *
 * Measured before it was built (7 October 2026). Gumroad lets a creator put
 * a product on their own site, as a button or an embedded card (its help
 * center, "Build Gumroad into your website"). Stan cannot: its checkout lives
 * at stan.store/<name> and nowhere else, and this site said the same of
 * itself on its comparison page. A creator who already has a blog, a
 * Squarespace page or a portfolio had to send readers away to a link in bio
 * before they could buy.
 *
 * Two things can be pasted, and both are plain HTML, so they go into any
 * page builder that takes HTML (an "Embed", "Code" or "Custom HTML" block)
 * without a script of ours running on the creator's site:
 *
 *   - a card: a frame holding the product's picture, title, price, its
 *     buyers' rating and the buy button. It is drawn by this site on every
 *     visit, so a price changed in the studio, a sale or a sell-out shows on
 *     the creator's site at once. The button opens Stripe's checkout in a new
 *     tab: Stripe will not be drawn inside a frame, and a new tab is the one
 *     way out of a frame that every page builder allows (several hold pasted
 *     code inside a frame of their own that may not move the page).
 *
 *   - a button: a plain link to the product's own page, in the store's
 *     colour, for a page that takes no frames. It says what the creator typed.
 *
 * Both carry utm tags naming where they were pasted, so a sale made through
 * them is reported under that name with the store's other sources
 * (lib/came-from.ts). Nothing else is counted and no cookie is set: the
 * frame is not counted as a visit, because it is drawn on every page of the
 * creator's site whether or not anyone looks at it.
 *
 * Browser-safe: the studio builds the code with these, and the page that
 * draws the card reads the same names.
 */

import { SITE_URL } from "./site-url";
import { contrast } from "./store-look";

/** What the tags call the way in, beside the place name the creator picks. */
export const EMBED_MEDIUM = "buy-button";

/** The place name when the creator leaves it empty. */
export const DEFAULT_PLACE = "website";

/** The longest place name, as lib/came-from.ts keeps it. */
export const MAX_PLACE = 30;

/** The longest text on the plain button. */
export const MAX_BUTTON_TEXT = 60;

/** The card's width in the code: enough for a title, a price and a rating on one line. */
export const CARD_WIDTH = 400;

/**
 * Its height: with the product's picture across the top, or without one.
 * The card page says which it needs (data-card-height on its root), and the
 * studio reads that off its own preview before the code is copied. A card
 * whose product gains or loses a picture later still fits the frame it was
 * pasted in: below CARD_COVER_FROM pixels the picture is drawn small, beside
 * the title, instead.
 */
export const CARD_HEIGHTS = { plain: 260, picture: 420 } as const;
export const CARD_COVER_FROM = 380;

/** The address of the card for one product. */
export function embedPath(handle: string, productId: string): string {
  return `/embed/${handle}/${productId}`;
}

/** Lower case, letters, digits, dots, dashes and underscores: what lib/came-from.ts would keep anyway. */
export function embedPlace(raw: unknown): string {
  const tidy = typeof raw === "string" ? raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "").slice(0, MAX_PLACE) : "";
  return tidy || DEFAULT_PLACE;
}

/** An address with the tags that name where the code was pasted. */
export function tagged(url: string, place: string): string {
  const joined = url.includes("?") ? "&" : "?";
  return `${url}${joined}utm_source=${encodeURIComponent(embedPlace(place))}&utm_medium=${EMBED_MEDIUM}`;
}

/** The tags the card was opened with, passed on to every link it holds, so a sale made a page later still names the place. */
export function placeFrom(source: unknown): string {
  return embedPlace(Array.isArray(source) ? source[0] : source);
}

/** Text as it may stand between tags or inside a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The button's words: what the creator typed, on one line, or "Buy <title>". */
export function buttonText(raw: unknown, title: string): string {
  const typed = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_BUTTON_TEXT) : "";
  return typed || `Buy ${title}`.slice(0, MAX_BUTTON_TEXT);
}

/** The code for the card. */
export function cardCode({
  handle,
  productId,
  title,
  place,
  height = CARD_HEIGHTS.plain,
  origin = SITE_URL,
}: {
  handle: string;
  productId: string;
  title: string;
  place: string;
  height?: number;
  origin?: string;
}): string {
  const src = tagged(`${origin}${embedPath(handle, productId)}`, place);
  const tall = Number.isInteger(height) && height >= 160 && height <= 800 ? height : CARD_HEIGHTS.plain;
  return (
    `<iframe src="${escapeHtml(src)}" title="${escapeHtml(`Buy ${title}`)}" width="${CARD_WIDTH}" height="${tall}" loading="lazy" ` +
    `style="display:block;width:100%;max-width:${CARD_WIDTH}px;height:${tall}px;border:0;border-radius:24px;"></iframe>`
  );
}

/** A readable pair for copied buttons and their previews; never changes saved store colors. */
export function buttonColors(fill: string, onFill: string): { fill: string; onFill: string; changed: boolean } {
  const valid = (color: string) => /^#[0-9a-f]{6}$/i.test(color);
  const background = valid(fill) ? fill : "#15112e";
  const foreground = valid(onFill) ? onFill : "#ffffff";
  const pair = contrast(background, foreground) >= 7 ? [background, foreground] : ["#15112e", "#ffffff"];
  return { fill: pair[0], onFill: pair[1], changed: pair[0] !== fill || pair[1] !== onFill };
}

/** The plain button's look, shared by the code and the studio's preview of it. */
export function buttonStyle(fill: string, onFill: string): Record<string, string> {
  const colors = buttonColors(fill, onFill);
  return {
    display: "inline-block",
    padding: "14px 28px",
    borderRadius: "999px",
    background: colors.fill,
    color: colors.onFill,
    font: "600 16px/1.25 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    textDecoration: "none",
  };
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The code for the plain button: a link to the product's own page. */
export function buttonCode({
  handle,
  productId,
  text,
  place,
  fill,
  onFill,
  origin = SITE_URL,
}: {
  handle: string;
  productId: string;
  text: string;
  place: string;
  fill: string;
  onFill: string;
  origin?: string;
}): string {
  const href = tagged(`${origin}/@${handle}/p/${productId}`, place);
  const style = Object.entries(buttonStyle(fill, onFill))
    .map(([name, value]) => `${kebab(name)}:${value}`)
    .join(";");
  return `<a href="${escapeHtml(href)}" style="${escapeHtml(`${style};`)}">${escapeHtml(text)}</a>`;
}
