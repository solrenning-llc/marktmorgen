import type { NextRequest } from "next/server";
import { adjustImages } from "@/lib/image-space";
import { deleteFile as del, headFile as head } from "@/lib/file-store";
import { setPodcastEpisodes, setProductPodcast, storeFolder, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
import { ownsPath } from "@/lib/product-file";
import { readListing } from "@/lib/catalog";
import { LockBusyError, withLock } from "@/lib/redis-lock";
import { UnknownReplyError } from "@/lib/redis-reply";
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
      // Only Redis's exact "no record" is an empty podcast; an unknown read throws (readPodcast) and nothing is
      // written, because what is written below is the whole podcast as read.
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
        // The product's own file and its other episodes share this folder: none of them is a new episode's audio,
        // so removing this episode later can never delete them.
        if (product.file?.pathname === pathname || podcast.episodes.some((episode) => episode.pathname === pathname)) return fail("in_use");
        const found = await head(pathname);
        edit = { op: "add", pathname, bytes: found.size, contentType: found.contentType, title: body.title, notes: body.notes, at: Math.floor(Date.now() / 1000) };
      } else if (action === "edit") {
        edit = { op: "edit", id: text(body.episode, 20), title: body.title, notes: body.notes };
      } else if (action === "remove") {
        edit = { op: "remove", id: text(body.episode, 20) };
      } else {
        return fail("invalid");
      }
      const result = editPodcast(podcast, edit);
      if (!result.ok) {
        // Nothing is deleted for a refusal, nor for an error thrown after the file was read (a full store, a file
        // store that did not answer, a lock lost): the browser names the file, and the product's folder also holds
        // its episodes and its own file, so the name may be one of those. No door can write down which upload is
        // new, because the name gets its random ending only once it is stored (app/api/store/file, the vault), so
        // "this request's own upload" cannot be proved here. A file left behind stays, never deleted from under a
        // record; its cost is bounded where it was let in: the door reserved its full size from the store's monthly
        // upload room (reserveStoreUpload, never refunded) and the store's storage brake counts it (lib/storage-quota.ts).
        return fail(result.reason);
      }
      await savePodcast(result.podcast);
      await setPodcastEpisodes(ref, id, result.podcast.episodes.length);
      // Audio the product's file or another episode still uses (written before the check above) is kept.
      const gone = result.removed;
      const shared = gone !== null && (product.file?.pathname === gone.pathname || result.podcast.episodes.some((episode) => episode.pathname === gone.pathname));
      if (gone && !shared) {
        const since = Date.now();
        const deleted = await del(gone.pathname).then(() => true, (error: unknown) => {
          console.error("could not delete an episode's audio", error);
          return false;
        });
        // Its room given back to the store's pictures (owner's decision 8, lib/image-space.ts).
        if (deleted) await adjustImages(ref, [], 0, { files: gone.bytes, since });
      }
      return Response.json({ ok: true, podcast: result.podcast });
    });
  } catch (error) {
    if (error instanceof LockBusyError) return fail("busy", 409);
    if (error instanceof UnknownReplyError) return fail("unavailable", 503);
    console.error("changing a podcast failed", error);
    return fail("server_error", 500);
  }
}
