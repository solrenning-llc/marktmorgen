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
 * unconfirmed step finds the copies the earlier press made. The order is the copies, then the old files, then the
 * record, so every step that fails leaves something the next press can finish: a step the file store does not
 * confirm throws, with the record as it was. A record the creator changed meanwhile is left as they left it, and
 * the copies made for it are deleted. A product published again before this runs is left alone.
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
 * Moves the picture of a product that is off the store to new names. "none" when there is nothing to move (no
 * picture, a product shown again, or a picture whose file is no longer there); "changed" when the creator replaced
 * or removed it meanwhile. Throws when a step's outcome is unknown.
 */
export async function withdrawProductPicture(ref: string, id: string): Promise<"moved" | "none" | "changed"> {
  // Read again, after the product was taken off: the caller's copy of the store may predate it.
  const store = await storeForEmail(ref);
  if (!store) throw new Error("the store could not be read again");
  // Exactly (rule 24): a record that answers in any other shape is never taken for "no picture".
  const product = await readListingExactly(store, id);
  if (product === "unknown") throw new Error("the product's record could not be read");
  if (!product || !product.hidden || !product.image) return "none";
  const key = deriveKey("picture-withdraw");
  if (!key) throw new Error("there is no key to name a moved picture with");
  const from = { path: product.image.path, small: product.image.small?.path ?? null };
  const to = { path: movedName(key, from.path), small: from.small ? movedName(key, from.small) : null };

  const main = await copyTo(from.path, to.path);
  const small = from.small && to.small ? await copyTo(from.small, to.small) : "absent";
  const olds = [from.path, ...(from.small ? [from.small] : [])];
  const made = [...(main === "copied" ? [to.path] : []), ...(small === "copied" && to.small ? [to.small] : [])];
  if (main === "absent") {
    // Its old address already answers "not found", and there is nothing to show it from: the record is left.
    if (made.length) await del([...olds, ...made]);
    return "none";
  }
  await del(olds);
  const moved = await moveProductImage(ref, id, from, { path: to.path, small: small === "copied" ? to.small : null });
  if (!moved.ok) {
    await del(made).catch((error: unknown) => console.error("could not delete the copies of a picture changed meanwhile", error));
    return moved.reason === "changed" ? "changed" : "none";
  }
  return "moved";
}
