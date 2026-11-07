import type { NextRequest } from "next/server";
import { lockedFor } from "@/lib/two-step";
import { refusedJson } from "@/lib/studio-route";
import { deleteFile as del, headFile as head } from "@/lib/file-store";
import { setPodcastEpisodes, setProductPodcast, storeFolder, storeForEmail } from "@/lib/store";
import { guardStoreWrite, text } from "@/lib/store-request";
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
 * its audio and its transcript; `{ action: "transcript", id, episode, pathname }`
 * gives an episode the uploaded plain text file as its transcript (274 [AX1]
 * Part B.3), and `{ action: "transcript", id, episode, remove: true }` takes it
 * away and deletes it. `id` is the product's, found in the creator's own store.
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
      // A file the product or an episode already names, as its audio or its transcript, is never taken as a new one.
      const named = (pathname: string, episodes = podcast.episodes) =>
        product.file?.pathname === pathname || episodes.some((episode) => episode.pathname === pathname || episode.transcript?.pathname === pathname);
      let edit: PodcastEdit;
      if (action === "add") {
        const pathname = text(body.pathname, 400);
        // In this store's folder for this very product, and what it is is read
        // from storage, not from the browser.
        if (!ownsPath(pathname, await storeFolder(ref), id)) return fail("invalid");
        // The product's own file and its other episodes share this folder: none of them is a new episode's audio,
        // so removing this episode later can never delete them.
        if (named(pathname)) return fail("in_use");
        const found = await head(pathname);
        edit = { op: "add", pathname, bytes: found.size, contentType: found.contentType, title: body.title, notes: body.notes, at: Math.floor(Date.now() / 1000) };
      } else if (action === "transcript") {
        const episode = text(body.episode, 20);
        const had = podcast.episodes.find((e) => e.id === episode)?.transcript ?? null;
        if (body.remove === true) {
          // Removing one deletes its file for good, and a session let in without the second step waits for it
          // (lib/two-step.ts, products "remove"); with none there is nothing to delete.
          if (had && (await lockedFor(request, "products", "remove"))) return refusedJson("locked");
          edit = { op: "transcript", id: episode, pathname: null, bytes: 0, contentType: "" };
        } else {
          const pathname = text(body.pathname, 400);
          // The same checks as an episode's audio: this product's own folder, never a file already named, and what
          // it is (plain text, its size) read from storage, not from the browser.
          if (!ownsPath(pathname, await storeFolder(ref), id)) return fail("invalid");
          if (!podcast.episodes.some((e) => e.id === episode)) return fail("unknown");
          if (named(pathname)) return fail("in_use");
          // A new one deletes the one it replaces, so it waits like every replacement (products "replace").
          if (had && (await lockedFor(request, "products", "replace"))) return refusedJson("locked");
          const found = await head(pathname);
          edit = { op: "transcript", id: episode, pathname, bytes: found.size, contentType: found.contentType };
        }
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
      // A dropped file the product or another episode still names (written before the check above) is kept.
      for (const pathname of result.dropped) {
        if (named(pathname, result.podcast.episodes)) continue;
        await del(pathname).catch((error: unknown) => console.error("could not delete an episode's file", error));
      }
      return Response.json({ ok: true, podcast: result.podcast });
    });
  } catch (error) {
    if (error instanceof LockBusyError) return fail("busy", 409);
    console.error("changing a podcast failed", error);
    return fail("server_error", 500);
  }
}
