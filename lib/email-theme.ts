/**
 * How a store's email looks (369 [SU2]): the store's own photo as its logo,
 * its theme's colors, its color and its letters, worked out from the look the
 * creator already set (lib/store-look.ts), with nothing new to configure.
 *
 * Every word in an email keeps 7:1 against what is behind it (AX274, WCAG
 * 1.4.6). Where the creator's color cannot reach that, it is moved, only in
 * the email and only as far as needed, to the nearest shade that does; the
 * store page keeps what it had. `emailColourNotes` says which color moved and
 * to what, so the studio can tell the creator rather than change their look
 * without a word (VR).
 *
 * Letters: a mail app only shows the faces already on the reader's device,
 * and nothing here downloads one. Each pairing names the store's own face
 * first (used where it happens to be installed) and then faces every mail
 * app has, ending in a generic family; the email may not look identical in
 * every app, and nothing says it will.
 *
 * The logo is the store photo at the address it already has, the same for
 * every reader, so it says nothing about who opened the email (no pixel).
 *
 * Pure and browser-safe: the studio reads the same notes as the sender.
 */
import { DEFAULT_LOOK, type FontId, type LookPaint, contrast, lookColours, mix, normaliseHex } from "@/lib/store-look";
import { photoUrl } from "@/lib/photo-limits";
import { SITE_URL } from "@/lib/site-url";

/**
 * How many times one email's logo is costed as fetched (tests/plan-cost-registry.ts, line email-logo): the reader's
 * app, their mail provider's picture proxy, a second device and a forward, each taken as a fetch the CDN did not
 * keep. A review ceiling, not a measurement: the logo is drawn at most once an email, only in emails counted against
 * the store's figures before they are sent (lib/mail.ts, lib/email.ts), and its address is kept for a year
 * everywhere, so a reader's app fetches it again only from a new device.
 */
export const EMAIL_LOGO_READS = 4;

/** What every word in an email reads at, at least (WCAG 1.4.6). */
export const EMAIL_TEXT_RATIO = 7;

const WHITE = "#ffffff";
const BLACK = "#000000";

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',Times,serif";

/** The letters of each pairing, as a mail app can show them: the store's face first, then faces every app has. */
export const EMAIL_FONTS: Record<FontId, { head: string; body: string }> = {
  modern: { head: SANS, body: SANS },
  editorial: { head: `Fraunces,${SERIF}`, body: SANS },
  elegant: { head: `'Playfair Display',Didot,'Bodoni 72',${SERIF}`, body: SANS },
  friendly: { head: "Nunito,'Trebuchet MS',Verdana,sans-serif", body: "Nunito,'Trebuchet MS',Verdana,sans-serif" },
  bold: { head: "'Bricolage Grotesque','Arial Black','Helvetica Neue',Arial,sans-serif", body: SANS },
};

/**
 * One place the creator's color is shown differently in emails than on their
 * store page. Only links can be: an email's button is the store page's own
 * button, which the studio already explains.
 */
export type EmailColourNote = {
  role: "links";
  picked: string;
  sent: string;
  direction: "darker" | "lighter";
};

export type EmailTheme = {
  scheme: "light" | "dark";
  /** Behind the whole email. */
  page: string;
  /** Behind the creator's words. */
  card: string;
  text: string;
  /** The small words at the foot, on the page. */
  muted: string;
  line: string;
  /** Links in the creator's words, always underlined too. */
  link: string;
  button: { fill: string; ink: string };
  /** The band across the top on the Color theme, as the store page has. */
  band: { fill: string; ink: string } | null;
  bodyFont: string;
  headFont: string;
  /** The store's name: the logo's alt text, or the words at the top when there is no photo. */
  name: string;
  logo: { src: string; alt: string } | null;
  notes: EmailColourNote[];
};

/** The first color on the way from `color` to `target` that passes `test`, so a color moves no further than it has to. */
function nearestPassing(color: string, target: string, test: (c: string) => boolean): string {
  for (let step = 0; step <= 50; step += 1) {
    const candidate = mix(color, target, step / 50);
    if (test(candidate)) return candidate;
  }
  return target;
}

function direction(picked: string, sent: string): "darker" | "lighter" {
  return contrast(sent, BLACK) < contrast(picked, BLACK) ? "darker" : "lighter";
}

/** Every color, letter and picture a store's email is drawn with. */
export function emailTheme(look: LookPaint | undefined, store: { name: string; photoId: string | null }): EmailTheme {
  const paint = look ?? DEFAULT_LOOK;
  const c = lookColours(paint);
  const picked = normaliseHex(paint.accent) ?? DEFAULT_LOOK.accent;
  const away = c.dark ? WHITE : BLACK;
  const reads = (on: string[]) => (x: string) => on.every((bg) => contrast(x, bg) >= EMAIL_TEXT_RATIO);

  // The theme's own ink already passes on its page and card; this only holds it there.
  const text = nearestPassing(c.text, away, reads([c.card, c.bg]));
  const muted = nearestPassing(c.muted, away, reads([c.card, c.bg]));
  // A link is the creator's color as words: moved towards the ink until it reads at 7:1 on the card.
  const link = nearestPassing(picked, text, reads([c.card]));
  // A button is the store page's own button, whose words already read at 7:1 on it.
  const button = { fill: c.accent, ink: c.onAccent };

  // The button is exactly the store page's, so only the links can differ from it.
  const notes: EmailColourNote[] = [];
  if (link !== picked) notes.push({ role: "links", picked, sent: link, direction: direction(picked, link) });

  const fonts = EMAIL_FONTS[paint.font ?? "modern"] ?? EMAIL_FONTS.modern;
  const name = store.name.trim() || "Store";
  return {
    scheme: c.dark ? "dark" : "light",
    page: c.bg,
    card: c.card,
    text,
    muted,
    line: c.lineStrong,
    link,
    button,
    band: paint.theme === "bold" ? { fill: c.accent, ink: c.onAccent } : null,
    bodyFont: fonts.body,
    headFont: fonts.head,
    name,
    logo: store.photoId ? { src: `${SITE_URL}${photoUrl(store.photoId)}`, alt: name } : null,
    notes,
  };
}

/** Where the creator's color is shown differently in emails; none when it reads as picked. */
export function emailColourNotes(look: LookPaint): EmailColourNote[] {
  return emailTheme(look, { name: "", photoId: null }).notes;
}

/** The sentence the studio shows under the color, or null when emails use the color as picked. */
export function emailColourNotice(look: LookPaint): string | null {
  const links = emailColourNotes(look).find((n) => n.role === "links");
  if (!links) return null;
  return `In your emails, links use a ${links.direction} shade of your color (${links.sent} instead of ${links.picked}), so they can be read. Buttons use the same shade as your store page, and your store page does not change.`;
}
