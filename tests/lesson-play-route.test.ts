/**
 * A press of Play on a lesson video, end to end with the real page and the real
 * route (app/api/store/course/play/route.ts; pre-review of the video hours
 * ceiling, 9 November 2026): the page draws a button and holds nothing; the
 * press checks the lesson is open to the one pressing, paces them and the
 * store's anonymous previews, takes the store's public requests, holds, and
 * sends the browser back with a ticket the page frames once; what kept a press
 * from playing is said in true words. Synthetic store, stand-in Redis and video
 * service; nothing is sent anywhere.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { renderToReadableStream } from "react-dom/server";
import LessonPage from "@/app/[handle]/course/[product]/[lesson]/page";
import { POST as playRoute } from "@/app/api/store/course/play/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { emailKey, storeKey } from "@/lib/learn";
import { saveCourse, type Course } from "@/lib/course";
import { coursesWords } from "@/lib/buyer-words/courses";
import { addProduct, claimHandle, ensureStatsId, ensureStoreId, setProductCourse, setSubscription, storeFolder, storeForEmail, type Store } from "@/lib/store";
import { windowId } from "@/lib/allowance-window";
import { streamPath } from "@/lib/stream-rules";
import { PAID_VIDEO_HOURS } from "@/lib/video-admission-rules";
import { PLAYS_PER_LEARNER_WINDOW, PREVIEW_PLAYS_PER_STORE_WINDOW } from "@/lib/lesson-play-rules";
import { HOLD_UNIT_SECONDS, PREVIEW_KEEP_BPS } from "@/lib/watch-rules";
import { answering } from "./security/next-headers";
import { store as redis } from "./redis-stub";
import { paidPeriod } from "./billing-period-fixture";
import { done, is, part } from "./check";
import { ROOM } from "./data-room";

process.env.BUNNY_STREAM_LIBRARY_ID = "12345";
process.env.BUNNY_STREAM_API_KEY = "bunny-api-key-only-a-stand-in";
process.env.BUNNY_STREAM_TOKEN_KEY = "bunny-token-key-only-a-stand-in";
globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;

const OWNER = "kiln@example.com";
const STUDENT = "student@example.com";
const STUDENT_TWO = "second@example.com";
const BASE = "https://marktmorgen.com";
const PREVIEW_VIDEO = "0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
const PAID_VIDEO = "1b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";

async function html(run: () => Promise<unknown>): Promise<string> {
  try {
    const node = await run();
    const stream = await renderToReadableStream(node as React.ReactElement, { onError: () => {} });
    await stream.allReady;
    return await new Response(stream).text();
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return `redirect ${digest.split(";")[2]}`;
    if (digest) return `thrown ${digest}`;
    throw error;
  }
}
/** React writes an apostrophe in text as &#x27;. */
const inHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "kilnworks", "Kiln Works", "");
  await ensureStatsId(OWNER);
  await ensureStoreId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_kiln00001", subscriptionId: "sub_kiln00001", active: true, tier: "pro", period: paidPeriod() });
  const folder = await storeFolder(OWNER);
  const made = await addProduct(OWNER, "Glazing masterclass", "", "149", null);
  if (!made.ok) throw new Error("no product");
  const id = made.product.id;
  const video = (lesson: string, guid: string) => ({ pathname: streamPath(folder, lesson, guid), name: "a.mp4", bytes: 1, contentType: "video/mp4", addedAt: "2026-11-01T00:00:00.000Z" });
  const previewVideo = video("lesson000001", PREVIEW_VIDEO);
  const paidVideo = video("lesson000002", PAID_VIDEO);
  const course: Course = {
    id: "d".repeat(32),
    certificate: false,
    startsAt: null,
    modules: [
      {
        id: "module000001",
        title: "Clay bodies",
        dripDays: 0,
        lessons: [
          { id: "lesson000001", title: "Free first look", preview: true, video: previewVideo, files: [], link: null, hasBody: false, quiz: null },
          { id: "lesson000002", title: "Paid lesson", preview: false, video: paidVideo, files: [], link: null, hasBody: false, quiz: null },
        ],
      },
    ],
  } as unknown as Course;
  await saveCourse(course, ROOM, true);
  const attached = await setProductCourse(OWNER, id, { id: course.id, lessons: 2 });
  if (!attached.ok) throw new Error(`no course: ${attached.reason}`);
  const store = (await storeForEmail(OWNER)) as Store;
  const record = (guid: string, pathname: string) => ["SET", `nl:stream:v:${guid}`, JSON.stringify({ id: guid, path: pathname, name: "a.mp4", type: "video/mp4", bytes: 1, state: "ready", at: Date.now(), seconds: 3600, width: 1920, height: 1080, settled: true })];
  await redis.pipeline([record(PREVIEW_VIDEO, previewVideo.pathname), record(PAID_VIDEO, paidVideo.pathname)]);
  const started = Math.floor(Date.now() / 1000) - 86_400;
  await redis.pipeline([["SET", `nl:learn:paid:${storeKey(store)}:${emailKey(STUDENT)}`, JSON.stringify({ p: { [id]: started }, x: [], r: [] }), "EX", 600]]);
  await redis.pipeline([["SET", `nl:learn:paid:${storeKey(store)}:${emailKey(STUDENT_TWO)}`, JSON.stringify({ p: { [id]: started }, x: [], r: [] }), "EX", 600]]);
  const sessions = { stranger: "", student: await openSession(STUDENT), second: await openSession(STUDENT_TWO) };
  type Who = keyof typeof sessions;
  const w = coursesWords(store.language);
  const HOLDS = `nl:watch:hold:${folder}`;
  const held = async () => (await redis.pipeline([["ZCARD", HOLDS]]))[0] as number;
  const LIMIT = PAID_VIDEO_HOURS.pro * 3600;

  const headers = (who: Who, ip: string, extra: Record<string, string> = {}) => ({
    host: "marktmorgen.com",
    ...(sessions[who] ? { cookie: `${SESSION_COOKIE}=${sessions[who]}` } : {}),
    "x-forwarded-for": ip,
    ...extra,
  });
  const page = (who: Who, lesson = "lesson000001", query: Record<string, string> = {}) => {
    answering(new NextRequest(`${BASE}/@kilnworks/course/${id}/${lesson}`, { headers: headers(who, "198.51.100.1") }));
    return html(() => LessonPage({ params: Promise.resolve({ handle: "@kilnworks", product: id, lesson }), searchParams: Promise.resolve(query) }));
  };
  // Presses that reach their pace: a stranger's of the preview from this site, and any of the student's.
  let anonymous = 0;
  let learner = 0;
  const press = async (who: Who, lesson = "lesson000001", ip = "198.51.100.1", origin = BASE) => {
    if (origin === BASE && (who === "student" || (who === "stranger" && lesson === "lesson000001"))) {
      if (who === "student") learner += 1;
      else anonymous += 1;
    }
    const request = new NextRequest(`${BASE}/api/store/course/play`, {
      method: "POST",
      headers: headers(who, ip, { origin, "content-type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ handle: "kilnworks", product: id, lesson }),
    });
    answering(request);
    const reply = await playRoute(request);
    const location = reply.headers.get("location") ?? "";
    const play = /[?&]play=([^&#]+)/.exec(location)?.[1] ?? "";
    return { status: reply.status, location, play };
  };
  const PLAYER = "https://player.mediadelivery.net/embed/12345/";
  // Read with a pattern, not includes/indexOf, so CodeQL does not take a test's frame check for URL sanitizing.
  const PLAYER_AT = /https:\/\/player\.mediadelivery\.net\/embed\/12345\//;
  const framesPlayer = (html: string) => PLAYER_AT.test(html);

  part("The page draws a Play lesson button and holds nothing");
  {
    const drawn = await page("stranger");
    is("a free preview's page has the button", drawn.includes(`>${w.playLesson}</button>`) && drawn.includes('action="/api/store/course/play"') && drawn.includes('method="post"'), true);
    is("and no player frame", framesPlayer(drawn), false);
    for (let i = 0; i < 40; i += 1) await page("stranger");
    is("41 anonymous draws hold nothing", await held(), 0);
  }

  part("A press holds, and the page it sends back to frames the player once");
  {
    const first = await press("stranger");
    is("the press answers with the lesson and a ticket, at the video", [first.status, first.location.startsWith(`${BASE}/@kilnworks/course/${id}/lesson000001?play=`), first.location.endsWith("#video"), /^[0-9a-f]{24}$/.test(first.play)], [303, true, true, true]);
    is("its playback is held", (await held()) > 0, true);
    const framed = await page("stranger", "lesson000001", { play: first.play });
    is("the page framed with the ticket shows the player", framesPlayer(framed) && framed.search(PLAYER_AT) < framed.indexOf(`>${w.playLesson}</button>`), true);
    // Owner's decision 16: a press plays a block of half an hour at most; the page says so, with Play lesson under it.
    const said = (w as unknown as { playBlockRest?: (minutes: number) => string }).playBlockRest;
    is("under the player, the block's words and a Play lesson button to go on", typeof said === "function" && framed.includes(inHtml(said(30))) && framed.includes(`>${w.playLesson}</button>`), true);
    const again = await page("stranger", "lesson000001", { play: first.play });
    is("the ticket is taken once: drawn again, the button, with no error said", again.includes(`>${w.playLesson}</button>`) && !framesPlayer(again) && !again.includes(inHtml(w.videoNotLoaded)), true);
    const other = await press("stranger");
    const wrongLesson = await page("student", "lesson000002", { play: other.play });
    is("a ticket frames nothing on another lesson", framesPlayer(wrongLesson), false);
  }

  part("Who may press: as the page decides");
  {
    const before = await held();
    const shut = await press("stranger", "lesson000002");
    is("a stranger's press of a lesson that is not a preview goes to the course, holding nothing", [shut.status, shut.location, await held()], [303, `${BASE}/@kilnworks/course/${id}`, before]);
    const cross = await press("stranger", "lesson000001", "198.51.100.1", "https://elsewhere.example");
    is("a press from another site is refused", cross.status, 403);
  }

  part("Anonymous previews hold at most half of what is left; students still play");
  {
    // Eight hours left of the Studio's 32 measured: the half kept for students is reached before the store's hourly
    // pace of anonymous presses (thirty presses of a half-hour block hold 15 hours at most, under 16, the owner's
    // decision 16).
    const LEFT = 8 * 3600;
    await redis.pipeline([["DEL", HOLDS], ["SET", `nl:watch:sec:${folder}:${windowId(store)}`, String(LIMIT - LEFT)]]);
    let kept = "";
    let plays = 0;
    for (let i = 0; i < PREVIEW_PLAYS_PER_STORE_WINDOW; i += 1) {
      const got = await press("stranger", "lesson000001", `203.0.113.${i + 1}`);
      if (/^[0-9a-f]{24}$/.test(got.play)) plays += 1;
      else { kept = got.play; break; }
    }
    console.log(`anonymous presses that played before the rest was kept: ${plays}`);
    is("anonymous presses stop at the share kept for students", kept, "kept");
    is("they hold no more than half of what is left", (await held()) * HOLD_UNIT_SECONDS <= (LEFT * (10_000 - PREVIEW_KEEP_BPS)) / 10_000, true);
    const said = await page("stranger", "lesson000001", { play: kept });
    is("the page says the time left is kept for students, beside the button", said.includes(inHtml(w.playKeptRest)) && said.includes(`>${w.playLesson}</button>`), true);
    const student = await press("student", "lesson000002");
    is("a student's press still plays", /^[0-9a-f]{24}$/.test(student.play), true);
  }

  part("A signed-in student's press again is the same token, nothing held again");
  {
    const one = await press("student", "lesson000002");
    const heldAfterOne = await held();
    const two = await press("student", "lesson000002");
    const src = async (play: string) => /src="([^"]+)"/.exec((await page("student", "lesson000002", { play })).replace(/&amp;/g, "&"))?.[1] ?? "";
    const [a, b] = [await src(one.play), await src(two.play)];
    is("the same player, and no more held", [a.startsWith(PLAYER), a === b, await held()], [true, true, heldAfterOne]);
  }

  part("Paces: the store's anonymous previews");
  {
    // Every anonymous press of the preview so far was counted before its hold, from whatever connection.
    const outcomes: string[] = [];
    while (anonymous < PREVIEW_PLAYS_PER_STORE_WINDOW + 1) outcomes.push((await press("stranger", "lesson000001", `192.0.2.${anonymous}`)).play);
    is(`anonymous press number ${PREVIEW_PLAYS_PER_STORE_WINDOW + 1} in the hour is told previews are busy`, outcomes.at(-1), "previews");
    const said = await page("stranger", "lesson000001", { play: "previews" });
    is("in true words", said.includes(inHtml(w.playPreviewsRest)), true);
  }

  part("Busy: other viewers hold the time; the page says when unused time comes back");
  {
    const now = Date.now();
    const units = LIMIT / HOLD_UNIT_SECONDS;
    await redis.pipeline([["DEL", HOLDS], ["ZADD", HOLDS, ...Array.from({ length: units }, (_, i) => [now + 30 * 60 * 1000, `other:${i}`]).flat()]]);
    // Half an hour of token left, a settling interval, a reading's and the job's margin: back within about 3 hours.
    // Rule 23 (review of #3402, M1): was the first student, who now has a live token in this store from the parts
    // above, and so is given a token ending with it (one live hold a person a store); a student with none is refused.
    const busy = await press("second", "lesson000001", "198.51.100.77");
    is("a student's press while others hold every hour: busy, about three hours", busy.play, "busy-3");
    const said = await page("second", "lesson000001", { play: busy.play });
    is("the page says other viewers hold the time and it comes back within about 3 hours", said.includes(inHtml(w.playBusyRest(3))) && !said.includes(inHtml(w.videoNotLoaded)), true);
  }

  part("Paused: what was measured leaves nothing, and the page says so with no button");
  {
    const current = (await storeForEmail(OWNER)) as Store;
    await redis.pipeline([["DEL", HOLDS], ["SET", `nl:watch:sec:${folder}:${windowId(current)}`, String(LIMIT)]]);
    const drawn = await page("stranger");
    is("paused words, no button", drawn.includes(inHtml(w.pausedStrong)) && !drawn.includes(`>${w.playLesson}</button>`), true);
    // VR 2: this store pays for its plan; it is never told it has none.
    const paid = (w as unknown as { pausedPaidRest?: (store: string) => string }).pausedPaidRest;
    is("a paid store's pause says its plan's hours are used, never that it has no paid plan", typeof paid === "function" && drawn.includes(inHtml(paid(current.name))) && !drawn.includes(inHtml(w.pausedRest(current.name))), true);
  }

  part("MEDIO (review of #3402, security M1): one live hold a person a store; pressing another lesson moves it, never adds one");
  {
    // Before: the same token came back only for the same lesson, so a student pressing different lessons held a new
    // block each time, and could hold the store's whole video time without watching (another student then got busy).
    const src = async (who: Who, lesson: string, play: string) => /src="([^"]+)"/.exec((await page(who, lesson, { play })).replace(/&amp;/g, "&"))?.[1] ?? "";
    const expires = (url: string) => new URL(url).searchParams.get("expires");
    await redis.pipeline([["DEL", `nl:watch:sec:${folder}:${windowId((await storeForEmail(OWNER)) as Store)}`]]);
    const live = await press("student", "lesson000002");
    const heldBefore = await held();
    const moved = await press("student", "lesson000001");
    is("the student's press of another lesson plays", /^[0-9a-f]{24}$/.test(moved.play), true);
    is("and holds nothing more", await held(), heldBefore);
    const [a, b] = [await src("student", "lesson000002", live.play), await src("student", "lesson000001", moved.play)];
    is("its token is the other video's, ending when the live one does", [b.startsWith(PLAYER), a !== b, expires(a) === expires(b)], [true, true, true]);

    // Presses at once, alternating lessons: still one block, so a person can never sum blocks by racing them.
    await redis.pipeline([["DEL", HOLDS]]);
    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => press("second", i % 2 ? "lesson000001" : "lesson000002", `198.51.100.${200 + i}`)));
    is("eight presses at once by one student all play", many.every((p) => /^[0-9a-f]{24}$/.test(p.play)), true);
    is("and hold one half-hour block, six units, not eight", await held(), 6);
  }

  part("LEVE (review of #3402, security L3): a connection past its pace reads nothing of the store");
  {
    const route = readFileSync(join(process.cwd(), "app/api/store/course/play/route.ts"), "utf8");
    is("its refusal comes before the store and the listing are read", route.indexOf('if (paced !== "within")') > 0 && route.indexOf('if (paced !== "within")') < route.indexOf("storeForHandle("), true);
    const registry = readFileSync(join(process.cwd(), "tests/store-data-registry.ts"), "utf8");
    const line = registry.split("\n").find((l) => l.includes('"nl:learn:playing:@lib/lesson-play.ts"')) ?? "";
    is("NIT: the kept token's registry line says half an hour at most, not four hours", [line.includes("four hours"), /half an hour/.test(line)], [false, true]);
  }

  part("A student's presses are paced too");
  {
    await redis.pipeline([["DEL", `nl:watch:sec:${folder}:${windowId((await storeForEmail(OWNER)) as Store)}`]]);
    const outcomes: string[] = [];
    while (learner < PLAYS_PER_LEARNER_WINDOW + 1) outcomes.push((await press("student", "lesson000002", `198.51.100.${100 + learner}`)).play);
    is(`the student's press number ${PLAYS_PER_LEARNER_WINDOW + 1} in the hour is told to try within an hour`, outcomes.at(-1), "many");
    is("every press before it played", outcomes.slice(0, -1).every((play) => /^[0-9a-f]{24}$/.test(play)), true);
    const said = await page("student", "lesson000002", { play: "many" });
    is("in true words", said.includes(inHtml(w.playManyRest)), true);
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
