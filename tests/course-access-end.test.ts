/**
 * 24 [E7] part 1: a course's access may end on a date the creator chooses.
 *
 * Fairness, the rule this file holds: the date applies only to people who join while it is set and shown (from when
 * it was set until the date itself; once it has passed the store no longer says it, so nobody who joins then has it). Somebody
 * who joined before it was set was promised the course with no end, and keeps it. Once set, the date can be moved
 * later (more time for everybody it applies to) or taken off, never earlier: an earlier end would shorten what was
 * shown to people who already joined. To end sooner, the creator takes the date off and sets it again, and then it
 * applies only to people who join from that moment.
 *
 * The learner's gate (lib/learn.ts courseAccess) closes the course once the date has passed, server side, and says
 * when it ended; a course record or a reply that cannot be read is said as such, never as ended and never as open.
 */
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readProduct } from "@/lib/catalog";
import { grantImported } from "@/lib/imported-purchases";
import { courseAccess, mintPass, passCookieName } from "@/lib/learn";
import { type Course, accessEndAhead, accessEndFor, accessEndState, editCourse, emptyCourse, parseCourse } from "@/lib/course";
import { accessEndFact, accessEndWhen } from "@/lib/course-access-end";
import { ProductFacts } from "@/components/store-product";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { coursesWords } from "@/lib/buyer-words/courses";
import { LANGUAGE_CODES } from "@/lib/store-language";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = 1_800_000_000;
const DAY = 86_400;

async function main(): Promise<void> {
  part("the creator sets, moves and takes off the date");
  const course = emptyCourse("a".repeat(32));
  const set = editCourse(course, { op: "access-end", at: NOW + 30 * DAY, now: NOW });
  is("a date in the future is set, with when it was set", set.ok ? [set.course.accessEndsAt, set.course.accessEndsSetAt] : set.reason, [NOW + 30 * DAY, NOW]);
  const set1 = set.ok ? set.course : course;
  is("a date in the past is refused", (() => { const r = editCourse(course, { op: "access-end", at: NOW - DAY, now: NOW }); return r.ok ? "set" : r.reason; })(), "access_end");
  is("now itself is refused", (() => { const r = editCourse(course, { op: "access-end", at: NOW, now: NOW }); return r.ok ? "set" : r.reason; })(), "access_end");
  is("more than ten years ahead is refused", (() => { const r = editCourse(course, { op: "access-end", at: NOW + 3_700 * DAY, now: NOW }); return r.ok ? "set" : r.reason; })(), "access_end");
  is("not a whole number of seconds is refused", ["x", 1.5, Number.NaN, {}].map((at) => { const r = editCourse(course, { op: "access-end", at, now: NOW }); return r.ok ? "set" : r.reason; }), ["access_end", "access_end", "access_end", "access_end"]);
  const later = editCourse(set1, { op: "access-end", at: NOW + 60 * DAY, now: NOW + DAY });
  is("moved later: the new date, and it still applies from when it was first set", later.ok ? [later.course.accessEndsAt, later.course.accessEndsSetAt] : later.reason, [NOW + 60 * DAY, NOW]);
  const earlier = editCourse(set1, { op: "access-end", at: NOW + 10 * DAY, now: NOW + DAY });
  is("moved earlier: refused, it would shorten what people who joined were shown", earlier.ok ? "moved" : earlier.reason, "access_end_earlier");
  const afterPassed = editCourse(set1, { op: "access-end", at: NOW + 90 * DAY, now: NOW + 40 * DAY });
  is("a date already passed, set later again: it applies from the new moment, never to who joined after it passed", afterPassed.ok ? [afterPassed.course.accessEndsAt, afterPassed.course.accessEndsSetAt] : afterPassed.reason, [NOW + 90 * DAY, NOW + 40 * DAY]);
  const off = editCourse(set1, { op: "access-end", at: null, now: NOW + DAY });
  is("taken off: neither field is left", off.ok ? ["accessEndsAt" in off.course, "accessEndsSetAt" in off.course] : off.reason, [false, false]);
  const again = off.ok ? editCourse(off.course, { op: "access-end", at: NOW + 10 * DAY, now: NOW + 2 * DAY }) : null;
  is("set again after taking it off: it applies from the new moment", again?.ok ? [again.course.accessEndsAt, again.course.accessEndsSetAt] : null, [NOW + 10 * DAY, NOW + 2 * DAY]);

  part("kept with the course record");
  const kept = parseCourse(JSON.stringify(set1));
  is("read back whole", kept ? [kept.accessEndsAt, kept.accessEndsSetAt] : null, [NOW + 30 * DAY, NOW]);
  is("a course saved before it existed has no end", parseCourse(JSON.stringify(course))?.accessEndsAt, undefined);
  const half = parseCourse(JSON.stringify({ ...course, accessEndsAt: NOW + DAY }));
  is("a date without when it was set cannot say whom it applies to: no end, the side that never takes away", [half?.accessEndsAt, half?.accessEndsSetAt], [undefined, undefined]);
  const bad = parseCourse(JSON.stringify({ ...course, accessEndsAt: "soon", accessEndsSetAt: NOW }));
  is("a date that does not read is no end either", bad?.accessEndsAt, undefined);

  part("whom it applies to, and when it has passed");
  const c = set1 as Course;
  is("joined before it was set: no end", accessEndFor(c, NOW - DAY), null);
  is("joined while it was set: that end", accessEndFor(c, NOW + DAY), NOW + 30 * DAY);
  is("joined after the date passed, when the store no longer said it: no end", accessEndFor(c, NOW + 31 * DAY), null);
  is("no date: no end", accessEndFor(course, NOW), null);
  is("said to a visitor while ahead", accessEndAhead(c, NOW + DAY), NOW + 30 * DAY);
  is("not said once passed", accessEndAhead(c, NOW + 30 * DAY), null);
  is("before the end: open", accessEndState(c, NOW + DAY, NOW + 29 * DAY), "open");
  is("at the end: ended", accessEndState(c, NOW + DAY, NOW + 30 * DAY), "ended");
  is("joined before it was set: open, even long after", accessEndState(c, NOW - DAY, NOW + 900 * DAY), "open");
  is("a clock that is not a time is unknown, never ended", accessEndState(c, NOW + DAY, Number.NaN), "unknown");

  part("said in the buyer's words, in UTC, with the time");
  is("English", accessEndWhen(NOW + 30 * DAY, "en"), "February 14, 2027, 8:00 AM UTC");
  for (const language of LANGUAGE_CODES) {
    const w = coursesWords(language);
    is(`${language}: every new sentence places the date`, [w.accessEndsOn.includes("{when}"), w.accessEndedBody.includes("{when}"), w.accessEndsFact.includes("{when}"),
      w.accessEndedTitle.length > 0, w.accessUncheckedTitle.length > 0, w.accessUncheckedBody.length > 0], [true, true, true, true, true, true]);
  }

  part("said on the sales page before anyone pays");
  is("the line for a date still ahead, in the buyer's words", accessEndFact(set1, "en", NOW + DAY), "Access to the course ends on February 14, 2027, 8:00 AM UTC.");
  is("no line once the date has passed: whoever buys then has no end", accessEndFact(set1, "en", NOW + 30 * DAY), null);
  is("no line for a course with no date, or a record that could not be read", [accessEndFact(course, "en", NOW), accessEndFact(null, "en", NOW)], [null, null]);
  is("every language places the moment", LANGUAGE_CODES.map((language) => accessEndFact(set1, language, NOW + DAY)?.includes("2027") ?? false), LANGUAGE_CODES.map(() => true));
  const salesPage = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is("the sales page reads it from the course record and hands it to both facts lines", [/accessEndFact\(course, store\.language\)/.test(salesPage), (salesPage.match(/accessEndLine=\{accessEndLine\}/g) ?? []).length], [true, 2]);
  const studio = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  is("the studio draws the field beside the start date", /<CourseAccessEnd productId=\{product\.id\} endsAt=\{course\.accessEndsAt \?\? null\} passed=\{[^}]+\} \/>/.test(studio), true);

  part("the learner's gate, with the real ledger");
  redis.clear();
  // Stripe answers with no sale of its own (synthetic): the learner's right is the imported purchase.
  const realFetch = globalThis.fetch;
  const secret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_course_access_end_synthetic";
  globalThis.fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "api.stripe.com" && url.pathname.endsWith("/checkout/sessions")) return Response.json({ object: "list", has_more: false, data: [] });
    throw new Error(`no network in this test: ${url.pathname}`);
  };
  const owner = "access-end-owner@example.test";
  is("(store)", (await claimHandle(owner, "access-end-school", "School", "")).ok, true);
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestAccessEnd1", true);
  await setPastBuyers(owner);
  const made = await addProduct(owner, "Course with an end", "Lessons", "49", null);
  if (!made.ok) throw new Error("product");
  await setProductCourse(owner, made.product.id, { id: "b".repeat(32), lessons: 1 });
  const store = (await storeForEmail(owner))!;
  const product = (await readProduct(store, made.product.id))!;
  const JOINED = 1_793_293_200;
  await grantImported(store.statsId!, "c".repeat(24), [{ email: "learner@example.test", productId: product.id, items: null }], JOINED, store.sid);
  const token = await mintPass(store, "learner@example.test", "all");
  const cookies = { get: (name: string) => (name === passCookieName(store) ? { value: token } : undefined) };
  const base: Course = { ...emptyCourse("b".repeat(32)) };
  const shown = renderToStaticMarkup(createElement(ProductFacts, { store, product, accessEndLine: "Access to the course ends on February 14, 2027, 8:00 AM UTC." }));
  is("the facts line under the title says it", shown.includes("Access to the course ends on February 14, 2027, 8:00 AM UTC."), true);
  is("and says nothing when the page has no line", renderToStaticMarkup(createElement(ProductFacts, { store, product })).includes("Access to the course ends"), false);
  const ended = { ...base, accessEndsAt: JOINED + DAY, accessEndsSetAt: JOINED - DAY };
  const realNow = Date.now;
  try {
    Date.now = () => (JOINED + 2 * DAY) * 1000;
    const a = await courseAccess(store, product, cookies, ended);
    is("joined while it was set, the date passed: expired, with when it ended", [a.state, a.state === "expired" ? a.endedAt : null], ["expired", JOINED + DAY]);
    is("the same, before the date: open", (await courseAccess(store, product, cookies, { ...ended, accessEndsAt: JOINED + 10 * DAY })).state, "open");
    is("joined before it was set: open", (await courseAccess(store, product, cookies, { ...ended, accessEndsSetAt: JOINED + 1 })).state, "open");
    is("no date: open, as before", (await courseAccess(store, product, cookies, base)).state, "open");
    const session = await openSession(owner);
    is("the store's owner always sees it", (await courseAccess(store, product, { get: (n: string) => (n === SESSION_COOKIE ? { value: session } : undefined) }, ended)).state, "open");
    // Without the record handed in, the gate reads it itself, so no caller can skip the date.
    await redis.pipeline([["SET", `nl:course:${base.id}`, JSON.stringify(ended)]]);
    const read = await courseAccess(store, product, cookies);
    is("the record read by the gate itself: expired", [read.state, read.state === "expired" ? read.endedAt : null], ["expired", JOINED + DAY]);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:course:${base.id}` ? [] : pipeline(commands)) as typeof redis.pipeline;
    try {
      is("the record cannot be read: unchecked, never open and never ended", (await courseAccess(store, product, cookies)).state, "unchecked");
    } finally {
      redis.pipeline = pipeline;
    }
    is("nobody signed in: closed, as before", (await courseAccess(store, product, { get: () => undefined }, ended)).state, "closed");
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
    if (secret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = secret;
  }
  done();
}

void main();
