import { copyAttachedPicture } from "@/lib/picture-r2-copy";
import type { NextRequest } from "next/server";
import { del, head } from "@/lib/blob";
import { firstBytes } from "@/lib/uploaded-image";
import {
  StoreFullError,
  imageFolder,
  setImageAlt,
  setProductDisplay,
  setProductImage,
  storeForEmail,
} from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { readListing } from "@/lib/catalog";
import { refusedJson } from "@/lib/studio-route";
import { lockedFor } from "@/lib/two-step";
import {
  IMAGE_CONTENT_TYPES,
  MAX_ALT_LENGTH,
  MAX_IMAGE_BYTES,
  MAX_THUMB_BYTES,
  type ProductImage,
  type SmallCopy,
  TONE_PATTERN,
  checkedSizes,
  imagePaths,
  isDisplayStyle,
  ownsImagePath,
} from "@/lib/product-image";
import { sniffPhotoType } from "@/lib/store-photo";
import { dropTakenPictures, takePictureDoor } from "@/lib/picture-door";

const ACTIONS = new Set(["attach", "remove", "alt", "display"]);

/**
 * A product's picture: put on, taken off, described, and how its card is
 * drawn.
 *
 * `{ action: "attach", id, path, width, height, alt }` after the browser has
 * uploaded it; `{ action: "remove", id }`; `{ action: "alt", id, alt }`;
 * `{ action: "display", id, display: "button" | "callout" | "preview" }`.
 *
 * What the browser says it uploaded is never taken at face value. The path
 * has to be a picture in this account's own folder, the file store is asked
 * how big it really is and what it says it is, and its first bytes have to be
 * a JPEG's or a WebP's. The old picture is deleted only after the record that
 * replaced it is written.
 *
 * `attach` may also name `small: { path, width }`: the smaller copy the
 * browser made for phones (lib/product-image.ts, SMALL_LONG_SIDE). It is
 * held to every check the picture itself is, and has to be narrower than it;
 * one that fails any of them is deleted and left out, and the picture is
 * attached without it — a copy is never worth refusing a picture for.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 2_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const action = text(body.action, 10);
  const id = text(body.id, 40);
  if (!ACTIONS.has(action) || !id) return Response.json({ ok: false, error: "invalid" }, { status: 400 });

  const alt = text(body.alt, MAX_ALT_LENGTH * 2).replace(/\s+/g, " ").trim().slice(0, MAX_ALT_LENGTH);

  // Pictures this request took from the door (lib/picture-door.ts): the only ones a failure here may delete.
  // A path the browser names may be another product's, link's or page's picture in the same folder.
  let fresh = new Map<string, number>();
  const dropFresh = (paths: string[]) => dropTakenPictures(fresh, paths);
  try {
    if (action === "alt") {
      const done = await setImageAlt(ref, id, alt);
      if (!done.ok) return Response.json({ ok: false, error: done.reason }, { status: 400 });
      return Response.json({ ok: true });
    }
    if (action === "display") {
      if (!isDisplayStyle(body.display)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      const done = await setProductDisplay(ref, id, body.display);
      if (!done.ok) return Response.json({ ok: false, error: done.reason }, { status: 400 });
      return Response.json({ ok: true });
    }

    let image: ProductImage | null = null;
    if (action === "attach") {
      const store = await storeForEmail(ref);
      if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
      const product = await readListing(store, id);
      // A new picture deletes the one there: not from a session let in without its second step (lib/two-step.ts).
      if ((await lockedFor(request, "products", "replace")) && product?.image) return refusedJson("locked");
      // What this product shows now: the only names besides a fresh upload it may be given (picture-door.ts).
      const own = new Set(imagePaths(product?.image));
      const path = text(body.path, 200);
      if (!ownsImagePath(path, await imageFolder(ref))) {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      const sent = body.small && typeof body.small === "object" ? (body.small as Record<string, unknown>) : null;
      const smallPath = sent ? text(sent.path, 200) : "";
      const smallOwned = smallPath !== "" && smallPath !== path && ownsImagePath(smallPath, await imageFolder(ref));
      // The thumbnail copy (Encanto 5b-2), named and checked exactly as the smaller copy is.
      const sentThumb = body.thumb && typeof body.thumb === "object" ? (body.thumb as Record<string, unknown>) : null;
      const thumbPath = sentThumb ? text(sentThumb.path, 200) : "";
      const thumbOwned = thumbPath !== "" && thumbPath !== path && thumbPath !== smallPath && ownsImagePath(thumbPath, await imageFolder(ref));
      fresh = await takePictureDoor([path, ...(smallOwned ? [smallPath] : []), ...(thumbOwned ? [thumbPath] : [])]);
      if (!product) {
        await dropFresh([path, smallPath, thumbPath]);
        return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      }
      // A name in the shared folder that is neither fresh from the door nor this product's own may be another
      // product's, a link's, a page's, a buyer's review photo or an email's picture: refused, and nothing deleted,
      // so replacing or removing this product's picture later can never delete it.
      if (!fresh.has(path) && !own.has(path)) {
        await dropFresh([smallPath, thumbPath]);
        return Response.json({ ok: false, error: "in_use" }, { status: 400 });
      }
      // This product's record was written only after each of its files passed the checks below, so a name it shows,
      // sent again and not fresh from the door, is answered from the record and not read again; a fresh one always is
      // (C1-20261107-1550-TODOS-10). So the file store is only ever asked about a file this request took from the door.
      const checked = checkedSizes(product.image);
      const keptSize = (name: string) => (fresh.has(name) ? undefined : checked.get(name));
      // A name it shows whose size the record cannot vouch for (checkedSizes) is not taken as checked, and not read on
      // its say-so either: refused, nothing written or deleted; sent fresh through the door it is checked as any (rule 24).
      const named = [path, ...(smallOwned ? [smallPath] : []), ...(thumbOwned ? [thumbPath] : [])];
      if (named.some((name) => !fresh.has(name) && own.has(name) && !checked.has(name))) {
        await dropFresh([path, smallPath, thumbPath]);
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      let size = keptSize(path);
      if (size === undefined) {
        const found = await head(path);
        if (found.size > MAX_IMAGE_BYTES) {
          await dropFresh([path, smallPath, thumbPath]);
          return Response.json({ ok: false, error: "too_big" }, { status: 413 });
        }
        const bytes = await firstBytes(path);
        const kind = bytes ? sniffPhotoType(bytes) : null;
        if (!kind || !(IMAGE_CONTENT_TYPES as readonly string[]).includes(kind) || kind !== found.contentType) {
          await dropFresh([path, smallPath, thumbPath]);
          return Response.json({ ok: false, error: "type" }, { status: 400 });
        }
        size = found.size;
      }
      const side = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 10_000 ? n : 0);
      const width = side(body.width);
      const height = side(body.height);
      if (!width || !height) {
        await dropFresh([path, smallPath, thumbPath]);
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      // The picture's color (Encanto 5b): absent, or exactly #rrggbb. Anything else refuses the picture and writes
      // nothing (C4-20261106-0700-C5-27, condition 1; Codex K2 on #2790).
      if (body.tone !== undefined && !(typeof body.tone === "string" && TONE_PATTERN.test(body.tone))) {
        await dropFresh([path, smallPath, thumbPath]);
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }

      // The smaller copy for phones, checked exactly as the picture was.
      let small: SmallCopy | null = null;
      // A smaller copy named that is neither fresh nor this product's own is left out, and kept.
      if (smallOwned && (fresh.has(smallPath) || own.has(smallPath))) {
        const smallWidth = side(sent?.width);
        const kept = keptSize(smallPath);
        // This product's own copy, checked when it was put on: its size from the record, its width held to its place.
        if (kept !== undefined) {
          if (smallWidth > 0 && smallWidth < width) small = { path: smallPath, width: smallWidth, bytes: kept };
        } else try {
          const copy = await head(smallPath);
          // Its size and width first: a copy that fails them is never read (Claude 1 on #2801, rule 30).
          const fits = smallWidth > 0 && smallWidth < width && copy.size <= MAX_IMAGE_BYTES;
          const first = fits ? await firstBytes(smallPath) : null;
          const copyKind = first ? sniffPhotoType(first) : null;
          const good =
            fits &&
            copyKind !== null &&
            (IMAGE_CONTENT_TYPES as readonly string[]).includes(copyKind) &&
            copyKind === copy.contentType;
          if (good) small = { path: smallPath, width: smallWidth, bytes: copy.size };
          else await dropFresh([smallPath]);
        } catch (error) {
          console.error("checking a picture's smaller copy failed; attached without it", error);
          await dropFresh([smallPath]);
        }
      }
      // The thumbnail copy (Encanto 5b-2), checked exactly as the smaller copy, within MAX_THUMB_BYTES and narrower
      // than the copy above it; one that fails is dropped and never written.
      let thumb: SmallCopy | null = null;
      if (thumbOwned && (fresh.has(thumbPath) || own.has(thumbPath))) {
        const thumbWidth = side(sentThumb?.width);
        const kept = keptSize(thumbPath);
        // This product's own copy, checked when it was put on: its size from the record, its width held to its place.
        if (kept !== undefined) {
          if (thumbWidth > 0 && thumbWidth < (small ? small.width : width) && kept <= MAX_THUMB_BYTES) thumb = { path: thumbPath, width: thumbWidth, bytes: kept };
        } else try {
          const copy = await head(thumbPath);
          // Its size and width first: the upload token allows MAX_IMAGE_BYTES under any picture name, so a file over
          // MAX_THUMB_BYTES is dropped unread, and the read its cost line counts is never more than that (Claude 1 on #2801).
          const fits = thumbWidth > 0 && thumbWidth < (small ? small.width : width) && copy.size > 0 && copy.size <= MAX_THUMB_BYTES;
          const first = fits ? await firstBytes(thumbPath) : null;
          const copyKind = first ? sniffPhotoType(first) : null;
          const good =
            fits &&
            copyKind !== null &&
            (IMAGE_CONTENT_TYPES as readonly string[]).includes(copyKind) &&
            copyKind === copy.contentType;
          if (good) thumb = { path: thumbPath, width: thumbWidth, bytes: copy.size };
          else await dropFresh([thumbPath]);
        } catch (error) {
          console.error("checking a picture's thumbnail copy failed; attached without it", error);
          await dropFresh([thumbPath]);
        }
      }
      // Checked above: exact, or none.
      const tone = typeof body.tone === "string" ? body.tone : null;
      image = { path, width, height, alt, bytes: size, small, ...(thumb ? { thumb } : {}), ...(tone ? { tone } : {}) };
      // Copied to the pictures' own bucket when it is on (313 [CV1] unit 4b); off, nothing is read. A failed copy
      // never refuses the picture: it is kept where it always was, unmarked.
      const mirrored = await copyAttachedPicture(imagePaths(image)).catch(() => false);
      if (mirrored) image = { ...image, r2: true };
    }

    const result = await setProductImage(ref, id, image);
    if (!result.ok) {
      if (image) await dropFresh(imagePaths(image));
      return Response.json({ ok: false, error: result.reason }, { status: result.reason === "unknown" ? 404 : 400 });
    }
    // Best effort, and deliberately after the write.
    // The picture and the smaller copy made of it go together, except a name the new picture still uses.
    const still = new Set(imagePaths(image));
    const replaced = imagePaths(result.removed).filter((removed) => !still.has(removed));
    if (replaced.length) {
      await del(replaced).catch((error: unknown) => {
        console.error("could not delete a replaced product picture", error);
      });
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof StoreFullError) {
      return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    }
    console.error("changing a product picture failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
