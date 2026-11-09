import type { NextRequest } from "next/server";
import { storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readPodcast } from "@/lib/podcast";
import { endGrant, feedAllowed, mayListenOrThrow, readFeedToken } from "@/lib/podcast-access";
import { signedMedia } from "@/lib/learn";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { EPISODE_URL_SECONDS, PLAY_REQUEST_UNITS } from "@/lib/podcast-rules";

/**
 * One episode, fetched by a buyer's podcast app: sent on to a signed address
 * in the private file store that works for a few minutes (EPISODE_URL_SECONDS;
 * the app asks here again for each fetch), and only while the buyer still
 * holds the podcast.
 *
 * The store's public requests are taken before the product is read or Stripe
 * is asked (audit of private podcasts, M1): a refusal costs what an answer
 * does, and is paid like one. A confirmed "no" ends the token's grant, so a
 * dead token is one read after that; Stripe that cannot be asked is not a no.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string; episode: string }> }) {
  const { token, episode: raw } = await params;
  const episodeId = raw.replace(/\.(mp3|m4a)$/, "");
  const grant = await readFeedToken(token);
  if (!grant) return new Response("Not found.", { status: 404 });
  if (!(await feedAllowed(token))) return new Response("Too many requests.", { status: 429, headers: { "Retry-After": "600" } });
  const store = await storeForHandle(grant.h);
  if (!store || store.statsId !== grant.s) return new Response("Not available.", { status: 403 });
  // The store's public requests on the buyers' side (lib/buyer-actions.ts), before anything else is read or asked.
  if (!(await takeBuyerRead(store, PLAY_REQUEST_UNITS))) return new Response("Try again later.", { status: 503, headers: { "Retry-After": "3600" } });
  const product = await readListing(store, grant.p);
  if (!product?.podcast) return new Response("Not available.", { status: 403 });
  let allowed: boolean;
  try {
    allowed = await mayListenOrThrow(store, product.id, grant.e);
  } catch {
    return new Response("Try again in a moment.", { status: 503, headers: { "Retry-After": "60", "Cache-Control": "private, no-store" } });
  }
  if (!allowed) {
    await endGrant(token).catch(() => undefined);
    return new Response("Not available.", { status: 403 });
  }
  const podcast = await readPodcast(product.podcast.id);
  const episode = podcast?.episodes.find((e) => e.id === episodeId);
  if (!episode) return new Response("Not found.", { status: 404 });
  const url = await signedMedia({ pathname: episode.pathname, name: `${episode.title}.mp3`, bytes: episode.bytes, contentType: episode.contentType, addedAt: "" }, EPISODE_URL_SECONDS);
  if (!url) return new Response("Try again in a moment.", { status: 503 });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
}
