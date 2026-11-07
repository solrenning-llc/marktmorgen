/**
 * A course's lessons as audio, in the student's own private podcast feed
 * (298 [H5-1], unit 1: the rules, the creator's switch and the two doors a
 * podcast app knocks on; the studio switch and the student's link are unit 2).
 *
 * The audio is the .mp3 or .m4a the creator already attached to a lesson, by
 * the same upload and the same storage as every other lesson file: nothing is
 * converted, no model is asked. The feed reuses the private podcast token of
 * lib/podcast-access.ts (one per address and product, deleted with the person).
 * What is checked:
 *
 *   - which lesson file is a lesson's audio, and that the feed holds only what
 *     the student may open today: a module still waiting (drip, a cohort that
 *     has not begun) and lessons behind an unpassed required quiz stay out;
 *     the creator's own feed holds everything; lesson order is kept;
 *   - the switch is off until the creator turns it on, takes its room first,
 *     and anything but its own "on" reads as off;
 *   - the feed: off is not found, a student's lists their open lessons, a
 *     stranger's, a refunded or blocked student's is empty, a forged token
 *     is not found; each build takes COURSE_AUDIO_READ_UNITS of the store's
 *     public requests before the course is read;
 *   - the play door hands a signed address only for a lesson in that feed.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, setSubscription, storeForEmail, storeFolder } from "@/lib/store";
import { type Course, type Lesson, saveCourse } from "@/lib/course";
import { emailKey, recordEnrollment, setBlocked } from "@/lib/learn";
import { markPassed } from "@/lib/quiz";
import { feedToken } from "@/lib/podcast-access";
import type { ProductFile } from "@/lib/product-file";
import { COURSE_AUDIO_READ_UNITS, audioEpisodes, audioLessons, lessonAudio } from "@/lib/course-audio-rules";
import { courseAudioOn, setCourseAudio } from "@/lib/course-audio";
import { GET as feed } from "@/app/api/store/course/audio/feed/[token]/route";
import { GET as play } from "@/app/api/store/course/audio/play/[token]/[lesson]/route";
import { requestsIn } from "@/lib/traffic";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

globalThis.fetch = (async () => new Response(JSON.stringify({ object: "list", data: [], has_more: false }))) as typeof fetch;

const OWNER = "teacher@example.com";
const STUDENT = "sam@example.com";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const COURSE_ID = "c".repeat(32);
const FOLDER = "f".repeat(32);

const file = (name: string, contentType: string): ProductFile => ({
  pathname: `vault/${FOLDER}/lesson/0011223344556677-${name}`,
  name,
  bytes: 1_000,
  contentType,
  addedAt: "2026-11-01T00:00:00.000Z",
});
const lesson = (id: string, title: string, files: ProductFile[], more: Partial<Lesson> = {}): Lesson => ({
  id,
  title,
  preview: false,
  video: null,
  files,
  link: null,
  hasBody: false,
  quiz: null,
  ...more,
});

function sampleCourse(startsAt: number | null = null): Course {
  return {
    id: COURSE_ID,
    certificate: false,
    startsAt,
    modules: [
      {
        id: "m1aaaaaaaaaa",
        title: "Start",
        dripDays: 0,
        lessons: [
          lesson("l1aaaaaaaaaa", "Welcome", [file("notes.pdf", "application/pdf"), file("welcome.mp3", "audio/mpeg")], { hasBody: true }),
          lesson("l2aaaaaaaaaa", "Slides only", [file("slides.pdf", "application/pdf"), file("raw.wav", "audio/wav")]),
          lesson("l3aaaaaaaaaa", "Check-in", [file("check.m4a", "audio/mp4")], { quiz: { questions: 3, passPercent: 70, attempts: 0, required: true } }),
          lesson("l4aaaaaaaaaa", "After the check-in", [file("after.mp3", "audio/mpeg")]),
        ],
      },
      {
        id: "m2aaaaaaaaaa",
        title: "Week two",
        dripDays: 7,
        lessons: [lesson("l5aaaaaaaaaa", "Week two talk", [file("two.mp3", "audio/mpeg")])],
      },
    ],
  };
}

const ids = (list: { id: string }[]) => list.map((x) => x.id);

async function main(): Promise<void> {
  redis.clear();
  process.env.STRIPE_SECRET_KEY = "sk_test_course_audio_only_a_stand_in";
  process.env.R2_ACCOUNT_ID = "a".repeat(32);
  process.env.R2_ACCESS_KEY_ID = "TESTACCESSKEY0001";
  process.env.R2_SECRET_ACCESS_KEY = "s".repeat(40);
  process.env.R2_BUCKET = "course-audio-test";

  part("Which file is a lesson's audio");
  const course = sampleCourse();
  is("the first .mp3 or .m4a, after any other file", lessonAudio(course.modules[0].lessons[0])?.name, "welcome.mp3");
  is("a .wav is not one every podcast app plays", lessonAudio(course.modules[0].lessons[1]), null);
  is("an .m4a is", lessonAudio(course.modules[0].lessons[2])?.contentType, "audio/mp4");

  part("Only what the student may open today");
  const joined = { start: NOW - DAY, owner: false, passed: new Set<string>() };
  is("a new student: open lessons up to the quiz they have not passed", ids(audioLessons(course, joined, NOW)), ["l1aaaaaaaaaa", "l3aaaaaaaaaa"]);
  is("passed: the rest of the open module", ids(audioLessons(course, { ...joined, passed: new Set(["l3aaaaaaaaaa"]) }, NOW)), ["l1aaaaaaaaaa", "l3aaaaaaaaaa", "l4aaaaaaaaaa"]);
  is("a week on: the next module too", ids(audioLessons(course, { start: NOW - 8 * DAY, owner: false, passed: new Set(["l3aaaaaaaaaa"]) }, NOW)), ["l1aaaaaaaaaa", "l3aaaaaaaaaa", "l4aaaaaaaaaa", "l5aaaaaaaaaa"]);
  is("a cohort that has not begun: nothing yet", audioLessons(sampleCourse(NOW + DAY), joined, NOW), []);
  is("the creator: everything", ids(audioLessons(course, { start: NOW, owner: true, passed: new Set() }, NOW)), ["l1aaaaaaaaaa", "l3aaaaaaaaaa", "l4aaaaaaaaaa", "l5aaaaaaaaaa"]);
  const episodes = audioEpisodes(audioLessons(course, { start: NOW, owner: true, passed: new Set() }, NOW), (id) => `https://x/@school/course/p/${id}`);
  is("each episode is its lesson, by its title and its file", [episodes[0].id, episodes[0].title, episodes[0].contentType, episodes[0].bytes], ["l1aaaaaaaaaa", "Welcome", "audio/mpeg", 1_000]);
  is("in lesson order, oldest first, as an app sorts by date", episodes.every((e, i) => i === 0 || e.at > episodes[i - 1].at), true);
  is("a lesson with text links to it; one without says nothing", [episodes[0].notes, episodes[1].notes], ["https://x/@school/course/p/l1aaaaaaaaaa", ""]);

  part("The creator's switch");
  await claimHandle(OWNER, "school", "River School", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestAudio00001", true);
  await setSubscription(OWNER, { customerId: "cus_Audio000001", subscriptionId: "sub_Audio000001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Bread Basics", "", "49", null);
  if (!made.ok) throw new Error("no product");
  const productId = made.product.id;
  let store = (await storeForEmail(OWNER))!;
  await saveCourse(course, store);
  await setProductCourse(OWNER, productId, { id: COURSE_ID, lessons: 5 });
  is("off until the creator turns it on", await courseAudioOn(COURSE_ID), false);
  await setCourseAudio(COURSE_ID, true, store);
  is("on", await courseAudioOn(COURSE_ID), true);
  await setCourseAudio(COURSE_ID, false, store);
  is("and off again", await courseAudioOn(COURSE_ID), false);
  await redis.pipeline([["SET", `nl:course:${COURSE_ID}:audio`, "yes"]]);
  is("anything but its own mark reads as off", await courseAudioOn(COURSE_ID), false);
  is("not a course id: off", await courseAudioOn("nope"), false);

  part("The feed");
  store = (await storeForEmail(OWNER))!;
  await recordEnrollment(store, STUDENT, productId, NOW - DAY);
  const token = (await feedToken(store, productId, STUDENT))!;
  const strangerToken = (await feedToken(store, productId, "nobody@example.com"))!;
  const ask = (t: string) => feed(new Request(`https://marktmorgen.com/api/store/course/audio/feed/${t}.xml`) as never, { params: Promise.resolve({ token: `${t}.xml` }) });
  const listen = (t: string, id: string) => play(new Request(`https://marktmorgen.com/api/store/course/audio/play/${t}/${id}.mp3`) as never, { params: Promise.resolve({ token: t, lesson: `${id}.mp3` }) });
  await setCourseAudio(COURSE_ID, false, store);
  is("switched off: not found", (await ask(token)).status, 404);
  await setCourseAudio(COURSE_ID, true, store);
  const folder = await storeFolder(OWNER);
  const before = await requestsIn(folder, windowId((await storeForEmail(OWNER))!)!);
  const first = await ask(token);
  const xml = await first.text();
  is("a student's feed is answered", [first.status, first.headers.get("content-type")], [200, "application/rss+xml; charset=utf-8"]);
  is("kept out of directories", xml.includes("<itunes:block>Yes</itunes:block>"), true);
  is("their open lessons, through the play door", [xml.includes("/api/store/course/audio/play/"), xml.includes("l1aaaaaaaaaa.mp3"), xml.includes("l3aaaaaaaaaa.m4a"), xml.includes("l4aaaaaaaaaa"), xml.includes("l5aaaaaaaaaa")], [true, true, true, false, false]);
  const after = await requestsIn(folder, windowId((await storeForEmail(OWNER))!)!);
  is("the build took its requests from the store's month", after - before, COURSE_AUDIO_READ_UNITS);
  await markPassed(COURSE_ID, emailKey(STUDENT), "l3aaaaaaaaaa", store);
  is("a quiz passed opens what it held", (await (await ask(token)).text()).includes("l4aaaaaaaaaa"), true);
  is("a stranger's feed lists nothing", /<item>/.test(await (await ask(strangerToken)).text()), false);
  is("a forged token is not found", (await ask("0".repeat(48))).status, 404);

  part("Playing a lesson");
  const ok = await listen(token, "l1aaaaaaaaaa");
  is("an open lesson: a short-lived signed address", [ok.status, (ok.headers.get("location") ?? "").startsWith("https://"), ok.headers.get("cache-control")], [302, true, "private, no-store"]);
  is("a lesson still waiting on its module: refused", (await listen(token, "l5aaaaaaaaaa")).status, 404);
  is("a lesson with no audio: not found", (await listen(token, "l2aaaaaaaaaa")).status, 404);
  is("a stranger: refused", (await listen(strangerToken, "l1aaaaaaaaaa")).status, 403);

  part("When access ends");
  await setBlocked(store, COURSE_ID, STUDENT, true);
  is("a student taken off the course: the feed empties", /<item>/.test(await (await ask(token)).text()), false);
  is("and each lesson is refused at once", (await listen(token, "l1aaaaaaaaaa")).status, 403);
  await setBlocked(store, COURSE_ID, STUDENT, false);
  await setCourseAudio(COURSE_ID, false, store);
  is("the creator turns it off: the play door closes too", (await listen(token, "l1aaaaaaaaaa")).status, 404);

  done();
}

void main();
