import type { NextRequest } from "next/server";
import { handleProblem, normaliseHandle, type Store } from "@/lib/store";
import { storeForHandleExactly } from "@/lib/store-exact";
import { productIdFromAddress, readListingExactly } from "@/lib/catalog";
import { readPodcast } from "@/lib/podcast";
import { type PublicCategory, PublicFeedError, publicFeedXml } from "@/lib/podcast-public-feed";
import {
  PUBLIC_FEED_BUILD_UNITS,
  PUBLIC_FEED_HOLD_UNITS,
  buildUnits,
  cachedFeed,
  etagOf,
  keepFeed,
  matchesTag,
  publicCandidates,
  readPublicShow,
  sendUnits,
  type KeptFeed,
} from "@/lib/podcast-public-show";
import { givePublicRequests, holdPublicRequests, takePublicRequest } from "@/lib/traffic";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { SITE_URL } from "@/lib/site-url";
import { productSegment } from "@/lib/product-slug";
import { imageUrl } from "@/lib/product-image";
import { photoUrl } from "@/lib/photo-limits";

/**
 * The public feed of a store's podcast (33 [F2], part 2): the RSS document Apple Podcasts, Spotify and any app read,
 * at /api/store/podcast/public/<handle>/<product>.xml, holding only the episodes the creator marked exactly "public"
 * (lib/podcast-public-feed.ts), each at the https address its audio is published at (lib/podcast-public-show.ts).
 * No audio passes through here and no buyer's feed or play address is named. A buyer's own private feed is
 * app/api/store/podcast/feed/[token], untouched.
 *
 * Every answer is paid from the store's public requests before it is sent (lib/traffic.ts): a feed built is held at
 * its worst (PUBLIC_FEED_HOLD_UNITS) before anything past the store is read and what it did not need is given back;
 * the bytes sent take one unit per PUBLIC_FEED_BYTES_PER_UNIT before the body goes. A spent window is a 503 with
 * Retry-After, which podcast apps take as "come back later"; nothing is sent beyond it.
 *
 * The XML is kept on the server PUBLIC_FEED_CACHE_SECONDS, so an app asking again reads nothing from Redis; caches
 * between are told to ask each time (no-cache), with an ETag, so every answer is counted and an app that already has
 * it gets a 304 with no body. A record that cannot be read is a 503, never an empty feed, and is not kept (rule 24).
 */
const FEED_HEADERS = { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "no-cache" };
const MAX_SEGMENT = 200;

function plain(status: number, text: string, retryAfter?: number): Response {
  const headers: Record<string, string> = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" };
  if (retryAfter) headers["Retry-After"] = String(retryAfter);
  return new Response(text, { status, headers });
}

const notFound = () => plain(404, "No such podcast feed.");
/** The store's public requests for the month are used: the feed rests until its next window. */
const resting = () => plain(503, "This feed is resting for now. Try again later.", 3600);
/** A record that could not be read: never an empty feed. */
const unavailable = () => plain(503, "This feed cannot be read just now. Try again in a minute.", 60);

/** The feed, or why there is none, built from the records once the build's units are held. */
async function build(store: Store, segment: string, now: number): Promise<KeptFeed | "none" | "unavailable" | "resting"> {
  // Held at its worst before anything past the store is read, the listing included (a GET when the product is off the
  // catalog's head); what it did not read is given back after. A listing that is missing keeps the base (the store and
  // the listing read); one that cannot be read keeps the whole hold, its cost unknown, never zero.
  if (!(await holdPublicRequests(store, PUBLIC_FEED_HOLD_UNITS, now))) return "resting";
  let used = PUBLIC_FEED_HOLD_UNITS;
  try {
    const id = productIdFromAddress(store, segment) ?? segment;
    const product = await readListingExactly(store, id);
    if (product === "unknown") return "unavailable";
    if (!product || product.hidden || !product.podcast) {
      used = PUBLIC_FEED_BUILD_UNITS;
      return "none";
    }
    const [podcast, show] = await Promise.all([readPodcast(product.podcast.id), readPublicShow(product.podcast.id)]);
    // What was read: the podcast as savePodcast writes it, and the settings as they came.
    const read = (podcast ? Buffer.byteLength(JSON.stringify(podcast), "utf8") : 0) + (show ? show.bytes : 0);
    used = Math.min(PUBLIC_FEED_HOLD_UNITS, buildUnits(read) ?? PUBLIC_FEED_HOLD_UNITS);
    if (!podcast || !show) return "none";
    const { candidates, audio } = publicCandidates(podcast, show);
    const xml = publicFeedXml({
      title: product.title,
      summary: product.summary,
      author: store.name,
      page: `${SITE_URL}/@${store.handle}/p/${productSegment(product)}`,
      image: product.image ? `${SITE_URL}${imageUrl(product.image)}` : store.photoId ? `${SITE_URL}${photoUrl(store.photoId)}` : null,
      // As stored: publicFeedXml refuses a category or flag that is not one (PublicFeedError), never guesses one.
      category: show.category as PublicCategory,
      explicit: show.explicit as boolean,
      language: LANGUAGES[parseLanguage(store.language)].locale.toLowerCase(),
      episodes: candidates,
      audio: (e) => audio.get(e.id) ?? "",
    });
    return { store, xml, etag: etagOf(xml), bytes: Buffer.byteLength(xml, "utf8") };
  } catch (error) {
    if (error instanceof PublicFeedError) console.warn(`a public podcast feed could not be written: ${error.reason}`);
    else console.error("a public podcast feed's records could not be read", error);
    return "unavailable";
  } finally {
    if (used < PUBLIC_FEED_HOLD_UNITS) await givePublicRequests(store, PUBLIC_FEED_HOLD_UNITS - used, now);
  }
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ handle: string; product: string }> }) {
  const { handle: rawHandle, product: rawProduct } = await params;
  let handle: string;
  let segment: string;
  try {
    handle = normaliseHandle(decodeURIComponent(rawHandle));
    segment = decodeURIComponent(rawProduct).replace(/\.xml$/, "");
  } catch {
    return notFound();
  }
  if (handleProblem(handle) || segment === "" || segment.length > MAX_SEGMENT) return notFound();
  const key = `${handle}|${segment}`;
  const now = Date.now();

  let feed = cachedFeed(key, now);
  if (!feed) {
    let store: Awaited<ReturnType<typeof storeForHandleExactly>>;
    try {
      store = await storeForHandleExactly(handle);
    } catch (error) {
      console.error("a public podcast feed's store could not be read", error);
      return unavailable();
    }
    if (store === "unknown") return unavailable();
    if (store === "none") return notFound();
    const built = await build(store, segment, now);
    if (built === "none") return notFound();
    if (built === "unavailable") return unavailable();
    if (built === "resting") return resting();
    keepFeed(key, built, now);
    feed = built;
  }

  // An app that already has this feed is told so with no body: one unit, taken before it is answered.
  if (matchesTag(request.headers.get("if-none-match"), feed.etag)) {
    if (!(await takePublicRequest(feed.store, "public", now, 1))) return resting();
    return new Response(null, { status: 304, headers: { ...FEED_HEADERS, ETag: feed.etag } });
  }
  const units = sendUnits(feed.bytes);
  if (units === null) return unavailable();
  if (!(await takePublicRequest(feed.store, "public", now, units))) return resting();
  const body = feed.xml;
  return new Response(body, { status: 200, headers: { ...FEED_HEADERS, ETag: feed.etag } });
}
