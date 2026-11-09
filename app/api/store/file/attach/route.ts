import type { NextRequest } from "next/server";
import { deleteFile as del, headFile as head } from "@/lib/file-store";
import { setProductFile, storeForEmail, storeFolder } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { ownsPath, safeFileName, type ProductFile } from "@/lib/product-file";
import { dropStamped } from "@/lib/pdf-stamp";
import { deliveredFile, readDelivery } from "@/lib/catalog";
import { audioPlayedBy } from "@/lib/podcast";
import { refusedJson } from "@/lib/studio-route";
import { lockedFor } from "@/lib/two-step";

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
  // Taking the file off deletes it and the buyers' stamped copies: named apart (lib/two-step.ts).
  const guarded = await guardStoreWrite(request, "products", 4_000, (sent) => (sent.detach === true ? "detach" : ""));
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

    // A new file deletes the one there, with the buyers' stamped copies: not from a session let in
    // without its second step (lib/two-step.ts). The id may name a price option, whose file is its
    // own, so the file is read where the id points (readDelivery), not on a product only.
    // Read once, only for a new file (the lock and the episodes need it); a detach reads it after its write instead.
    const delivery = detach ? null : await readDelivery(store, id);
    if (!detach && (await lockedFor(request, "products", "replace")) && deliveredFile(delivery)) return refusedJson("locked");

    let file: ProductFile | null = null;
    if (!detach) {
      const folder = await storeFolder(ref);
      if (!ownsPath(pathname, folder, id)) {
        return Response.json({ ok: false, error: "invalid" }, { status: 400 });
      }
      // The product's folder also holds its podcast episodes' audio: none of it is ever the product's file, so taking
      // the file off or replacing it later can never delete an episode's audio. Today a podcast takes no file
      // (lib/store.ts changeDelivery) and an option's file sits in the option's own folder, so this is a defence for
      // a record written before those rules. Episodes that cannot be read refuse the file, nothing written.
      // Only for the product itself: an option's file is in the option's own folder (ownsPath above), where no
      // episode is, so a bonus file on a podcast's price option is never held up by its episodes.
      if (!delivery) return Response.json({ ok: false, error: "unknown" }, { status: 404 });
      if (!delivery.option) {
        const audio = await audioPlayedBy(delivery.product);
        if (!audio) return Response.json({ ok: false, error: "server_error" }, { status: 500 });
        if (audio.has(pathname)) return Response.json({ ok: false, error: "in_use" }, { status: 400 });
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

    const result = await setProductFile(ref, id, file);
    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason },
        { status: result.reason === "unknown" ? 404 : 400 },
      );
    }

    // Best effort, and deliberately after the write. A file left behind costs
    // a fraction of a cent; a product pointing at nothing costs a sale.
    // Nor an episode's audio (a record written before a podcast took no file): read after the write, kept when the
    // episodes cannot be read. A file left behind costs storage; an episode deleted from under a feed costs listeners.
    const removed = result.removed;
    // A new file reuses what was read before the write (no second read of the listing, Claude 4 on #2657); a detach reads
    // it once here. A read that throws is unknown (kept), and when no product was found, audioPlayedBy answers unknown
    // (kept), never "no episodes".
    const stillPlayed = !removed
      ? new Set<string>()
      : await (delivery ? Promise.resolve(delivery) : readDelivery(result.store, id)).then((found) => audioPlayedBy(found?.product)).catch(() => null);
    if (removed && removed.pathname !== file?.pathname && stillPlayed && !stillPlayed.has(removed.pathname)) {
      await del(removed.pathname).catch((error: unknown) => {
        console.error("could not delete the replaced file", error);
      });
      // Buyers' stamped copies of it go with it.
      await dropStamped(removed);
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("attaching a file failed", error);
    return Response.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
