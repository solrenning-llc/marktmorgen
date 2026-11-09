import type { NextRequest } from "next/server";
import { del } from "@/lib/blob";
import { StoreFullError, imageFolder, setLinkImage, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { checkedSizes, ownsImagePath } from "@/lib/product-image";
import { LINK_IMAGE_SIDE, type LinkImage } from "@/lib/store-link";
import { checkUploadedImage } from "@/lib/uploaded-image";
import { dropTakenPictures, takePictureDoor } from "@/lib/picture-door";
import { refusedJson } from "@/lib/studio-route";
import { lockedFor } from "@/lib/two-step";

/**
 * A link's own small picture (lib/store-link.ts, LinkImage): put on after
 * the browser has uploaded it, or taken off.
 *
 * `{ action: "attach", id, path, width, height }` or `{ action: "remove", id }`.
 *
 * Held to every check a product's picture is (app/api/store/image): a fresh
 * name in this store's own picture folder, a JPEG or a WebP by its own bytes,
 * a megabyte at most — and, since the browser was asked to make it
 * LINK_IMAGE_SIDE on its long side, no bigger than that either. The old
 * picture is deleted only after the record that replaced it is written.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "page", 2_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const action = text(body.action, 10);
  const id = text(body.id, 40);
  if ((action !== "attach" && action !== "remove") || !id) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  // Pictures this request took from the door (lib/picture-door.ts): the only ones a failure here may delete.
  // A path the browser names may be another product's, link's or page's picture in the same folder.
  let fresh = new Map<string, number>();
  const dropFresh = (path: string) => dropTakenPictures(fresh, [path]);
  try {
    let image: LinkImage | null = null;
    if (action === "attach") {
      const store = await storeForEmail(ref);
      if (!store) return Response.json({ ok: false, error: "none" }, { status: 400 });
      const link = store.links.find((each) => each.id === id);
      // A new picture deletes the one there: not from a session let in without its second step (lib/two-step.ts).
      if ((await lockedFor(request, "page", "replace")) && link?.image) return refusedJson("locked");
      const path = text(body.path, 200);
      if (!ownsImagePath(path, await imageFolder(ref))) {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      fresh = await takePictureDoor([path]);
      // A link that is not there answers "unknown" before any other refusal. Only a picture fresh from the door is
      // deleted then (dropFresh): one of a product, another link or a page is never touched. A fresh one is not kept for
      // later: the door's note ends in a day, nothing sweeps such pictures and the studio uploads each under a new
      // name (Claude 5's correction on #2657, which withdrew the refusal before the door).
      if (!link) {
        await dropFresh(path);
        return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      }
      const side = (n: unknown) => (typeof n === "number" && Number.isInteger(n) && n > 0 && n <= LINK_IMAGE_SIDE ? n : 0);
      const width = side(body.width);
      const height = side(body.height);
      if (!width || !height) {
        await dropFresh(path);
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      // A name in the shared folder that is neither fresh from the door nor this link's own may be a product's,
      // another link's, a page's, a buyer's review photo or an email's picture: refused and kept, so taking this
      // link or its picture off later can never delete it (lib/picture-door.ts). It is answered before the file store is
      // asked anything, like a missing link above: a read is only ever of a file this request took from the door
      // (C1-20261107-1550-TODOS-10).
      if (!fresh.has(path) && link.image?.path !== path) {
        return Response.json({ ok: false, error: "in_use" }, { status: 400 });
      }
      // The link's own picture, sent again and not fresh: checked when it was put on, so its size comes from the record.
      // One whose size the record cannot vouch for is refused, not read on its say-so (checkedSizes, rule 24).
      let bytes = fresh.has(path) ? undefined : checkedSizes(link.image).get(path);
      if (bytes === undefined && !fresh.has(path)) return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      if (bytes === undefined) {
        const checked = await checkUploadedImage(path);
        if (!checked.ok) {
          await dropFresh(path);
          return Response.json({ ok: false, error: checked.error }, { status: checked.error === "too_big" ? 413 : 400 });
        }
        bytes = checked.bytes;
      }
      image = { path, width, height, bytes };
    }

    const result = await setLinkImage(ref, id, image);
    if (!result.ok) {
      if (image) await dropFresh(image.path);
      return Response.json({ ok: false, error: result.reason }, { status: result.reason === "unknown" ? 404 : 400 });
    }
    // Best effort, and deliberately after the write.
    if (result.removed && result.removed.path !== image?.path) {
      await del(result.removed.path).catch((error: unknown) => {
        console.error("could not delete a replaced link picture", error);
      });
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof StoreFullError) {
      return Response.json({ ok: false, error: "store_full" }, { status: 409 });
    }
    console.error("changing a link picture failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
