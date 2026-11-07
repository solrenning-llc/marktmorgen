import type { NextRequest } from "next/server";
import { openCourseAudio } from "@/lib/course-audio";
import { audioEpisodes } from "@/lib/course-audio-rules";
import { feedXml } from "@/lib/podcast-rules";
import { imageUrl } from "@/lib/product-image";
import { photoUrl } from "@/lib/photo-limits";
import { SITE_URL } from "@/lib/site-url";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { productSegment } from "@/lib/product-slug";

/**
 * Never kept by the CDN or the app: a refund, an ended membership, a student
 * taken off the course or the switch turned off empties the feed the next
 * time it is asked for, not hours later. What that costs is the feed built
 * on each ask, up to FEED_READS_A_DAY times a day for one address (the asks
 * past it are refused before anything of the store's month is taken), each
 * paid for in steps before it reads (lib/course-audio.ts).
 */
const HEADERS = {
  "Content-Type": "application/rss+xml; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
};

/**
 * One student's private feed of a course's lessons as audio (298 [H5-1],
 * lib/course-audio.ts): only while the creator has it on, and only the
 * lessons that student may open today. A student whose access ended gets an
 * empty list that says so.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = raw.replace(/\.xml$/, "");
  const opened = await openCourseAudio(token, "feed");
  if (!opened.ok) {
    return new Response(opened.text, {
      status: opened.status,
      headers: { "Cache-Control": "no-store", ...(opened.retryAfter ? { "Retry-After": String(opened.retryAfter) } : {}) },
    });
  }
  const { store, product, lessons } = opened;
  const play = `${SITE_URL}/api/store/course/audio/play/${token}`;
  const body = feedXml({
    title: product.title,
    summary: lessons ? product.summary : coursesWords(store.language).feedEnded(product.title, store.name),
    // The store's language (lib/store-language.ts), as RSS writes one.
    language: LANGUAGES[parseLanguage(store.language)].locale.toLowerCase(),
    author: store.name,
    page: `${SITE_URL}/@${store.handle}/p/${productSegment(product)}`,
    image: product.image ? `${SITE_URL}${imageUrl(product.image)}` : store.photoId ? `${SITE_URL}${photoUrl(store.photoId)}` : null,
    episodes: audioEpisodes(lessons ?? [], (lessonId) => `${SITE_URL}/@${store.handle}/course/${product.id}/${lessonId}`),
    audio: (e) => `${play}/${e.id}.${e.contentType === "audio/mp4" ? "m4a" : "mp3"}`,
  });
  return new Response(body, { status: 200, headers: HEADERS });
}
