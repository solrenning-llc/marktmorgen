import type { NextRequest } from "next/server";
import { deleteFile as del, headFile as head } from "@/lib/file-store";
import { setPodcastEpisodes, setProductPodcast, storeFolder, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { refusedJson } from "@/lib/studio-route";
import { requestLocked } from "@/lib/two-step";
import { ownsPath } from "@/lib/product-file";
import { readListing } from "@/lib/catalog";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { dropPodcast, editPodcast, newPodcastId, readPodcast, savePodcast, type PodcastEdit } from "@/lib/podcast";

/**
 * Everything the studio changes about a private podcast.
 *
 * `{ action: "enable", id }` makes a product a podcast; `{ action: "disable",
 * id }` turns an empty one back; `{ action: "add", id, pathname, title, notes }`
 * puts an uploaded episode out; `{ action: "edit", id, episode, title, notes }`
 * changes one; `{ action: "remove", id, episode }` takes one away and deletes
 * its audio. `id` is the product's, found in the creator's own store.
 */
export async function POST(request: NextRequest) {
  const guarded = await guardStoreWrite(request, "products", 12_000);
  if (!guarded.ok) return guarded.response;
  const { ref, body } = guarded;
  const fail = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
  const action = text(body.action, 10);
  const id = text(body.id, 40);
  try {
    const store = await storeForEmail(ref);
    if (!store) return fail("none");
    const product = id ? await readListing(store, id) : null;
    if (!product) return fail("unknown", 404);

    if (action === "enable") {
      if (product.podcast) return Response.json({ ok: true, podcastId: product.podcast.id });
      const podcastId = newPodcastId();
      const result = await setProductPodcast(ref, id, { id: podcastId, episodes: 0 });
      if (!result.ok) return fail(result.reason);
      await savePodcast({ id: podcastId, episodes: [] });
      return Response.json({ ok: true, podcastId });
    }
    if (!product.podcast) return fail("not_podcast");
    const podcastId = product.podcast.id;

    return await withLock(`nl:pod:${podcastId}:lock`, 60, 15_000, async () => {
      const podcast = (await readPodcast(podcastId)) ?? { id: podcastId, episodes: [] };
      if (action === "disable") {
        if (podcast.episodes.length > 0) return fail("not_empty");
        const result = await setProductPodcast(ref, id, null);
        if (!result.ok) return fail(result.reason);
        await dropPodcast(podcastId);
        return Response.json({ ok: true });
      }
      let edit: PodcastEdit;
      if (action === "add") {
        const pathname = text(body.pathname, 400);
        // In this store's folder for this very product, and what it is is read
        // from storage, not from the browser.
        if (!ownsPath(pathname, await storeFolder(ref), id)) return fail("invalid");
        const found = await head(pathname);
        edit = { op: "add", pathname, bytes: found.size, contentType: found.contentType, title: body.title, notes: body.notes, at: Math.floor(Date.now() / 1000) };
      } else if (action === "edit") {
        edit = { op: "edit", id: text(body.episode, 20), title: body.title, notes: body.notes };
      } else if (action === "remove") {
        // Its audio is deleted for good: not while the session is locked (lib/two-step.ts).
        if (await requestLocked(request)) return refusedJson("locked");
        edit = { op: "remove", id: text(body.episode, 20) };
      } else {
        return fail("invalid");
      }
      const result = editPodcast(podcast, edit);
      if (!result.ok) {
        // An upload that could not be taken is not left in storage.
        if (edit.op === "add") await del(edit.pathname).catch(() => {});
        return fail(result.reason);
      }
      await savePodcast(result.podcast);
      await setPodcastEpisodes(ref, id, result.podcast.episodes.length);
      if (result.removed) await del(result.removed.pathname).catch((error: unknown) => console.error("could not delete an episode's audio", error));
      return Response.json({ ok: true, podcast: result.podcast });
    });
  } catch (error) {
    if (error instanceof LockBusyError) return fail("busy", 409);
    console.error("changing a podcast failed", error);
    return fail("server_error", 500);
  }
}
