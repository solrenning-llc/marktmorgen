/**
 * How a store's email looks (369 [SU2]): its name at the top, its theme's
 * colors, its color and its letters, worked out from the look the creator
 * already set (lib/store-look.ts), with nothing new to configure.
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
 * No picture is drawn at the top: the store's name is written there in its
 * heading letters. The store photo is kept at 480 px and up to 200 kB, while a
 * logo is drawn at 48 px, and every reader's fetch of it is paid at the region
 * the reader opens it from; priced at the dearest region (Vercel, 14 September
 * 2026), that passes the owner's US$65 ceiling on a refunded Store first year
 * (Claude 1's re-review of #3030, comment 6709534250; tests/email-logo-region.test.ts).
 * A logo comes back only with an email-size copy of the photo, its own costed
 * line at the dearest region, and that ceiling still met.
 *
 * Pure and browser-safe: the studio reads the same notes as the sender.
 */
import { DEFAULT_LOOK, type FontId, type LookPaint, contrast, lookColours, mix, normaliseHex } from "@/lib/store-look";

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
  /** The store's name, written at the top in the heading letters. */
  name: string;
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
export function emailTheme(look: LookPaint | undefined, store: { name: string }): EmailTheme {
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
    notes,
  };
}

/** Where the creator's color is shown differently in emails; none when it reads as picked. */
export function emailColourNotes(look: LookPaint): EmailColourNote[] {
  return emailTheme(look, { name: "" }).notes;
}

/** The sentence the studio shows under the color, or null when emails use the color as picked. */
export function emailColourNotice(look: LookPaint): string | null {
  const links = emailColourNotes(look).find((n) => n.role === "links");
  if (!links) return null;
  return `In your emails, links use a ${links.direction} shade of your color (${links.sent} instead of ${links.picked}), so they can be read. Buttons use the same shade as your store page, and your store page does not change.`;
}
