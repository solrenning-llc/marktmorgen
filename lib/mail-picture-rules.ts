/**
 * Pictures in a creator's email (added 10 October 2026), as rules the
 * browser can read too. The part that keeps one is lib/mail-pictures.ts.
 *
 * An email stays plain text the creator can read and edit: a picture is a
 * line of its own, `![what it shows](address)`, put there by "Add a picture"
 * in the studio. Only a picture kept here becomes one — a JPEG in a store's
 * own picture folder, served from this site and cached for a year — so an
 * email can never carry a picture from elsewhere, nor anything that reports
 * back when it is opened. JPEG because Outlook on Windows shows no WebP.
 * Anything else written that way stays the text it is.
 */
import { SITE_URL } from "@/lib/site-url";

/** The longest side a picture in an email is made, twice the width it is shown at. */
export const MAIL_PICTURE_SIDE = 1200;
/** The most one picture may weigh. */
export const MAX_MAIL_PICTURE_BYTES = 300_000;
/** The most pictures one email shows; any past it stay text. */
export const MAX_MAIL_PICTURES = 6;
/** The longest description a picture keeps. */
export const MAX_PICTURE_ALT = 200;

const escaped = SITE_URL.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const LINE = new RegExp(`^!\\[([^\\]\\n]{0,${MAX_PICTURE_ALT}})\\]\\((${escaped}/api/image/[0-9a-f]{24}/[0-9a-f]{32}\\.jpg)\\)$`);

/** The address a kept picture is shown from. */
export function pictureUrl(folder: string, file: string): string {
  return `${SITE_URL}/api/image/${folder}/${file}`;
}

/** A line of an email, read as a picture: what it shows and where it is; null for any other line. */
export function readPicture(line: string): { alt: string; url: string } | null {
  const match = line.trim().match(LINE);
  return match ? { alt: match[1].trim(), url: match[2] } : null;
}

/** The line that puts a picture in an email. Brackets and line breaks in the description are dropped. */
export function pictureLine(alt: string, url: string): string {
  const clean = alt.replace(/[[\]\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_PICTURE_ALT);
  return `![${clean}](${url})`;
}

/** How many pictures an email holds. */
export function pictureCount(body: string): number {
  return body.split("\n").filter((line) => readPicture(line) !== null).length;
}

/** A store's picture folder, as imageFolder (lib/store.ts) makes it. */
const FOLDER = /^[0-9a-f]{24}$/;

/**
 * The email with only the pictures one store may show in it: those kept in
 * `folder`, that store's own picture folder (imageFolder in lib/store.ts), or
 * in any of a list of its own folders (pictureFolders in lib/store.ts: the
 * current one and those it had before its owner's address changed). Every
 * other picture becomes its description in brackets, or goes when it has
 * none, as withoutPictures makes them. With no folder, an empty list, or
 * ones not of a folder's shape, none stays.
 *
 * "Add a picture" is only in the studio's emails to a store's list, and only
 * keeps a picture in that store's own folder (lib/mail-pictures.ts). Each
 * picture is fetched from /api/image whenever an email is opened, so one in
 * a store's other emails (a win-back, an offer, a notice), or one copied from
 * another store, would be a fetch nobody chose and no plan counts.
 */
export function ownPicturesOnly(body: string, folder?: string | readonly string[]): string {
  const folders: readonly unknown[] = Array.isArray(folder) ? folder : [folder];
  const own = folders.filter((one): one is string => typeof one === "string" && FOLDER.test(one)).map((one) => `${SITE_URL}/api/image/${one}/`);
  return body
    .split("\n")
    .flatMap((line) => {
      const picture = readPicture(line);
      if (!picture || own.some((start) => picture.url.startsWith(start))) return [line];
      return picture.alt ? [`[${picture.alt}]`] : [];
    })
    .join("\n");
}

/**
 * The email as plain text, for readers whose app shows no pictures: each
 * picture becomes its description in brackets, or goes when it has none.
 */
export function withoutPictures(body: string): string {
  return ownPicturesOnly(body);
}
