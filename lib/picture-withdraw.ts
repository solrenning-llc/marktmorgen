/**
 * A product taken down keeps its picture only under a new name (R44, 9 November 2026).
 *
 * A picture's address never changes while it is shown, and every browser and cache may keep what is behind it for a
 * year (app/api/image), so unpublishing a product left its picture at the address its page, its search data and its
 * shared card gave out. A takedown (lib/takedown.ts) now copies the picture and its smaller copy to new names in the
 * same folder, inside the file store, deletes the old files, and points the product at the copies. From then on the
 * old address answers "not found" from us, and the creator's studio shows the picture from the new name, which no
 * public page gives out while the product is off the store.
 *
 * Each new name comes from the old one and a key only this deployment has (lib/secret-box.ts), so a press after an
 * unconfirmed step finds the copies the earlier press made. The order is the copies, then the old names kept with
 * the takedown's steps, then the record, and the old files only once the record names the copies (Claude 2 on
 * #3382): a step that fails or is not confirmed throws and leaves every file there, the originals and the copies,
 * so nothing the creator made is lost and the next press finishes. A record that cannot be read is never taken for
 * "nothing to move". A press after the record moved finds the old names in the steps and only deletes those files,
 * so a picture is never moved twice. A record the creator changed meanwhile is left as they left it, and the copies
 * made for it are deleted; one that still shows an old file is read and moved again. A product published again
 * before this runs is left alone.
 *
 * Not reached from here: copies a shared cache made before the takedown, kept there until they expire.
 */
import { createHmac } from "node:crypto";
import { BlobNotFoundError } from "@vercel/blob";
import { copy, del, head } from "@/lib/blob";
import { readListingExactly } from "@/lib/catalog";
import { imageType } from "@/lib/product-image";
import { deriveKey } from "@/lib/secret-box";
import { moveProductImage, storeForEmail } from "@/lib/store";

/** A file's new name: the same folder and type, and a name only this deployment can work out from the old one. */
function movedName(key: Buffer, path: string): string {
  const folder = path.slice(0, path.lastIndexOf("/"));
  return `${folder}/${createHmac("sha256", key).update(path).digest("hex").slice(0, 32)}${path.slice(path.lastIndexOf("."))}`;
}

/**
 * Copies one file to its new name. "copied" when the copy is there, made now or by an earlier press; "absent" only
 * when the file store says neither the file nor its copy exists. Anything else throws.
 */
async function copyTo(from: string, to: string): Promise<"copied" | "absent"> {
  try {
    await copy(from, to, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: imageType(to) });
    return "copied";
  } catch (error) {
    // An earlier press may have made this copy and deleted the old file before its record was written.
    try {
      await head(to);
      return "copied";
    } catch (missing) {
      if (!(missing instanceof BlobNotFoundError)) throw error;
    }
    try {
      await head(from);
    } catch (missing) {
      if (missing instanceof BlobNotFoundError) return "absent";
    }
    throw error;
  }
}

/**
 * The files of one picture: the picture, its smaller copy and its thumbnail copy (#2801), each when it has one. A
 * takedown's names kept before the thumbnail existed have no `thumb`: none.
 */
export type PictureNames = { path: string; small: string | null; thumb?: string | null };

const namesOf = (picture: PictureNames): string[] => [picture.path, ...(picture.small ? [picture.small] : []), ...(picture.thumb ? [picture.thumb] : [])];

/**
 * Moves the picture of a product that is off the store to new names. "none" when there is nothing to move (no
 * picture, a product shown again, or a picture whose file is no longer there); "changed" when the creator replaced
 * or removed it meanwhile. Throws when a step's outcome is unknown, with every file still there.
 *
 * `before`: the old names an earlier press of this takedown kept; `remember` keeps them, confirmed, before the
 * record is pointed at the copies (lib/takedown.ts keeps them with the takedown's steps).
 */
export async function withdrawProductPicture(
  ref: string,
  id: string,
  before: PictureNames | null,
  remember: (olds: PictureNames) => Promise<void>,
): Promise<"moved" | "none" | "changed"> {
  // A record changed meanwhile that still shows an old file (the same picture with another smaller copy, say) is read
  // again and moved again: a takedown is never done while an address its pages gave out still answers (Claude 2 on
  // #3382). A record that keeps changing throws, every file still there, and the next press finishes.
  for (let attempt = 0; attempt < WITHDRAW_ATTEMPTS; attempt += 1) {
    const done = await withdrawOnce(ref, id, before, remember);
    if (done !== "again") return done;
  }
  throw new Error("the picture kept changing while it was being moved");
}

/** How many times one press reads and moves a picture that changed meanwhile and still shows an old file. */
const WITHDRAW_ATTEMPTS = 3;

/** One read and move; "again" when the creator changed the picture meanwhile and it still shows an old file. */
async function withdrawOnce(
  ref: string,
  id: string,
  before: PictureNames | null,
  remember: (olds: PictureNames) => Promise<void>,
): Promise<"moved" | "none" | "changed" | "again"> {
  // Read again, after the product was taken off: the caller's copy of the store may predate it.
  const store = await storeForEmail(ref);
  if (!store) throw new Error("the store could not be read again");
  // Exactly (rule 24): a record that answers in any other shape is never taken for "no picture".
  const product = await readListingExactly(store, id);
  if (product === "unknown") throw new Error("the product's record could not be read");
  if (!product || !product.hidden || !product.image) return "none";
  const key = deriveKey("picture-withdraw");
  if (!key) throw new Error("there is no key to name a moved picture with");
  const shown = namesOf({ path: product.image.path, small: product.image.small?.path ?? null, thumb: product.image.thumb?.path ?? null });
  if (before && product.image.path === movedName(key, before.path)) {
    // An earlier press pointed the record at the copies and its delete of the old files was not confirmed.
    await del(namesOf(before).filter((name) => !shown.includes(name)));
    return "moved";
  }
  // Every file of the picture moves, its thumbnail copy too (Claude 1's HIGH on #2801): one left at its old name
  // would stay served after the notice.
  const from = { path: product.image.path, small: product.image.small?.path ?? null, thumb: product.image.thumb?.path ?? null };
  const to = { path: movedName(key, from.path), small: from.small ? movedName(key, from.small) : null, thumb: from.thumb ? movedName(key, from.thumb) : null };

  const main = await copyTo(from.path, to.path);
  const small = from.small && to.small ? await copyTo(from.small, to.small) : "absent";
  const thumb = from.thumb && to.thumb ? await copyTo(from.thumb, to.thumb) : "absent";
  const olds = namesOf(from);
  const made = [...(main === "copied" ? [to.path] : []), ...(small === "copied" && to.small ? [to.small] : []), ...(thumb === "copied" && to.thumb ? [to.thumb] : [])];
  if (main === "absent") {
    // Its old address already answers "not found", and there is nothing to show it from: the record is left.
    if (made.length) await del([...olds, ...made]);
    return "none";
  }
  await remember(from);
  const moved = await moveProductImage(ref, id, from, { path: to.path, small: small === "copied" ? to.small : null, thumb: thumb === "copied" ? to.thumb : null });
  if (!moved.ok && moved.reason !== "changed") {
    // The record could not be read or written: the originals and the copies stay, and the next press finishes.
    throw new Error("the product's record could not be confirmed");
  }
  if (!moved.ok) {
    // The creator replaced or removed the picture meanwhile: what they show now is kept, nothing else of the old.
    await del(made.filter((name) => !moved.shown.includes(name))).catch((error: unknown) => console.error("could not delete the copies of a picture changed meanwhile", error));
    const unshown = olds.filter((name) => !moved.shown.includes(name));
    if (unshown.length) await del(unshown);
    return unshown.length < olds.length ? "again" : "changed";
  }
  // Only now, with the record confirmed to name the copies, the old files go.
  await del(olds);
  return "moved";
}
