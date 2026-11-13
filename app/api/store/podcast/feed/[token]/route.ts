import type { NextRequest } from "next/server";
import { storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { readPodcast } from "@/lib/podcast";
import { FEED_SHARED_SECONDS, feedReadAllowed, listenerOf, mayListen, readFeedToken } from "@/lib/podcast-access";
import { normaliseEmail } from "@/lib/auth";
import { isResting, recordListener } from "@/lib/traffic";
import { feedXml } from "@/lib/podcast-rules";
import { imageUrl } from "@/lib/product-image";
import { photoUrl } from "@/lib/photo-limits";
import { SITE_URL } from "@/lib/site-url";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { productSegment } from "@/lib/product-slug";
import { holdState } from "@/lib/child-safety";

/**
 * Kept by the CDN, under the feed's own secret address, for a few hours: a
 * podcast app asks every hour whether or not anybody listens, and this is
 * what answers it without the feed being put together each time
 * (lib/podcast-access.ts). A browser or an app keeps nothing: it asks the
 * CDN every time.
 */
const HEADERS = {
  "Content-Type": "application/rss+xml; charset=utf-8",
  "Cache-Control": `public, max-age=0, s-maxage=${FEED_SHARED_SECONDS}`,
  "X-Robots-Tag": "noindex, nofollow",
};

/**
 * One buyer's private feed of a podcast (lib/podcast-rules.ts). Read by their
 * podcast app; it lists episodes only while that buyer holds the product,
 * and each episode is asked about again when it is fetched.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = raw.replace(/\.xml$/, "");
  const grant = await readFeedToken(token);
  if (!grant) return new Response("No such feed.", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!(await feedReadAllowed(token))) {
    return new Response("Too many requests.", { status: 429, headers: { "Retry-After": String(FEED_SHARED_SECONDS), "Cache-Control": "no-store" } });
  }
  const store = await storeForHandle(grant.h);
  const product = store && store.statsId === grant.s ? await readListing(store, grant.p) : null;
  if (!store || !product?.podcast) return new Response("This podcast is no longer here.", { status: 410, headers: { "Cache-Control": "no-store" } });
  // A podcast held for a child-safety report (lib/child-safety.ts) is no feed for anyone, and no cache keeps the
  // answer; a hold that cannot be read is asked about again later, never answered with the feed.
  const hold = await holdState(store, product.id);
  if (hold === "held") return new Response("No such feed.", { status: 404, headers: { "Cache-Control": "no-store" } });
  if (hold === "unknown") return new Response("Try again later.", { status: 503, headers: { "Retry-After": "600", "Cache-Control": "no-store" } });
  const allowed = await mayListen(store, product.id, grant.e);
  const own = normaliseEmail(grant.e) === normaliseEmail(store.email);
  // Once the store has used the whole month's visits, a subscriber's feed rests like the
  // store's other buyer pages (lib/traffic-rules.ts): the app is told to come back later,
  // and nothing in the feed is taken away.
  // Asked by the app maker's servers, which many subscribers share: bounded by the feed's own reads, not by a connection's share of the day.
  if (allowed && !own && (await isResting(store, Date.now(), "buyer", { shared: true }))) {
    return new Response("This feed is resting for now. It opens again with the store's next month.", { status: 503, headers: { "Retry-After": String(6 * 3600), "Cache-Control": "no-store" } });
  }
  // A subscriber whose app asked today is that day's visit to the store,
  // once (lib/traffic.ts). Never the creator's own feed.
  if (allowed && !own) await recordListener(store, listenerOf(token));
  const podcast = allowed ? await readPodcast(product.podcast.id) : null;
  const base = `${SITE_URL}/api/store/podcast/play/${token}`;
  const body = feedXml({
    title: product.title,
    summary: allowed ? product.summary : coursesWords(store.language).feedEnded(product.title, store.name),
    // The store's language (lib/store-language.ts), as RSS writes one.
    language: LANGUAGES[parseLanguage(store.language)].locale.toLowerCase(),
    author: store.name,
    page: `${SITE_URL}/@${store.handle}/p/${productSegment(product)}`,
    image: product.image ? `${SITE_URL}${imageUrl(product.image)}` : store.photoId ? `${SITE_URL}${photoUrl(store.photoId)}` : null,
    episodes: podcast?.episodes ?? [],
    audio: (e) => `${base}/${e.id}.${e.contentType === "audio/mp4" ? "m4a" : "mp3"}`,
  });
  return new Response(body, { status: 200, headers: HEADERS });
}
