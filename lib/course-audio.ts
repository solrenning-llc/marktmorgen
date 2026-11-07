/**
 * Whether a course's lessons go out as audio in its students' private feeds
 * (298 [H5-1]; the rules are lib/course-audio-rules.ts).
 *
 *   nl:course:<course>:audio   "1" while the creator has it on; absent is off
 *
 * Off until the creator turns it on, course by course. Anything but its own
 * "1" (a missing key, an unexpected value, a database that cannot answer)
 * reads as off, so a feed is never served on a guess. Its few bytes take
 * their room in the store's data room before they are written
 * (lib/store-data.ts) and give it back when it is turned off.
 */
import { isRedisConfigured, redisPipeline } from "@/lib/redis";
import { COURSE_ID_PATTERN, readCourse } from "@/lib/course";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { type Store, storeForHandle } from "@/lib/store";
import { type Listing, readListing } from "@/lib/catalog";
import { normaliseEmail } from "@/lib/auth";
import { emailKey, paidCourses } from "@/lib/learn";
import { passedQuizzes } from "@/lib/quiz";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { FEED_SHARED_SECONDS, feedAllowed, feedReadAllowed, readFeedToken } from "@/lib/podcast-access";
import { FEED_TOKEN } from "@/lib/podcast-rules";
import { type AudioLesson, COURSE_AUDIO_READ_UNITS, audioLessons } from "@/lib/course-audio-rules";

const audioKey = (courseId: string) => `nl:course:${courseId}:audio`;
const AUDIO_SLOT = (courseId: string) => `ca:${courseId}`;

/** Whether the course's audio feed is on: true only for its own "1". */
export async function courseAudioOn(courseId: string): Promise<boolean> {
  if (!COURSE_ID_PATTERN.test(courseId) || !isRedisConfigured()) return false;
  try {
    const [raw] = await redisPipeline([["GET", audioKey(courseId)]]);
    return raw === "1";
  } catch (error) {
    console.error("reading a course's audio switch failed", error);
    return false;
  }
}

/**
 * Turns the course's audio feed on or off. On takes its room first (throws
 * DataRoomError when it does not fit) and writes one value, whatever was
 * there before; off deletes it and gives the room back. Never a read then a
 * write, so two at once leave whichever came last.
 */
export async function setCourseAudio(courseId: string, on: boolean, room: DataStore): Promise<void> {
  if (!COURSE_ID_PATTERN.test(courseId)) throw new Error("not a course id");
  if (on) {
    await needData(room, [{ slot: AUDIO_SLOT(courseId), bytes: dataBytes([audioKey(courseId), "1"], 1), set: true }]);
    await redisPipeline([["SET", audioKey(courseId), "1"]]);
    return;
  }
  await redisPipeline([["DEL", audioKey(courseId)]]);
  await giveData(room, [{ slot: AUDIO_SLOT(courseId), bytes: 0, set: true }]);
}

/** A door opened: the store, the course's listing, and the lessons this token's address may hear now (null: none, their access has ended or never was). */
export type CourseListen = { ok: true; store: Store; product: Listing; lessons: AudioLesson[] | null };
export type ListenRefused = { ok: false; status: 404 | 410 | 429 | 503; text: string; retryAfter?: number };

/**
 * The steps both doors take, in this order: the token's own limit (a feed
 * built at most FEED_READS_A_DAY times a day, a lesson fetched within
 * feedAllowed's hour), the token and its store, then
 * COURSE_AUDIO_READ_UNITS of the store's public requests taken before the
 * course, the switch, the student's access or their quizzes are read.
 * Whether the address may still listen is lib/learn.ts paidCourses, the
 * lesson page's own answer: a refund, an ended membership or a student
 * taken off the course closes it at once.
 */
export async function openCourseAudio(token: string, door: "feed" | "play", now = Date.now()): Promise<CourseListen | ListenRefused> {
  const missing: ListenRefused = { ok: false, status: 404, text: "No such feed." };
  if (!FEED_TOKEN.test(token)) return missing;
  try {
    const paced = door === "feed" ? await feedReadAllowed(token, now) : await feedAllowed(token);
    if (!paced) return { ok: false, status: 429, text: "Too many requests.", retryAfter: door === "feed" ? FEED_SHARED_SECONDS : 600 };
    const grant = await readFeedToken(token);
    if (!grant) return missing;
    const store = await storeForHandle(grant.h);
    const gone: ListenRefused = { ok: false, status: 410, text: "This course is no longer here." };
    if (!store || !store.statsId || store.statsId !== grant.s) return gone;
    // Counted in the asking connection's share of the day too, like every buyer read: only the affiliate book and a
    // community archive's walk are counted outside it (tests/public-reads-ceiling.test.ts, MM-SA-01).
    const taken = await takeBuyerRead(store, COURSE_AUDIO_READ_UNITS);
    if (!taken) return { ok: false, status: 503, text: "This feed is resting for now. It opens again with the store's next month.", retryAfter: 6 * 3600 };
    const product = await readListing(store, grant.p);
    if (!product?.course) return gone;
    if (!(await courseAudioOn(product.course.id))) return missing;
    const own = normaliseEmail(grant.e) === normaliseEmail(store.email);
    const start = own ? Math.floor(now / 1000) - 400 * 86_400 : (await paidCourses(store, grant.e)).get(product.id);
    if (start === undefined || !Number.isFinite(start)) return { ok: true, store, product, lessons: null };
    const course = await readCourse(product.course.id);
    if (!course) return gone;
    const passed = own ? new Set<string>() : await passedQuizzes(course.id, emailKey(grant.e));
    return { ok: true, store, product, lessons: audioLessons(course, { start, owner: own, passed }, now / 1000) };
  } catch (error) {
    console.error("opening a course's audio feed failed", error);
    return { ok: false, status: 503, text: "Try again in a moment.", retryAfter: 600 };
  }
}
