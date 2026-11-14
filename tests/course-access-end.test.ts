/**
 * 24 [E7] part 1: a course's access may end on a date the creator chooses.
 *
 * Fairness, the rule this file holds (after Claude 2's and Claude 6's reviews of afe23ece on #3445): the date reaches
 * only a buyer who was shown it before paying. The course's own sales page and course page say it and send it with
 * the buy form; the checkout stamps the one shown on the Stripe session; the learner's gate holds an end only for a
 * stamped purchase, as the later of the stamp and the course's date now. Every other way in has no end
 * (tests/course-access-end-stamp.test.ts holds those paths, the checkout and the drip emails). Once set, the date can
 * be moved later (more time for everybody it reached) or taken off, never earlier; a membership never takes one.
 *
 * The learner's gate (lib/learn.ts courseAccess) closes the course once the end has passed, server side, and says
 * when it ended; a course record or a reply that cannot be read is said as such, never as ended and never as open.
 */
import { addProduct, claimHandle, ensureStatsId, setPastBuyers, setProductCourse, setStripeAccount, storeForEmail } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readProduct } from "@/lib/catalog";
import { grantImported } from "@/lib/imported-purchases";
import { courseAccess, mintPass, passCookieName, recordEnrollment } from "@/lib/learn";
import { type Course, accessEndAhead, accessEndState, editCourse, emptyCourse, parseCourse, stampedAccessEnd } from "@/lib/course";
import { accessEndFact, accessEndStamp, accessEndWhen, readShownAccessEnd, shownAccessEnd } from "@/lib/course-access-end";
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
  const edit = (base: Course, at: unknown, now: number, membership = false) => editCourse(base, { op: "access-end", at, now, membership });
  const set = edit(course, NOW + 30 * DAY, NOW);
  is("a date in the future is set", set.ok ? set.course.accessEndsAt : set.reason, NOW + 30 * DAY);
  const set1 = set.ok ? set.course : course;
  is("a date in the past is refused", (() => { const r = edit(course, NOW - DAY, NOW); return r.ok ? "set" : r.reason; })(), "access_end");
  is("now itself is refused", (() => { const r = edit(course, NOW, NOW); return r.ok ? "set" : r.reason; })(), "access_end");
  is("more than ten years ahead is refused", (() => { const r = edit(course, NOW + 3_700 * DAY, NOW); return r.ok ? "set" : r.reason; })(), "access_end");
  is("not a whole number of seconds is refused", ["x", 1.5, Number.NaN, {}].map((at) => { const r = edit(course, at, NOW); return r.ok ? "set" : r.reason; }), ["access_end", "access_end", "access_end", "access_end"]);
  const later = edit(set1, NOW + 60 * DAY, NOW + DAY);
  is("moved later: the new date", later.ok ? later.course.accessEndsAt : later.reason, NOW + 60 * DAY);
  const earlier = edit(set1, NOW + 10 * DAY, NOW + DAY);
  is("moved earlier: refused", earlier.ok ? "moved" : earlier.reason, "access_end_earlier");
  const afterPassed = edit(set1, NOW + 90 * DAY, NOW + 40 * DAY);
  is("a date already passed, set later again: the new date", afterPassed.ok ? afterPassed.course.accessEndsAt : afterPassed.reason, NOW + 90 * DAY);
  const off = edit(set1, null, NOW + DAY);
  is("taken off: the field is gone", off.ok ? "accessEndsAt" in off.course : off.reason, false);
  const again = off.ok ? edit(off.course, NOW + 10 * DAY, NOW + 2 * DAY) : null;
  is("set again after taking it off, earlier than before: allowed, buyers stamped before keep the later of the two", again?.ok ? again.course.accessEndsAt : null, NOW + 10 * DAY);
  is("a membership: refused", (() => { const r = edit(course, NOW + DAY, NOW, true); return r.ok ? "set" : r.reason; })(), "access_end_membership");
  is("a membership may still take an old date off", edit(set1, null, NOW, true).ok, true);

  part("kept with the course record");
  const kept = parseCourse(JSON.stringify(set1));
  is("read back whole", kept?.accessEndsAt, NOW + 30 * DAY);
  is("a course saved before it existed has no end", parseCourse(JSON.stringify(course))?.accessEndsAt, undefined);
  const bad = parseCourse(JSON.stringify({ ...course, accessEndsAt: "soon" }));
  is("a date that does not read is no end", bad?.accessEndsAt, undefined);
  is("nor a negative or fractional one", [parseCourse(JSON.stringify({ ...course, accessEndsAt: -5 }))?.accessEndsAt, parseCourse(JSON.stringify({ ...course, accessEndsAt: 1.5 }))?.accessEndsAt], [undefined, undefined]);
  is("a record written by the first head of #3445, with when it was set: the date is kept, the rest ignored", parseCourse(JSON.stringify({ ...course, accessEndsAt: NOW + DAY, accessEndsSetAt: NOW }))?.accessEndsAt, NOW + DAY);

  part("the stamp, the end it gives, and when it has passed");
  const c = set1 as Course;
  is("said to a visitor while ahead", accessEndAhead(c, NOW + DAY), NOW + 30 * DAY);
  is("not said once passed", accessEndAhead(c, NOW + 30 * DAY), null);
  is("the form sends the end said, or none", [shownAccessEnd(c, NOW + DAY), shownAccessEnd(c, NOW + 30 * DAY), shownAccessEnd(course, NOW)], [String(NOW + 30 * DAY), "none", "none"]);
  is("what a form sent: nothing, none, an end, or bad", [readShownAccessEnd(null), readShownAccessEnd("none"), readShownAccessEnd(String(NOW)), readShownAccessEnd("1e9"), readShownAccessEnd("012"), readShownAccessEnd("")], [undefined, null, NOW, "bad", "bad", "bad"]);
  is("the stamp read off a session: only the exact shape", [accessEndStamp({ access_end: String(NOW) }), accessEndStamp({ access_end: "soon" }), accessEndStamp({ access_end: "-1" }), accessEndStamp({}), accessEndStamp(null)], [NOW, null, null, null, null]);
  is("a stamped end is the later of the stamp and the date now", [stampedAccessEnd(c, NOW + DAY, null), stampedAccessEnd(c, NOW + 90 * DAY, null)], [NOW + 30 * DAY, NOW + 90 * DAY]);
  is("the date taken off: no end", stampedAccessEnd(course, NOW + DAY, null), null);
  is("before the end: open", accessEndState(c, NOW + 30 * DAY, NOW + 29 * DAY, null), "open");
  is("at the end: ended", accessEndState(c, NOW + 30 * DAY, NOW + 30 * DAY, null), "ended");
  is("no stamp: open, even long after", accessEndState(c, null, NOW + 900 * DAY, null), "open");
  is("a clock that is not a time is unknown, never ended", accessEndState(c, NOW + 30 * DAY, Number.NaN, null), "unknown");
  is("a stamp that is not a time is unknown, never ended", accessEndState(c, 1.5, NOW, null), "unknown");

  part("said in the buyer's words, in UTC, with the time");
  is("English", accessEndWhen(NOW + 30 * DAY, "en"), "February 14, 2027, 8:00 AM UTC");
  for (const language of LANGUAGE_CODES) {
    const w = coursesWords(language);
    is(`${language}: every new sentence places the date`, [w.accessEndsOn.includes("{when}"), w.accessEndedBody.includes("{when}"), w.accessEndsFact.includes("{when}"),
      w.accessEndedTitle.length > 0, w.accessUncheckedTitle.length > 0, w.accessUncheckedBody.length > 0], [true, true, true, true, true, true]);
  }

  part("said on the sales page before anyone pays");
  is("the line for a date still ahead, in the buyer's words", accessEndFact(set1, "en", NOW + DAY), "Access to the course ends on February 14, 2027, 8:00 AM UTC.");
  is("no line once the date has passed: whoever buys then is stamped with none", accessEndFact(set1, "en", NOW + 30 * DAY), null);
  is("no line for a course with no date, or a record that could not be read", [accessEndFact(course, "en", NOW), accessEndFact(null, "en", NOW)], [null, null]);
  is("every language places the moment", LANGUAGE_CODES.map((language) => accessEndFact(set1, language, NOW + DAY)?.includes("2027") ?? false), LANGUAGE_CODES.map(() => true));
  const salesPage = readFileSync("app/[handle]/p/[product]/page.tsx", "utf8");
  is("the sales page reads the course exactly to sell it, hands the line to both facts lines, and the end and an unread record to the buy box",
    [/readCourseForSale\(product\.course\.id\)/.test(salesPage), /accessEndFact\(course, store\.language\)/.test(salesPage), (salesPage.match(/accessEndLine=\{accessEndLine\}/g) ?? []).length, /unread=\{courseUnread\} accessEnd=\{courseFacts\?\.shownEnd \?\? null\}/.test(salesPage)],
    [true, true, 2, true]);
  const studio = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  is("the studio draws the field beside the start date, told whether the course is a membership or offers a payment plan", /<CourseAccessEnd productId=\{product\.id\} endsAt=\{course\.accessEndsAt \?\? null\} passed=\{[^}]+\} membership=\{product\.recurring !== null\} planOffered=\{activePlan\(product\) !== null\} \/>/.test(studio), true);

  part("the learner's gate, with the real ledger");
  redis.clear();
  // Synthetic Stripe: the stamped learner's purchase, or an outage.
  const realFetch = globalThis.fetch;
  const secret = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_course_access_end_synthetic";
  let sessions: Record<string, unknown>[] = [];
  let stripeDown = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "api.stripe.com" && url.pathname.endsWith("/checkout/sessions")) {
      if (stripeDown) return Response.json({ error: { message: "synthetic outage" } }, { status: 500 });
      return Response.json({ object: "list", has_more: false, data: sessions });
    }
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
  const passFor = async (email: string) => {
    const token = await mintPass(store, email, "all");
    return { get: (name: string) => (name === passCookieName(store) ? { value: token } : undefined) };
  };
  await grantImported(store.statsId!, "c".repeat(24), [{ email: "learner@example.test", productId: product.id, items: null }], JOINED, store.sid);
  const imported = await passFor("learner@example.test");
  const base: Course = { ...emptyCourse("b".repeat(32)) };
  const shown = renderToStaticMarkup(createElement(ProductFacts, { store, product, accessEndLine: "Access to the course ends on February 14, 2027, 8:00 AM UTC." }));
  is("the facts line under the title says it", shown.includes("Access to the course ends on February 14, 2027, 8:00 AM UTC."), true);
  is("and says nothing when the page has no line", renderToStaticMarkup(createElement(ProductFacts, { store, product })).includes("Access to the course ends"), false);
  const ended = { ...base, accessEndsAt: JOINED + DAY };
  const stampedSession = {
    id: "cs_test_stamped", object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment", created: JOINED,
    metadata: { store: store.handle, product: product.id, access_end: String(JOINED + DAY) }, payment_intent: null, subscription: null,
  };
  const realNow = Date.now;
  try {
    Date.now = () => (JOINED + 2 * DAY) * 1000;
    sessions = [stampedSession];
    const stamped = await passFor("stamped@example.test");
    const a = await courseAccess(store, product, stamped, ended);
    is("stamped at checkout, the date passed: expired, with when it ended", [a.state, a.state === "expired" ? a.endedAt : null], ["expired", JOINED + DAY]);
    is("the same, the date since moved later: open, until then", await courseAccess(store, product, await passFor("stamped2@example.test"), { ...ended, accessEndsAt: JOINED + 10 * DAY }).then((x) => [x.state, x.state === "open" ? x.endsAt : null]), ["open", JOINED + 10 * DAY]);
    is("the same, the date taken off: open, no end", await courseAccess(store, product, await passFor("stamped3@example.test"), base).then((x) => [x.state, x.state === "open" ? x.endsAt : null]), ["open", null]);
    sessions = [];
    is("brought over from another platform, never shown a date: open", (await courseAccess(store, product, imported, ended)).state, "open");
    const session = await openSession(owner);
    is("the store's owner always sees it", (await courseAccess(store, product, { get: (n: string) => (n === SESSION_COOKIE ? { value: session } : undefined) }, ended)).state, "open");
    // Without the record handed in, the gate reads it itself, so no caller can skip the date.
    sessions = [stampedSession];
    await redis.pipeline([["SET", `nl:course:${base.id}`, JSON.stringify(ended)]]);
    const read = await courseAccess(store, product, await passFor("stamped4@example.test"));
    is("the record read by the gate itself: expired", [read.state, read.state === "expired" ? read.endedAt : null], ["expired", JOINED + DAY]);
    const pipeline = redis.pipeline.bind(redis);
    redis.pipeline = (async (commands: (string | number)[][]) =>
      commands.length === 1 && commands[0][0] === "GET" && commands[0][1] === `nl:course:${base.id}` ? [] : pipeline(commands)) as typeof redis.pipeline;
    try {
      is("the record cannot be read for a stamped learner: unchecked, never open and never ended", (await courseAccess(store, product, await passFor("stamped5@example.test"))).state, "unchecked");
      is("nor needed for a learner with no end: open", (await courseAccess(store, product, imported)).state, "open");
    } finally {
      redis.pipeline = pipeline;
    }
    // Stripe down, the sale written down here: its stamp is only on the Stripe session.
    stripeDown = true;
    await recordEnrollment(store, "written@example.test", product.id, JOINED);
    is("Stripe cannot be asked, the course has a date: unchecked", (await courseAccess(store, product, await passFor("written@example.test"), ended)).state, "unchecked");
    is("Stripe cannot be asked, the course has no date: open", (await courseAccess(store, product, await passFor("written@example.test"), base)).state, "open");
    stripeDown = false;
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
