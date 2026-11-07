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
 *   - the feed: never kept by a cache, so a refund or the switch turned off
 *     counts at once; off is not found, a student's lists their open lessons,
 *     a stranger's, a refunded, ended or blocked student's is empty, a forged
 *     token or one naming another store is not found;
 *   - paid in steps, each before what it reads: one request for the listing,
 *     the switch and the course's size; the course's own requests by its
 *     measured size; the access requests by the store's courses and their
 *     measured listings. A feed switched off, a product that is not a course
 *     or a token naming another store costs one; a made-up lesson stops after
 *     the course is read, before the student's access is asked;
 *   - the play door hands a signed address only for a lesson in that feed,
 *     at most COURSE_AUDIO_PLAYS_A_DAY times a day for one feed;
 *   - characters XML 1.0 does not allow never reach the feed.
 */
import { addProduct, claimHandle, ensureStatsId, setProductCourse, setStripeAccount, setSubscription, storeForEmail, storeFolder } from "@/lib/store";
import { type Course, type Lesson, saveCourse } from "@/lib/course";
import { emailKey, recordEnrollment, setBlocked } from "@/lib/learn";
import { markPassed } from "@/lib/quiz";
import { feedToken, tokenKey } from "@/lib/podcast-access";
import { idsOfKind, listingSizes } from "@/lib/catalog";
import type { ProductFile } from "@/lib/product-file";
import { feedXml } from "@/lib/podcast-rules";
import {
  COURSE_AUDIO_PLAYS_A_DAY,
  COURSE_AUDIO_URL_SECONDS,
  accessWork,
  audioEpisodes,
  audioLessons,
  audioUnits,
  lessonAudio,
  outlineWork,
} from "@/lib/course-audio-rules";
import { courseAudioOn, setCourseAudio } from "@/lib/course-audio";
import { GET as feed } from "@/app/api/store/course/audio/feed/[token]/route";
import { GET as play } from "@/app/api/store/course/audio/play/[token]/[lesson]/route";
import { requestsIn } from "@/lib/traffic";
import { windowId } from "@/lib/allowance-window";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const OWNER = "teacher@example.com";
const STUDENT = "sam@example.com";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const COURSE_ID = "c".repeat(32);
const CLUB_ID = "d".repeat(32);
const FOLDER = "f".repeat(32);

/** Checkouts by the address they were paid from, as the creator's Stripe account lists them. */
const sessions: Record<string, Record<string, unknown>[]> = {};
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const data = path === "/checkout/sessions" ? sessions[url.searchParams.get("customer_details[email]") ?? ""] ?? [] : [];
  return new Response(JSON.stringify({ object: "list", data, has_more: false }));
}) as typeof fetch;
const charge = (amount: number, back: number) => ({ object: "charge", amount, amount_refunded: back, refunded: back >= amount });
const checkout = (id: string, product: string, over: Record<string, unknown> = {}) => ({
  id,
  object: "checkout.session",
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW - DAY,
  customer: "cus_TestStudent01",
  metadata: { store: "school", product },
  payment_intent: { id: `pi_${id.slice(8)}`, latest_charge: charge(4900, 0) },
  ...over,
});

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

function sampleCourse(startsAt: number | null = null, id = COURSE_ID): Course {
  return {
    id,
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
  is("no transcript is claimed for a lesson's audio", (episodes[0] as { transcript?: unknown }).transcript ?? null, null);

  part("Characters XML 1.0 does not allow never reach the feed");
  const odd = feedXml({ title: "A￾B￿C\u0001D\uD800E", summary: "", author: "S", page: "https://x/p", image: null, episodes: [{ ...episodes[0], title: "T￿\uDC00\u0008x" }], audio: () => "https://x/a.mp3" });
  is("U+FFFE, U+FFFF, C0 controls and lone surrogates are dropped", [odd.includes("<title>ABCDE</title>"), odd.includes("<title>Tx</title>"), /[￾￿\u0001\u0008]|[\uD800-\uDFFF]/.test(odd)], [true, true, false]);
  const kept = feedXml({ title: "Tab\tline\nemoji \u{1F3B5} é", summary: "", author: "S", page: "https://x/p", image: null, episodes: [], audio: () => "" });
  is("tabs, new lines, accents and characters past U+FFFF stay", kept.includes("<title>Tab\tline\nemoji \u{1F3B5} é</title>"), true);

  part("The creator's switch");
  await claimHandle(OWNER, "school", "River School", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestAudio00001", true);
  await setSubscription(OWNER, { customerId: "cus_Audio000001", subscriptionId: "sub_Audio000001", active: true, period: paidPeriod() });
  const made = await addProduct(OWNER, "Bread Basics", "", "49", null);
  const clubMade = await addProduct(OWNER, "Bread Club", "", "15", { interval: "month" } as Parameters<typeof addProduct>[4]);
  const plainMade = await addProduct(OWNER, "Starter Guide", "", "9", null);
  if (!made.ok || !clubMade.ok || !plainMade.ok) throw new Error("no product");
  const productId = made.product.id;
  const clubId = clubMade.product.id;
  let store = (await storeForEmail(OWNER))!;
  await saveCourse(course, store);
  await saveCourse(sampleCourse(null, CLUB_ID), store);
  await setProductCourse(OWNER, productId, { id: COURSE_ID, lessons: 5 });
  await setProductCourse(OWNER, clubId, { id: CLUB_ID, lessons: 5 });
  is("off until the creator turns it on", await courseAudioOn(COURSE_ID), false);
  await setCourseAudio(COURSE_ID, true, store);
  is("on", await courseAudioOn(COURSE_ID), true);
  await setCourseAudio(COURSE_ID, false, store);
  is("and off again", await courseAudioOn(COURSE_ID), false);
  await redis.pipeline([["SET", `nl:course:${COURSE_ID}:audio`, "yes"]]);
  is("anything but its own mark reads as off", await courseAudioOn(COURSE_ID), false);
  is("not a course id: off", await courseAudioOn("nope"), false);

  part("The feed, and what each step takes");
  store = (await storeForEmail(OWNER))!;
  await recordEnrollment(store, STUDENT, productId, NOW - DAY);
  const token = (await feedToken(store, productId, STUDENT))!;
  const strangerToken = (await feedToken(store, productId, "nobody@example.com"))!;
  const ask = (t: string) => feed(new Request(`https://marktmorgen.com/api/store/course/audio/feed/${t}.xml`) as never, { params: Promise.resolve({ token: `${t}.xml` }) });
  const listen = (t: string, id: string) => play(new Request(`https://marktmorgen.com/api/store/course/audio/play/${t}/${id}.mp3`) as never, { params: Promise.resolve({ token: t, lesson: `${id}.mp3` }) });
  const folder = await storeFolder(OWNER);
  const used = async () => requestsIn(folder, windowId((await storeForEmail(OWNER))!)!);
  const taken = async (run: () => Promise<Response>) => {
    const before = await used();
    const response = await run();
    return { response, units: (await used()) - before };
  };
  // What the later steps are paid at, from what the code measures before it reads.
  const courses = idsOfKind(store, "course");
  const [courseBytes] = (await redis.pipeline([["STRLEN", `nl:course:${COURSE_ID}`]])) as number[];
  const listingBytes = ((await listingSizes(store, courses)) ?? []).reduce((a, b) => a + b, 0);
  const outlineUnits = audioUnits(outlineWork(courseBytes, courses.length));
  const accessUnits = audioUnits(accessWork(courses.length, listingBytes));
  is("two courses in the store, measured before reading", [courses.length, courseBytes > 0, outlineUnits >= 1, accessUnits >= 1], [2, true, true, true]);

  await setCourseAudio(COURSE_ID, false, store);
  const off = await taken(() => ask(token));
  is("switched off: not found, for one request", [off.response.status, off.units], [404, 1]);
  await setCourseAudio(COURSE_ID, true, store);
  const first = await taken(() => ask(token));
  const xml = await first.response.text();
  is("a student's feed is answered", [first.response.status, first.response.headers.get("content-type")], [200, "application/rss+xml; charset=utf-8"]);
  is("never kept by a cache, so a refund or the switch counts at once", first.response.headers.get("cache-control"), "private, no-store");
  is("kept out of directories", xml.includes("<itunes:block>Yes</itunes:block>"), true);
  is("their open lessons, through the play door", [xml.includes("/api/store/course/audio/play/"), xml.includes("l1aaaaaaaaaa.mp3"), xml.includes("l3aaaaaaaaaa.m4a"), xml.includes("l4aaaaaaaaaa"), xml.includes("l5aaaaaaaaaa")], [true, true, true, false, false]);
  is("the build took one request, the course's and the access's", first.units, 1 + outlineUnits + accessUnits);
  await markPassed(COURSE_ID, emailKey(STUDENT), "l3aaaaaaaaaa", store);
  is("a quiz passed opens what it held", (await (await ask(token)).text()).includes("l4aaaaaaaaaa"), true);
  is("a stranger's feed lists nothing", /<item>/.test(await (await ask(strangerToken)).text()), false);
  const forged = await taken(() => ask("0".repeat(48)));
  is("a forged token is not found, and takes nothing", [forged.response.status, forged.units], [404, 0]);
  const plainToken = (await feedToken(store, plainMade.product.id, STUDENT))!;
  const plain = await taken(() => ask(plainToken));
  is("a product that is not a course: gone, for one request", [plain.response.status, plain.units], [410, 1]);

  part("A token that names another store");
  await claimHandle("other@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("other@example.com");
  const other = (await storeForEmail("other@example.com"))!;
  const otherMade = await addProduct("other@example.com", "Harbor Course", "", "29", null);
  if (!otherMade.ok) throw new Error("no product");
  const crossed = "e".repeat(48);
  await redis.pipeline([["SET", tokenKey(crossed), JSON.stringify({ s: other.statsId, h: "school", p: productId, e: STUDENT })]]);
  const crossedAsk = await taken(() => ask(crossed));
  is("another store's id under this store's name: gone, and nothing taken", [crossedAsk.response.status, crossedAsk.units], [410, 0]);
  const foreign = "9".repeat(48);
  await redis.pipeline([["SET", tokenKey(foreign), JSON.stringify({ s: store.statsId, h: "school", p: otherMade.product.id, e: STUDENT })]]);
  const foreignAsk = await taken(() => ask(foreign));
  is("another store's product: gone, for one request", [foreignAsk.response.status, foreignAsk.units], [410, 1]);

  part("Playing a lesson");
  const ok = await listen(token, "l1aaaaaaaaaa");
  const location = ok.headers.get("location") ?? "";
  is("an open lesson: a signed address", [ok.status, location.startsWith("https://"), ok.headers.get("cache-control")], [302, true, "private, no-store"]);
  is("that works for COURSE_AUDIO_URL_SECONDS", new URL(location).searchParams.get("X-Amz-Expires"), String(COURSE_AUDIO_URL_SECONDS));
  is("a lesson still waiting on its module: refused", (await listen(token, "l5aaaaaaaaaa")).status, 404);
  is("a lesson with no audio: not found", (await listen(token, "l2aaaaaaaaaa")).status, 404);
  const madeUp = await taken(() => listen(token, "zzzzzzzzzzzz"));
  is("a made-up lesson: not found once the course is read, before access is asked", [madeUp.response.status, madeUp.units], [404, 1 + outlineUnits]);
  const malformed = await taken(() => listen(token, "..%2Fx"));
  is("a lesson id that cannot be one: not found, and nothing taken", [malformed.response.status, malformed.units], [404, 0]);
  is("a stranger: refused", (await listen(strangerToken, "l1aaaaaaaaaa")).status, 403);
  const busy = (await feedToken(store, productId, "pat@example.com"))!;
  await recordEnrollment(store, "pat@example.com", productId, NOW - DAY);
  const statuses: number[] = [];
  for (let i = 0; i <= COURSE_AUDIO_PLAYS_A_DAY; i += 1) statuses.push((await listen(busy, "l1aaaaaaaaaa")).status);
  const past = await taken(() => listen(busy, "l1aaaaaaaaaa"));
  is("one feed plays only so often in a day", [statuses.filter((s) => s === 302).length, statuses[statuses.length - 1], past.response.status, past.units], [COURSE_AUDIO_PLAYS_A_DAY, 429, 429, 0]);

  part("When access ends");
  sessions["rae@example.com"] = [checkout("cs_test_rae000000001", productId, { payment_intent: { id: "pi_rae01", latest_charge: charge(4900, 4900) } })];
  await recordEnrollment(store, "rae@example.com", productId, NOW - DAY);
  const rae = (await feedToken(store, productId, "rae@example.com"))!;
  is("refunded in full: the feed is empty and says so", [/<item>/.test(await (await ask(rae)).text())], [false]);
  is("and each lesson is refused", (await listen(rae, "l1aaaaaaaaaa")).status, 403);
  await setCourseAudio(CLUB_ID, true, store);
  sessions["mia@example.com"] = [checkout("cs_test_mia000000001", clubId, { mode: "subscription", payment_intent: null, subscription: { id: "sub_mia01", status: "active" } })];
  sessions["max@example.com"] = [checkout("cs_test_max000000001", clubId, { mode: "subscription", payment_intent: null, subscription: { id: "sub_max01", status: "canceled" } })];
  const mia = (await feedToken(store, clubId, "mia@example.com"))!;
  const max = (await feedToken(store, clubId, "max@example.com"))!;
  is("a running membership: its lessons", /<item>/.test(await (await ask(mia)).text()), true);
  is("a membership that ended: the feed is empty", /<item>/.test(await (await ask(max)).text()), false);
  is("and each lesson is refused", (await listen(max, "l1aaaaaaaaaa")).status, 403);
  await setBlocked(store, COURSE_ID, STUDENT, true);
  is("a student taken off the course: the feed empties", /<item>/.test(await (await ask(token)).text()), false);
  is("and each lesson is refused at once", (await listen(token, "l1aaaaaaaaaa")).status, 403);
  await setBlocked(store, COURSE_ID, STUDENT, false);
  await setCourseAudio(COURSE_ID, false, store);
  is("the creator turns it off: the play door closes too", (await listen(token, "l1aaaaaaaaaa")).status, 404);

  part("What a student's day costs, in the store's public requests");
  const perBuild = 1 + outlineUnits + accessUnits;
  console.log("      scenario (this test's store: 2 courses)                  | per request | a day");
  console.log(`      feed switched off, app asking every hour (8 built, 16 at 429) | 1           | ${8 * 1}`);
  console.log(`      feed on, app asking every hour (8 built, 16 at 429)           | ${perBuild}           | ${8 * perBuild}`);
  console.log(`      feed on and ${COURSE_AUDIO_PLAYS_A_DAY} lessons fetched (the most in a day)            | ${perBuild}           | ${8 * perBuild + COURSE_AUDIO_PLAYS_A_DAY * perBuild}`);

  done();
}

void main();
