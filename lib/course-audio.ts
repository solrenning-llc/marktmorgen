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
import { COURSE_ID_PATTERN, ITEM_ID_PATTERN, parseCourse } from "@/lib/course";
import { type DataStore, giveData, needData } from "@/lib/store-data";
import { dataBytes } from "@/lib/store-data-rules";
import { type Store, storeForHandle } from "@/lib/store";
import { type Listing, idsOfKind, listingSizes, readListing } from "@/lib/catalog";
import { normaliseEmail } from "@/lib/auth";
import { emailKey, paidCourses } from "@/lib/learn";
import { passedQuizzes } from "@/lib/quiz";
import { takeBuyerRead } from "@/lib/buyer-actions";
import { withinLimit } from "@/lib/request-guard";
import { feedReadAllowed, readFeedToken } from "@/lib/podcast-access";
import { FEED_TOKEN } from "@/lib/podcast-rules";
import { type AudioLesson, COURSE_AUDIO_PLAYS_A_DAY, accessWork, audioLessons, audioUnits, hasLessonAudio, outlineWork } from "@/lib/course-audio-rules";

const audioKey = (courseId: string) => `nl:course:${courseId}:audio`;
/** The course's own record, as lib/course.ts keeps it: read here only up to the size measured and paid for. */
const outlineKey = (courseId: string) => `nl:course:${courseId}`;
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
 * The steps both doors take, each paid for before what it reads:
 *
 *   0. the token's shape (and, to play, the lesson id's); the token read; its
 *      own limit (a feed built at most FEED_READS_A_DAY times a day, a lesson
 *      fetched at most COURSE_AUDIO_PLAYS_A_DAY); its store, which must be
 *      the one the token was made in. Nothing of the store's month is taken.
 *   1. one public request: the listing, the switch and the course's size.
 *      Switched off, not a course, or no course record: stops here.
 *   2. the course's own requests (outlineWork, by its measured size): the
 *      course read up to that size, never past it, and the size of each of
 *      the store's course listings. A lesson the course does not have, with
 *      audio, stops here, before anybody's access is asked.
 *   3. the access requests (accessWork, by the store's courses and their
 *      measured listings): whether the address may still listen (lib/learn.ts
 *      paidCourses, the lesson page's own answer: a refund, an ended
 *      membership or a student taken off the course closes it at once) and
 *      the quizzes it passed.
 *
 * Every request is counted in the asking connection's share of the day too,
 * like every buyer read: only the affiliate book and a community archive's
 * walk are counted outside it (tests/public-reads-ceiling.test.ts, MM-SA-01).
 * An answer that cannot be read (a size, a record cut short because it grew
 * after it was measured) refuses, never guesses.
 */
export async function openCourseAudio(token: string, door: "feed" | "play", lessonId: string | null = null, now = Date.now()): Promise<CourseListen | ListenRefused> {
  const missing: ListenRefused = { ok: false, status: 404, text: "No such feed." };
  const notFound: ListenRefused = { ok: false, status: 404, text: "Not found." };
  const gone: ListenRefused = { ok: false, status: 410, text: "This course is no longer here." };
  const resting: ListenRefused = { ok: false, status: 503, text: "This feed is resting for now. It opens again with the store's next month.", retryAfter: 6 * 3600 };
  const later: ListenRefused = { ok: false, status: 503, text: "Try again in a moment.", retryAfter: 600 };
  if (!FEED_TOKEN.test(token)) return missing;
  if (door === "play" && (!lessonId || !ITEM_ID_PATTERN.test(lessonId))) return notFound;
  try {
    // 0. The token, its own limit, its store.
    const grant = await readFeedToken(token);
    if (!grant) return missing;
    const paced = door === "feed" ? await feedReadAllowed(token, now) : await withinLimit("course-audio-play", token, COURSE_AUDIO_PLAYS_A_DAY, 86_400);
    if (!paced) return { ok: false, status: 429, text: "Too many requests.", retryAfter: 3600 };
    const store = await storeForHandle(grant.h);
    if (!store || !store.statsId || store.statsId !== grant.s) return gone;

    // 1. One request: the listing, the switch, the course's size.
    if (!(await takeBuyerRead(store, 1))) return resting;
    const product = await readListing(store, grant.p);
    const courseId = product?.course?.id;
    if (!product || !courseId || !COURSE_ID_PATTERN.test(courseId)) return gone;
    const [switched, measured] = await redisPipeline([["GET", audioKey(courseId)], ["STRLEN", outlineKey(courseId)]]);
    if (switched !== "1") return door === "play" ? notFound : missing;
    if (typeof measured !== "number" || !Number.isSafeInteger(measured) || measured < 0) return later;
    if (measured === 0) return gone;

    // 2. The course, up to its measured size, and the size of each course listing.
    const courses = idsOfKind(store, "course");
    if (!(await takeBuyerRead(store, audioUnits(outlineWork(measured, courses.length))))) return resting;
    const [raw] = await redisPipeline([["GETRANGE", outlineKey(courseId), 0, measured - 1]]);
    const course = parseCourse(raw);
    if (!course || course.id !== courseId) return later;
    if (door === "play" && !hasLessonAudio(course, lessonId!)) return notFound;
    const sizes = await listingSizes(store, courses);
    if (!sizes) return later;

    // 3. Whether this address may listen, and what it passed.
    if (!(await takeBuyerRead(store, audioUnits(accessWork(courses.length, sizes.reduce((a, b) => a + b, 0)))))) return resting;
    const own = normaliseEmail(grant.e) === normaliseEmail(store.email);
    const start = own ? Math.floor(now / 1000) - 400 * 86_400 : (await paidCourses(store, grant.e)).get(product.id);
    if (start === undefined || !Number.isFinite(start)) return { ok: true, store, product, lessons: null };
    const passed = own ? new Set<string>() : await passedQuizzes(course.id, emailKey(grant.e));
    return { ok: true, store, product, lessons: audioLessons(course, { start, owner: own, passed }, now / 1000) };
  } catch (error) {
    console.error("opening a course's audio feed failed", error);
    return later;
  }
}
