import type { NextRequest } from "next/server";
import { openCourseAudio } from "@/lib/course-audio";
import { audioEpisodes } from "@/lib/course-audio-rules";
import { FEED_SHARED_SECONDS } from "@/lib/podcast-access";
import { feedXml } from "@/lib/podcast-rules";
import { imageUrl } from "@/lib/product-image";
import { photoUrl } from "@/lib/photo-limits";
import { SITE_URL } from "@/lib/site-url";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGES, parseLanguage } from "@/lib/store-language";
import { productSegment } from "@/lib/product-slug";

/**
 * Kept by the CDN under the feed's own secret address for a few hours, as a
 * private podcast's is (lib/podcast-access.ts): an app's hourly question is
 * answered without the course being read again. Each lesson's audio is
 * asked about again whenever it is fetched (../../play).
 */
const HEADERS = {
  "Content-Type": "application/rss+xml; charset=utf-8",
  "Cache-Control": `public, max-age=0, s-maxage=${FEED_SHARED_SECONDS}`,
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
