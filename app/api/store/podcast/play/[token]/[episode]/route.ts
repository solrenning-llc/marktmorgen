import type { NextRequest } from "next/server";
import { storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readPodcast } from "@/lib/podcast";
import { feedAllowed, mayListen, readFeedToken } from "@/lib/podcast-access";
import { signedMedia } from "@/lib/learn";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { TRANSCRIPT_TYPE } from "@/lib/podcast-rules";

/**
 * One episode, fetched by a buyer's podcast app: sent on to a signed address
 * in the private file store that works for a few hours, and only while the
 * buyer still holds the podcast. `<episode>.txt` is that episode's transcript
 * (274 [AX1] Part B.3), behind exactly the same checks.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string; episode: string }> }) {
  const { token, episode: raw } = await params;
  const words = raw.endsWith(".txt");
  const episodeId = raw.replace(/\.(mp3|m4a|txt)$/, "");
  const grant = await readFeedToken(token);
  if (!grant) return new Response("Not found.", { status: 404 });
  if (!(await feedAllowed(token))) return new Response("Too many requests.", { status: 429, headers: { "Retry-After": "600" } });
  const store = await storeForHandle(grant.h);
  const product = store && store.statsId === grant.s ? await readListing(store, grant.p) : null;
  if (!store || !product?.podcast || !(await mayListen(store, product.id, grant.e))) return new Response("Not available.", { status: 403 });
  // One of the store's public requests on the buyers' side (lib/buyer-actions.ts).
  if (!(await takeBuyerRead(store))) return new Response("Try again later.", { status: 503, headers: { "Retry-After": "3600" } });
  const podcast = await readPodcast(product.podcast.id);
  const episode = podcast?.episodes.find((e) => e.id === episodeId);
  if (!episode || (words && !episode.transcript)) return new Response("Not found.", { status: 404 });
  const file = words && episode.transcript
    ? { pathname: episode.transcript.pathname, name: `${episode.title}.txt`, bytes: episode.transcript.bytes, contentType: TRANSCRIPT_TYPE, addedAt: "" }
    : { pathname: episode.pathname, name: `${episode.title}.mp3`, bytes: episode.bytes, contentType: episode.contentType, addedAt: "" };
  const url = await signedMedia(file, 4 * 3600);
  if (!url) return new Response("Try again in a moment.", { status: 503 });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
}
