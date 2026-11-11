/**
 * The links on a store page that are not for sale.
 *
 * This is the "in bio" half of link in bio. A creator's page is where they
 * send everyone, so it has to be able to point at the rest of their life —
 * the YouTube channel, the Instagram, the newsletter, the booking page they
 * already pay someone else for. A page that can only take money and can never
 * send anyone anywhere is a checkout, not a bio.
 *
 * A link is not a product. It has no price, it never reaches Stripe, and
 * nothing is delivered for it. That is why it lives here instead of as a
 * product with an empty price: a free thing and a thing that is not for sale
 * are different, and the page says which is which.
 *
 * The address itself is checked by readLink in lib/product-link.ts, the same
 * check a paid delivery link gets. Somebody is about to be sent wherever this
 * points and the person who typed it is not us, so it is https only, with no
 * credentials in it and no address that only resolves on the visitor's own
 * machine.
 */

import { readVideo } from "@/lib/sales-page";
import { readAudio } from "@/lib/audio-embed";

/** Whether a link can be played on the page: a video (lib/sales-page.ts) or music or a podcast (lib/audio-embed.ts). */
export function playsOnPage(url: string): boolean {
  return readVideo(url) !== null || readAudio(url) !== null;
}
import { type ProductImage, parseProductImage } from "@/lib/product-image";

/**
 * A link's own picture, drawn small beside its words in place of the icon
 * (added 9 October 2026): a podcast's cover, a channel's face, the poster of
 * a talk. The same kind of file as a product's picture, in the same folder
 * of the store's own (lib/product-image.ts), shrunk in the creator's browser
 * to LINK_IMAGE_SIDE on its long side — it is never drawn bigger than a few
 * dozen points, so that is plenty for the sharpest phone and a few dozen
 * kilobytes for everyone. It carries no words of its own: the link's title,
 * right beside it, already says what it is, so a screen reader is told once.
 */
export type LinkImage = Pick<ProductImage, "path" | "width" | "height" | "bytes">;

/** The long side, in pixels, a link's picture is shrunk to. */
export const LINK_IMAGE_SIDE = 320;

/** A stored link picture, made safe; null when there is none or it is not one. */
export function parseLinkImage(raw: unknown): LinkImage | null {
  const image = parseProductImage(raw && typeof raw === "object" ? { ...(raw as object), small: null, alt: "" } : raw);
  return image ? { path: image.path, width: image.width, height: image.height, bytes: image.bytes } : null;
}

/**
 * How many a store may list: a hundred, which is more places than anybody is
 * found in. Each one is small — a title and an address — so a full list is a
 * fraction of what the store's record is allowed to weigh (MAX_STORE_BYTES in
 * lib/store.ts), and the page still reads as a page rather than a directory.
 */
export const MAX_STORE_LINKS = 100;

/** Long enough for "Book a call with me", short enough to read as a button. */
export const MAX_LINK_TITLE_LENGTH = 60;

export type StoreLink = {
  id: string;
  /** What the button says. The creator's words, not the site's name. */
  title: string;
  /** Where it goes, normalised by readLink before it is ever stored. */
  url: string;
  addedAt: string;
  /**
   * Drawn larger, in the store's accent, so the one thing the creator most
   * wants followed is seen first. Optional; stores written before have none.
   */
  spotlight?: boolean;
  /** Shown only from this moment (ISO), and/or only until that one: a launch, a live, a limited offer. */
  from?: string;
  until?: string;
  /** A YouTube, Vimeo or Loom address played on the store page itself instead of opened elsewhere. */
  play?: boolean;
  /**
   * A heading over the links after it, with no address (added 9 October
   * 2026): "My podcast", "Free stuff". Its `url` is "", and it is never
   * clicked, counted or played.
   */
  header?: boolean;
  /** Its own small picture, in place of the icon (LinkImage, above). Never on a heading. */
  image?: LinkImage;
  /**
   * Kept back from the page by the creator without being removed (423 [LT1];
   * added 10 November 2026): its title, address, times, picture and clicks
   * stay, and "Show again" brings it back in one press. Showing it again
   * never clears its times, so a link whose time has passed stays hidden
   * until the creator changes them. Absent: not archived.
   */
  archived?: true;
};

/** Whether an entry is a heading over links, not a link. */
export function isHeader(link: Pick<StoreLink, "header">): boolean {
  return link.header === true;
}

/** A moment the creator chose, kept only when it is one; "" when it is not. */
export function linkMoment(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return "";
  const year = new Date(time).getUTCFullYear();
  return year >= 2020 && year <= 2100 ? new Date(time).toISOString() : "";
}

/** Whether a link is on the page at this moment: inside its window, when it has one. */
export function linkShowing(link: StoreLink, now = Date.now()): boolean {
  if (link.archived) return false;
  if (link.from && Date.parse(link.from) > now) return false;
  if (link.until && Date.parse(link.until) <= now) return false;
  return true;
}

/**
 * The links a visitor sees right now, in the creator's order. A heading with
 * nothing showing under it before the next heading is left out with them.
 */
export function showingLinks(links: StoreLink[], now = Date.now()): StoreLink[] {
  const showing = links.filter((link) => linkShowing(link, now));
  return showing.filter((link, i) => {
    if (!isHeader(link)) return true;
    const next = showing[i + 1];
    return next !== undefined && !isHeader(next);
  });
}

/** Where a link stands, for the studio: "archived" (kept back by the creator), "live", "soon" (not yet) or "ended". */
export function linkWhen(link: StoreLink, now = Date.now()): "archived" | "live" | "soon" | "ended" {
  if (link.archived) return "archived";
  if (link.until && Date.parse(link.until) <= now) return "ended";
  if (link.from && Date.parse(link.from) > now) return "soon";
  return "live";
}

/** The extras a link may carry, from a form or from storage, made consistent. */
export function linkExtras(raw: Record<string, unknown>, playable: boolean): Pick<StoreLink, "spotlight" | "from" | "until" | "play"> {
  const from = linkMoment(raw.from);
  let until = linkMoment(raw.until);
  // An end before the start would hide the link for ever; the end is dropped.
  if (from && until && Date.parse(until) <= Date.parse(from)) until = "";
  return {
    ...(raw.spotlight === true ? { spotlight: true } : {}),
    ...(from ? { from } : {}),
    ...(until ? { until } : {}),
    ...(raw.play === true && playable ? { play: true } : {}),
  };
}

/** Whatever came back from storage, made safe to render. */
export function parseStoreLinks(raw: unknown): StoreLink[] {
  if (!Array.isArray(raw)) return [];
  const links: StoreLink[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Partial<StoreLink>;
    if (typeof value.id !== "string" || !value.id) continue;
    if (typeof value.title !== "string" || !value.title) continue;
    const header = value.header === true;
    if (typeof value.url !== "string" || (!header && !value.url)) continue;
    if (header) {
      const { from, until } = linkExtras(value as Record<string, unknown>, false);
      links.push({ id: value.id, title: value.title.slice(0, MAX_LINK_TITLE_LENGTH), url: "", addedAt: typeof value.addedAt === "string" ? value.addedAt : "", header: true, ...(from ? { from } : {}), ...(until ? { until } : {}), ...(value.archived === true ? { archived: true as const } : {}) });
    } else {
      const image = parseLinkImage(value.image);
      links.push({
        id: value.id,
        title: value.title.slice(0, MAX_LINK_TITLE_LENGTH),
        url: value.url,
        addedAt: typeof value.addedAt === "string" ? value.addedAt : "",
        ...linkExtras(value as Record<string, unknown>, playsOnPage(value.url)),
        ...(image ? { image } : {}),
        ...(value.archived === true ? { archived: true as const } : {}),
      });
    }
    if (links.length >= MAX_STORE_LINKS) break;
  }
  return links;
}
