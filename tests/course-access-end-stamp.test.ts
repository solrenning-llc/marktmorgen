/**
 * 24 [E7] part 1, after Claude 2's and Claude 6's reviews of afe23ece (#3445): the end applies only to a purchase
 * whose buyer was shown it.
 *
 * The only forms that say the date before paying are the course's own sales page and its course page. They send the
 * end they showed (`access_end`: seconds, or "none"); the checkout reads the course again, refuses when the end is no
 * longer the one shown, and stamps the matching end on the Stripe session (`metadata[access_end]`). The learner's gate
 * then applies an end only to a stamped purchase:
 *
 * - every other way in (the storefront card, the cart, a bundle, a box ticked at checkout, a gift, a pre-order, a
 *   group place, an import, a community level) carries no stamp, and has no end (A1, A2);
 * - with several purchases, the most generous one counts: any purchase without an end, or with one still ahead,
 *   keeps the course open (A3);
 * - a membership course never takes an end (H1);
 * - a drip email is not sent for a module that opens after the student's end (M3).
 *
 * Synthetic Stripe and an in-memory Redis; the real ledger, gate, checkout route, studio route and drip job run.
 */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { POST as checkoutRoute } from "@/app/api/store/checkout/route";
import { POST as courseRoute } from "@/app/api/store/course/route";
import {
  addProduct,
  claimHandle,
  ensureStatsId,
  setPastBuyers,
  setProductCourse,
  setProductExtras,
  setStripeAccount,
  setSubscription,
  storeForEmail,
  type Store,
} from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { readProduct } from "@/lib/catalog";
import type { Listing } from "@/lib/store";
import * as learn from "@/lib/learn";
import { courseAccess, emailKey, mintPass, storeKey, passCookieName, recordEnrollment, registerDrip, sendDripEmails, touchStudent } from "@/lib/learn";
import * as accessEnd from "@/lib/course-access-end";
import { grantImported } from "@/lib/imported-purchases";
import { type Course, type KeptEnd, MAX_KEPT_ENDS, editCourse, emptyCourse, keepEnd, parseCourse, readCourseExact, saveCourse } from "@/lib/course";
import { paidPeriod } from "./billing-period-fixture";
import { withConsent } from "./digital-consent-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;
const SET_AT = 1_800_000_000;
const END = SET_AT + 10 * DAY;
const LATER = SET_AT + 20 * DAY;

type Session = Record<string, unknown>;
let listed: Session[] = [];
let stripeDown = false;
const opened: URLSearchParams[] = [];
const realFetch = globalThis.fetch;
process.env.STRIPE_SECRET_KEY = "sk_test_course_access_end_stamp";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
    opened.push(new URLSearchParams(String(init.body)));
    return Response.json({ id: "cs_test_accessEndStamp0001", url: "https://checkout.stripe.com/c/pay/cs_test_accessEndStamp0001" });
  }
  if (url.hostname === "api.stripe.com" && stripeDown) return Response.json({ error: { message: "synthetic outage" } }, { status: 500 });
  if (url.hostname === "api.stripe.com" && url.pathname === "/v1/checkout/sessions") return Response.json({ object: "list", has_more: false, data: listed });
  if (url.hostname === "api.stripe.com") return Response.json({ object: "list", has_more: false, data: [] });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

function session(store: Store, meta: Record<string, string>, created: number): Session {
  return {
    id: `cs_test_${created}_${Object.keys(meta).join("")}`,
    object: "checkout.session",
    status: "complete",
    payment_status: "paid",
    mode: "payment",
    created,
    metadata: { store: store.handle, ...meta },
    customer_details: { email: "learner@example.test" },
    payment_intent: null,
    subscription: null,
  };
}

async function shop(handle: string, recurring = false): Promise<{ store: Store; product: Listing; owner: string; courseId: string }> {
  const owner = `${handle}@example.test`;
  if (!(await claimHandle(owner, handle, "Course end shop", "")).ok) throw new Error("store");
  await ensureStatsId(owner);
  await setStripeAccount(owner, "acct_TestStamp1", true);
  await setSubscription(owner, { customerId: `cus_${handle}01`, subscriptionId: `sub_${handle}01`, active: true, tier: "creator", period: paidPeriod() });
  const made = await addProduct(owner, "Course with an end", "Lessons", "49", recurring ? { interval: "month", trialDays: 0, payments: 0 } : null);
  if (!made.ok) throw new Error("product");
  const courseId = crypto.randomUUID().replace(/-/g, "");
  await setProductCourse(owner, made.product.id, { id: courseId, lessons: 1 });
  const store = (await storeForEmail(owner))!;
  return { store, product: (await readProduct(store, made.product.id))!, owner, courseId };
}

/** The course record as #3445's first head wrote it: the end and when it was set. */
function withEnd(courseId: string, end = END): Course {
  return { ...emptyCourse(courseId), accessEndsAt: end, accessEndsSetAt: SET_AT } as Course;
}

async function gate(store: Store, product: Listing, course: Course, email: string, now: number) {
  const token = await mintPass(store, email, "all");
  const cookies = { get: (name: string) => (name === passCookieName(store) ? { value: token } : undefined) };
  const realNow = Date.now;
  Date.now = () => now * 1000;
  try {
    return await courseAccess(store, product, cookies, course);
  } finally {
    Date.now = realNow;
  }
}

async function main(): Promise<void> {
  redis.clear();

  part("A1: a purchase that was never shown the date has no end");
  const a = await shop("stampa1");
  const course = withEnd(a.courseId);
  listed = [session(a.store, { product: a.product.id }, SET_AT + DAY)];
  is("bought on the storefront card or the cart (no stamp), after the date was set: open", (await gate(a.store, a.product, course, "a1-card@example.test", LATER)).state, "open");
  listed = [session(a.store, { product: "bundle01", bundle: a.product.id }, SET_AT + DAY)];
  is("the course came in a bundle: open", (await gate(a.store, a.product, course, "a1-bundle@example.test", LATER)).state, "open");
  listed = [session(a.store, { product: a.product.id, access_end: String(END) }, SET_AT + DAY)];
  const stamped = await gate(a.store, a.product, course, "a1-stamped@example.test", LATER);
  is("bought on its own page, which said the date (stamped): expired, with when it ended", [stamped.state, stamped.state === "expired" ? stamped.endedAt : null], ["expired", END]);
  is("the same, before the date: open, and the page says when it ends", await gate(a.store, a.product, course, "a1-stamped2@example.test", END - DAY).then((x) => [x.state, x.state === "open" ? x.endsAt : null]), ["open", END]);
  listed = [session(a.store, { product: a.product.id, access_end: "soon" }, SET_AT + DAY)];
  is("a stamp that does not read is never an end (rule 24): open", (await gate(a.store, a.product, course, "a1-bad@example.test", LATER)).state, "open");

  part("the ten-minute cache of what Stripe said");
  // Kept with no expiry here: the gate's clock is moved to after the date, and the in-memory Redis expires by it.
  const cacheKey = (email: string) => `nl:learn:paid:${storeKey(a.store)}:${emailKey(email)}`;
  listed = [session(a.store, { product: a.product.id, access_end: String(END) }, SET_AT + DAY)];
  await redis.pipeline([["SET", cacheKey("cache-bad@example.test"), JSON.stringify({ p: { [a.product.id]: SET_AT + DAY }, x: [], r: [], e: { [a.product.id]: "soon" } })]]);
  is("a cached end that does not read is asked of Stripe again, never read as no end", (await gate(a.store, a.product, course, "cache-bad@example.test", LATER)).state, "expired");
  await redis.pipeline([["SET", cacheKey("cache-old@example.test"), JSON.stringify({ p: { [a.product.id]: SET_AT + DAY }, x: [], r: [] })]]);
  is("an answer cached before stamps existed: no stamp, so no end", (await gate(a.store, a.product, course, "cache-old@example.test", LATER)).state, "open");
  await gate(a.store, a.product, course, "cache-new@example.test", LATER);
  const kept = JSON.parse(String((await redis.pipeline([["GET", cacheKey("cache-new@example.test")]]))[0])) as { e?: Record<string, number> };
  is("what is cached now keeps the stamped end", kept.e?.[a.product.id], END);

  part("A2: a pre-order or a group place, handed over after the date was set, has no end");
  listed = [];
  await recordEnrollment(a.store, "a2-preorder@example.test", a.product.id, SET_AT + DAY);
  is("written down on the ledger at hand-over, no Stripe purchase of its own: open", (await gate(a.store, a.product, course, "a2-preorder@example.test", LATER)).state, "open");

  part("A3: buying again after the end reopens the course");
  listed = [
    session(a.store, { product: a.product.id, access_end: String(END) }, SET_AT + DAY),
    session(a.store, { product: a.product.id }, END + DAY),
  ];
  is("Stripe: a stamped purchase that ended, then one with no end: open", (await gate(a.store, a.product, course, "a3-again@example.test", LATER)).state, "open");
  listed = [
    session(a.store, { product: a.product.id, access_end: String(END) }, SET_AT + DAY),
    session(a.store, { product: a.product.id, access_end: String(LATER + 30 * DAY) }, END + DAY),
  ];
  const moved = withEnd(a.courseId, LATER + 30 * DAY);
  is("Stripe: bought again under a later date: the later end counts", await gate(a.store, a.product, moved, "a3-later@example.test", LATER).then((x) => [x.state, x.state === "open" ? x.endsAt : null]), ["open", LATER + 30 * DAY]);
  listed = [session(a.store, { product: a.product.id }, END + DAY)];
  await recordEnrollment(a.store, "a3-ledger@example.test", a.product.id, SET_AT + DAY);
  is("ledger: written down first, then bought again with no end: open", (await gate(a.store, a.product, course, "a3-ledger@example.test", LATER)).state, "open");

  part("the creator moves the date later or takes it off: everyone stamped follows");
  listed = [session(a.store, { product: a.product.id, access_end: String(END) }, SET_AT + DAY)];
  is("moved later after it passed: open again until the new date", await gate(a.store, a.product, withEnd(a.courseId, LATER + DAY), "move-later@example.test", LATER).then((x) => [x.state, x.state === "open" ? x.endsAt : null]), ["open", LATER + DAY]);
  is("taken off: open, no end", await gate(a.store, a.product, emptyCourse(a.courseId), "move-off@example.test", LATER).then((x) => [x.state, x.state === "open" ? x.endsAt : null]), ["open", null]);

  part("M-R (Codex Cloud 1 on #3445): taking the date off and setting an earlier one never shortens an end already reached");
  {
    const r = await shop("stampmr");
    const T = (day: number) => SET_AT + day * DAY;
    const edit = (c: Course, at: number | null, now: number) => {
      const result = editCourse(c, { op: "access-end", at, now, membership: false } as never);
      if (!result.ok) throw new Error(`edit refused: ${result.reason}`);
      return result.course;
    };
    // Bought at day 1 under an end of day 10 (stamped), the date then moved later to day 50, which reached them.
    let c = edit(emptyCourse(r.courseId), T(10), T(0));
    listed = [session(r.store, { product: r.product.id, access_end: String(T(10)) }, T(1))];
    c = edit(c, T(50), T(2));
    is("after the date moved to day 50, at day 20 the stamped buyer is open until day 50", await gate(r.store, r.product, c, "mr-early@example.test", T(20)).then((x) => [x.state, x.state === "open" ? x.endsAt : null]), ["open", T(50)]);
    const direct = editCourse(c, { op: "access-end", at: T(5), now: T(2), membership: false } as never);
    is("a direct move from day 50 to day 5 is refused", direct.ok ? "set" : direct.reason, "access_end_earlier");
    // The studio's own path to end sooner for new buyers: take the date off, then set an earlier one.
    c = edit(c, null, T(3));
    c = edit(c, T(5), T(3));
    is("the earlier date is set for new buyers", c.accessEndsAt, T(5));
    const kept = await gate(r.store, r.product, c, "mr-early@example.test", T(20));
    is("at day 20 the same buyer is still open, until the day 50 they were given", [kept.state, kept.state === "open" ? kept.endsAt : null], ["open", T(50)]);
    // The pass is minted under the same clock, so its 90 days (PASS_SECONDS) still run at day 51.
    const realNow = Date.now;
    Date.now = () => T(51) * 1000;
    const after = await gate(r.store, r.product, c, "mr-early@example.test", T(51)).finally(() => {
      Date.now = realNow;
    });
    is("after day 50 their access ends, at day 50", [after.state, after.state === "expired" ? after.endedAt : null], ["expired", T(50)]);
    // A buyer stamped with day 5, after the earlier date was set, was never given day 50.
    listed = [session(r.store, { product: r.product.id, access_end: String(T(5)) }, T(4))];
    const late = await gate(r.store, r.product, c, "mr-late@example.test", T(20));
    is("a buyer who bought after the date came off and was set earlier keeps only the day 5 they were shown", [late.state, late.state === "expired" ? late.endedAt : null], ["expired", T(5)]);
    // The record keeps it across a save and a read.
    await saveCourse(c, r.store);
    const reread = await gate(r.store, r.product, (await readCourseExact(r.courseId))!, "mr-early@example.test", T(20));
    is("read back from Redis, the early buyer still has day 50", [reread.state, reread.state === "open" ? reread.endsAt : null], ["open", T(50)]);
    // Rule 24: a kept list in another shape is a check not made for a stamped buyer, never an end dropped.
    const garbled = parseCourse(JSON.stringify({ ...c, accessEndsKept: [{ at: "day 50", before: T(3) }] }))!;
    is("a kept list that does not read is \"unknown\"", garbled.accessEndsKept, "unknown");
    is("the stamped buyer is then unchecked, neither open nor ended", (await gate(r.store, r.product, garbled, "mr-early@example.test", T(20))).state, "unchecked");
    // The list stays bounded, and merging only ever gives a buyer more time.
    let many: KeptEnd[] = [];
    for (let i = 0; i < MAX_KEPT_ENDS + 5; i += 1) many = keepEnd(many, { at: T(100 - i), before: T(i + 1) });
    is("at most MAX_KEPT_ENDS kept ends", many.length, MAX_KEPT_ENDS);
    is("the oldest buyers keep the latest end they reached", many[0].at, T(100));
    is("a later, longer end drops those it covers", keepEnd(many, { at: T(200), before: T(500) }), [{ at: T(200), before: T(500) }]);
  }

  part("H1: a membership course never takes an end");
  const refusal = editCourse(emptyCourse(a.courseId), { op: "access-end", at: SET_AT + DAY, now: SET_AT, membership: true } as never);
  is("editCourse refuses an end on a membership", refusal.ok ? "set" : refusal.reason, "access_end_membership");
  const m = await shop("stamph1", true);
  await saveCourse(emptyCourse(m.courseId), m.store);
  const sessionCookie = await openSession(m.owner);
  const post = (body: unknown) =>
    courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${sessionCookie}` }, body: JSON.stringify(body) }));
  const routed = await post({ action: "access-end", id: m.product.id, at: Math.floor(Date.now() / 1000) + 30 * DAY });
  is("the studio route refuses it too", [routed.status, ((await routed.json()) as { error?: string }).error], [400, "access_end_membership"]);

  part("the studio route: the date as sent");
  const s = await shop("stamproute");
  await saveCourse(emptyCourse(s.courseId), s.store);
  const ownerCookie = await openSession(s.owner);
  const send = async (body: unknown) => {
    const response = await courseRoute(new NextRequest("https://marktmorgen.com/api/store/course", { method: "POST", headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${ownerCookie}` }, body: JSON.stringify(body) }));
    return [response.status, ((await response.json()) as { error?: string }).error ?? "ok"];
  };
  const ahead = Math.floor(Date.now() / 1000) + 30 * DAY;
  is("a string, a fraction, missing: refused", [await send({ action: "access-end", id: s.product.id, at: "soon" }), await send({ action: "access-end", id: s.product.id, at: 1.5 }), await send({ action: "access-end", id: s.product.id })], [[400, "access_end"], [400, "access_end"], [400, "access_end"]]);
  is("a whole number of seconds ahead: set", await send({ action: "access-end", id: s.product.id, at: ahead }), [200, "ok"]);
  is("earlier than the date set: refused", await send({ action: "access-end", id: s.product.id, at: ahead - DAY }), [400, "access_end_earlier"]);
  is("taken off: done", await send({ action: "access-end", id: s.product.id, at: null }), [200, "ok"]);

  part("M2: the checkout refuses an end that is not the one shown, and stamps the one that is");
  const c = await shop("stampcheckout");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const end = nowSeconds + 30 * DAY;
  await saveCourse(withEnd(c.courseId, end), c.store);
  const pay = async (fields: Record<string, string>) => {
    opened.length = 0;
    const form = withConsent(new URLSearchParams({ handle: c.store.handle, product: c.product.id, ...fields }));
    const response = await checkoutRoute(new NextRequest("https://marktmorgen.test/api/store/checkout", {
      method: "POST",
      headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }));
    return { location: response.headers.get("location") ?? "", opened: opened.length, stamp: opened[0]?.get("metadata[access_end]") ?? null };
  };
  const stale = await pay({ access_end: "none" });
  is("the page said no end, the course has one now: refused, no checkout opened", [stale.opened, /terms=changed/.test(stale.location)], [0, true]);
  const other = await pay({ access_end: String(end - DAY) });
  is("the page said another date: refused", [other.opened, /terms=changed/.test(other.location)], [0, true]);
  const same = await pay({ access_end: String(end) });
  is("the page said this date: the checkout opens, stamped with it", [same.opened, same.stamp], [1, String(end)]);
  const unsaid = await pay({});
  is("a form that said nothing (the storefront card): opens, with no stamp", [unsaid.opened, unsaid.stamp], [1, null]);
  is("a value that is not a date: refused as a bad request", (await pay({ access_end: "1e9" })).opened, 0);

  part("M3: no drip email for a module that opens after the student's end");
  const d = await shop("stampdrip");
  let dripCourse = emptyCourse(d.courseId);
  const step = (edit: Parameters<typeof editCourse>[1]) => {
    const r = editCourse(dripCourse, edit);
    if (!r.ok) throw new Error(`course fixture: ${r.reason}`);
    dripCourse = r.course;
  };
  step({ op: "module-add", title: "Week two" });
  const moduleId = dripCourse.modules[0].id;
  step({ op: "lesson-add", moduleId, title: "Lesson" });
  step({ op: "module-edit", moduleId, title: "Week two", dripDays: 14 });
  const dripEnded = { ...dripCourse, accessEndsAt: SET_AT + 10 * DAY, accessEndsSetAt: SET_AT } as Course;
  await saveCourse(dripEnded, d.store);
  await registerDrip(d.store, d.product, dripEnded);
  await touchStudent(d.courseId, "drip-ended@example.test", SET_AT + DAY, d.store, SET_AT + 10 * DAY);
  await touchStudent(d.courseId, "drip-open@example.test", SET_AT + DAY, d.store, null);
  const claimed: string[] = [];
  const pipeline = redis.pipeline.bind(redis);
  redis.pipeline = (async (commands: (string | number)[][]) => {
    for (const command of commands) if (command[0] === "SET" && String(command[1]).includes(":dripmail:")) claimed.push(String(command[1]));
    return pipeline(commands);
  }) as typeof redis.pipeline;
  try {
    await sendDripEmails(async () => d.store, async () => dripEnded, "https://marktmorgen.test", SET_AT + 15 * DAY + 3600);
  } finally {
    redis.pipeline = pipeline;
  }
  is("the student whose end passed before the module opens: not emailed", claimed.some((key) => key.includes(emailKey("drip-ended@example.test"))), false);
  is("the student with no end: emailed as before", claimed.some((key) => key.includes(emailKey("drip-open@example.test"))), true);

  part("M-A (C2 focal): a checkout opened before the end and paid after it has no end");
  // Stripe keeps a checkout open for up to 24 hours: a stamp counts only on a session made at least that long before it.
  listed = [session(a.store, { product: a.product.id, access_end: String(END) }, END - 3600)];
  is("opened an hour before the end, read an hour after: open", (await gate(a.store, a.product, course, "ma-late@example.test", END + 3600)).state, "open");
  listed = [session(a.store, { product: a.product.id, access_end: String(END) }, END - 24 * 3600)];
  is("opened 24 hours before the end: the end holds", (await gate(a.store, a.product, course, "ma-24h@example.test", END + 3600)).state, "expired");
  const noCreated = session(a.store, { product: a.product.id, access_end: String(END) }, SET_AT + DAY);
  delete noCreated.created;
  listed = [noCreated];
  is("a session whose creation does not read: no end", (await gate(a.store, a.product, course, "ma-nocreated@example.test", END + 3600)).state, "open");
  const forSale = (accessEnd as Record<string, unknown>).shownAccessEnd as (c: Course, now?: number) => string;
  is("in its last 24 hours the date is no longer said, nor sent with the form", [forSale(course, END - 12 * 3600), forSale(course, END - 25 * 3600)], ["none", String(END)]);
  is("nor the line on the sales page", accessEnd.accessEndFact(course, "en", END - 12 * 3600), null);
  const near = await shop("stampnear");
  const nearEnd = Math.floor(Date.now() / 1000) + 12 * 3600;
  await saveCourse(withEnd(near.courseId, nearEnd), near.store);
  opened.length = 0;
  const nearForm = withConsent(new URLSearchParams({ handle: near.store.handle, product: near.product.id, access_end: "none" }));
  await checkoutRoute(new NextRequest("https://marktmorgen.test/api/store/checkout", { method: "POST", headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" }, body: nearForm.toString() }));
  is("a page drawn in the last 24 hours said none: the checkout opens with no stamp", [opened.length, opened[0]?.get("metadata[access_end]") ?? null], [1, null]);

  part("M-B (C2 focal): a place, gift or pre-order given after a stamped end reopens the course");
  const recordOpen = ((learn as Record<string, unknown>).recordOpenEnrollment ?? recordEnrollment) as typeof recordEnrollment;
  listed = [session(a.store, { product: a.product.id, access_end: String(END) }, SET_AT + DAY)];
  await recordEnrollment(a.store, "mb-place@example.test", a.product.id, SET_AT + DAY);
  await recordOpen(a.store, "mb-place@example.test", a.product.id, END + DAY);
  is("a group place taken after the stamped end: open", (await gate(a.store, a.product, course, "mb-place@example.test", LATER)).state, "open");
  // As deliverGift and handOverPreorder do: the grant, and the store's doors that read grants opened.
  await grantImported(a.store.statsId!, "g".repeat(24), [{ email: "mb-gift@example.test", productId: a.product.id, items: null }], END + DAY, a.store.sid);
  await setPastBuyers(a.owner);
  const granting = (await storeForEmail(a.owner))!;
  is("a gift or pre-order after the stamped end (both written as a grant): open", (await gate(granting, a.product, course, "mb-gift@example.test", LATER)).state, "open");
  const group = readFileSync("app/[handle]/group/[group]/page.tsx", "utf8");
  const paypal = readFileSync("lib/paypal-delivery.ts", "utf8");
  is("the group place and the PayPal sale write their course as one with no end", [/recordOpenEnrollment\(store, email, productId, start\)/.test(group), /recordOpenEnrollment\(store, email, productId, start\)/.test(paypal)], [true, true]);

  part("L-A (C2 focal): a learner with no end needs no answer from Stripe");
  stripeDown = true;
  await recordOpen(a.store, "la-open@example.test", a.product.id, SET_AT + DAY);
  is("Stripe down, a group place: open, not \"could not check\"", (await gate(a.store, a.product, course, "la-open@example.test", LATER)).state, "open");
  stripeDown = false;

  part("L-B (C2 focal): the start button keeps the student's stamp right");
  const stampOf = (learn as Record<string, unknown>).purchaseStamp as ((st: Store, email: string, productId: string) => Promise<number | null | "unknown">) | undefined;
  listed = [session(a.store, { product: a.product.id, access_end: String(END) }, SET_AT + DAY), session(a.store, { product: a.product.id }, END + DAY)];
  is("the gate's stamp for a learner who bought again with no end: none", stampOf ? await stampOf(a.store, "lb-again@example.test", a.product.id) : "missing", null);
  listed = [session(a.store, { product: a.product.id, access_end: String(END) }, SET_AT + DAY)];
  is("and for a stamped learner: the stamp", stampOf ? await stampOf(a.store, "lb-stamped@example.test", a.product.id) : "missing", END);
  // The stamp is asked only once a row is found (C2's L-1): handed in as a function.
  const note = (learn as Record<string, unknown>).noteStudentStamp as ((courseId: string, email: string, stamp: () => Promise<number | null | "unknown">, room: Store) => Promise<void>) | undefined;
  await touchStudent(d.courseId, "lb-row@example.test", SET_AT + DAY, d.store, SET_AT + 10 * DAY);
  if (note) await note(d.courseId, "lb-row@example.test", async () => null, d.store);
  if (note) await note(d.courseId, "lb-none@example.test", async () => SET_AT + 10 * DAY, d.store);
  const rows = await redis.pipeline([["HGET", `nl:course:${d.courseId}:students`, emailKey("lb-row@example.test")], ["HGET", `nl:course:${d.courseId}:students`, emailKey("lb-none@example.test")]]);
  is("bought again with no end: the row's end goes, the row stays; no row is made for a learner who never came", [typeof rows[0] === "string" && !("x" in JSON.parse(rows[0] as string)), rows[1]], [true, null]);
  const start = readFileSync("app/api/store/course/start/route.ts", "utf8");
  is("the start route keeps it on the student row", /purchaseStamp\(store, (?:order\.)?email, product\.id\)/.test(start) && /noteStudentStamp\(/.test(start), true);

  part("M-P (C6 focal): a course paid through its payment plan has no end, as a membership has none");
  const plan = await shop("stampplan");
  if (!(await setProductExtras(plan.owner, plan.product.id, { plan: { payments: 3, interval: "month", amountCents: 2000 } })).ok) throw new Error("plan fixture");
  const planEnd = Math.floor(Date.now() / 1000) + 30 * DAY;
  await saveCourse(withEnd(plan.courseId, planEnd), plan.store);
  opened.length = 0;
  const planForm = withConsent(new URLSearchParams({ handle: plan.store.handle, product: plan.product.id, pay: "plan", access_end: String(planEnd) }));
  await checkoutRoute(new NextRequest("https://marktmorgen.test/api/store/checkout", { method: "POST", headers: { host: "marktmorgen.test", origin: "https://marktmorgen.test", "content-type": "application/x-www-form-urlencoded" }, body: planForm.toString() }));
  is("a payment-plan checkout opens as a plan, with no end stamped", [opened.length, opened[0]?.get("metadata[kind]") ?? null, opened[0]?.get("metadata[access_end]") ?? null], [1, "plan", null]);
  listed = [{ ...session(a.store, { product: a.product.id, kind: "plan", access_end: String(END) }, SET_AT + DAY), mode: "subscription", subscription: { status: "active" } }];
  is("a stamped plan purchase read after the end (sessions made before this change): open", (await gate(a.store, a.product, course, "mp-plan@example.test", LATER)).state, "open");
  const studioPage = readFileSync("app/studio/course/[product]/page.tsx", "utf8");
  const editor = readFileSync("components/course-editor.tsx", "utf8");
  const terms = readFileSync("app/terms/page.tsx", "utf8");
  is("the studio and the Terms say a payment-plan buyer keeps the course with no end",
    [/planOffered=\{activePlan\(product\) !== null\}/.test(studioPage), /pay in a payment plan keep the course with no end/.test(editor), /pay in a payment plan[\s\S]{0,40}keep the course[\s\S]{0,10}with no end/.test(terms)],
    [true, true, true]);

  part("L-1 (C2 focal): the start button reads the learner's courses only for a student row that exists");
  const noteLazy = (learn as Record<string, unknown>).noteStudentStamp as (courseId: string, email: string, stamp: () => Promise<number | null | "unknown">, room: Store) => Promise<void>;
  let asked = 0;
  const lazy = async () => {
    asked += 1;
    return SET_AT + 40 * DAY;
  };
  await noteLazy(d.courseId, "l1-norow@example.test", lazy, d.store);
  const askedWithoutRow = asked;
  await touchStudent(d.courseId, "l1-row@example.test", SET_AT + DAY, d.store, null);
  await noteLazy(d.courseId, "l1-row@example.test", lazy, d.store);
  const l1row = await redis.pipeline([["HGET", `nl:course:${d.courseId}:students`, emailKey("l1-row@example.test")]]);
  is("the start button's reading of a row that exists is paid first as one more public request", /paidStampNow = async \(\) => \(\(await takePublicRequest\(store, "buyer"\)/.test(readFileSync("app/api/store/course/start/route.ts", "utf8")), true);
  is("no row: nothing asked; a row: asked once, and its end kept", [askedWithoutRow, asked, typeof l1row[0] === "string" ? (JSON.parse(l1row[0] as string) as { x?: number }).x : null], [0, 1, SET_AT + 40 * DAY]);

  globalThis.fetch = realFetch;
  done();
}

void main();
