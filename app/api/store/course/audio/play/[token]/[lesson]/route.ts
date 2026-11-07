import type { NextRequest } from "next/server";
import { openCourseAudio } from "@/lib/course-audio";
import { signedMedia } from "@/lib/learn";
import { COURSE_AUDIO_URL_SECONDS } from "@/lib/course-audio-rules";

/**
 * One lesson's audio, fetched by a student's podcast app (298 [H5-1]): sent
 * on to a signed address in the private file store that works for
 * COURSE_AUDIO_URL_SECONDS (why so long is said there), and only while the
 * switch is on, the student still holds the course and the lesson is open
 * for them today. Counted as a delivery of
 * the store's month, as every lesson file is (lib/delivery.ts).
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ token: string; lesson: string }> }) {
  const { token, lesson: raw } = await params;
  const lessonId = raw.replace(/\.(mp3|m4a)$/, "");
  const opened = await openCourseAudio(token, "play", lessonId);
  if (!opened.ok) {
    return new Response(opened.text, {
      status: opened.status,
      headers: { "Cache-Control": "no-store", ...(opened.retryAfter ? { "Retry-After": String(opened.retryAfter) } : {}) },
    });
  }
  if (!opened.lessons) return new Response("Not available.", { status: 403, headers: { "Cache-Control": "no-store" } });
  const lesson = opened.lessons.find((l) => l.id === lessonId);
  if (!lesson) return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  const url = await signedMedia(lesson.file, COURSE_AUDIO_URL_SECONDS);
  if (!url) return new Response("Try again in a moment.", { status: 503, headers: { "Retry-After": "600", "Cache-Control": "no-store" } });
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
}
