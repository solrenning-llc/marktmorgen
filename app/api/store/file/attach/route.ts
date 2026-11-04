import type { NextRequest } from "next/server";
import { deleteFile as del, headFile as head } from "@/lib/file-store";
import { productFile, setProductFile, storeForEmail, storeFolder } from "@/lib/store";
import { refusedJson } from "@/lib/studio-route";
import { requestLocked } from "@/lib/two-step";
import { guardStoreWrite, text } from "@/lib/store-request";
import { ownsPath, safeFileName, type ProductFile } from "@/lib/product-file";
import { dropStamped } from "@/lib/pdf-stamp";

/**
 * Puts the file that was just uploaded onto the product, or takes it off.
 *
 * The browser tells us where it put the file. That claim is never taken at
 * face value: the path has to sit inside this account's own folder, and the
 * file store is asked how big the file really is and what it really is, so
 * what the page shows is measured rather than reported.
 *
 * The old file is deleted only after the record that replaced it is written.
 * The other order would leave a product pointing at a file that no longer
 * exists if the write failed in between.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products");
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;

  const id = text(body.id, 40);
  const pathname = text(body.pathname, 400);
  const detach = body.detach === true;
  if (!id) {
    return Response.json({ ok: false, error: "invalid" }, { status: 400 });
  }

  try {
    const store = await storeForEmail(ref);
    if (!store) {
      return Response.json({ ok: false, error: "none" }, { status: 400 });
    }

    let file: ProductFile | null = null;
    if (!detach) {
      const folder = await storeFolder(ref);
      if (!ownsPath(pathname, folder, id)) {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }

      const found = await head(pathname);
      file = {
        pathname,
        name: safeFileName(text(body.name, 200) || found.pathname),
        bytes: found.size,
        contentType: found.contentType,
        addedAt: new Date().toISOString(),
      };
    }

    // Replacing or taking off the file it holds deletes that file, and buyers' stamped copies, for
    // good: not while the session is locked (lib/two-step.ts). Putting a file where there is none is.
    if (await requestLocked(request)) {
      const held = await productFile(ref, id);
      if (held && held.file.pathname !== file?.pathname) return refusedJson("locked");
    }

    const result = await setProductFile(ref, id, file);
    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason },
        { status: result.reason === "unknown" ? 404 : 400 },
      );
    }

    // Best effort, and deliberately after the write. A file left behind costs
    // a fraction of a cent; a product pointing at nothing costs a sale.
    if (result.removed && result.removed.pathname !== file?.pathname) {
      await del(result.removed.pathname).catch((error: unknown) => {
        console.error("could not delete the replaced file", error);
      });
      // Buyers' stamped copies of it go with it.
      await dropStamped(result.removed);
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("attaching a file failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
